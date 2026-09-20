/**
 * Canonical document and wire types for Window.
 *
 * Every document interface is generic in its id type so the same declaration
 * serves the server (where ids are `ObjectId`) and the clients (where ids have
 * already been serialised to strings). Server code writes `ProductDoc<ObjectId>`;
 * client code writes `ProductDoc` and gets `string` ids.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Money is always minor units plus an ISO 4217 code. Never a float. */
export interface Money {
  /** Minor units, e.g. 12999 === $129.99. */
  amount: number;
  currency: string;
}

export type SourceType = 'new' | 'secondhand' | 'auction';

/** The 8-point ordinal condition scale. Order is meaningful: index 0 is best. */
export const CONDITION_SCALE = [
  'new',
  'like_new',
  'excellent',
  'good',
  'fair',
  'poor',
  'for_parts',
  'unknown',
] as const;
export type Condition = (typeof CONDITION_SCALE)[number];

export type ProductStatus = 'active' | 'stale' | 'dead' | 'rejected';

export type FeedMode = 'single' | 'window';

export type RiskTier = 'clear' | 'watch' | 'caution' | 'high' | 'blocked';

export type SourceTier = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Interaction events
// ---------------------------------------------------------------------------

export const INTERACTION_TYPES = [
  'impression',
  'dwell_short',
  'dwell_long',
  'skip_fast',
  'gallery_advance',
  'upvote',
  'upvote_removed',
  'reviews_open',
  'reviews_dwell',
  'seller_open',
  'share',
  'cart_add',
  'cart_remove',
  'purchase',
  'hide_product',
  'hide_brand',
  'mute_seller',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/** Reason tags offered by the upvote long-press picker. */
export const UPVOTE_REASONS = ['price', 'design', 'brand', 'need_it'] as const;
export type UpvoteReason = (typeof UPVOTE_REASONS)[number];

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export interface CategoryRef {
  l1: string;
  l2: string;
  l3: string;
  /** Classifier confidence recorded at ingest. */
  confidence?: number;
}

export interface CategoryDoc<Id = string> {
  /** Slug id, e.g. "mechanical-keyboards". */
  id: string;
  level: 1 | 2 | 3;
  parent: string | null;
  l1: string;
  displayName: string;
  /** 1024-dim mean of the top-500 products by engagement. */
  centroid: number[] | null;
  centroidComputedAt: Date | null;
  memberCount: number;
  /** L1 only: the onboarding grid tile. */
  tile: { image: string; order: number } | null;
  engagement: { medianCtr: number; productCount: number };
  /** L1 only: nightly co-occurrence lift against other L1 topics. */
  coOccurrence: Array<{ topic: string; lift: number }>;
  /** Present only so the generic parameter is used uniformly across docs. */
  __idBrand?: Id;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** Widths the transcoder emits, in order. */
export const MEDIA_WIDTHS = [480, 1080, 1440] as const;

export interface MediaImage {
  /** AVIF urls at 480, 1080, 1440. */
  avif: string[];
  /** WebP urls at 480, 1080, 1440. */
  webp: string[];
  width: number;
  height: number;
  blurhash: string;
}

export interface MediaVideo {
  hls: string;
  durationMs: number;
  poster: string;
}

export interface ProductMedia {
  hero: MediaImage;
  /** Max 8. */
  gallery: MediaImage[];
  video: MediaVideo | null;
}

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

export interface ProductIdentifiers {
  gtin?: string | null;
  upc?: string | null;
  ean?: string | null;
  asin?: string | null;
  mpn?: string | null;
  isbn?: string | null;
}

export interface QualityCaution {
  theme: string;
  negativeShare: number;
  mentions: number;
}

export interface ProductQuality {
  /** Q, in [0,1]. */
  score: number;
  reviewAdj: number;
  corpusDepth: number;
  sentimentConsistency: number;
  listingCompleteness: number;
  engagement: number;
  credibilityFactor: number;
  cautions: QualityCaution[];
  computedAt: Date;
}

export interface RiskSignal {
  family: RiskFamily;
  value: number;
  detail: string;
}

export const RISK_FAMILIES = [
  'price_anomaly',
  'seller_history',
  'media_forensics',
  'text_signals',
  'listing_coherence',
  'counterfeit',
  'cross_listing',
  'network',
] as const;
export type RiskFamily = (typeof RISK_FAMILIES)[number];

export interface ProductRisk<Id = string> {
  score: number;
  tier: RiskTier;
  signals: RiskSignal[];
  modelVersion: string;
  reports: { count: number; upheld: number };
  reviewedBy: Id | null;
  reviewedAt: Date | null;
  computedAt: Date;
}

export interface ProductDoc<Id = string> {
  id: Id;
  /** Parent cluster; null until clustered. */
  clusterId: Id | null;
  source: { domain: string; sourceId: string; tier: SourceTier; url: string };
  sourceType: SourceType;
  /** Normalized, <= 120 chars. */
  title: string;
  rawTitle: string;
  brand: string | null;
  identifiers: ProductIdentifiers;
  category: CategoryRef;
  price: Money;
  originalPrice: Money | null;
  shipping: { amount: number; currency: string; freeThreshold: number | null };
  condition: Condition;
  stock: { inStock: boolean; quantity: number | null; singleUnit: boolean };
  auction: { endsAt: Date; currentBid: number; bidCount: number } | null;
  specs: Array<{ key: string; value: string; unit: string | null }>;
  media: ProductMedia;
  sellerId: Id;
  /** 1024-dim, unit normalized. */
  embedding: number[];
  embeddingVersion: string;
  quality: ProductQuality;
  risk: ProductRisk<Id>;
  engagement: {
    impressions: number;
    interactions: number;
    ctrSmoothed: number;
    cartAdds: number;
  };
  crawl: {
    firstSeenAt: Date;
    lastCrawledAt: Date;
    lastChangedAt: Date;
    failCount: number;
    tier: SourceTier;
  };
  status: ProductStatus;
  rejectReason: string | null;
}

// ---------------------------------------------------------------------------
// productClusters
// ---------------------------------------------------------------------------

export interface ReviewTheme {
  name: string;
  positive: number;
  negative: number;
  mentions: number;
}

export interface ClusterDoc<Id = string> {
  id: Id;
  /** Best offer, recomputed on price change. */
  canonicalProductId: Id;
  title: string;
  brand: string | null;
  category: CategoryRef;
  identifiers: ProductIdentifiers;
  offerCount: number;
  priceRange: { min: number; max: number; median: number; currency: string };
  sourceTypes: SourceType[];
  /** Centroid of member products. */
  embedding: number[];
  reviews: {
    count: number;
    meanRating: number;
    perSource: Array<{ domain: string; count: number; meanRating: number }>;
    summary: { text: string; generatedAt: Date; modelVersion: string } | null;
    themes: ReviewTheme[];
    asOf: Date | null;
  };
  engagement: { impressions: number; ctrSmoothed: number; upvotes: number };
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export type InterestSource = 'onboarding' | 'exploration' | 'behavior';

export interface InterestEntry {
  topic: string;
  weight: number;
  source: InterestSource;
  addedAt: Date;
  lastPositiveAt: Date | null;
  /** Impressions accrued since the topic graduated, for the demotion rule. */
  impressionsSinceAdded?: number;
  /** Positive signal accrued since the topic graduated. */
  positiveSinceAdded?: number;
}

export interface BloomFilterState {
  /** Base64 of the bit array. */
  bits: string;
  k: number;
  m: number;
  rebuiltAt: Date;
  /** Inserted element count, for load monitoring. */
  n: number;
}

export interface UserDoc<Id = string> {
  id: Id;
  /**
   * Public, non-secret handle for the device. Server-minted, safe to log and
   * to return. It is an identifier, not a credential.
   */
  deviceUserId: string;
  /**
   * SHA-256 of the device secret the client holds. The secret itself is
   * returned exactly once, at mint time, and never stored — so a dump of this
   * collection yields no way to authenticate as anyone in it.
   */
  deviceSecretHash: string;
  /**
   * Session generation. Every token carries the epoch it was minted under;
   * incrementing this revokes all of them at once.
   */
  sessionEpoch: number;
  auth: {
    email: string | null;
    providers: string[];
    claimedAt: Date;
    /** Null until an ownership challenge is actually passed. */
    emailVerifiedAt: Date | null;
  } | null;
  onboarding: {
    topics: string[];
    priceBand: PriceBand | null;
    completedAt: Date;
  } | null;
  /** 1024-dim, unit normalized. */
  interestVector: number[] | null;
  interestSet: InterestEntry[];
  explorationState: {
    counter: number;
    lastTopic: string | null;
    /** Topics rejected twice, suppressed until the given date. */
    rejected: Array<{ topic: string; strikes: number; until: Date }>;
    /** Per-topic evidence accumulated inside the rolling 3-session window. */
    pending: Array<{
      topic: string;
      sessions: string[];
      positiveDwells: number;
      bestDwellMs: number;
      railInteraction: boolean;
      cartAdd: boolean;
    }>;
  };
  pricePrior: { center: number; currency: string; confidence: number };
  affinities: {
    brands: Record<string, number>;
    sellers: Record<string, number>;
  };
  suppressions: { products: Id[]; brands: string[]; sellers: Id[] };
  seenFilter: BloomFilterState;
  counters: {
    interactionCount: number;
    sessionCount: number;
    lastActiveAt: Date;
    /** Last day the decay job ran for this user, as YYYY-MM-DD. */
    lastDecayedOn: string | null;
  };
  settings: {
    reducedMotion: boolean;
    autoplayVideo: boolean;
    dataSaver: boolean;
    region: string;
    currency: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export type PriceBand = 'budget' | 'mid' | 'premium';

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

export interface InteractionDoc<Id = string> {
  id: Id;
  userId: Id;
  productId: Id;
  clusterId: Id | null;
  sessionId: string;
  type: InteractionType;
  /** Resolved from config at write time. */
  weight: number;
  mode: FeedMode;
  /** Index in the session's feed. */
  position: number;
  dwellMs: number | null;
  isExploration: boolean;
  /** Denormalized for aggregation. */
  category: CategoryRef;
  reason?: UpvoteReason | null;
  rankingConfigVersion: string;
  experiments: Record<string, string>;
  /** Client-generated idempotency key; the collector dedupes on it. */
  idempotencyKey: string;
  clientTs: Date;
  serverTs: Date;
}

// ---------------------------------------------------------------------------
// sellers
// ---------------------------------------------------------------------------

export interface SellerDoc<Id = string> {
  id: Id;
  sourceDomain: string;
  sourceSellerId: string;
  handle: string;
  type: 'retailer' | 'individual' | 'auction_house';
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  metrics: {
    rating: number | null;
    reviewCount: number;
    salesCount: number;
    memberSince: Date | null;
    responseTime: string | null;
  };
  policies: { returnWindowDays: number; shippingSummary: string } | null;
  /** Auction houses only. */
  auctionTerms: { buyerPremiumPct: number; termsUrl: string } | null;
  liveListingCount: number;
  trust: { score: number; flags: string[] };
  /** Set when two reports against this seller are upheld. */
  suppressed: boolean;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export const REVIEW_BUCKETS = ['recent', 'helpful', 'critical', 'positive'] as const;
export type ReviewBucket = (typeof REVIEW_BUCKETS)[number];

export interface ReviewDoc<Id = string> {
  id: Id;
  clusterId: Id;
  source: { domain: string; url: string };
  rating: number;
  ratingScale: number;
  /** <= 400 chars, never the full text. */
  excerpt: string;
  authorHandle: string | null;
  verifiedPurchase: boolean | null;
  helpfulCount: number;
  postedAt: Date;
  bucket: ReviewBucket;
  themes: string[];
  fetchedAt: Date;
}

// ---------------------------------------------------------------------------
// carts and orders
// ---------------------------------------------------------------------------

export interface CartItem<Id = string> {
  /** Line id, stable for PATCH/DELETE. */
  id: Id;
  productId: Id;
  clusterId: Id | null;
  sellerId: Id;
  merchantDomain: string;
  variant: Record<string, string>;
  quantity: number;
  priceAtAdd: Money;
  priceNow: Money;
  priceChanged: boolean;
  available: boolean;
  /** Window cannot reserve inventory it does not own. Indicator only. */
  softHold: boolean;
  addedAt: Date;
}

export interface CartDoc<Id = string> {
  id: Id;
  userId: Id;
  status: 'open' | 'checking_out' | 'closed';
  items: Array<CartItem<Id>>;
  updatedAt: Date;
}

export type OrderStatus =
  | 'pending'
  | 'quoting'
  | 'awaiting_auth'
  | 'placing'
  | 'placed'
  | 'uncertain'
  | 'failed'
  | 'cancelled';

export interface Quote {
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  currency: string;
  generatedAt: Date;
  expiresAt: Date;
  /** Hash the client must echo back on authorize. */
  hash: string;
}

export interface OrderDoc<Id = string> {
  id: Id;
  userId: Id;
  cartId: Id;
  merchantDomain: string;
  items: Array<{
    productId: Id;
    title: string;
    quantity: number;
    unitPrice: number;
    variant: Record<string, string>;
  }>;
  quote: Quote | null;
  coupon: { code: string; discount: number; attempts: number } | null;
  authorization: {
    authorizedAt: Date;
    userAgentHash: string;
    quoteHash: string;
  } | null;
  payment: {
    rail: 'reap';
    intentId: string;
    tokenRef: string;
    cap: number;
    protocol: 'acp' | 'mpp' | 'tap' | 'browser';
  } | null;
  agentRun: {
    jobId: string;
    startedAt: Date;
    endedAt: Date | null;
    toolCallCount: number;
    screenshots: string[];
    transcriptRef: string;
  } | null;
  status: OrderStatus;
  merchantOrderNumber: string | null;
  failure: { code: string; message: string; recoverable: boolean } | null;
  /** Set once, ever. Guards the single-submission invariant. */
  submissionSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A user's linked account at one merchant.
 *
 * Guest checkout is always preferred, so this exists only for merchants that
 * require an account. The session is encrypted at rest with a per-user key and
 * is never placed in a model context — the agent receives an opaque handle.
 */
export interface MerchantLinkRecord<Id = string> {
  id: Id;
  userId: Id;
  merchantDomain: string;
  status: 'pending' | 'linked' | 'expired' | 'revoked';
  encryptedSession: { ciphertext: string; iv: string; keyVersion: number } | null;
  createdAt: Date;
  linkedAt: Date | null;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// coupons and sources
// ---------------------------------------------------------------------------

export interface CouponDoc<Id = string> {
  id: Id;
  merchantDomain: string;
  code: string;
  discovered: {
    from: 'aggregator' | 'affiliate' | 'onsite';
    url: string;
    at: Date;
  };
  constraints: {
    minSpend: number | null;
    categories: string[];
    firstOrderOnly: boolean;
    expiresAt: Date | null;
  };
  performance: {
    attempts: number;
    successes: number;
    successRate: number;
    meanDiscountPct: number;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
  };
  stackable: boolean;
  status: 'active' | 'retired';
}

export interface SourceDoc<Id = string> {
  /** The domain is the id. */
  id: string;
  displayName: string;
  tier: SourceTier;
  sourceType: SourceType;
  crawlPolicy: {
    rps: number;
    concurrency: number;
    allowedHours: [number, number];
    proxyPool: string;
    backoff: 'exponential' | 'linear';
  };
  stalenessCeilingHours: number;
  extractors: { listing: string; detail: string };
  health: {
    errorRate: number;
    circuitOpen: boolean;
    circuitOpenedAt: Date | null;
    lastSuccessAt: Date | null;
    /** Rolling 15-minute window used by the circuit breaker. */
    window: Array<{ at: Date; ok: boolean }>;
  };
  checkout: {
    supported: boolean;
    guestCheckout: boolean;
    blocksAgents: boolean;
    /** Agentic protocol the merchant speaks, if any. */
    protocol: 'acp' | 'mpp' | 'tap' | null;
    stackableCoupons: boolean;
  };
  status: 'active' | 'degraded' | 'blocked';
  __idBrand?: Id;
}

// ---------------------------------------------------------------------------
// Render-ready projections
// ---------------------------------------------------------------------------

/** Trust badges rendered in the metadata bar. */
export interface CardBadges {
  source: SourceType;
  condition: Condition | null;
  /** "below" | "above" only when the spread exceeds 15%. */
  priceContext: 'below' | 'above' | null;
  /** True for single-unit listings. */
  onlyOne: boolean;
  /** Auction end, ISO string. */
  endsAt: string | null;
  /** Plain-language risk flag, or null. */
  riskFlag: string | null;
  /** Top-decile quality. */
  wellReviewed: boolean;
  /** Plain-language quality caution, e.g. "Reviewers commonly report sizing runs small." */
  caution: string | null;
}

/**
 * The flat, render-ready feed projection. Deliberately excludes the embedding,
 * the full spec list and review bodies.
 */
export interface ProductCard {
  productId: string;
  clusterId: string | null;
  title: string;
  brand: string | null;
  price: Money;
  originalPrice: Money | null;
  shipping: { amount: number; currency: string; free: boolean };
  merchant: { domain: string; displayName: string };
  seller: {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    type: SellerDoc['type'];
    rating: number | null;
  };
  category: CategoryRef;
  badges: CardBadges;
  media: {
    hero: MediaImage;
    galleryCount: number;
    /** Full gallery is only sent in Single mode. */
    gallery: MediaImage[];
    video: MediaVideo | null;
  };
  reviews: { count: number; meanRating: number | null };
  upvotes: number;
  /** Cluster offer affordance: "4 other sellers, from $X". */
  otherOffers: { count: number; fromAmount: number; currency: string } | null;
  auction: { endsAt: string; currentBid: number; bidCount: number } | null;
  /** Auction items cannot be added to cart. */
  canAddToCart: boolean;
  /** High-risk listings are reachable by direct link with a full-card warning. */
  warning: string | null;
  isExploration: boolean;
  explorationTopic: string | null;
}
