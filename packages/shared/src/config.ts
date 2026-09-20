/**
 * Ranking and interaction configuration.
 *
 * The PRD is explicit that these are configuration, not code: they live in a
 * config document, are hot-reloadable, and every served page records the
 * `version` it was ranked under so metrics can be attributed to it.
 */

import type { InteractionType, RiskTier } from './types.js';

// ---------------------------------------------------------------------------
// Interaction signal weights
// ---------------------------------------------------------------------------

/** Signal weight per event type. Negative polarity is encoded in the sign. */
export const SIGNAL_WEIGHTS: Record<InteractionType, number> = {
  impression: 0.0,
  dwell_short: 0.05,
  dwell_long: 0.35,
  skip_fast: -0.2,
  gallery_advance: 0.15,
  upvote: 0.6,
  upvote_removed: -0.6,
  reviews_open: 0.45,
  reviews_dwell: 0.25,
  seller_open: 0.3,
  share: 0.4,
  cart_add: 0.85,
  cart_remove: -0.3,
  purchase: 1.0,
  hide_product: -0.7,
  hide_brand: -0.9,
  mute_seller: -0.9,
};

/** Dwell classification thresholds, in milliseconds. */
export const DWELL_THRESHOLDS = {
  /** Under this is `skip_fast`. */
  skipFastMaxMs: 800,
  /** `dwell_short` spans [min, max). */
  shortMinMs: 1500,
  shortMaxMs: 4000,
  /** Over this is `dwell_long`. */
  longMinMs: 8000,
  /** `reviews_dwell` fires past this much time in the sheet. */
  reviewsDwellMs: 15000,
} as const;

/**
 * Two rules protect signal quality, per the interaction model:
 * a dwell only counts when foregrounded and the card fills at least this much
 * of the viewport, and skip negatives are suppressed for the opening cards.
 */
export const SIGNAL_QUALITY_RULES = {
  minViewportFraction: 0.6,
  requireForeground: true,
  suppressSkipForFirstNCards: 3,
} as const;

/** Events at or above this weight flush immediately and bust the buffer cache. */
export const STRONG_SIGNAL_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  /** w1 — cosine similarity, user vector to product vector. */
  sim: number;
  /** w2 — listing quality. */
  quality: number;
  /** w3 — global engagement rate, Bayesian-smoothed. */
  ctr: number;
  /** w4 — freshness. */
  freshness: number;
  /** w5 — brand and seller affinity. */
  affinity: number;
  /** w6 — penalties, subtracted. */
  penalty: number;
}

export interface RankingConfig {
  version: string;
  weights: ScoringWeights;
  retrieval: {
    numCandidates: number;
    limit: number;
    /** Narrower per-quad retrieval in Window mode. */
    quadNumCandidates: number;
    quadLimit: number;
  };
  filters: {
    /** Price prior band: [lo, hi] multipliers. */
    priceLowMultiplier: number;
    priceHighMultiplier: number;
    seenWindowDays: number;
  };
  diversification: {
    /** MMR lambda: relevance vs. novelty. */
    lambda: number;
    /** Guardrail: distinct L2 categories required per page. */
    minDistinctL2PerPage: number;
  };
  penalties: {
    /** Cosine above this against a recent card counts as a near-duplicate. */
    nearDuplicateSimilarity: number;
    nearDuplicate: number;
    sameBrandWithin: number;
    sameBrandPenalty: number;
    sameSellerWithin: number;
    sameSellerPenalty: number;
  };
  exploration: {
    counterMin: number;
    counterMax: number;
    /** A topic rejected this many times is suppressed. */
    rejectionStrikes: number;
    suppressionDays: number;
    /** Weight of co-occurrence lift vs. global quality when sampling a topic. */
    liftWeight: number;
    qualityWeight: number;
  };
  userVector: {
    /** EMA rate. */
    alpha: number;
    /** Per inactive day. */
    dailyDecay: number;
    /** Interest weights never fall below this. */
    decayFloor: number;
  };
  quads: {
    size: number;
    /** Four items must sit within this multiple of each other's price. */
    priceBandMultiplier: number;
  };
  cache: {
    bufferTtlMs: number;
    bufferSize: number;
  };
  /** Bayesian smoothing prior strength for CTR against the category mean. */
  ctrSmoothingPrior: number;
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  version: 'rc-2026-09-02',
  weights: {
    sim: 0.45,
    quality: 0.15,
    ctr: 0.15,
    freshness: 0.1,
    affinity: 0.1,
    penalty: 0.05,
  },
  retrieval: {
    numCandidates: 4000,
    limit: 400,
    quadNumCandidates: 600,
    quadLimit: 60,
  },
  filters: {
    priceLowMultiplier: 0.25,
    priceHighMultiplier: 4,
    seenWindowDays: 30,
  },
  diversification: {
    lambda: 0.7,
    minDistinctL2PerPage: 5,
  },
  penalties: {
    nearDuplicateSimilarity: 0.94,
    nearDuplicate: 1.0,
    sameBrandWithin: 5,
    sameBrandPenalty: 0.6,
    sameSellerWithin: 10,
    sameSellerPenalty: 0.4,
  },
  exploration: {
    counterMin: 10,
    counterMax: 20,
    rejectionStrikes: 2,
    suppressionDays: 30,
    liftWeight: 0.7,
    qualityWeight: 0.3,
  },
  userVector: {
    alpha: 0.08,
    dailyDecay: 0.97,
    decayFloor: 0.1,
  },
  quads: {
    size: 4,
    priceBandMultiplier: 2.5,
  },
  cache: {
    bufferTtlMs: 90_000,
    bufferSize: 60,
  },
  ctrSmoothingPrior: 200,
};

// ---------------------------------------------------------------------------
// Topic adoption
// ---------------------------------------------------------------------------

/**
 * An exploration topic graduates into the interest set when, inside a rolling
 * 3-session window, the user produces any of these. The granted weight is the
 * maximum of the triggers that fired, so a cart add always wins.
 */
export const TOPIC_ADOPTION = {
  sessionWindow: 3,
  triggers: {
    /** Dwell on the exploration card over 8 s. */
    dwell: { thresholdMs: 8000, weight: 0.15 },
    /** Any rail interaction: upvote, reviews, seller, share. */
    rail: { weight: 0.3 },
    /** Cart add. */
    cartAdd: { weight: 0.6 },
    /** Two separate exploration cards in the topic, both dwelled over 6 s. */
    repeatDwell: { thresholdMs: 6000, count: 2, weight: 0.4 },
  },
  /** Demoted if no positive signal accrues across this many impressions. */
  demotionImpressions: 40,
} as const;

/** Rail interactions that count toward the `rail` adoption trigger. */
export const RAIL_INTERACTION_TYPES: InteractionType[] = [
  'upvote',
  'reviews_open',
  'seller_open',
  'share',
];

// ---------------------------------------------------------------------------
// Cold start
// ---------------------------------------------------------------------------

/**
 * The first 20 cards are composed deliberately rather than purely by vector
 * score. Ranges are inclusive, 1-based, matching the PRD table.
 */
export const COLD_START_COMPOSITION = [
  { from: 1, to: 3, strategy: 'top_topic_crowd_pleasers' },
  { from: 4, to: 9, strategy: 'round_robin_selected_topics' },
  { from: 10, to: 12, strategy: 'l2_diversification' },
  { from: 13, to: 15, strategy: 'price_band_spread' },
  { from: 16, to: 20, strategy: 'pure_vector' },
] as const;

export type ColdStartStrategy = (typeof COLD_START_COMPOSITION)[number]['strategy'];

/** Composition rules apply only below this interaction count. */
export const COLD_START_INTERACTION_CEILING = 20;

/** Onboarding requires exactly this many topics; the button hard-caps there. */
export const ONBOARDING_TOPIC_COUNT = 3;

/** Price band to a soft price prior, in minor units. */
export const PRICE_BAND_CENTERS: Record<string, number> = {
  budget: 2500,
  mid: 8000,
  premium: 30000,
};

/** Confidence of the prior when stated vs. skipped. */
export const PRICE_PRIOR_CONFIDENCE = { stated: 0.4, skipped: 0.1 } as const;

/** Returning-user re-entry block. */
export const RETURNING_USER = {
  dormantDays: 14,
  blockSize: 5,
  fromStrongestInterest: 3,
  fromRisingTopics: 2,
} as const;

// ---------------------------------------------------------------------------
// Buffer and prefetch (client)
// ---------------------------------------------------------------------------

/**
 * The rolling catalog window.
 *
 * The stored catalog is kept small and fresh rather than large and stale: once
 * a session scrolls past `threshold`, the server fetches `add` new listings and
 * retires the `drop` oldest, so the catalog stays around `size`.
 */
export const CATALOG_WINDOW = {
  size: 48,
  /** Cursor index that triggers a rotation, counted from zero. */
  threshold: 10,
  add: 8,
  drop: 8,
  /**
   * Floor between two rotations from one client. Crossing the threshold, going
   * back and crossing it again must not start a second crawl.
   */
  cooldownMs: 60_000,
} as const;

export const BUFFER_CONFIG = {
  /** Rolling buffer of 40: 10 behind the cursor, 30 ahead. */
  size: 40,
  behind: 10,
  ahead: 30,
  /** A page request fires when fewer than this many remain ahead. */
  refillThreshold: 15,
  pageSize: 20,
  prefetch: {
    singleHeroImages: 12,
    windowPanes: 8,
    /** Video is prefetched for cursor+1 only, first 3 seconds. */
    videoLookahead: 1,
    videoPrefetchMs: 3000,
    videoEvictBeyond: 3,
  },
  /** Data saver cuts prefetch depth to 4 and drops video. */
  dataSaverPrefetchDepth: 4,
  /** Only the last N seen ids travel with a page request. */
  seenIdsInRequest: 200,
} as const;

// ---------------------------------------------------------------------------
// Quality and risk
// ---------------------------------------------------------------------------

/** Q = 0.40 R_adj + 0.20 C + 0.15 S + 0.15 L + 0.10 E */
export const QUALITY_WEIGHTS = {
  reviewAdj: 0.4,
  corpusDepth: 0.2,
  sentimentConsistency: 0.15,
  listingCompleteness: 0.15,
  engagement: 0.1,
} as const;

export const QUALITY_PARAMS = {
  /** Bayesian prior strength for the category rating mean. */
  ratingPriorCount: 25,
  /** Review count that saturates corpus depth. */
  corpusDepthSaturation: 400,
  multiSourceBonus: 0.1,
  singleSourcePenalty: 0.1,
  credibility: { min: 0.5, max: 1.0 },
  /** A theme over this negative share with this many mentions becomes a caution. */
  cautionNegativeShare: 0.6,
  cautionMinMentions: 30,
  /** Badge thresholds. */
  wellReviewedPercentile: 0.9,
  derankPercentile: 0.1,
} as const;

export const RISK_TIER_BOUNDS: Array<{ tier: RiskTier; min: number; max: number }> = [
  { tier: 'clear', min: 0, max: 0.2 },
  { tier: 'watch', min: 0.2, max: 0.45 },
  { tier: 'caution', min: 0.45, max: 0.7 },
  { tier: 'high', min: 0.7, max: 0.88 },
  { tier: 'blocked', min: 0.88, max: Infinity },
];

export function riskTierFor(score: number): RiskTier {
  for (const b of RISK_TIER_BOUNDS) {
    if (score >= b.min && score < b.max) return b.tier;
  }
  return 'blocked';
}

export const RISK_ENFORCEMENT = {
  /** Caution tier is ranked down by this factor. */
  cautionRankMultiplier: 0.6,
  /** Reports needed to auto-promote a listing to High pending review. */
  autoPromoteReports: 3,
  /** Upheld reports against a seller before every listing is suppressed. */
  sellerSuppressionUpheld: 2,
} as const;

/** Weights of the eight risk signal families in the v1 rule ensemble. */
export const RISK_FAMILY_WEIGHTS = {
  price_anomaly: 0.28,
  seller_history: 0.16,
  media_forensics: 0.14,
  text_signals: 0.12,
  listing_coherence: 0.12,
  counterfeit: 0.1,
  cross_listing: 0.05,
  network: 0.03,
} as const;

/** Brands where counterfeiting is common enough to warrant extra checks. */
export const COUNTERFEIT_WATCHLIST_CATEGORIES = [
  'sneakers',
  'watches',
  'fashion-men',
  'fashion-women',
  'tech',
] as const;

// ---------------------------------------------------------------------------
// Quality gate (ingestion)
// ---------------------------------------------------------------------------

export const QUALITY_GATE = {
  minImageShortEdge: 800,
  minTitleLength: 10,
  minClassificationConfidence: 0.4,
  /** Price under this share of the cluster median, from a new seller, is a scam heuristic. */
  scamPriceShareOfMedian: 0.15,
  /** A new seller account, in days. */
  newSellerAgeDays: 30,
  maxTitleLength: 120,
  maxGalleryImages: 8,
  maxVideoDurationMs: 15000,
} as const;

// ---------------------------------------------------------------------------
// Dedupe and clustering
// ---------------------------------------------------------------------------

export const CLUSTERING = {
  fuzzyCosineThreshold: 0.94,
  fuzzyPriceTolerance: 0.3,
  /** Price context badge appears when the spread exceeds this. */
  priceContextSpread: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const REVIEWS_CONFIG = {
  /** Cap at 200 stored reviews per cluster: 50 per bucket. */
  perBucketCap: 50,
  totalCap: 200,
  excerptMaxChars: 400,
  maxThemes: 5,
  /** The summary is regenerated on either of these. */
  regenerateOnCountGrowth: 0.2,
  regenerateOnRatingShift: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export const CHECKOUT_CONFIG = {
  quoteTtlMs: 10 * 60 * 1000,
  /** Per-job agent timeout. */
  jobTimeoutMs: 180_000,
  /** Cap on coupon attempts per job. */
  maxCouponAttempts: 8,
  /** A code failing this many consecutive times on a merchant is retired. */
  couponRetirementFailures: 3,
  /** Reap amount cap tolerance above the authorized quote. */
  amountCapTolerance: 0.02,
  /** Protocols the orchestrator tries before falling back to the browser. */
  protocolPriority: ['acp', 'mpp', 'tap'] as const,
  pollIntervalMs: 2000,
} as const;

// ---------------------------------------------------------------------------
// Sessions and credentials
// ---------------------------------------------------------------------------

/**
 * Session lifetimes.
 *
 * A token is a bearer credential: whoever holds it is the user. The only thing
 * that bounds the damage of a leaked one is how long it stays useful, so it
 * expires and the client silently re-derives a new one from the device secret
 * it holds in secure storage. Thirty days is long enough that an anonymous
 * browser never sees a sign-in prompt, and short enough that a token scraped
 * from a log last quarter is inert.
 */
export const SESSION_CONFIG = {
  tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** Tolerated clock difference when checking `iat`. */
  clockSkewMs: 2 * 60 * 1000,
  /** How long an emailed verification code is valid. */
  emailCodeTtlMs: 10 * 60 * 1000,
  /** Wrong codes accepted for one challenge before it is burned. */
  emailCodeMaxAttempts: 5,
  /**
   * SSE tickets. Short enough that a URL captured in an access log is already
   * dead by the time anyone reads it, long enough to survive a reconnect.
   */
  streamTicketTtlMs: 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// Rate limits, per principal
// ---------------------------------------------------------------------------

export const RATE_LIMITS = {
  feedPagesPerMinute: 120,
  eventBatchesPerMinute: 600,
  checkoutQuotesPerHour: 20,
  merchantLinksPerDay: 5,
  /**
   * Credential paths, limited per IP rather than per principal: there is no
   * principal yet when they are called, which is exactly why they are the ones
   * worth limiting hardest.
   */
  deviceBootstrapsPerHour: 30,
  claimAttemptsPerHour: 10,
  /**
   * Authorizations per hour. A user places a handful of orders; a script
   * grinding stolen quote hashes places thousands.
   */
  authorizationsPerHour: 30,
} as const;

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export const GUARDRAILS = {
  feedPageLatencyP95Ms: 400,
  deadListingRate: 0.03,
  priceAccuracyTolerance: 0.02,
  minDistinctL2PerSession: 5,
  unintendedPurchaseRate: 0.001,
} as const;

/** Source staleness ceilings by tier, in hours. */
export const TIER_STALENESS_CEILING_HOURS: Record<1 | 2 | 3, number> = {
  1: 6,
  2: 12,
  3: 24,
};

/** A source over this error rate in the rolling window is circuit-broken. */
export const CIRCUIT_BREAKER = {
  errorRateThreshold: 0.2,
  windowMs: 15 * 60 * 1000,
  /** Minimum samples before the breaker can trip. */
  minSamples: 10,
} as const;

/** Embedding dimensionality, fixed by the vector index definition. */
export const EMBEDDING_DIM = 1024;
/**
 * Bumped when anything that changes a vector changes — including the tokenizer.
 * Stemming altered every product vector, and a catalog holding both the old and
 * new encodings is one incoherent space, so the version is what makes the stale
 * rows identifiable and the re-embed a background job rather than a mystery.
 */
export const EMBEDDING_VERSION = 'mm-v3-stemmed';
