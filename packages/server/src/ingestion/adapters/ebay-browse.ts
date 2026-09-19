/**
 * eBay, at tier 1, through the official Browse API.
 *
 * eBay's robots.txt disallows `/itm/` and `/sch/`, and its user agreement
 * forbids automated collection from the site, so the site is not a source at
 * any tier — the API is. That is not a limitation worked around here; it is the
 * PRD's posture applied literally: "affiliate program, then partnership, then
 * API", and never a scraper pointed at a host that has said no. The Browse API
 * is also affiliate-eligible, which makes this the one path that is both
 * permitted and monetizable.
 *
 * The generic `Tier1AffiliateAdapter` cannot serve eBay because eBay is not a
 * feed: it is an OAuth2 client-credentials token endpoint, a search endpoint
 * with its own paging ceiling, and a detail endpoint whose item shape (auction
 * fields, localized aspects, per-marketplace pricing) has no dotted-path
 * mapping that stays honest. This adapter is therefore a real client, and it
 * reuses the tier-2 price and completeness helpers so that a listing from eBay
 * and a listing from a scraped page are scored on exactly the same axes.
 *
 * With no credentials configured every method throws
 * `SourceUnavailableError(domain, 'not_configured')`, the same posture as the
 * tier-3 adapter with no browser driver: a missing key must be a loud failure,
 * because the alternative — an empty array — looks identical to "eBay had
 * nothing today" on the crawl dashboard.
 */

import type { ProductIdentifiers, SourceTier, SourceType } from '@window/shared';
import { logger } from '../../lib/logger.js';
import {
  CONDITION_SYNONYMS,
  SourceUnavailableError,
  type CrawlContext,
  type DiscoveredListing,
  type RawListing,
  type RawSeller,
  type SourceAdapter,
} from '../types.js';
import {
  CRAWLER_USER_AGENT,
  emptyParsed,
  parsePriceToMinor,
  resolveUrl,
  toRawListing,
  type FetchLike,
  type ParsedProduct,
} from './tier2-structured.js';

const log = logger.child('ingestion.ebay');

const DEFAULT_API_BASE = 'https://api.ebay.com';
const TOKEN_PATH = '/identity/v1/oauth2/token';
const SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const ITEM_PATH = '/buy/browse/v1/item';
/** The only scope a client-credentials grant can hold; Browse needs nothing more. */
const API_SCOPE = 'https://api.ebay.com/oauth/api_scope';

/** eBay rejects `limit` above this and silently truncates nothing — it 400s. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;
/**
 * `offset + limit` may not exceed 10,000; eBay answers past it with an error,
 * not an empty page, so discovery has to stop itself rather than find out.
 */
const RESULT_CEILING = 10_000;

/** Refresh this far before expiry so an in-flight request never carries a dead token. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EbayBrowseOptions {
  clientId: string | null;
  clientSecret: string | null;
  /**
   * Discovery needs one of `query` or `categoryIds`: the Browse search endpoint
   * has no "everything" mode and rejects a request carrying neither.
   */
  query?: string | null;
  categoryIds?: string | null;
  /** eBay filter syntax, passed through verbatim, e.g. `buyingOptions:{AUCTION}`. */
  filter?: string | null;
  marketplaceId?: string;
  pageSize?: number;
  /** Affiliate campaign id; sent as end-user context so clicks are attributed. */
  campaignId?: string | null;
  /** Overridable for the sandbox host. */
  apiBase?: string;
  domain?: string;
}

export interface EbayBrowseDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Credential lookup; overridable so tests never touch the real environment. */
  secret?: (name: string) => string | undefined;
}

export const EBAY_ENV_VARS = {
  clientId: 'EBAY_CLIENT_ID',
  clientSecret: 'EBAY_CLIENT_SECRET',
  marketplaceId: 'EBAY_MARKETPLACE_ID',
  query: 'EBAY_SEARCH_QUERY',
  categoryIds: 'EBAY_CATEGORY_IDS',
  filter: 'EBAY_SEARCH_FILTER',
  campaignId: 'EBAY_CAMPAIGN_ID',
} as const;

// ---------------------------------------------------------------------------
// JSON access
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function rec(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(source: unknown, key: string): unknown {
  return rec(source)?.[key];
}

function parseDate(raw: unknown): Date | null {
  const text = str(raw);
  if (text === null) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** eBay money is always `{ value: "12.34", currency: "USD" }`. */
function money(node: unknown): { minor: number; currency: string | null; text: string } | null {
  const value = str(field(node, 'value'));
  if (value === null) return null;
  const currency = str(field(node, 'currency'));
  const parsed = parsePriceToMinor(value, currency);
  return parsed === null ? null : { minor: parsed.minor, currency: parsed.currency, text: value };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('crawl aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('crawl aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Item mapping
// ---------------------------------------------------------------------------

/**
 * Whether the item is second-hand, using the repo's own condition table rather
 * than a second list that would drift from it. eBay's numeric `conditionId` is
 * the fallback because the wording is localized per marketplace while the id is
 * not: anything at or above 2000 is refurbished or worse, 1000/1500 are new.
 */
export function isUsedCondition(conditionText: string | null, conditionId: string | null): boolean {
  const mapped = conditionText === null ? undefined : CONDITION_SYNONYMS[conditionText.trim().toLowerCase()];
  if (mapped !== undefined) return mapped !== 'new';
  const id = conditionId === null ? null : Number.parseInt(conditionId, 10);
  if (id !== null && Number.isFinite(id)) return id >= 2000;
  return false;
}

export function ebaySourceType(
  buyingOptions: string[],
  conditionText: string | null,
  conditionId: string | null,
): SourceType {
  if (buyingOptions.includes('AUCTION')) return 'auction';
  return isUsedCondition(conditionText, conditionId) ? 'secondhand' : 'new';
}

/**
 * eBay publishes availability as a SCREAMING_SNAKE enum, and the normalizer
 * matches on prose (`/in\s*stock/i`). Replacing the underscores is the whole
 * translation: no value is invented, and the enum survives verbatim in specs
 * for anyone auditing what eBay actually said.
 */
function availabilityText(status: string | null): string | null {
  return status === null ? null : status.replace(/_/g, ' ');
}

function sellerProfileUrl(listingUrl: string, username: string): string {
  // Derived from the listing's own origin so a non-US marketplace does not get
  // a www.ebay.com profile link stitched onto it.
  const base = resolveUrl(`/usr/${encodeURIComponent(username)}`, listingUrl);
  return base ?? listingUrl;
}

function mapSeller(item: JsonRecord, listingUrl: string): RawSeller | null {
  const seller = rec(item['seller']);
  if (seller === null) return null;
  const username = str(seller['username']);
  if (username === null) return null;

  // `feedbackPercentage` is a percentage string ("98.7"), not a five-star
  // rating, so the scale travels with it; scoring it out of 5 would rank every
  // eBay seller as perfect.
  const rating = num(seller['feedbackPercentage']);
  const accountType = str(seller['sellerAccountType']);
  const returnPeriod = rec(field(item['returnTerms'], 'returnPeriod'));
  const returnUnit = str(returnPeriod?.['unit']);
  const shippingOption = rec(arr(item['shippingOptions'])[0]);

  return {
    sourceSellerId: username,
    handle: username,
    displayName: username,
    type: accountType === 'BUSINESS' ? 'retailer' : 'individual',
    // Browse exposes no seller avatar; a placeholder would be a fabrication.
    avatarUrl: null,
    profileUrl: sellerProfileUrl(listingUrl, username),
    rating,
    ratingScale: 100,
    reviewCount: num(seller['feedbackScore']) ?? 0,
    salesCount: 0,
    memberSince: null,
    responseTime: null,
    returnWindowDays: returnUnit === 'DAY' ? num(returnPeriod?.['value']) : null,
    shippingSummary: str(shippingOption?.['type']),
    buyerPremiumPct: null,
    listingCount: 0,
  };
}

function mapIdentifiers(item: JsonRecord): ProductIdentifiers {
  const identifiers: ProductIdentifiers = {};
  const gtin = str(item['gtin']);
  if (gtin !== null) {
    identifiers.gtin = gtin;
    // GTIN-12 *is* a UPC and GTIN-13 *is* an EAN; splitting them out is a
    // restatement of the standard, not a guess, and clustering keys on both.
    const digits = gtin.replace(/\D/g, '');
    if (digits.length === 12) identifiers.upc = digits;
    if (digits.length === 13) identifiers.ean = digits;
  }
  const mpn = str(item['mpn']);
  if (mpn !== null) identifiers.mpn = mpn;
  return identifiers;
}

function mapImages(item: JsonRecord): ParsedProduct['images'] {
  const urls = [str(field(item['image'], 'imageUrl'))];
  for (const extra of arr(item['additionalImages'])) urls.push(str(field(extra, 'imageUrl')));

  const images: ParsedProduct['images'] = [];
  for (const url of urls) {
    if (url === null || images.some((image) => image.url === url)) continue;
    // Browse returns no dimensions. Zero is the honest answer and lets the
    // media gate measure the bytes; a plausible 1600x1600 would decide feed
    // eligibility on a number nobody measured.
    images.push({ url, width: 0, height: 0 });
  }
  return images;
}

function mapSpecs(item: JsonRecord): ParsedProduct['specs'] {
  const specs: ParsedProduct['specs'] = [];
  for (const aspect of arr(item['localizedAspects'])) {
    const key = str(field(aspect, 'name'));
    const value = str(field(aspect, 'value'));
    if (key !== null && value !== null) specs.push({ key, value });
  }
  // eBay's catalog product id has no slot in `ProductIdentifiers`, but it is the
  // strongest dedupe key eBay hands out, so it is preserved where it survives.
  const epid = str(item['epid']);
  if (epid !== null) specs.push({ key: 'epid', value: epid });
  const conditionId = str(item['conditionId']);
  if (conditionId !== null) specs.push({ key: 'conditionId', value: conditionId });
  const status = str(field(arr(item['estimatedAvailabilities'])[0], 'estimatedAvailabilityStatus'));
  if (status !== null) specs.push({ key: 'estimatedAvailabilityStatus', value: status });
  return specs;
}

function brandOf(item: JsonRecord): string | null {
  const direct = str(item['brand']);
  if (direct !== null) return direct;
  for (const aspect of arr(item['localizedAspects'])) {
    if (str(field(aspect, 'name'))?.toLowerCase() === 'brand') return str(field(aspect, 'value'));
  }
  return null;
}

/** Maps a Browse `Item` onto the shared intermediate shape. */
export function mapEbayItem(item: JsonRecord, fallbackUrl: string): ParsedProduct {
  const out = emptyParsed('merged');
  const listingUrl = str(item['itemWebUrl']) ?? fallbackUrl;

  out.sku = str(item['itemId']);
  out.canonicalUrl = listingUrl;
  out.title = str(item['title']);
  out.description = str(item['shortDescription']) ?? str(item['description']);
  out.brand = brandOf(item);
  out.identifiers = mapIdentifiers(item);

  const price = money(item['price']);
  if (price !== null) {
    out.priceAmountMinor = price.minor;
    out.priceText = price.text;
    out.currency = price.currency;
  }
  const originalPrice = money(field(item['marketingPrice'], 'originalPrice'));
  if (originalPrice !== null && originalPrice.minor !== out.priceAmountMinor) {
    out.originalPriceAmountMinor = originalPrice.minor;
    out.originalPriceText = originalPrice.text;
  }
  const shipping = money(field(arr(item['shippingOptions'])[0], 'shippingCost'));
  if (shipping !== null) {
    out.shippingAmountMinor = shipping.minor;
    out.shippingText = shipping.text;
  }

  out.conditionText = str(item['condition']);
  const availability = rec(arr(item['estimatedAvailabilities'])[0]);
  out.availabilityText = availabilityText(str(availability?.['estimatedAvailabilityStatus']));
  out.quantity = num(availability?.['estimatedAvailableQuantity']);

  out.images = mapImages(item);
  out.specs = mapSpecs(item);
  out.seller = mapSeller(item, listingUrl);

  // `categoryPath` is one pipe-delimited string, deepest segment last.
  const categoryPath = str(item['categoryPath']);
  out.breadcrumb = categoryPath === null
    ? []
    : categoryPath.split('|').map((segment) => segment.trim()).filter((segment) => segment !== '');

  const buyingOptions = arr(item['buyingOptions']).map((option) => str(option)).filter((o): o is string => o !== null);
  if (buyingOptions.includes('AUCTION')) {
    const endsAt = parseDate(item['itemEndDate']);
    const bid = money(item['currentBidPrice']);
    // An auction with no end date or no bid price is not an auction we can put
    // a countdown on, so it stays a fixed-price row rather than a half-filled one.
    if (endsAt !== null && bid !== null) {
      out.auction = { endsAt, currentBidMinor: bid.minor, bidCount: num(item['bidCount']) ?? 0 };
    }
  }

  const review = rec(item['primaryProductReviewRating']);
  const average = num(review?.['averageRating']);
  if (average !== null) {
    // Browse exposes an aggregate only, never review bodies. `reviews` stays
    // empty and the review job fetches the corpus from its own source.
    out.aggregateRating = { value: average, scale: 5, count: num(review?.['reviewCount']) ?? 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

export class EbayBrowseAdapter implements SourceAdapter {
  readonly tier: SourceTier = 1;
  readonly domain: string;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly apiBase: string;
  private readonly marketplaceId: string;
  private readonly pageSize: number;

  private token: CachedToken | null = null;
  /** Collapses a token stampede: many concurrent requests, one grant. */
  private tokenInFlight: Promise<string> | null = null;

  /** Requests are serialized through this chain so `rps` is a real ceiling. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAtMs = 0;

  constructor(private readonly options: EbayBrowseOptions, deps: EbayBrowseDeps = {}) {
    this.domain = options.domain ?? 'ebay.com';
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.marketplaceId = options.marketplaceId ?? 'EBAY_US';
    this.pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  }

  // -- credentials --------------------------------------------------------

  private credentials(): { clientId: string; clientSecret: string } {
    const clientId = trimmed(this.options.clientId);
    const clientSecret = trimmed(this.options.clientSecret);
    const missing: string[] = [];
    if (clientId === null) missing.push(EBAY_ENV_VARS.clientId);
    if (clientSecret === null) missing.push(EBAY_ENV_VARS.clientSecret);
    if (clientId === null || clientSecret === null) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `${this.domain} is reachable only through the eBay Browse API: set ${missing.join(' and ')} `
          + '(eBay developer application keys, production environment) and restart. '
          + "eBay's robots.txt disallows /itm/ and /sch/, so there is no lower tier for this source: "
          + 'without these keys it produces no listings at all.',
      );
    }
    return { clientId, clientSecret };
  }

  private async accessToken(context: CrawlContext): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAtMs > this.now().getTime() + TOKEN_REFRESH_SKEW_MS) return cached.value;
    if (this.tokenInFlight !== null) return this.tokenInFlight;

    const pending = this.requestToken(context).finally(() => {
      this.tokenInFlight = null;
    });
    this.tokenInFlight = pending;
    return pending;
  }

  private async requestToken(context: CrawlContext): Promise<string> {
    const { clientId, clientSecret } = this.credentials();
    const url = `${this.apiBase}${TOKEN_PATH}`;
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': CRAWLER_USER_AGENT,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: API_SCOPE }).toString(),
        signal: context.signal,
      });
    } catch (cause) {
      throw this.networkError(url, cause, context);
    }

    const text = await response.text();
    if (response.status === 400 || response.status === 401) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `eBay rejected the client-credentials grant (${response.status}): ${text.slice(0, 200)}. `
          + `Check ${EBAY_ENV_VARS.clientId} and ${EBAY_ENV_VARS.clientSecret} are the production keys `
          + 'for an application with the Browse API enabled.',
      );
    }
    if (response.status >= 400) {
      throw new SourceUnavailableError(this.domain, 'network', `eBay token endpoint returned ${response.status}`);
    }

    const body = rec(safeJson(text));
    const value = str(body?.['access_token']);
    const expiresIn = num(body?.['expires_in']);
    if (value === null) {
      throw new SourceUnavailableError(this.domain, 'network', 'eBay token response carried no access_token');
    }
    // Grants last two hours; caching is the difference between one token per
    // crawl and one per listing, and eBay rate-limits the token endpoint too.
    const ttlMs = (expiresIn ?? 0) > 0 ? (expiresIn as number) * 1000 : 60_000;
    this.token = { value, expiresAtMs: this.now().getTime() + ttlMs };
    log.debug('minted eBay application token', { domain: this.domain, expiresInSeconds: expiresIn });
    return value;
  }

  // -- transport ----------------------------------------------------------

  private networkError(url: string, cause: unknown, context: CrawlContext): Error {
    // An abort is the circuit breaker doing its job, not a source failure; it
    // must not be re-labelled as one or the fallback chain will retry it.
    if (context.signal?.aborted === true) return cause instanceof Error ? cause : new Error('crawl aborted');
    const message = cause instanceof Error ? cause.message : String(cause);
    return new SourceUnavailableError(this.domain, 'network', `eBay request to ${url} failed: ${message}`);
  }

  private minIntervalMs(context: CrawlContext): number {
    return context.rps > 0 ? Math.ceil(1000 / context.rps) : 1000;
  }

  private throttled<T>(context: CrawlContext, run: () => Promise<T>): Promise<T> {
    const interval = this.minIntervalMs(context);
    const result = this.queue.then(async () => {
      const wait = this.lastRequestAtMs + interval - Date.now();
      if (wait > 0) await delay(wait, context.signal);
      this.lastRequestAtMs = Date.now();
      return run();
    });
    // The chain must survive a rejection, or the first 500 wedges the source.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async send(url: string, token: string, context: CrawlContext): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
      'user-agent': CRAWLER_USER_AGENT,
    };
    const campaignId = this.options.campaignId;
    if (campaignId !== null && campaignId !== undefined && campaignId !== '') {
      headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${campaignId}`;
    }
    return this.fetchImpl(url, { method: 'GET', headers, signal: context.signal });
  }

  /** One authenticated GET, with token refresh, backoff, and eBay's error taxonomy. */
  private async get(url: string, context: CrawlContext): Promise<ApiResponse> {
    let refreshed = false;
    let retries = 0;

    for (;;) {
      const token = await this.accessToken(context);
      let response: Response;
      try {
        response = await this.throttled(context, () => this.send(url, token, context));
      } catch (cause) {
        if (cause instanceof SourceUnavailableError) throw cause;
        throw this.networkError(url, cause, context);
      }

      if (response.status === 401 && !refreshed) {
        // Tokens can be revoked before they expire, and the cheapest way to
        // tell that apart from a bad key is to mint one and try once more.
        refreshed = true;
        this.token = null;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retries < MAX_RETRIES) {
        const retryAfter = num(response.headers.get('retry-after'));
        await delay(retryAfter !== null ? retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** retries, context.signal);
        retries += 1;
        continue;
      }

      const text = await response.text();
      if (response.status === 404 || response.status === 410) return { status: response.status, body: null };
      if (response.status === 401 || response.status === 403) {
        throw new SourceUnavailableError(
          this.domain,
          'blocked',
          `eBay returned ${response.status} for ${url}: ${text.slice(0, 200)}. `
            + 'The application key is rejected or the Browse API grant was withdrawn.',
        );
      }
      if (response.status === 429) {
        throw new SourceUnavailableError(this.domain, 'blocked', `eBay rate-limited us on ${url} after ${retries} retries`);
      }
      if (response.status >= 400) {
        throw new SourceUnavailableError(
          this.domain,
          'network',
          `eBay returned ${response.status} for ${url}: ${text.slice(0, 200)}`,
        );
      }
      return { status: response.status, body: safeJson(text) };
    }
  }

  // -- SourceAdapter ------------------------------------------------------

  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    this.credentials();

    const query = trimmed(this.options.query);
    const categoryIds = trimmed(this.options.categoryIds);
    if (query === null && categoryIds === null) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `eBay Browse search needs a starting point: set ${EBAY_ENV_VARS.query} or ${EBAY_ENV_VARS.categoryIds}. `
          + 'The API has no "list everything" mode and rejects a search carrying neither.',
      );
    }

    const offset = cursor === undefined ? 0 : Math.max(Number.parseInt(cursor, 10) || 0, 0);
    if (offset >= RESULT_CEILING) return { listings: [], nextCursor: null };
    const limit = Math.min(this.pageSize, RESULT_CEILING - offset);

    const url = new URL(`${this.apiBase}${SEARCH_PATH}`);
    if (query !== null) url.searchParams.set('q', query);
    if (categoryIds !== null) url.searchParams.set('category_ids', categoryIds);
    const filter = trimmed(this.options.filter);
    if (filter !== null) url.searchParams.set('filter', filter);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const { body } = await this.get(url.toString(), context);
    const page = rec(body);
    const summaries = arr(page?.['itemSummaries']);

    const seenAt = this.now();
    const listings: DiscoveredListing[] = [];
    for (const summary of summaries) {
      const item = rec(summary);
      if (item === null) continue;
      const sourceId = str(item['itemId']);
      const listingUrl = str(item['itemWebUrl']);
      if (sourceId === null || listingUrl === null) {
        log.debug('search result missing itemId or itemWebUrl', { domain: this.domain });
        continue;
      }
      listings.push({
        sourceDomain: this.domain,
        sourceId,
        url: listingUrl,
        priceHint: money(item['price'])?.minor ?? null,
        seenAt,
      });
    }

    const total = num(page?.['total']);
    const nextOffset = offset + summaries.length;
    // eBay's own `next` link is the authority on whether another page exists;
    // the ceiling is enforced on top of it because the link keeps being offered
    // past offset 10,000 and the request behind it fails.
    const hasNext = str(page?.['next']) !== null && summaries.length > 0;
    const withinCeiling = nextOffset < RESULT_CEILING && (total === null || nextOffset < total);
    return { listings, nextCursor: hasNext && withinCeiling ? String(nextOffset) : null };
  }

  private itemUrl(sourceId: string): string {
    // Item ids are of the form `v1|123456789|0`; the pipes must be encoded or
    // eBay answers 404 for an item that exists.
    return `${this.apiBase}${ITEM_PATH}/${encodeURIComponent(sourceId)}`;
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    this.credentials();
    const { body } = await this.get(this.itemUrl(listing.sourceId), context);
    const item = rec(body);
    if (item === null) return null;

    const parsed = mapEbayItem(item, listing.url);
    if (parsed.title === null) {
      log.debug('Browse item carried no title', { domain: this.domain, sourceId: listing.sourceId });
      return null;
    }
    const buyingOptions = arr(item['buyingOptions']).map((o) => str(o)).filter((o): o is string => o !== null);
    return toRawListing(parsed, {
      domain: this.domain,
      tier: this.tier,
      sourceType: ebaySourceType(buyingOptions, parsed.conditionText, str(item['conditionId'])),
      sourceId: listing.sourceId,
      url: listing.url,
      fetchedAt: this.now(),
    });
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
    this.credentials();
    const { status, body } = await this.get(this.itemUrl(listing.sourceId), context);
    const item = rec(body);
    if (status === 404 || status === 410 || item === null) {
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }

    const endsAt = parseDate(item['itemEndDate']);
    if (endsAt !== null && endsAt.getTime() <= this.now().getTime()) {
      // eBay keeps ended listings addressable for weeks. A 200 here means the
      // page exists, not that the thing is buyable, which is exactly the case
      // the pre-checkout verification exists to catch.
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }

    const price = money(item['price']);
    const availability = rec(arr(item['estimatedAvailabilities'])[0]);
    const availabilityStatus = str(availability?.['estimatedAvailabilityStatus']);
    const quantity = num(availability?.['estimatedAvailableQuantity']);
    return {
      // LIMITED_STOCK is still buyable; only an explicit OUT_OF_STOCK is not.
      // With no availability block at all, a live item with a price is in stock.
      inStock: availabilityStatus === null ? price !== null : availabilityStatus !== 'OUT_OF_STOCK',
      priceAmountMinor: price?.minor ?? null,
      currency: price?.currency ?? null,
      quantity,
      removed: false,
    };
  }
}

function trimmed(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value.trim();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Construction from the environment
// ---------------------------------------------------------------------------

/**
 * Returns the adapter, or null when eBay is not configured.
 *
 * Null is for the caller that wants to skip the source cleanly at startup —
 * never for the caller mid-crawl. Once the adapter exists, every method is
 * loud, because a silent skip and a silent empty crawl are indistinguishable
 * in the catalog and only one of them is acceptable.
 */
export function fromEnv(deps: EbayBrowseDeps = {}): EbayBrowseAdapter | null {
  const secret = deps.secret ?? ((name: string) => process.env[name]);
  const clientId = trimmed(secret(EBAY_ENV_VARS.clientId));
  const clientSecret = trimmed(secret(EBAY_ENV_VARS.clientSecret));
  if (clientId === null || clientSecret === null) {
    log.warn('eBay is unconfigured and will be skipped', {
      domain: 'ebay.com',
      needs: [EBAY_ENV_VARS.clientId, EBAY_ENV_VARS.clientSecret],
    });
    return null;
  }

  const options: EbayBrowseOptions = {
    clientId,
    clientSecret,
    query: trimmed(secret(EBAY_ENV_VARS.query)),
    categoryIds: trimmed(secret(EBAY_ENV_VARS.categoryIds)),
    filter: trimmed(secret(EBAY_ENV_VARS.filter)),
    campaignId: trimmed(secret(EBAY_ENV_VARS.campaignId)),
  };
  const marketplaceId = trimmed(secret(EBAY_ENV_VARS.marketplaceId));
  if (marketplaceId !== null) options.marketplaceId = marketplaceId;
  return new EbayBrowseAdapter(options, deps);
}

/** Aliased so both tier-1 API adapters can be re-exported from one barrel. */
export { fromEnv as ebayBrowseFromEnv };
