import type { Condition, ProductIdentifiers, SourceTier, SourceType } from '@window/shared';

/**
 * The contract every source adapter produces, regardless of tier.
 *
 * It is deliberately close to the source's own shape: raw strings, whatever
 * identifiers the page exposed, prices as they were written. Normalization is a
 * separate stage so that a parsing change and a normalization change are never
 * the same commit, and so a badly behaved source can be diagnosed from what it
 * actually returned rather than from what survived cleanup.
 */
export interface RawListing {
  sourceDomain: string;
  /** The source's own id for this listing. Unique within the domain. */
  sourceId: string;
  url: string;
  tier: SourceTier;
  sourceType: SourceType;

  title: string;
  description: string | null;
  brand: string | null;
  identifiers: ProductIdentifiers;

  /** As written by the source: "$129.99", "129,99 EUR", or already in minor units. */
  priceText: string | null;
  priceAmountMinor: number | null;
  currency: string | null;
  originalPriceText: string | null;
  originalPriceAmountMinor: number | null;

  shippingText: string | null;
  shippingAmountMinor: number | null;

  /** The source's own condition wording, mapped later onto the 8-point scale. */
  conditionText: string | null;
  availabilityText: string | null;
  quantity: number | null;

  auction: { endsAt: Date; currentBidMinor: number; bidCount: number } | null;

  /** Free-form key/value pairs as scraped; units are normalized downstream. */
  specs: Array<{ key: string; value: string }>;

  images: Array<{ url: string; width: number; height: number }>;
  video: { url: string; durationMs: number } | null;

  seller: RawSeller | null;

  /** Category breadcrumb from the source, used as a classification hint. */
  breadcrumb: string[];

  /** Reviews exposed on the listing page itself. */
  reviews: RawReview[];

  fetchedAt: Date;
  /** Extraction completeness in [0,1], reported per-source on the crawl dashboard. */
  extractionCompleteness: number;
}

export interface RawSeller {
  sourceSellerId: string;
  handle: string;
  displayName: string;
  type: 'retailer' | 'individual' | 'auction_house';
  avatarUrl: string | null;
  profileUrl: string;
  rating: number | null;
  ratingScale: number;
  reviewCount: number;
  salesCount: number;
  memberSince: Date | null;
  responseTime: string | null;
  returnWindowDays: number | null;
  shippingSummary: string | null;
  buyerPremiumPct: number | null;
  listingCount: number;
}

export interface RawReview {
  rating: number;
  ratingScale: number;
  text: string;
  authorHandle: string | null;
  verifiedPurchase: boolean | null;
  helpfulCount: number;
  postedAt: Date;
  sourceUrl: string;
}

/** What a discovery crawl returns: enough to decide whether to fetch detail. */
export interface DiscoveredListing {
  sourceDomain: string;
  sourceId: string;
  url: string;
  /** Present when the listing page exposed it; lets refresh skip unchanged items. */
  priceHint: number | null;
  seenAt: Date;
}

export interface CrawlContext {
  /** Honours the source's `crawlPolicy`: rate, concurrency, allowed hours. */
  rps: number;
  concurrency: number;
  proxyPool: string;
  /** Aborts the fetch when the circuit breaker opens mid-crawl. */
  signal?: AbortSignal;
}

/**
 * A source adapter. The three tiers differ only in how `fetchDetail` gets the
 * bytes; everything downstream is identical, which is what makes tier fallback
 * a configuration change rather than a rewrite.
 */
export interface SourceAdapter {
  readonly tier: SourceTier;
  readonly domain: string;
  /** Finds new listings. Frequency is set per source by observed new-listing rate. */
  discover(context: CrawlContext, cursor?: string): Promise<{
    listings: DiscoveredListing[];
    nextCursor: string | null;
  }>;
  /** Full extraction for one listing. */
  fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null>;
  /**
   * Cheap price-and-stock re-verification. Used by refresh crawls and by the
   * just-in-time check on cart add and immediately before checkout.
   */
  verify(listing: { sourceId: string; url: string }, context: CrawlContext): Promise<{
    inStock: boolean;
    priceAmountMinor: number | null;
    currency: string | null;
    quantity: number | null;
    removed: boolean;
  } | null>;
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly domain: string,
    readonly reason: 'circuit_open' | 'blocked' | 'not_configured' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** Condition wording seen across sources, mapped to the 8-point ordinal scale. */
export const CONDITION_SYNONYMS: Record<string, Condition> = {
  new: 'new',
  'brand new': 'new',
  'new with tags': 'new',
  nwt: 'new',
  'new without tags': 'like_new',
  nwot: 'like_new',
  'open box': 'like_new',
  'like new': 'like_new',
  mint: 'like_new',
  'as new': 'like_new',
  excellent: 'excellent',
  'excellent condition': 'excellent',
  'very good': 'excellent',
  refurbished: 'excellent',
  'certified refurbished': 'excellent',
  good: 'good',
  'good condition': 'good',
  used: 'good',
  'pre-owned': 'good',
  preowned: 'good',
  'gently used': 'good',
  fair: 'fair',
  acceptable: 'fair',
  worn: 'fair',
  poor: 'poor',
  'heavily used': 'poor',
  damaged: 'poor',
  'for parts': 'for_parts',
  'for parts or not working': 'for_parts',
  'not working': 'for_parts',
  salvage: 'for_parts',
};
