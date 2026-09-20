import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type {
  AddCartItemRequest,
  AuthorizeRequest,
  CartResponse,
  ChatRequest,
  ChatResponse,
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

/**
 * Called with a 401 so the session layer can re-derive a token from the device
 * secret. Tokens now expire, so this is the ordinary path on a returning
 * device, not an error path — a user who has not opened the app in a month must
 * not be shown a sign-in screen they never signed into.
 */
let reauthorize: (() => Promise<string | null>) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setReauthorizer(fn: (() => Promise<string | null>) | null): void {
  reauthorize = fn;
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

async function request<T>(path: string, options: RequestOptions = {}, retrying = false): Promise<T> {
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
    // An expired or revoked session is re-derived once from the device secret
    // and the call is replayed. Exactly once: a second 401 on the retry means
    // the identity is genuinely gone, and looping on it would be a hot loop
    // against our own auth endpoint.
    if (response.status === 401 && !retrying && !options.anonymous && reauthorize) {
      const token = await reauthorize();
      if (token) return request<T>(path, options, true);
    }

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

export interface DeviceBootstrap {
  token: string;
  /** Present only when a new identity was minted. Store it; it is never re-sent. */
  deviceSecret?: string;
  deviceUserId: string;
  userId: string;
  isAnonymous: boolean;
  /** Whether this deployment requires a claimed account to place orders. */
  requiresAccount?: boolean;
  onboarded: boolean;
}

export const api = {
  // ---- Identity ----------------------------------------------------------
  /**
   * Resumes an identity from the stored device secret, or mints a new one.
   *
   * Omitting the secret is the "new device" case. The server never adopts an
   * identity from a value the client chose, so a secret it does not recognise
   * yields a fresh empty profile rather than somebody else's account.
   */
  bootstrapDevice(deviceSecret: string | null) {
    return request<DeviceBootstrap>('/v1/auth/device', {
      method: 'POST',
      body: deviceSecret ? { deviceSecret } : {},
      anonymous: true,
    });
  },

  /** Step one of an email claim: a code is sent to the address. */
  startEmailClaim(email: string) {
    return request<{ expiresAt: string }>('/v1/me/claim/email', {
      method: 'POST',
      body: { email },
    });
  },

  /** Step two: the code proves ownership and the profile is claimed. */
  claimWithEmailCode(email: string, code: string) {
    return request<{ token: string }>('/v1/me/claim', {
      method: 'POST',
      body: { provider: 'email', email, token: code },
    });
  },

  /** Invalidates every token issued for this identity, on every device. */
  revokeSessions() {
    return request<void>('/v1/me/sessions/revoke', { method: 'POST' });
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

  /**
   * Asks the server to advance the rolling catalog window. Like `feedPage`,
   * this never surfaces an error: rotation is background housekeeping and a
   * failed one only means the catalog is refreshed a little later.
   */
  async rotateCatalog(body: { add: number; drop: number }): Promise<void> {
    if (!authToken) return;
    try {
      await request<{ status: string }>('/v1/feed/rotate', { method: 'POST', body });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[Window] catalog rotation request failed', error);
      }
    }
  },

  // ---- Catalog -----------------------------------------------------------
  /**
   * `live` asks the server to re-fetch the listing at its source URL before
   * answering; the stored row is returned when the source refuses.
   */
  product(id: string, options: { live?: boolean } = {}) {
    const suffix = options.live ? '?live=1' : '';
    return request<ProductDetail>(`/v1/products/${id}${suffix}`);
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

  // ---- Ask ---------------------------------------------------------------
  /**
   * One turn of the shopping assistant. Unlike the feed this is allowed to
   * throw: the user is watching a spinner they opened themselves, so a failure
   * has to be told to them rather than swallowed.
   */
  ask(body: ChatRequest, signal?: AbortSignal) {
    return request<ChatResponse>('/v1/chat', { method: 'POST', body, signal });
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
   * `EventSource` cannot set an Authorization header, so the URL carries its
   * own credential — and a URL is the worst place in the system to put one: it
   * reaches access logs, proxy logs and browser history. What it carries is
   * therefore a ticket, not the session token: one job, one minute, one use,
   * fetched over an authenticated POST immediately before the stream opens.
   */
  async jobStreamUrl(id: string): Promise<string> {
    const base = `${API_BASE_URL}/v1/checkout/jobs/${id}/stream`;
    const { ticket } = await request<{ ticket: string; expiresAt: string }>(
      `/v1/checkout/jobs/${id}/stream-ticket`,
      { method: 'POST' },
    );
    return `${base}?ticket=${encodeURIComponent(ticket)}`;
  },
};
