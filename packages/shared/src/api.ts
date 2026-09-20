/**
 * The `/v1` wire contract, shared verbatim by the server and every client.
 */

import type {
  CardBadges,
  Condition,
  FeedMode,
  InteractionType,
  MediaImage,
  Money,
  OrderStatus,
  PriceBand,
  ProductCard,
  Quote,
  ReviewBucket,
  SourceType,
  UpvoteReason,
} from './types.js';

export const API_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export interface FeedPageRequest {
  mode: FeedMode;
  limit: number;
  /** The client's current index. Telemetry only; the server does not page from it. */
  cursor: number;
  sessionId: string;
  /** Last 200 only; the server holds the rest in the Bloom filter. */
  seenIds: string[];
  context: {
    region: string;
    currency: string;
    connection: 'wifi' | 'cellular' | 'offline' | 'unknown';
    dataSaver?: boolean;
  };
}

export interface FeedPageResponse {
  items: ProductCard[];
  /** Index groupings for Window mode, or null in Single mode. */
  quads: number[][] | null;
  /** Positions in `items` carrying an exploration card. */
  explorationIndexes: number[];
  rankingConfigVersion: string;
  nextCursorHint: number;
  ttlMs: number;
  /** Set when the graceful degradation ladder was used. */
  degraded: 'cache' | 'topic_popularity' | 'global_popularity' | null;
}

export interface FeedSessionResponse {
  sessionId: string;
  user: {
    id: string;
    isAnonymous: boolean;
    onboarded: boolean;
    interactionCount: number;
    settings: {
      reducedMotion: boolean;
      autoplayVideo: boolean;
      dataSaver: boolean;
      region: string;
      currency: string;
    };
  };
  explorationCounter: number;
  rankingConfigVersion: string;
  experiments: Record<string, string>;
  flags: Record<string, boolean>;
  buffer: {
    size: number;
    behind: number;
    ahead: number;
    refillThreshold: number;
    pageSize: number;
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ProductDetail extends ProductCard {
  specs: Array<{ key: string; value: string; unit: string | null }>;
  description: string | null;
  sourceUrl: string;
  condition: Condition;
  sourceType: SourceType;
  quality: { score: number; cautions: Array<{ theme: string; text: string }> };
  risk: { tier: string; flag: string | null };
  lastVerifiedAt: string;
}

export interface ClusterOffer {
  productId: string;
  merchantDomain: string;
  merchantName: string;
  sellerId: string;
  price: Money;
  shipping: Money;
  /** Price + shipping. Offers sort by this. */
  landedPrice: Money;
  condition: Condition;
  sourceType: SourceType;
  inStock: boolean;
  isCanonical: boolean;
}

export interface ClusterResponse {
  clusterId: string;
  title: string;
  brand: string | null;
  category: { l1: string; l2: string; l3: string };
  priceRange: { min: number; max: number; median: number; currency: string };
  offers: ClusterOffer[];
  reviews: {
    count: number;
    meanRating: number | null;
    perSource: Array<{ domain: string; count: number; meanRating: number }>;
    summary: { text: string; generatedAt: string; modelVersion: string } | null;
    themes: Array<{ name: string; positive: number; negative: number; mentions: number }>;
    asOf: string | null;
  };
  /** Window's own upvotes, kept visually separate from source reviews. */
  windowUpvotes: { count: number; reasons: Array<{ reason: UpvoteReason; count: number }> };
  media: { hero: MediaImage; gallery: MediaImage[] };
}

export interface ReviewItem {
  id: string;
  /** `null` when the source shows review content without a per-review star rating. */
  rating: number | null;
  ratingScale: number;
  excerpt: string;
  authorHandle: string | null;
  verifiedPurchase: boolean | null;
  helpfulCount: number;
  postedAt: string;
  bucket: ReviewBucket;
  themes: string[];
  source: { domain: string; url: string };
}

export interface ReviewsResponse {
  clusterId: string;
  items: ReviewItem[];
  total: number;
  nextOffset: number | null;
  asOf: string | null;
}

export interface SellerResponse {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  sourceDomain: string;
  type: 'retailer' | 'individual' | 'auction_house';
  metrics: {
    rating: number | null;
    reviewCount: number;
    salesCount: number;
    memberSince: string | null;
    responseTime: string | null;
  };
  policies: { returnWindowDays: number; shippingSummary: string } | null;
  auctionTerms: { buyerPremiumPct: number; termsUrl: string } | null;
  liveListingCount: number;
  muted: boolean;
}

export interface SearchResponse {
  query: string;
  items: ProductCard[];
  total: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ClientEvent {
  /** Client-generated; the collector dedupes on it. */
  idempotencyKey: string;
  type: InteractionType;
  productId: string;
  position: number;
  mode: FeedMode;
  clientTs: string;
  dwellMs?: number;
  reason?: UpvoteReason;
  /** Set by the client when the card was served as an exploration card. */
  isExploration?: boolean;
  /** Fraction of the viewport the card occupied, for the dwell quality rule. */
  viewportFraction?: number;
  foreground?: boolean;
}

export interface EventsRequest {
  sessionId: string;
  events: ClientEvent[];
}

export interface EventsResponse {
  accepted: number;
  rejected: Array<{ idempotencyKey: string; reason: string }>;
  /** True when a strong signal invalidated the buffer, so the client should refetch. */
  invalidatedBuffer: boolean;
}

// ---------------------------------------------------------------------------
// Onboarding and profile
// ---------------------------------------------------------------------------

export interface OnboardingTopic {
  id: string;
  displayName: string;
  /** Photo collage for the tile. */
  image: string;
  order: number;
}

export interface OnboardingTopicsResponse {
  topics: OnboardingTopic[];
  /** Exactly three. The continue button activates there and hard-caps. */
  requiredSelections: number;
}

export interface OnboardingCompleteRequest {
  topics: string[];
  priceBand: PriceBand | null;
}

export interface MeResponse {
  id: string;
  deviceUserId: string;
  isAnonymous: boolean;
  email: string | null;
  onboarding: { topics: string[]; priceBand: PriceBand | null; completedAt: string } | null;
  interestSet: Array<{
    topic: string;
    displayName: string;
    weight: number;
    source: string;
    addedAt: string;
  }>;
  pricePrior: { center: number; currency: string; confidence: number };
  settings: {
    reducedMotion: boolean;
    autoplayVideo: boolean;
    dataSaver: boolean;
    region: string;
    currency: string;
  };
  counters: { interactionCount: number; sessionCount: number };
}

export interface SuppressionRequest {
  kind: 'product' | 'brand' | 'seller';
  /** Product id, brand name or seller id. */
  value: string;
  /** Present for `hide_product`, so the ranker gets the signal too. */
  productId?: string;
}

export interface ClaimRequest {
  provider: 'email' | 'apple' | 'google';
  email?: string;
  /** Opaque token from the provider; verified server-side. */
  token: string;
}

// ---------------------------------------------------------------------------
// Cart and checkout
// ---------------------------------------------------------------------------

export interface CartLine {
  id: string;
  productId: string;
  clusterId: string | null;
  title: string;
  merchant: { domain: string; displayName: string };
  seller: { id: string; handle: string };
  /**
   * The product's hero image, when it has one.
   *
   * Nullable, like `OrdersResponse`'s already is: a listing can reach the
   * cart without usable imagery, and declaring otherwise only moves the
   * problem to a null dereference in the renderer.
   */
  hero: MediaImage | null;
  variant: Record<string, string>;
  quantity: number;
  priceAtAdd: Money;
  priceNow: Money;
  priceChanged: boolean;
  available: boolean;
  /** Window cannot reserve inventory it does not own. */
  softHold: boolean;
  badges: CardBadges;
}

export interface CartResponse {
  cartId: string;
  status: 'open' | 'checking_out' | 'closed';
  lines: CartLine[];
  byMerchant: Array<{ domain: string; displayName: string; lineIds: string[]; subtotal: Money }>;
  /** Changes since the last view that the user must acknowledge. */
  diffs: Array<{
    lineId: string;
    kind: 'price_up' | 'price_down' | 'out_of_stock';
    from: Money | null;
    to: Money | null;
  }>;
  total: Money;
  verifiedAt: string;
}

export interface AddCartItemRequest {
  productId: string;
  variant?: Record<string, string>;
  quantity?: number;
}

export interface QuoteRequest {
  cartId: string;
}

export interface CheckoutJobSummary {
  jobId: string;
  orderId: string;
  merchantDomain: string;
  merchantName: string;
  status: OrderStatus;
  quote: (Omit<Quote, 'generatedAt' | 'expiresAt'> & {
    generatedAt: string;
    expiresAt: string;
  }) | null;
  coupon: { code: string; discount: number; attempts: number } | null;
  /** Savings are always the observed pre-code minus post-code merchant total. */
  savings: { amount: number; currency: string } | null;
  /**
   * The lines being bought, carrying the same hero image the feed showed.
   *
   * Checkout is the screen where someone commits money, so it has to show the
   * thing they are committing it to — a title alone asks them to trust that the
   * agent picked the product they were looking at. Nullable for the same reason
   * the cart's is: a listing can reach checkout without usable imagery.
   */
  items: Array<{
    productId: string;
    title: string;
    quantity: number;
    unitPrice: number;
    hero: MediaImage | null;
  }>;
  protocol: 'acp' | 'mpp' | 'tap' | 'browser' | null;
  needsInput: CheckoutInputPrompt | null;
  failure: { code: string; message: string; recoverable: boolean } | null;
  merchantOrderNumber: string | null;
  /** Interstitial copy when a line carries a caution-tier risk flag. */
  riskInterstitial: string | null;
}

export interface QuoteResponse {
  jobs: CheckoutJobSummary[];
}

export interface CheckoutInputPrompt {
  promptId: string;
  kind: 'address' | 'shipping_option' | 'captcha' | 'twofa' | 'three_ds' | 'choice';
  message: string;
  options?: Array<{ id: string; label: string; detail?: string }>;
  /** For CAPTCHA / 2FA / 3DS the user is handed the live view. */
  handoffUrl?: string;
}

export interface AuthorizeRequest {
  /** Must match the hash returned with the quote, or the call 409s. */
  quoteHash: string;
  /** Passkey assertion from the authorization tap. */
  passkeyAssertion?: string;
}

export interface CheckoutInputRequest {
  promptId: string;
  value: string;
}

export interface OrderSummary {
  orderId: string;
  merchantDomain: string;
  merchantName: string;
  status: OrderStatus;
  total: Money | null;
  merchantOrderNumber: string | null;
  items: Array<{ productId: string; title: string; quantity: number; hero: MediaImage | null }>;
  createdAt: string;
}

export interface OrdersResponse {
  orders: OrderSummary[];
}

/** SSE event names on `/v1/checkout/jobs/{id}/stream`. */
export const CHECKOUT_STREAM_EVENTS = [
  'state',
  'step',
  'coupon_attempt',
  'needs_input',
  'quote_ready',
] as const;
export type CheckoutStreamEvent = (typeof CHECKOUT_STREAM_EVENTS)[number];

export interface CheckoutStreamPayload {
  jobId: string;
  event: CheckoutStreamEvent;
  at: string;
  state?: OrderStatus;
  step?: string;
  couponAttempt?: { code: string; ok: boolean; discount: number; reason?: string };
  needsInput?: CheckoutInputPrompt;
  quote?: CheckoutJobSummary;
}

export interface MerchantLinkResponse {
  merchantDomain: string;
  /** The in-app authenticated web view the user completes the link in. */
  linkUrl: string;
  linkId: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Ranking debug (internal only)
// ---------------------------------------------------------------------------

export interface RankingDebugCandidate {
  productId: string;
  title: string;
  category: { l1: string; l2: string; l3: string };
  sim: number;
  quality: number;
  ctr: number;
  freshness: number;
  affinity: number;
  penalty: number;
  score: number;
  mmrScore: number | null;
  selected: boolean;
  selectionReason: string;
}

export interface RankingDebugResponse {
  userId: string;
  mode: FeedMode;
  rankingConfigVersion: string;
  stages: {
    retrieved: number;
    afterFilters: number;
    filteredBy: Record<string, number>;
    scored: number;
    selected: number;
  };
  explorationTopic: string | null;
  candidates: RankingDebugCandidate[];
  timingsMs: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Ask — the shopping assistant
// ---------------------------------------------------------------------------

/** One line of the conversation, oldest first. */
export interface ChatTurnWire {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * What earlier turns settled on. The client holds it and hands it back, which
 * is what makes the conversation work without server-side session state — and
 * what lets "under $50" resolve even when the model is unreachable.
 */
export interface StandingIntentWire {
  item: string;
  budgetMinor: number | null;
  requirements: string[];
}

export interface ChatRequest {
  /** What the shopper typed, verbatim. */
  message: string;
  sessionId: string;
  /** The conversation so far, excluding `message`. Oldest first. */
  history?: ChatTurnWire[];
  /** The request earlier turns settled on, from the last response. */
  standing?: StandingIntentWire | null;
}

/**
 * One retrieved listing. Deliberately not a `ProductCard`: these come off a
 * live Amazon or eBay search page and most were never ingested, so they have
 * no cluster, no seller record and no media pipeline behind them. Giving them
 * a `ProductCard` shape would promise the rest of the app things it cannot
 * deliver — reviews sheets, variant pickers, add-to-cart.
 */
export interface ChatPickResponse {
  productId: string;
  title: string;
  /** Minor units, and the currency it is quoted in. Never null on the wire. */
  priceMinor: number;
  currency: string;
  url: string;
  imageUrl: string | null;
  sourceDomain: string | null;
  /** Star rating out of 5 as the storefront showed it. */
  rating: number | null;
  reviewCount: number | null;
  /** The same evidence as one line, ready to render. */
  reviewNote: string | null;
  /** Where that evidence can be checked. */
  sources: Array<{ title: string; url: string }>;
}

export interface ChatResponse {
  kind: 'answer' | 'clarify' | 'refused';
  /** The assistant's message. Always set, even when `picks` is empty. */
  message: string;
  picks: ChatPickResponse[];
  /**
   * What this turn resolved the request to. The client sends it back with the
   * next message so a follow-up builds on it. Null when nothing was settled.
   */
  standing: StandingIntentWire | null;
  /** The enforced price ceiling, echoed so the client can render it. */
  budgetMinor: number | null;
  /** Non-price constraints read out of the ask. */
  requirements: string[];
}
