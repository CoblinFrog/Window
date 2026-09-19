/**
 * Tier 1: an official API or affiliate product feed.
 *
 * Near-zero cost per listing, no terms-of-service exposure, and the merchant's
 * own field values — so every source that has a partner programme is registered
 * at this tier and the other two exist to cover the ones that do not.
 *
 * Every affiliate feed is a different JSON document with the same handful of
 * facts in it, so this adapter is a mapper rather than a per-partner client:
 * the source config names the feed URL, where the item array lives, and which
 * dotted path holds each canonical field. Onboarding a new partner is then a
 * registry edit, which is the difference between a source taking an afternoon
 * and a source taking a release.
 */

import type { ProductIdentifiers, SourceDoc, SourceTier } from '@window/shared';
import { logger } from '../../lib/logger.js';
import {
  SourceUnavailableError,
  type CrawlContext,
  type DiscoveredListing,
  type RawListing,
  type RawReview,
  type RawSeller,
  type SourceAdapter,
} from '../types.js';
import {
  CRAWLER_USER_AGENT,
  extractionCompleteness,
  emptyParsed,
  isInStock,
  normalizeSchemaEnum,
  parsePriceToMinor,
  resolveUrl,
  type FetchLike,
  type Json,
  type ParsedProduct,
} from './tier2-structured.js';

const log = logger.child('ingestion.tier1');

// ---------------------------------------------------------------------------
// Dotted-path access
// ---------------------------------------------------------------------------

/**
 * Reads `a.b.0.c` out of a parsed feed item, with `*` mapping over an array
 * (`images.*.url`). Feeds nest deeply and inconsistently; a path expression in
 * config is what keeps that variance out of this file.
 */
export function getPath(root: unknown, path: string): unknown {
  if (path === '') return undefined;
  let current: unknown = root;
  const segments = path.split('.');

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || current === null || current === undefined) return undefined;

    if (segment === '*') {
      if (!Array.isArray(current)) return undefined;
      const rest = segments.slice(i + 1).join('.');
      if (rest === '') return current;
      return current
        .map((entry) => getPath(entry, rest))
        .filter((value) => value !== undefined && value !== null);
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * A path of the form `=USD` is a literal rather than a lookup. Feeds carry
 * facts that are constant per partner but absent from every row — the rating
 * scale a percentage feedback score is out of, for instance — and the
 * alternative is either a hardcoded per-source branch or a wrong default.
 */
function literalOf(path: string): string | null {
  return path.startsWith('=') ? path.slice(1) : null;
}

function pathString(root: unknown, path: string | undefined): string | null {
  if (path === undefined) return null;
  const literal = literalOf(path);
  if (literal !== null) return literal === '' ? null : literal;
  const value = getPath(root, path);
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' || typeof v === 'number');
    return first === undefined ? null : String(first);
  }
  return null;
}

function pathNumber(root: unknown, path: string | undefined): number | null {
  if (path === undefined) return null;
  const literal = literalOf(path);
  const value = literal !== null ? literal : getPath(root, path);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[^\d.\-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pathStringList(root: unknown, path: string | undefined): string[] {
  if (path === undefined) return [];
  const value = getPath(root, path);
  const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'number' ? String(entry) : null))
    .filter((entry): entry is string => entry !== null && entry.trim() !== '');
}

// ---------------------------------------------------------------------------
// Feed configuration
// ---------------------------------------------------------------------------

/** Canonical fields a feed can be mapped onto. Anything absent stays null. */
export interface Tier1FieldMapping {
  sourceId?: string;
  url?: string;
  title?: string;
  description?: string;
  brand?: string;
  priceAmount?: string;
  /** Use when the feed already publishes minor units, which several do. */
  priceAmountMinor?: string;
  currency?: string;
  originalPriceAmount?: string;
  shippingAmount?: string;
  conditionText?: string;
  availabilityText?: string;
  /** Truthy/falsy stock flag, used when the feed has no availability string. */
  inStock?: string;
  quantity?: string;
  images?: string;
  imageWidth?: string;
  imageHeight?: string;
  videoUrl?: string;
  videoDurationMs?: string;
  gtin?: string;
  upc?: string;
  ean?: string;
  asin?: string;
  mpn?: string;
  isbn?: string;
  breadcrumb?: string;
  specKeys?: string;
  specValues?: string;
  sellerId?: string;
  sellerHandle?: string;
  sellerName?: string;
  sellerUrl?: string;
  sellerAvatarUrl?: string;
  sellerRating?: string;
  sellerRatingScale?: string;
  sellerReviewCount?: string;
  sellerSalesCount?: string;
  sellerMemberSince?: string;
  sellerResponseTime?: string;
  sellerReturnWindowDays?: string;
  sellerShippingSummary?: string;
  sellerBuyerPremiumPct?: string;
  auctionEndsAt?: string;
  auctionCurrentBid?: string;
  auctionBidCount?: string;
  ratingValue?: string;
  ratingScale?: string;
  reviewCount?: string;
}

export interface Tier1FeedConfig {
  /** Feed or API endpoint. Query parameters already in it are preserved. */
  url: string;
  /** Dotted path to the array of items inside the response. */
  itemsPath: string;
  /**
   * Credentials are never written into the registry. The config names an
   * environment variable and the adapter refuses to run when it is unset, so a
   * missing key is a loud startup failure rather than a silent empty crawl.
   */
  authHeader?: { name: string; envVar: string; prefix?: string };
  /** Cursor pagination: the request parameter, and where the next value lives. */
  cursor?: { param: string; path?: string; startAt?: string };
  /** Page-number pagination, for feeds with no cursor. */
  page?: { param: string; startAt: number; sizeParam?: string; size?: number };
  /** Per-item detail endpoint; `{sourceId}` is substituted. */
  itemUrl?: string;
  /** Path to the item inside a detail response, when it is wrapped. */
  itemPath?: string;
  /** Product page URL template, when the feed publishes only an id. */
  urlTemplate?: string;
  sellerType?: RawSeller['type'];
  mapping: Tier1FieldMapping;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseTier1Config(spec: string, domain: string): Tier1FeedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(spec) as Json;
  } catch {
    throw new SourceUnavailableError(
      domain,
      'not_configured',
      `tier-1 config must be JSON, got ${JSON.stringify(spec.slice(0, 80))}`,
    );
  }
  const record = asRecord(raw);
  if (!record) {
    throw new SourceUnavailableError(domain, 'not_configured', 'tier-1 config must be a JSON object');
  }
  const url = record['url'];
  const itemsPath = record['itemsPath'];
  const mapping = asRecord(record['mapping']);
  if (typeof url !== 'string' || typeof itemsPath !== 'string' || mapping === null) {
    throw new SourceUnavailableError(
      domain,
      'not_configured',
      'tier-1 config needs { url, itemsPath, mapping } at minimum',
    );
  }
  // The cast is over a validated shape: every consumer below re-checks the
  // individual field it reads, and an unmapped field simply stays null.
  return record as unknown as Tier1FeedConfig;
}

// ---------------------------------------------------------------------------
// Item mapping
// ---------------------------------------------------------------------------

function mapImages(item: unknown, mapping: Tier1FieldMapping, base: string): ParsedProduct['images'] {
  const width = pathNumber(item, mapping.imageWidth) ?? 0;
  const height = pathNumber(item, mapping.imageHeight) ?? 0;
  const images: ParsedProduct['images'] = [];
  for (const raw of pathStringList(item, mapping.images)) {
    const url = resolveUrl(raw, base);
    if (url === null || images.some((image) => image.url === url)) continue;
    images.push({ url, width, height });
  }
  return images;
}

function mapSeller(item: unknown, config: Tier1FeedConfig, listingUrl: string): RawSeller | null {
  const mapping = config.mapping;
  const name = pathString(item, mapping.sellerName) ?? pathString(item, mapping.sellerHandle);
  if (name === null) return null;
  const handle = pathString(item, mapping.sellerHandle) ?? name;
  return {
    sourceSellerId: pathString(item, mapping.sellerId) ?? handle,
    handle,
    displayName: name,
    type: config.sellerType ?? 'retailer',
    avatarUrl: resolveUrl(pathString(item, mapping.sellerAvatarUrl), listingUrl),
    profileUrl: resolveUrl(pathString(item, mapping.sellerUrl), listingUrl) ?? listingUrl,
    rating: pathNumber(item, mapping.sellerRating),
    ratingScale: pathNumber(item, mapping.sellerRatingScale) ?? 5,
    reviewCount: pathNumber(item, mapping.sellerReviewCount) ?? 0,
    salesCount: pathNumber(item, mapping.sellerSalesCount) ?? 0,
    memberSince: toDate(pathString(item, mapping.sellerMemberSince)),
    responseTime: pathString(item, mapping.sellerResponseTime),
    returnWindowDays: pathNumber(item, mapping.sellerReturnWindowDays),
    shippingSummary: pathString(item, mapping.sellerShippingSummary),
    buyerPremiumPct: pathNumber(item, mapping.sellerBuyerPremiumPct),
    listingCount: 0,
  };
}

function toDate(raw: string | null): Date | null {
  if (raw === null) return null;
  const numeric = Number(raw);
  // Feeds publish epoch seconds and epoch milliseconds about equally often.
  const at = Number.isFinite(numeric) && raw.trim() !== '' && /^\d+$/.test(raw.trim())
    ? new Date(numeric > 1e11 ? numeric : numeric * 1000)
    : new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function truthy(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'in_stock', 'instock', 'available'].includes(token)) return true;
    if (['false', 'no', 'n', '0', 'out_of_stock', 'outofstock', 'sold', 'unavailable'].includes(token)) return false;
  }
  return null;
}

/** Maps one feed item onto the same intermediate shape the tier-2 parsers produce. */
export function mapFeedItem(item: unknown, config: Tier1FeedConfig, sourceUrl: string): ParsedProduct {
  const mapping = config.mapping;
  const out = emptyParsed('merged');
  const sourceId = pathString(item, mapping.sourceId);
  const listingUrl = resolveUrl(pathString(item, mapping.url), sourceUrl)
    ?? (config.urlTemplate !== undefined && sourceId !== null
      ? config.urlTemplate.replace('{sourceId}', encodeURIComponent(sourceId))
      : null);

  out.sku = sourceId;
  out.canonicalUrl = listingUrl;
  out.title = pathString(item, mapping.title);
  out.description = pathString(item, mapping.description);
  out.brand = pathString(item, mapping.brand);

  const currency = pathString(item, mapping.currency);
  out.currency = currency;
  const minorDirect = pathNumber(item, mapping.priceAmountMinor);
  if (minorDirect !== null) {
    out.priceAmountMinor = Math.round(minorDirect);
    out.priceText = pathString(item, mapping.priceAmountMinor);
  } else {
    const priceText = pathString(item, mapping.priceAmount);
    const price = parsePriceToMinor(priceText, currency);
    if (price !== null) {
      out.priceAmountMinor = price.minor;
      out.priceText = priceText;
      out.currency ??= price.currency;
    }
  }
  const originalText = pathString(item, mapping.originalPriceAmount);
  const original = parsePriceToMinor(originalText, out.currency);
  if (original !== null && original.minor !== out.priceAmountMinor) {
    out.originalPriceAmountMinor = original.minor;
    out.originalPriceText = originalText;
  }
  const shippingText = pathString(item, mapping.shippingAmount);
  const shipping = parsePriceToMinor(shippingText, out.currency);
  if (shipping !== null) {
    out.shippingAmountMinor = shipping.minor;
    out.shippingText = shippingText;
  }

  out.conditionText = pathString(item, mapping.conditionText);
  const availability = normalizeSchemaEnum(pathString(item, mapping.availabilityText));
  if (availability !== null) {
    out.availabilityText = availability;
  } else if (mapping.inStock !== undefined) {
    const flag = truthy(getPath(item, mapping.inStock));
    if (flag !== null) out.availabilityText = flag ? 'InStock' : 'OutOfStock';
  }
  out.quantity = pathNumber(item, mapping.quantity);

  out.identifiers = {} as ProductIdentifiers;
  for (const key of ['gtin', 'upc', 'ean', 'asin', 'mpn', 'isbn'] as const) {
    const value = pathString(item, mapping[key]);
    if (value !== null) out.identifiers[key] = value;
  }

  out.images = mapImages(item, mapping, listingUrl ?? sourceUrl);
  const videoUrl = resolveUrl(pathString(item, mapping.videoUrl), listingUrl ?? sourceUrl);
  if (videoUrl !== null) {
    out.video = { url: videoUrl, durationMs: pathNumber(item, mapping.videoDurationMs) ?? 0 };
  }

  out.breadcrumb = pathStringList(item, mapping.breadcrumb);
  const specKeys = pathStringList(item, mapping.specKeys);
  const specValues = pathStringList(item, mapping.specValues);
  for (let i = 0; i < Math.min(specKeys.length, specValues.length); i++) {
    const key = specKeys[i];
    const value = specValues[i];
    if (key !== undefined && value !== undefined) out.specs.push({ key, value });
  }

  out.seller = mapSeller(item, config, listingUrl ?? sourceUrl);

  const endsAt = toDate(pathString(item, mapping.auctionEndsAt));
  const bid = parsePriceToMinor(pathString(item, mapping.auctionCurrentBid), out.currency);
  if (endsAt !== null && bid !== null) {
    out.auction = { endsAt, currentBidMinor: bid.minor, bidCount: pathNumber(item, mapping.auctionBidCount) ?? 0 };
  }

  const ratingValue = pathNumber(item, mapping.ratingValue);
  if (ratingValue !== null) {
    out.aggregateRating = {
      value: ratingValue,
      scale: pathNumber(item, mapping.ratingScale) ?? 5,
      count: pathNumber(item, mapping.reviewCount) ?? 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface Tier1Deps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Credential lookup; overridable so tests never touch the real environment. */
  secret?: (name: string) => string | undefined;
}

/** Bounds the discover-to-fetchDetail handoff cache; feeds page in the low hundreds. */
const ITEM_CACHE_LIMIT = 2000;

export class Tier1AffiliateAdapter implements SourceAdapter {
  readonly tier: SourceTier = 1;
  readonly domain: string;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly secret: (name: string) => string | undefined;
  /**
   * A feed page already contains the full item, so re-fetching it for detail
   * would double the request count for no new data. Discovery parks what it saw
   * here and `fetchDetail` drains it.
   */
  private readonly itemCache = new Map<string, unknown>();

  constructor(private readonly source: SourceDoc<string>, deps: Tier1Deps = {}) {
    this.domain = source._id;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.secret = deps.secret ?? ((name) => process.env[name]);
  }

  private config(): Tier1FeedConfig {
    return parseTier1Config(this.source.extractors.listing, this.domain);
  }

  private headers(config: Tier1FeedConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': CRAWLER_USER_AGENT,
      accept: 'application/json',
    };
    const auth = config.authHeader;
    if (auth !== undefined) {
      const value = this.secret(auth.envVar);
      if (value === undefined || value === '') {
        throw new SourceUnavailableError(
          this.domain,
          'not_configured',
          `${this.domain} tier-1 feed needs credentials in ${auth.envVar}; set it or move the source to tier 2`,
        );
      }
      headers[auth.name.toLowerCase()] = `${auth.prefix ?? ''}${value}`;
    }
    return headers;
  }

  private async fetchJson(url: string, config: Tier1FeedConfig, context: CrawlContext): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: this.headers(config),
        redirect: 'follow',
        signal: context.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SourceUnavailableError(this.domain, 'network', `feed fetch failed for ${url}: ${message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SourceUnavailableError(
        this.domain,
        'blocked',
        `feed ${url} returned ${response.status}; the partner credential is rejected or the programme is suspended`,
      );
    }
    if (response.status === 429) {
      throw new SourceUnavailableError(this.domain, 'blocked', `feed ${url} rate-limited us (429)`);
    }
    if (response.status === 404 || response.status === 410) {
      return null;
    }
    if (response.status >= 400) {
      throw new SourceUnavailableError(this.domain, 'network', `feed ${url} returned ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `feed ${url} did not return JSON; the endpoint or the partner contract has changed`,
      );
    }
  }

  private remember(sourceId: string, item: unknown): void {
    if (this.itemCache.size >= ITEM_CACHE_LIMIT) {
      const oldest = this.itemCache.keys().next();
      if (!oldest.done) this.itemCache.delete(oldest.value);
    }
    this.itemCache.set(sourceId, item);
  }

  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const config = this.config();
    const url = new URL(config.url);
    if (config.cursor !== undefined) {
      const value = cursor ?? config.cursor.startAt;
      if (value !== undefined && value !== '') url.searchParams.set(config.cursor.param, value);
    } else if (config.page !== undefined) {
      const page = cursor === undefined ? config.page.startAt : Number.parseInt(cursor, 10) || config.page.startAt;
      url.searchParams.set(config.page.param, String(page));
      if (config.page.sizeParam !== undefined && config.page.size !== undefined) {
        url.searchParams.set(config.page.sizeParam, String(config.page.size));
      }
    }

    const body = await this.fetchJson(url.toString(), config, context);
    const items = getPath(body, config.itemsPath);
    if (!Array.isArray(items)) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `itemsPath ${JSON.stringify(config.itemsPath)} did not resolve to an array in the ${this.domain} feed`,
      );
    }

    const seenAt = this.now();
    const listings: DiscoveredListing[] = [];
    for (const item of items) {
      const parsed = mapFeedItem(item, config, url.toString());
      const sourceId = parsed.sku;
      const listingUrl = parsed.canonicalUrl;
      if (sourceId === null || listingUrl === null) {
        // A feed row with no id or no URL cannot be refreshed or linked out to,
        // so it is dropped here rather than failing the quality gate later.
        log.debug('feed item missing id or url', { domain: this.domain });
        continue;
      }
      this.remember(sourceId, item);
      listings.push({
        sourceDomain: this.domain,
        sourceId,
        url: listingUrl,
        priceHint: parsed.priceAmountMinor,
        seenAt,
      });
    }

    let nextCursor: string | null = null;
    if (config.cursor?.path !== undefined) {
      const next = getPath(body, config.cursor.path);
      nextCursor = typeof next === 'string' && next !== '' ? next : typeof next === 'number' ? String(next) : null;
    } else if (config.page !== undefined && items.length > 0) {
      const page = cursor === undefined ? config.page.startAt : Number.parseInt(cursor, 10) || config.page.startAt;
      nextCursor = String(page + 1);
    }
    return { listings, nextCursor };
  }

  private async fetchItem(sourceId: string, config: Tier1FeedConfig, context: CrawlContext): Promise<unknown> {
    const cached = this.itemCache.get(sourceId);
    if (cached !== undefined) return cached;
    if (config.itemUrl === undefined) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `${this.domain} has no itemUrl template, so listing ${sourceId} can only be read from a discovery page; `
          + 'add extractors.listing.itemUrl to support detail and just-in-time verification',
      );
    }
    const url = config.itemUrl.replace('{sourceId}', encodeURIComponent(sourceId));
    const body = await this.fetchJson(url, config, context);
    if (body === null) return null;
    const item = config.itemPath === undefined ? body : getPath(body, config.itemPath);
    return Array.isArray(item) ? item[0] : item;
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    const config = this.config();
    const item = await this.fetchItem(listing.sourceId, config, context);
    if (item === null || item === undefined) return null;

    const parsed = mapFeedItem(item, config, listing.url);
    if (parsed.title === null) {
      log.debug('feed item has no title under the configured mapping', {
        domain: this.domain,
        sourceId: listing.sourceId,
      });
      return null;
    }

    // Feed reviews, where a partner exposes them, arrive as a separate endpoint
    // in every programme we have read; the review job fetches those, not this.
    const reviews: RawReview[] = [];
    return {
      sourceDomain: this.domain,
      sourceId: listing.sourceId,
      url: parsed.canonicalUrl ?? listing.url,
      tier: this.tier,
      sourceType: this.source.sourceType,
      title: parsed.title,
      description: parsed.description,
      brand: parsed.brand,
      identifiers: parsed.identifiers,
      priceText: parsed.priceText,
      priceAmountMinor: parsed.priceAmountMinor,
      currency: parsed.currency,
      originalPriceText: parsed.originalPriceText,
      originalPriceAmountMinor: parsed.originalPriceAmountMinor,
      shippingText: parsed.shippingText,
      shippingAmountMinor: parsed.shippingAmountMinor,
      conditionText: parsed.conditionText,
      availabilityText: parsed.availabilityText,
      quantity: parsed.quantity,
      auction: parsed.auction,
      specs: parsed.specs,
      images: parsed.images,
      video: parsed.video,
      seller: parsed.seller,
      breadcrumb: parsed.breadcrumb,
      reviews,
      fetchedAt: this.now(),
      extractionCompleteness: extractionCompleteness(parsed),
    };
  }

  async verify(
    listing: { sourceId: string; url: string },
    context: CrawlContext,
  ): Promise<{
    inStock: boolean;
    priceAmountMinor: number | null;
    currency: string | null;
    quantity: number | null;
    removed: boolean;
  } | null> {
    const config = this.config();
    // The cache answers discovery-time questions, but verification exists to
    // catch change, so it always goes back to the partner.
    this.itemCache.delete(listing.sourceId);
    const item = await this.fetchItem(listing.sourceId, config, context);
    if (item === null || item === undefined) {
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }
    const parsed = mapFeedItem(item, config, listing.url);
    return {
      // Partners drop sold-out rows from the feed entirely, so a row that is
      // still being served with no availability field is a purchasable row.
      inStock: parsed.availabilityText === null ? true : isInStock(parsed.availabilityText),
      priceAmountMinor: parsed.priceAmountMinor,
      currency: parsed.currency,
      quantity: parsed.quantity,
      removed: false,
    };
  }
}
