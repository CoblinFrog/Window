/**
 * Amazon, at tier 1, through the Product Advertising API.
 *
 * Amazon's robots.txt disallows `/dp/`, `/gp/` and `/s?`, and its conditions of
 * use forbid automated access to the storefront, so the storefront is not a
 * source at any tier. PA-API is. The PRD's ingestion posture makes this the
 * easy call — official API first, wherever one exists — and Amazon is also the
 * source where the alternative is least defensible and least durable: a scraper
 * here would be both a terms breach and a losing fight with bot mitigation.
 *
 * Two things make this a real client rather than a `Tier1AffiliateAdapter`
 * config entry. PA-API authenticates with AWS Signature Version 4 over a POSTed
 * JSON body, which no feed mapper can express; and it is throttled hard enough
 * (one request per second for a new account, less if sales are low) that the
 * request pacing has to be part of the adapter rather than an afterthought.
 *
 * SigV4 is implemented here on `node:crypto` because adding a dependency for
 * four HMACs is not a trade worth making. It is exported so it can be checked
 * against the published AWS test vectors: a signing bug is invisible until it
 * 403s against the live API, at which point it looks like a credential problem.
 */

import { createHash, createHmac } from 'node:crypto';
import type { ProductIdentifiers, SourceTier, SourceType } from '@window/shared';
import { logger } from '../../lib/logger.js';
import {
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

const log = logger.child('ingestion.amazon');

const SERVICE = 'ProductAdvertisingAPI';
const TARGET_PREFIX = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1';
const SEARCH_PATH = '/paapi5/searchitems';
const GET_ITEMS_PATH = '/paapi5/getitems';

/** PA-API refuses `ItemPage` above 10 regardless of how many results exist. */
const MAX_ITEM_PAGE = 10;
/** GetItems takes at most ten ASINs per call. */
const MAX_ITEM_IDS = 10;
/**
 * The published floor for a new associate account. Exceeding it earns
 * `TooManyRequests` immediately and, repeated, an account review — so this is a
 * hard floor, not a default that `CrawlContext.rps` may raise.
 */
const MIN_REQUEST_INTERVAL_MS = 1000;

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

export interface SigV4Request {
  method: string;
  /** Signed, but deliberately not sent: `fetch` sets `Host` itself. */
  host: string;
  path: string;
  query?: Record<string, string>;
  /** Every header that must be signed, `host` included. */
  headers: Record<string, string>;
  payload: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  /** Basic-format timestamp, `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

export interface SigV4Result {
  authorization: string;
  signature: string;
  signedHeaders: string;
  credentialScope: string;
  /** Returned so the intermediate products can be diffed against a test vector. */
  canonicalRequest: string;
  stringToSign: string;
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986, which is stricter than `encodeURIComponent`: the four sub-delims
 * that function leaves alone must be percent-encoded or the canonical request
 * differs from the one AWS reconstructs, and the signature silently mismatches.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? '')}`)
    .join('&');
}

function canonicalPath(path: string): string {
  if (path === '' || path === '/') return '/';
  return path
    .split('/')
    .map((segment) => (segment === '' ? '' : encodeRfc3986(segment)))
    .join('/');
}

/** Derives the date/region/service/request-scoped signing key. */
export function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function signAwsV4(request: SigV4Request): SigV4Result {
  const dateStamp = request.amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;

  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    // Header values are trimmed and their internal runs of whitespace
    // collapsed; AWS canonicalizes the same way before it verifies.
    normalized.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const names = [...normalized.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${normalized.get(name) ?? ''}\n`).join('');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.path),
    canonicalQuery(request.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(request.payload),
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    request.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = hmac(
    deriveSigningKey(request.secretKey, dateStamp, request.region, request.service),
    stringToSign,
  ).toString('hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${request.accessKey}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signedHeaders,
    credentialScope,
    canonicalRequest,
    stringToSign,
  };
}

/** `2026-09-19T12:34:56.789Z` -> `20260919T123456Z`. */
export function amzDate(at: Date): string {
  return `${at.toISOString().replace(/[:-]/g, '').split('.')[0] ?? ''}Z`;
}

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

interface Marketplace {
  host: string;
  region: string;
  marketplace: string;
  domain: string;
}

/** Host, region and marketplace travel together; picking one wrong 403s. */
export const AMAZON_MARKETPLACES: Record<string, Marketplace> = {
  com: { host: 'webservices.amazon.com', region: 'us-east-1', marketplace: 'www.amazon.com', domain: 'amazon.com' },
  ca: { host: 'webservices.amazon.ca', region: 'us-east-1', marketplace: 'www.amazon.ca', domain: 'amazon.ca' },
  'com.mx': { host: 'webservices.amazon.com.mx', region: 'us-east-1', marketplace: 'www.amazon.com.mx', domain: 'amazon.com.mx' },
  'com.br': { host: 'webservices.amazon.com.br', region: 'us-east-1', marketplace: 'www.amazon.com.br', domain: 'amazon.com.br' },
  'co.uk': { host: 'webservices.amazon.co.uk', region: 'eu-west-1', marketplace: 'www.amazon.co.uk', domain: 'amazon.co.uk' },
  de: { host: 'webservices.amazon.de', region: 'eu-west-1', marketplace: 'www.amazon.de', domain: 'amazon.de' },
  fr: { host: 'webservices.amazon.fr', region: 'eu-west-1', marketplace: 'www.amazon.fr', domain: 'amazon.fr' },
  it: { host: 'webservices.amazon.it', region: 'eu-west-1', marketplace: 'www.amazon.it', domain: 'amazon.it' },
  es: { host: 'webservices.amazon.es', region: 'eu-west-1', marketplace: 'www.amazon.es', domain: 'amazon.es' },
  'co.jp': { host: 'webservices.amazon.co.jp', region: 'us-west-2', marketplace: 'www.amazon.co.jp', domain: 'amazon.co.jp' },
  'com.au': { host: 'webservices.amazon.com.au', region: 'us-west-2', marketplace: 'www.amazon.com.au', domain: 'amazon.com.au' },
  in: { host: 'webservices.amazon.in', region: 'eu-west-1', marketplace: 'www.amazon.in', domain: 'amazon.in' },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AmazonPaapiOptions {
  accessKey: string | null;
  secretKey: string | null;
  partnerTag: string | null;
  /** Key into `AMAZON_MARKETPLACES`; `com` unless set. */
  tld?: string;
  /** Discovery needs one of these; SearchItems rejects a request with neither. */
  keywords?: string | null;
  browseNodeId?: string | null;
  /** PA-API requires a specific index when browsing a node; `All` is search-only. */
  searchIndex?: string;
  domain?: string;
}

export interface AmazonPaapiDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Credential lookup; overridable so tests never touch the real environment. */
  secret?: (name: string) => string | undefined;
}

export const AMAZON_ENV_VARS = {
  accessKey: 'AMAZON_ACCESS_KEY',
  secretKey: 'AMAZON_SECRET_KEY',
  partnerTag: 'AMAZON_PARTNER_TAG',
  tld: 'AMAZON_MARKETPLACE_TLD',
  keywords: 'AMAZON_SEARCH_KEYWORDS',
  browseNodeId: 'AMAZON_BROWSE_NODE_ID',
  searchIndex: 'AMAZON_SEARCH_INDEX',
} as const;

/** Detail resources. PA-API returns only what is asked for, and 400s on a typo. */
const DETAIL_RESOURCES = [
  'BrowseNodeInfo.BrowseNodes',
  'Images.Primary.Large',
  'Images.Variants.Large',
  'ItemInfo.ByLineInfo',
  'ItemInfo.ExternalIds',
  'ItemInfo.Features',
  'ItemInfo.ProductInfo',
  'ItemInfo.Title',
  'Offers.Listings.Availability.Message',
  'Offers.Listings.Availability.Type',
  'Offers.Listings.Condition',
  'Offers.Listings.MerchantInfo',
  'Offers.Listings.Price',
  'Offers.Listings.SavingBasis',
] as const;

/** Discovery only needs enough to decide whether detail is worth a request. */
const DISCOVERY_RESOURCES = ['ItemInfo.Title', 'Offers.Listings.Price'] as const;

/** Verification is price and stock and nothing else. */
const VERIFY_RESOURCES = [
  'Offers.Listings.Availability.Message',
  'Offers.Listings.Availability.Type',
  'Offers.Listings.Price',
] as const;

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
  if (typeof value === 'boolean') return String(value);
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

/** Every scalar in PA-API is wrapped as `{ DisplayValue, Label, Locale }`. */
function display(node: unknown): string | null {
  return str(field(node, 'DisplayValue'));
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

function trimmed(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value.trim();
}

// ---------------------------------------------------------------------------
// Item mapping
// ---------------------------------------------------------------------------

function firstListing(item: JsonRecord): JsonRecord | null {
  return rec(arr(field(item['Offers'], 'Listings'))[0]);
}

function mapIdentifiers(item: JsonRecord): ProductIdentifiers {
  const identifiers: ProductIdentifiers = {};
  const asin = str(item['ASIN']);
  if (asin !== null) identifiers.asin = asin;

  const external = rec(field(item['ItemInfo'], 'ExternalIds'));
  const ean = str(arr(field(external?.['EANs'], 'DisplayValues'))[0]);
  const upc = str(arr(field(external?.['UPCs'], 'DisplayValues'))[0]);
  const isbn = str(arr(field(external?.['ISBNs'], 'DisplayValues'))[0]);
  if (ean !== null) {
    identifiers.ean = ean;
    identifiers.gtin = ean;
  }
  if (upc !== null) {
    identifiers.upc = upc;
    // A UPC is a GTIN-12; where both are published the EAN is the longer form
    // and wins the shared slot, which keeps `gtin` a single consistent value.
    identifiers.gtin ??= upc;
  }
  if (isbn !== null) identifiers.isbn = isbn;
  return identifiers;
}

function mapImages(item: JsonRecord): ParsedProduct['images'] {
  const nodes = [field(item['Images'], 'Primary')];
  for (const variant of arr(field(item['Images'], 'Variants'))) nodes.push(variant);

  const images: ParsedProduct['images'] = [];
  for (const node of nodes) {
    const large = rec(field(node, 'Large'));
    const url = str(large?.['URL']);
    if (url === null || images.some((image) => image.url === url)) continue;
    // PA-API publishes real pixel dimensions, so the media gate gets measured
    // numbers here rather than the zeros a dimensionless source has to send.
    images.push({ url, width: num(large?.['Width']) ?? 0, height: num(large?.['Height']) ?? 0 });
  }
  return images;
}

/**
 * `ProductInfo` is a bag of `{DisplayValue, Label, Unit}` nodes plus a nested
 * `ItemDimensions`. Flattening it keeps the unit attached to the value, which
 * is what the spec normalizer parses back out.
 */
function mapSpecs(item: JsonRecord): ParsedProduct['specs'] {
  const specs: ParsedProduct['specs'] = [];
  const productInfo = rec(field(item['ItemInfo'], 'ProductInfo'));
  if (productInfo === null) return specs;

  const push = (key: string, node: unknown): void => {
    const value = display(node);
    if (value === null) return;
    const unit = str(field(node, 'Unit'));
    specs.push({ key: str(field(node, 'Label')) ?? key, value: unit === null ? value : `${value} ${unit}` });
  };

  for (const [key, node] of Object.entries(productInfo)) {
    if (key === 'ItemDimensions') {
      for (const [dimension, dimensionNode] of Object.entries(rec(node) ?? {})) push(dimension, dimensionNode);
      continue;
    }
    push(key, node);
  }
  return specs;
}

/** Walks `BrowseNodes[0]` up its ancestor chain, broadest category first. */
function mapBreadcrumb(item: JsonRecord): string[] {
  const node = rec(arr(field(item['BrowseNodeInfo'], 'BrowseNodes'))[0]);
  if (node === null) return [];

  const chain: string[] = [];
  let current: JsonRecord | null = node;
  // Bounded: a malformed or self-referential ancestor chain must not hang the
  // crawl, and no real Amazon taxonomy is close to this deep.
  for (let depth = 0; current !== null && depth < 16; depth++) {
    const name = str(current['DisplayName']) ?? str(current['ContextFreeName']);
    if (name !== null) chain.unshift(name);
    current = rec(current['Ancestor']);
  }
  return chain;
}

function mapSeller(item: JsonRecord, listingUrl: string): RawSeller | null {
  const merchant = rec(field(firstListing(item), 'MerchantInfo'));
  const name = str(merchant?.['Name']);
  if (merchant === null || name === null) return null;
  const id = str(merchant['Id']) ?? name;
  const profileUrl = resolveUrl(`/sp?seller=${encodeURIComponent(id)}`, listingUrl);

  return {
    sourceSellerId: id,
    handle: name,
    displayName: name,
    // Everyone selling on Amazon is a merchant account, including Amazon itself.
    type: 'retailer',
    avatarUrl: null,
    profileUrl: profileUrl ?? listingUrl,
    rating: num(merchant['FeedbackRating']),
    ratingScale: 5,
    reviewCount: num(merchant['FeedbackCount']) ?? 0,
    salesCount: 0,
    memberSince: null,
    responseTime: null,
    returnWindowDays: null,
    shippingSummary: null,
    buyerPremiumPct: null,
    listingCount: 0,
  };
}

function mapCondition(listing: JsonRecord | null): string | null {
  const condition = rec(listing?.['Condition']);
  // `Value` is the machine enum ("New"), `DisplayValue` the localized label.
  return str(condition?.['Value']) ?? display(condition);
}

function mapAvailability(listing: JsonRecord | null): string | null {
  const availability = rec(listing?.['Availability']);
  // `Message` ("In Stock.") is what the stock normalizer's prose match reads;
  // `Type` ("Now") is an enum it cannot interpret, so it is only the fallback.
  return str(availability?.['Message']) ?? str(availability?.['Type']);
}

/** Maps one PA-API `Item` onto the shared intermediate shape. */
export function mapAmazonItem(item: JsonRecord, fallbackUrl: string): ParsedProduct {
  const out = emptyParsed('merged');
  const listingUrl = str(item['DetailPageURL']) ?? fallbackUrl;
  const info = rec(item['ItemInfo']);
  const listing = firstListing(item);

  out.sku = str(item['ASIN']);
  out.canonicalUrl = listingUrl;
  out.title = display(field(info, 'Title'));
  out.brand = display(field(field(info, 'ByLineInfo'), 'Brand'));
  out.identifiers = mapIdentifiers(item);

  // PA-API has no description field; the bullet features are the nearest thing
  // Amazon publishes, and they are what the listing page itself shows.
  const features = arr(field(field(info, 'Features'), 'DisplayValues'))
    .map((feature) => str(feature))
    .filter((feature): feature is string => feature !== null);
  out.description = features.length > 0 ? features.join('\n') : null;

  const price = rec(listing?.['Price']);
  const currency = str(price?.['Currency']);
  // `Amount` is a decimal number (12.99), never minor units.
  const amount = num(price?.['Amount']);
  const parsedPrice = amount === null ? null : parsePriceToMinor(amount, currency);
  if (parsedPrice !== null) {
    out.priceAmountMinor = parsedPrice.minor;
    out.priceText = str(price?.['DisplayAmount']) ?? String(amount);
    out.currency = parsedPrice.currency ?? currency;
  }

  const savingBasis = rec(listing?.['SavingBasis']);
  const basisAmount = num(savingBasis?.['Amount']);
  const parsedBasis = basisAmount === null
    ? null
    : parsePriceToMinor(basisAmount, str(savingBasis?.['Currency']) ?? currency);
  if (parsedBasis !== null && parsedBasis.minor !== out.priceAmountMinor) {
    out.originalPriceAmountMinor = parsedBasis.minor;
    out.originalPriceText = str(savingBasis?.['DisplayAmount']) ?? String(basisAmount);
  }

  out.conditionText = mapCondition(listing);
  out.availabilityText = mapAvailability(listing);
  // PA-API exposes no stock count, and a guessed one would drive the scarcity
  // badge in the feed. Absent stays absent.
  out.quantity = null;

  out.images = mapImages(item);
  out.specs = mapSpecs(item);
  out.breadcrumb = mapBreadcrumb(item);
  out.seller = mapSeller(item, listingUrl);
  return out;
}

export function amazonSourceType(conditionText: string | null): SourceType {
  if (conditionText === null) return 'new';
  const token = conditionText.trim().toLowerCase();
  return token === 'new' ? 'new' : 'secondhand';
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface PaapiResponse {
  status: number;
  body: JsonRecord | null;
  errorCodes: string[];
}

export class AmazonPaapiAdapter implements SourceAdapter {
  readonly tier: SourceTier = 1;
  readonly domain: string;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly marketplace: Marketplace;

  /** Requests are serialized through this chain so the 1 rps floor is real. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAtMs = 0;
  /**
   * Raised by `TooManyRequests` and decayed by success. PA-API punishes a
   * caller that keeps its nominal rate through a throttle, so the pacing has to
   * remember it was throttled rather than treat each 429 as independent.
   */
  private throttlePenaltyMs = 0;

  constructor(private readonly options: AmazonPaapiOptions, deps: AmazonPaapiDeps = {}) {
    const tld = options.tld ?? 'com';
    const marketplace = AMAZON_MARKETPLACES[tld];
    if (marketplace === undefined) {
      throw new SourceUnavailableError(
        options.domain ?? `amazon.${tld}`,
        'not_configured',
        `unknown Amazon marketplace ${JSON.stringify(tld)}; set ${AMAZON_ENV_VARS.tld} to one of `
          + Object.keys(AMAZON_MARKETPLACES).join(', '),
      );
    }
    this.marketplace = marketplace;
    this.domain = options.domain ?? marketplace.domain;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
  }

  // -- credentials --------------------------------------------------------

  private credentials(): { accessKey: string; secretKey: string; partnerTag: string } {
    const accessKey = trimmed(this.options.accessKey);
    const secretKey = trimmed(this.options.secretKey);
    const partnerTag = trimmed(this.options.partnerTag);
    const missing: string[] = [];
    if (accessKey === null) missing.push(AMAZON_ENV_VARS.accessKey);
    if (secretKey === null) missing.push(AMAZON_ENV_VARS.secretKey);
    if (partnerTag === null) missing.push(AMAZON_ENV_VARS.partnerTag);
    if (accessKey === null || secretKey === null || partnerTag === null) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `${this.domain} is reachable only through the Product Advertising API: set ${missing.join(', ')} `
          + '(PA-API 5 credentials from an approved Amazon Associates account) and restart. '
          + "Amazon's robots.txt disallows /dp/ and /gp/, so there is no lower tier for this source: "
          + 'without these keys it produces no listings at all.',
      );
    }
    return { accessKey, secretKey, partnerTag };
  }

  // -- transport ----------------------------------------------------------

  private minIntervalMs(context: CrawlContext): number {
    const requested = context.rps > 0 ? Math.ceil(1000 / context.rps) : MIN_REQUEST_INTERVAL_MS;
    return Math.max(MIN_REQUEST_INTERVAL_MS, requested) + this.throttlePenaltyMs;
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

  private async post(
    operation: 'SearchItems' | 'GetItems',
    payload: JsonRecord,
    context: CrawlContext,
  ): Promise<PaapiResponse> {
    const { accessKey, secretKey } = this.credentials();
    const path = operation === 'SearchItems' ? SEARCH_PATH : GET_ITEMS_PATH;
    const url = `https://${this.marketplace.host}${path}`;
    const body = JSON.stringify(payload);

    for (let attempt = 0; ; attempt++) {
      const timestamp = amzDate(this.now());
      const signedHeaders: Record<string, string> = {
        'content-encoding': 'amz-1.0',
        'content-type': 'application/json; charset=utf-8',
        host: this.marketplace.host,
        'x-amz-date': timestamp,
        'x-amz-target': `${TARGET_PREFIX}.${operation}`,
      };
      const signed = signAwsV4({
        method: 'POST',
        host: this.marketplace.host,
        path,
        headers: signedHeaders,
        payload: body,
        region: this.marketplace.region,
        service: SERVICE,
        accessKey,
        secretKey,
        amzDate: timestamp,
      });

      // `host` is signed but not sent: undici sets `Host` from the URL and
      // rejects or overrides an explicit one, and the two agree by construction.
      const { host: _host, ...sendable } = signedHeaders;
      let response: Response;
      try {
        response = await this.throttled(context, () =>
          this.fetchImpl(url, {
            method: 'POST',
            headers: { ...sendable, authorization: signed.authorization, 'user-agent': CRAWLER_USER_AGENT },
            body,
            signal: context.signal,
          }),
        );
      } catch (cause) {
        if (cause instanceof SourceUnavailableError) throw cause;
        // An abort is the circuit breaker, not a source failure.
        if (context.signal?.aborted === true) throw cause;
        throw new SourceUnavailableError(
          this.domain,
          'network',
          `PA-API ${operation} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const text = await response.text();
      const parsed = rec(safeJson(text));
      const errorCodes = arr(parsed?.['Errors'])
        .map((error) => str(field(error, 'Code')))
        .filter((code): code is string => code !== null);

      const throttled = response.status === 429 || errorCodes.includes('TooManyRequests');
      if (throttled && attempt < MAX_RETRIES) {
        // Additive penalty, multiplicative wait: PA-API's quota is earned back
        // by behaving, so slowing down permanently is cheaper than retrying fast.
        this.throttlePenaltyMs = Math.min(this.throttlePenaltyMs + 500, 5000);
        log.warn('PA-API throttled us; backing off', {
          domain: this.domain,
          operation,
          attempt,
          penaltyMs: this.throttlePenaltyMs,
        });
        await delay(BASE_BACKOFF_MS * 2 ** attempt, context.signal);
        continue;
      }
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt, context.signal);
        continue;
      }

      if (throttled) {
        throw new SourceUnavailableError(
          this.domain,
          'blocked',
          `PA-API throttled ${operation} through ${MAX_RETRIES} retries; the account's request quota is exhausted`,
        );
      }
      if (
        response.status === 401
        || response.status === 403
        || errorCodes.some((code) => /Signature|UnrecognizedClient|AccessDenied|InvalidAssociate/i.test(code))
      ) {
        throw new SourceUnavailableError(
          this.domain,
          'blocked',
          `PA-API rejected ${operation} (${response.status}, ${errorCodes.join('/') || 'no code'}): `
            + `${text.slice(0, 200)}. Check ${AMAZON_ENV_VARS.accessKey}, ${AMAZON_ENV_VARS.secretKey} and `
            + `${AMAZON_ENV_VARS.partnerTag}, and that the Associates account still has API access.`,
        );
      }
      if (response.status >= 400 && !errorCodes.includes('NoResults') && !errorCodes.includes('ItemNotAccessible')) {
        throw new SourceUnavailableError(
          this.domain,
          response.status >= 500 ? 'network' : 'not_configured',
          `PA-API ${operation} returned ${response.status} (${errorCodes.join('/') || 'no code'}): ${text.slice(0, 200)}`,
        );
      }

      // Quota is repaid slowly for the same reason it is taken quickly.
      if (this.throttlePenaltyMs > 0) this.throttlePenaltyMs = Math.max(0, this.throttlePenaltyMs - 100);
      return { status: response.status, body: parsed, errorCodes };
    }
  }

  private basePayload(): JsonRecord {
    const { partnerTag } = this.credentials();
    return { PartnerTag: partnerTag, PartnerType: 'Associates', Marketplace: this.marketplace.marketplace };
  }

  // -- SourceAdapter ------------------------------------------------------

  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    this.credentials();
    const keywords = trimmed(this.options.keywords);
    const browseNodeId = trimmed(this.options.browseNodeId);
    if (keywords === null && browseNodeId === null) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `PA-API SearchItems needs a starting point: set ${AMAZON_ENV_VARS.keywords} or `
          + `${AMAZON_ENV_VARS.browseNodeId}. The API has no "list everything" mode.`,
      );
    }
    const searchIndex = trimmed(this.options.searchIndex) ?? 'All';
    if (browseNodeId !== null && searchIndex === 'All') {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `PA-API rejects BrowseNodeId with SearchIndex "All": set ${AMAZON_ENV_VARS.searchIndex} to the `
          + 'specific index the node lives in (Electronics, Apparel, and so on).',
      );
    }

    const page = cursor === undefined ? 1 : Math.max(Number.parseInt(cursor, 10) || 1, 1);
    if (page > MAX_ITEM_PAGE) return { listings: [], nextCursor: null };

    const payload: JsonRecord = {
      ...this.basePayload(),
      Resources: [...DISCOVERY_RESOURCES],
      ItemPage: page,
      SearchIndex: searchIndex,
    };
    if (keywords !== null) payload['Keywords'] = keywords;
    if (browseNodeId !== null) payload['BrowseNodeId'] = browseNodeId;

    const { body } = await this.post('SearchItems', payload, context);
    const items = arr(field(body?.['SearchResult'], 'Items'));

    const seenAt = this.now();
    const listings: DiscoveredListing[] = [];
    for (const raw of items) {
      const item = rec(raw);
      if (item === null) continue;
      const sourceId = str(item['ASIN']);
      const url = str(item['DetailPageURL']);
      if (sourceId === null || url === null) {
        log.debug('search result missing ASIN or DetailPageURL', { domain: this.domain });
        continue;
      }
      const price = rec(field(arr(field(item['Offers'], 'Listings'))[0], 'Price'));
      const amount = num(price?.['Amount']);
      listings.push({
        sourceDomain: this.domain,
        sourceId,
        url,
        priceHint: amount === null ? null : parsePriceToMinor(amount, str(price?.['Currency']))?.minor ?? null,
        seenAt,
      });
    }

    // PA-API's page ceiling is hard: page 11 is an error, not an empty page.
    const nextCursor = items.length > 0 && page < MAX_ITEM_PAGE ? String(page + 1) : null;
    return { listings, nextCursor };
  }

  /**
   * Detail for up to ten ASINs in one call.
   *
   * `SourceAdapter.fetchDetail` is one listing at a time, but GetItems is
   * billed and throttled per request rather than per item, so a caller that can
   * batch gets ten listings for the same second of quota as one.
   */
  async fetchDetailBatch(listings: DiscoveredListing[], context: CrawlContext): Promise<RawListing[]> {
    this.credentials();
    if (listings.length === 0) return [];

    const results: RawListing[] = [];
    for (let start = 0; start < listings.length; start += MAX_ITEM_IDS) {
      const batch = listings.slice(start, start + MAX_ITEM_IDS);
      const payload: JsonRecord = {
        ...this.basePayload(),
        ItemIds: batch.map((listing) => listing.sourceId),
        ItemIdType: 'ASIN',
        Resources: [...DETAIL_RESOURCES],
      };
      const { body } = await this.post('GetItems', payload, context);
      const byAsin = new Map<string, JsonRecord>();
      for (const raw of arr(field(body?.['ItemsResult'], 'Items'))) {
        const item = rec(raw);
        const asin = str(item?.['ASIN']);
        if (item !== null && asin !== null) byAsin.set(asin, item);
      }

      const fetchedAt = this.now();
      for (const listing of batch) {
        const item = byAsin.get(listing.sourceId);
        if (item === undefined) {
          // PA-API drops unavailable ASINs from the response rather than
          // erroring on them, so an absence here is data, not a failure.
          log.debug('GetItems returned no item for ASIN', { domain: this.domain, asin: listing.sourceId });
          continue;
        }
        const parsed = mapAmazonItem(item, listing.url);
        if (parsed.title === null) continue;
        results.push({
          ...toRawListing(parsed, {
            domain: this.domain,
            tier: this.tier,
            sourceType: amazonSourceType(parsed.conditionText),
            sourceId: listing.sourceId,
            url: listing.url,
            fetchedAt,
          }),
          // PA-API returns no review text under any resource. An empty corpus
          // is the truth; the review job sources ratings elsewhere.
          reviews: [],
        });
      }
    }
    return results;
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    const [only] = await this.fetchDetailBatch([listing], context);
    return only ?? null;
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
    const payload: JsonRecord = {
      ...this.basePayload(),
      ItemIds: [listing.sourceId],
      ItemIdType: 'ASIN',
      Resources: [...VERIFY_RESOURCES],
    };
    const { body, errorCodes } = await this.post('GetItems', payload, context);
    const item = rec(arr(field(body?.['ItemsResult'], 'Items'))[0]);
    if (item === null) {
      // Either the ASIN was withdrawn or it is no longer sellable in this
      // marketplace; both mean the row must leave the feed.
      log.debug('GetItems found no item during verification', {
        domain: this.domain,
        asin: listing.sourceId,
        errorCodes,
      });
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }

    const offer = firstListing(item);
    const price = rec(offer?.['Price']);
    const amount = num(price?.['Amount']);
    const currency = str(price?.['Currency']);
    const parsedPrice = amount === null ? null : parsePriceToMinor(amount, currency);
    const availabilityType = str(field(offer?.['Availability'], 'Type'));
    return {
      // No offer block at all means nobody is currently selling it, which is
      // Amazon's way of saying out of stock without saying it.
      inStock: offer !== null && parsedPrice !== null && availabilityType !== 'OutOfStock',
      priceAmountMinor: parsedPrice?.minor ?? null,
      currency: parsedPrice?.currency ?? currency,
      quantity: null,
      removed: false,
    };
  }
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
 * Returns the adapter, or null when PA-API is not configured.
 *
 * Null is for the caller that wants to skip the source cleanly at startup —
 * never for the caller mid-crawl. Once the adapter exists, every method is
 * loud, because a silent skip and a silent empty crawl are indistinguishable
 * in the catalog and only one of them is acceptable.
 */
export function fromEnv(deps: AmazonPaapiDeps = {}): AmazonPaapiAdapter | null {
  const secret = deps.secret ?? ((name: string) => process.env[name]);
  const accessKey = trimmed(secret(AMAZON_ENV_VARS.accessKey));
  const secretKey = trimmed(secret(AMAZON_ENV_VARS.secretKey));
  const partnerTag = trimmed(secret(AMAZON_ENV_VARS.partnerTag));
  if (accessKey === null || secretKey === null || partnerTag === null) {
    log.warn('Amazon PA-API is unconfigured and will be skipped', {
      domain: 'amazon.com',
      needs: [AMAZON_ENV_VARS.accessKey, AMAZON_ENV_VARS.secretKey, AMAZON_ENV_VARS.partnerTag],
    });
    return null;
  }

  const options: AmazonPaapiOptions = {
    accessKey,
    secretKey,
    partnerTag,
    keywords: trimmed(secret(AMAZON_ENV_VARS.keywords)),
    browseNodeId: trimmed(secret(AMAZON_ENV_VARS.browseNodeId)),
  };
  const tld = trimmed(secret(AMAZON_ENV_VARS.tld));
  if (tld !== null) options.tld = tld;
  const searchIndex = trimmed(secret(AMAZON_ENV_VARS.searchIndex));
  if (searchIndex !== null) options.searchIndex = searchIndex;
  return new AmazonPaapiAdapter(options, deps);
}

/** Aliased so both tier-1 API adapters can be re-exported from one barrel. */
export { fromEnv as amazonPaapiFromEnv };
