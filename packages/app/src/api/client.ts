import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type {
  AddCartItemRequest,
  AuthorizeRequest,
  CartResponse,
  ClusterResponse,
  EventsRequest,
  EventsResponse,
  FeedPageRequest,
  FeedPageResponse,
  FeedSessionResponse,
  MeResponse,
  OnboardingCompleteRequest,
  OnboardingTopicsResponse,
  OrdersResponse,
  ProblemDetails,
  ProductDetail,
  QuoteResponse,
  ReviewsResponse,
  SearchResponse,
  SellerResponse,
  SuppressionRequest,
} from '@window/shared';

/**
 * The API client.
 *
 * One rule shapes everything here: the feed never surfaces a network error. A
 * failed page request returns null and the caller keeps serving its buffer, a
 * 429 is honoured silently, and only the paths where the user is actively
 * waiting on something — the cart, checkout — are allowed to throw.
 */

function resolveBaseUrl(): string {
  // An environment variable is an explicit deployment override and wins over
  // the development defaults below.
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;

  // On a device the Metro host is the only address that can reach the dev
  // machine; localhost would resolve to the phone itself. This must run before
  // Expo's `extra.apiUrl`, whose checked-in localhost value is intended for web.
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  if (hostUri && Platform.OS !== 'web') {
    const host = hostUri.split(':')[0];
    if (host) return `http://${host}:4000`;
  }

  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (configured) return configured;
  return 'http://127.0.0.1:4000';
}

export const API_BASE_URL = resolveBaseUrl();

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with ${status}`);
    this.name = 'ApiRequestError';
  }

  /** True when the client should back off and serve from its local buffer. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skips the Authorization header, for the device bootstrap call. */
  anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!options.anonymous && authToken) headers.authorization = `Bearer ${authToken}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    let problem: ProblemDetails | null = null;
    try {
      problem = (await response.json()) as ProblemDetails;
    } catch {
      problem = null;
    }
    const retryAfter = response.headers.get('retry-after');
    throw new ApiRequestError(
      response.status,
      problem,
      retryAfter ? Number.parseInt(retryAfter, 10) : null,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  // ---- Identity ----------------------------------------------------------
  bootstrapDevice(deviceUserId: string) {
    return request<{ token: string; userId: string; isAnonymous: boolean; onboarded: boolean }>(
      '/v1/auth/device',
      { method: 'POST', body: { deviceUserId }, anonymous: true },
    );
  },

  // ---- Feed --------------------------------------------------------------
  session() {
    return request<FeedSessionResponse>('/v1/feed/session');
  },

  /**
   * Returns null rather than throwing on a rate limit or a transient failure.
   * The feed stops advancing; it never shows an error.
   */
  async feedPage(body: FeedPageRequest, signal?: AbortSignal): Promise<FeedPageResponse | null> {
    // Requesting a page before the device token exists is a guaranteed 401, and
    // the round trip teaches the caller nothing it cannot know from here.
    if (!authToken) return null;

    try {
      return await request<FeedPageResponse>('/v1/feed/page', { method: 'POST', body, signal });
    } catch (error) {
      // The feed keeps its resilient buffer behavior, but log the reason in
      // development so a stale API URL or server-side problem is diagnosable
      // instead of looking like an unexplained empty screen.
      if ((error as Error).name === 'AbortError') return null;
      if (process.env.NODE_ENV !== 'production') {
        console.error('[Window] feed request failed', error);
      }
      return null;
    }
  },

  refreshFeed() {
    return request<void>('/v1/feed/refresh', { method: 'POST' });
  },

  // ---- Catalog -----------------------------------------------------------
  product(id: string) {
    return request<ProductDetail>(`/v1/products/${id}`);
  },
  cluster(id: string) {
    return request<ClusterResponse>(`/v1/clusters/${id}`);
  },
  reviews(clusterId: string, params: { bucket?: string; sort?: string; offset?: number } = {}) {
    const query = new URLSearchParams();
    if (params.bucket) query.set('bucket', params.bucket);
    if (params.sort) query.set('sort', params.sort);
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return request<ReviewsResponse>(`/v1/clusters/${clusterId}/reviews${suffix}`);
  },
  seller(id: string) {
    return request<SellerResponse>(`/v1/sellers/${id}`);
  },
  sellerListings(id: string) {
    return request<{ items: SearchResponse['items'] }>(`/v1/sellers/${id}/listings`);
  },
  search(q: string) {
    return request<SearchResponse>(`/v1/search?q=${encodeURIComponent(q)}`);
  },

  // ---- Events ------------------------------------------------------------
  events(body: EventsRequest) {
    return request<EventsResponse>('/v1/events', { method: 'POST', body });
  },

  // ---- Onboarding and profile --------------------------------------------
  onboardingTopics() {
    return request<OnboardingTopicsResponse>('/v1/onboarding/topics');
  },
  completeOnboarding(body: OnboardingCompleteRequest) {
    return request<void>('/v1/onboarding/complete', { method: 'POST', body });
  },
  me() {
    return request<MeResponse>('/v1/me');
  },
  updateSettings(body: Partial<MeResponse['settings']>) {
    return request<void>('/v1/me/settings', { method: 'PATCH', body });
  },
  suppress(body: SuppressionRequest) {
    return request<void>('/v1/me/suppressions', { method: 'POST', body });
  },
  deleteAccount() {
    return request<void>('/v1/me', { method: 'DELETE' });
  },
  report(body: { productId: string; reason: string; note?: string }) {
    return request<{ reports: number }>('/v1/reports', { method: 'POST', body });
  },

  // ---- Cart and checkout -------------------------------------------------
  cart() {
    return request<CartResponse>('/v1/cart');
  },
  addToCart(body: AddCartItemRequest) {
    return request<CartResponse>('/v1/cart/items', { method: 'POST', body });
  },
  updateCartItem(id: string, body: { quantity?: number; variant?: Record<string, string> }) {
    return request<CartResponse>(`/v1/cart/items/${id}`, { method: 'PATCH', body });
  },
  removeCartItem(id: string) {
    return request<CartResponse>(`/v1/cart/items/${id}`, { method: 'DELETE' });
  },
  quote() {
    return request<QuoteResponse>('/v1/checkout/quote', { method: 'POST', body: {} });
  },
  job(id: string) {
    return request<QuoteResponse['jobs'][number]>(`/v1/checkout/jobs/${id}`);
  },
  authorize(id: string, body: AuthorizeRequest) {
    return request<QuoteResponse['jobs'][number]>(`/v1/checkout/jobs/${id}/authorize`, {
      method: 'POST',
      body,
    });
  },
  answerPrompt(id: string, body: { promptId: string; value: string }) {
    return request<void>(`/v1/checkout/jobs/${id}/input`, { method: 'POST', body });
  },
  cancelJob(id: string) {
    return request<QuoteResponse['jobs'][number]>(`/v1/checkout/jobs/${id}/cancel`, {
      method: 'POST',
      body: {},
    });
  },
  orders() {
    return request<OrdersResponse>('/v1/orders');
  },

  /**
   * SSE stream URL for a checkout job. Polling at 2 s is the documented
   * fallback and the only path on native, which has no `EventSource`.
   *
   * The token rides as a query parameter because `EventSource` cannot set an
   * Authorization header. The server accepts it on this one path only.
   */
  jobStreamUrl(id: string): string {
    const base = `${API_BASE_URL}/v1/checkout/jobs/${id}/stream`;
    return authToken ? `${base}?access_token=${encodeURIComponent(authToken)}` : base;
  },
};
