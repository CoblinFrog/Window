/**
 * Tier 2: plain HTTP fetch, then parse whatever structured product data the
 * page already serves — JSON-LD, then microdata, then Open Graph.
 *
 * This tier carries most of the catalog because it is nearly free and it reads
 * data the merchant publishes deliberately for machines. The parsers below are
 * exported individually and take an HTML string, so the extraction logic is
 * testable without a network and a regression on one source can be reproduced
 * from a saved page rather than from a live crawl.
 *
 * The HTML scanner is hand-rolled on purpose. A DOM library would be a
 * dependency, a parse of the whole document, and a much larger attack surface
 * for the adversarial markup real retail pages contain; all this tier needs is
 * tag boundaries, attributes, and element ranges.
 */

import type { ProductIdentifiers, SourceDoc, SourceTier, SourceType } from '@window/shared';
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

const log = logger.child('ingestion.tier2');

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function asRecord(value: Json | undefined): Record<string, Json> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: Json | undefined): string | null {
  if (typeof value === 'string') {
    const trimmed = collapse(value);
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  // schema.org routinely nests the human-readable value one level down.
  const record = asRecord(value);
  if (record) return asText(record['name'] ?? record['@value'] ?? record['value']);
  if (Array.isArray(value) && value.length > 0) return asText(value[0]);
  return null;
}

function asFiniteNumber(value: Json | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const record = asRecord(value);
  if (record) return asFiniteNumber(record['value'] ?? record['@value']);
  return null;
}

// ---------------------------------------------------------------------------
// HTML scanning
// ---------------------------------------------------------------------------

/** Elements that never have a closing tag, so they never open a scope. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text, where a `<` does not start a tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

export interface HtmlElement {
  name: string;
  attrs: Record<string, string>;
  /** Offset of the opening `<`. Used for containment tests. */
  start: number;
  /** Offset just past the opening tag's `>`. */
  contentStart: number;
  /** Offset of the closing tag's `<`, or of the document end when unclosed. */
  contentEnd: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', eacute: 'é', reg: '®',
  trade: '™', copy: '©', deg: '°', euro: '€', pound: '£',
  yen: '¥', cent: '¢',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function collapse(input: string): string {
  return decodeEntities(input).replace(/\s+/g, ' ').trim();
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1];
    if (name === undefined || name === '') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name.toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/** Finds the `>` that ends a tag, ignoring `>` inside quoted attribute values. */
function tagEnd(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (c === undefined) break;
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function closingTagIndex(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}\\s*>`, 'i');
  const match = pattern.exec(html.slice(from));
  return match ? from + match.index : -1;
}

/**
 * Scans the document into a flat, document-ordered element list with content
 * ranges. Malformed markup is tolerated the way a browser tolerates it:
 * an unmatched closing tag is ignored and unclosed elements end at their
 * nearest enclosing close, which is enough for attribute and range queries.
 */
export function parseElements(html: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  const open: number[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const close = html.indexOf('>', lt);
      i = close < 0 ? html.length : close + 1;
      continue;
    }

    const end = tagEnd(html, lt);
    if (end < 0) break;
    const raw = html.slice(lt + 1, end);

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let s = open.length - 1; s >= 0; s--) {
        const index = open[s];
        if (index === undefined) continue;
        const candidate = elements[index];
        if (candidate && candidate.name === name) {
          for (let k = open.length - 1; k >= s; k--) {
            const unclosed = elements[open[k] ?? -1];
            if (unclosed) unclosed.contentEnd = lt;
          }
          open.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(raw);
    if (!nameMatch || nameMatch[1] === undefined) {
      i = end + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const element: HtmlElement = {
      name,
      attrs: parseAttributes(raw.slice(nameMatch[1].length)),
      start: lt,
      contentStart: end + 1,
      contentEnd: end + 1,
    };
    elements.push(element);

    const selfClosing = raw.trimEnd().endsWith('/') || VOID_ELEMENTS.has(name);
    if (selfClosing) {
      i = end + 1;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = closingTagIndex(html, name, end + 1);
      element.contentEnd = close < 0 ? html.length : close;
      i = element.contentEnd;
      continue;
    }
    open.push(elements.length - 1);
    i = end + 1;
  }

  for (const index of open) {
    const element = elements[index];
    if (element) element.contentEnd = html.length;
  }
  return elements;
}

function contentOf(html: string, element: HtmlElement): string {
  return html.slice(element.contentStart, Math.max(element.contentStart, element.contentEnd));
}

function textOf(html: string, element: HtmlElement): string {
  return collapse(contentOf(html, element).replace(/<[^>]*>/g, ' '));
}

// ---------------------------------------------------------------------------
// Value normalization shared by all three parsers
// ---------------------------------------------------------------------------

/** Currencies with no minor unit. Dividing these by 100 silently loses money. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'PYG', 'RWF', 'UGX', 'VUV']);

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR',
  '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', 'R$': 'BRL', 'C$': 'CAD',
  'A$': 'AUD', 'CHF': 'CHF',
};

export function currencyExponent(currency: string | null): number {
  return currency !== null && ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Parses a price as written by a source into minor units.
 *
 * Sources write prices every way a human writes them: "$1,299.99",
 * "1.299,99 EUR", "129,99", "USD 45". The separator rule is the only ambiguous
 * part, and the heuristic is that a trailing group of one or two digits is a
 * decimal fraction and anything else is a thousands group — so "1.234" reads as
 * one thousand two hundred thirty-four, which is what every retail page means.
 */
export function parsePriceToMinor(
  raw: string | number | null | undefined,
  currencyHint?: string | null,
): { minor: number; currency: string | null } | null {
  if (raw === null || raw === undefined) return null;

  let currency = currencyHint !== undefined && currencyHint !== null && /^[A-Za-z]{3}$/.test(currencyHint)
    ? currencyHint.toUpperCase()
    : null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return { minor: Math.round(raw * 10 ** currencyExponent(currency)), currency };
  }

  const text = decodeEntities(raw).trim();
  if (text === '') return null;

  if (currency === null) {
    const iso = /\b([A-Z]{3})\b/.exec(text.toUpperCase());
    if (iso && iso[1] !== undefined && iso[1] !== 'VAT') currency = iso[1];
  }
  if (currency === null) {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (text.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }

  const digits = /-?[\d.,\u00a0\u202f ]*\d/.exec(text.replace(/[A-Za-z]/g, ''));
  if (!digits) return null;
  const numeric = digits[0].replace(/[\u00a0\u202f ]/g, '');
  const negative = numeric.startsWith('-');
  const bare = numeric.replace(/^-/, '');

  const lastSeparator = Math.max(bare.lastIndexOf('.'), bare.lastIndexOf(','));
  let whole = bare;
  let fraction = '';
  if (lastSeparator >= 0) {
    const tail = bare.slice(lastSeparator + 1);
    if (/^\d{1,2}$/.test(tail)) {
      whole = bare.slice(0, lastSeparator);
      fraction = tail;
    }
  }
  whole = whole.replace(/[.,]/g, '');
  if (whole === '' && fraction === '') return null;

  const exponent = currencyExponent(currency);
  const major = Number.parseInt(whole === '' ? '0' : whole, 10);
  if (!Number.isFinite(major)) return null;
  const fractionMinor = exponent === 0
    ? 0
    : Number.parseInt(fraction.padEnd(exponent, '0').slice(0, exponent) || '0', 10);
  const minor = major * 10 ** exponent + fractionMinor;
  return { minor: negative ? -minor : minor, currency };
}

/** Resolves possibly-relative and protocol-relative URLs against the page URL. */
export function resolveUrl(raw: string | null | undefined, base: string): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = decodeEntities(raw).trim();
  if (trimmed === '' || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** `https://schema.org/InStock` and friends reduce to their last path segment. */
export function normalizeSchemaEnum(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const segment = trimmed.split(/[/#]/).pop();
  return segment === undefined || segment === '' ? trimmed : segment;
}

const IN_STOCK_TOKENS = new Set(['instock', 'in stock', 'instoreonly', 'onlineonly', 'limitedavailability', 'available', 'true', '1']);

/**
 * Preorder and backorder deliberately read as out of stock: the feed promises
 * the user can buy the thing now, and a preorder cannot honour that.
 */
export function isInStock(availabilityText: string | null): boolean {
  if (availabilityText === null) return false;
  return IN_STOCK_TOKENS.has(normalizeSchemaEnum(availabilityText)?.toLowerCase().replace(/[_-]/g, ' ') ?? '');
}

const SCHEMA_CONDITIONS: Record<string, string> = {
  newcondition: 'new',
  usedcondition: 'used',
  refurbishedcondition: 'refurbished',
  damagedcondition: 'damaged',
};

function normalizeCondition(raw: string | null): string | null {
  const token = normalizeSchemaEnum(raw);
  if (token === null) return null;
  return SCHEMA_CONDITIONS[token.toLowerCase()] ?? token;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function parseDate(raw: string | null): Date | null {
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

// ---------------------------------------------------------------------------
// The parser's intermediate shape
// ---------------------------------------------------------------------------

/**
 * What one extraction strategy found. Deliberately a superset of `RawListing`'s
 * extractable fields and nothing else: merging happens on this shape, and
 * `toRawListing` is the only place that decides what a listing finally looks
 * like.
 */
export interface ParsedProduct {
  strategy: 'json-ld' | 'microdata' | 'open-graph' | 'merged';
  title: string | null;
  description: string | null;
  brand: string | null;
  sku: string | null;
  canonicalUrl: string | null;
  identifiers: ProductIdentifiers;
  priceText: string | null;
  priceAmountMinor: number | null;
  currency: string | null;
  originalPriceText: string | null;
  originalPriceAmountMinor: number | null;
  shippingText: string | null;
  shippingAmountMinor: number | null;
  conditionText: string | null;
  availabilityText: string | null;
  quantity: number | null;
  auction: { endsAt: Date; currentBidMinor: number; bidCount: number } | null;
  specs: Array<{ key: string; value: string }>;
  images: Array<{ url: string; width: number; height: number }>;
  video: { url: string; durationMs: number } | null;
  seller: RawSeller | null;
  breadcrumb: string[];
  reviews: RawReview[];
  /**
   * The page's own aggregate rating. `RawListing` has no field for it because
   * ratings are recomputed per cluster from the per-source review pool, but the
   * review-aggregation stage reads it from the parser output to weight sources.
   */
  aggregateRating: { value: number; scale: number; count: number } | null;
}

export function emptyParsed(strategy: ParsedProduct['strategy']): ParsedProduct {
  return {
    strategy,
    title: null,
    description: null,
    brand: null,
    sku: null,
    canonicalUrl: null,
    identifiers: {},
    priceText: null,
    priceAmountMinor: null,
    currency: null,
    originalPriceText: null,
    originalPriceAmountMinor: null,
    shippingText: null,
    shippingAmountMinor: null,
    conditionText: null,
    availabilityText: null,
    quantity: null,
    auction: null,
    specs: [],
    images: [],
    video: null,
    seller: null,
    breadcrumb: [],
    reviews: [],
    aggregateRating: null,
  };
}

/**
 * The fields the crawl dashboard scores a source on. Extraction completeness is
 * the fraction of these that came back populated; it is how a source that
 * quietly stopped emitting offers is noticed before the feed fills with
 * priceless listings.
 */
export const CANONICAL_FIELDS = [
  'title', 'description', 'brand', 'identifiers', 'price', 'currency',
  'condition', 'availability', 'images', 'specs', 'breadcrumb', 'seller', 'reviews',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

function fieldPopulated(parsed: ParsedProduct, field: CanonicalField): boolean {
  switch (field) {
    case 'title': return parsed.title !== null;
    case 'description': return parsed.description !== null;
    case 'brand': return parsed.brand !== null;
    case 'identifiers': return Object.values(parsed.identifiers).some((v) => typeof v === 'string' && v !== '');
    case 'price': return parsed.priceAmountMinor !== null;
    case 'currency': return parsed.currency !== null;
    case 'condition': return parsed.conditionText !== null;
    case 'availability': return parsed.availabilityText !== null;
    case 'images': return parsed.images.length > 0;
    case 'specs': return parsed.specs.length > 0;
    case 'breadcrumb': return parsed.breadcrumb.length > 0;
    case 'seller': return parsed.seller !== null;
    case 'reviews': return parsed.reviews.length > 0 || parsed.aggregateRating !== null;
  }
}

export function extractionCompleteness(parsed: ParsedProduct): number {
  const populated = CANONICAL_FIELDS.filter((field) => fieldPopulated(parsed, field)).length;
  return populated / CANONICAL_FIELDS.length;
}

// ---------------------------------------------------------------------------
// schema.org mapping, shared by JSON-LD and microdata
// ---------------------------------------------------------------------------

const PRODUCT_TYPES = new Set([
  'product', 'individualproduct', 'productmodel', 'productgroup', 'vehicle',
  'book', 'softwareapplication', 'mobileapplication', 'videogame', 'clothing',
]);

function typeTokens(node: Record<string, Json>): string[] {
  return asArray(node['@type'] ?? node['type'])
    .map((t) => normalizeSchemaEnum(asText(t))?.toLowerCase() ?? '')
    .filter((t) => t !== '');
}

function isType(node: Record<string, Json>, predicate: (token: string) => boolean): boolean {
  return typeTokens(node).some(predicate);
}

function setIdentifier(into: ProductIdentifiers, key: keyof ProductIdentifiers, value: string | null): void {
  if (value !== null && into[key] == null) into[key] = value;
}

function mapSeller(node: Json | undefined, pageUrl: string, fallbackType: RawSeller['type']): RawSeller | null {
  const record = asRecord(node);
  const name = record ? asText(record['name']) : asText(node);
  if (name === null) return null;
  const url = record ? resolveUrl(asText(record['url']) ?? asText(record['@id']), pageUrl) : null;
  const rating = record ? asRecord(record['aggregateRating']) : null;
  const type: RawSeller['type'] = record && isType(record, (t) => t === 'person') ? 'individual' : fallbackType;
  return {
    sourceSellerId: (record ? asText(record['@id']) ?? asText(record['identifier']) : null) ?? name,
    handle: name,
    displayName: name,
    type,
    avatarUrl: record ? resolveUrl(asText(record['logo'] ?? record['image']), pageUrl) : null,
    profileUrl: url ?? pageUrl,
    rating: rating ? asFiniteNumber(rating['ratingValue']) : null,
    ratingScale: (rating ? asFiniteNumber(rating['bestRating']) : null) ?? 5,
    // Zero here means "the page did not say", not "measured zero". Normalization
    // treats a seller with no exposed metrics as unrated rather than badly rated.
    reviewCount: (rating ? asFiniteNumber(rating['reviewCount'] ?? rating['ratingCount']) : null) ?? 0,
    salesCount: 0,
    memberSince: null,
    responseTime: null,
    returnWindowDays: null,
    shippingSummary: null,
    buyerPremiumPct: null,
    listingCount: 0,
  };
}

function mapReview(node: Json, pageUrl: string): RawReview | null {
  const record = asRecord(node);
  if (!record) return null;
  const text = asText(record['reviewBody'] ?? record['description'] ?? record['name']);
  if (text === null) return null;
  const ratingRecord = asRecord(record['reviewRating']) ?? asRecord(record['rating']);
  const rating = ratingRecord ? asFiniteNumber(ratingRecord['ratingValue']) : null;
  return {
    rating: rating ?? 0,
    ratingScale: (ratingRecord ? asFiniteNumber(ratingRecord['bestRating']) : null) ?? 5,
    text,
    authorHandle: asText(record['author']),
    verifiedPurchase: null,
    helpfulCount: asFiniteNumber(record['upvoteCount']) ?? 0,
    postedAt: parseDate(asText(record['datePublished'])) ?? new Date(0),
    sourceUrl: resolveUrl(asText(record['url']), pageUrl) ?? pageUrl,
  };
}

function mapImages(node: Json | undefined, pageUrl: string): ParsedProduct['images'] {
  const images: ParsedProduct['images'] = [];
  for (const entry of asArray(node)) {
    const record = asRecord(entry);
    const url = resolveUrl(record ? asText(record['url'] ?? record['contentUrl']) : asText(entry), pageUrl);
    if (url === null) continue;
    images.push({
      url,
      width: (record ? asFiniteNumber(record['width']) : null) ?? 0,
      height: (record ? asFiniteNumber(record['height']) : null) ?? 0,
    });
  }
  return images;
}

function mapOffer(offer: Record<string, Json>, into: ParsedProduct, pageUrl: string): void {
  // AggregateOffer carries the range rather than a price; the low price is the
  // one the card would show, so it is what we take.
  const priceRaw = offer['price'] ?? offer['lowPrice']
    ?? asRecord(offer['priceSpecification'])?.['price'] ?? null;
  const currency = asText(offer['priceCurrency'] ?? asRecord(offer['priceSpecification'])?.['priceCurrency']);
  const price = parsePriceToMinor(
    typeof priceRaw === 'number' ? priceRaw : asText(priceRaw),
    currency,
  );
  if (price !== null && into.priceAmountMinor === null) {
    into.priceAmountMinor = price.minor;
    into.priceText = asText(priceRaw) ?? String(price.minor);
    into.currency = price.currency ?? into.currency;
  }

  const listPrice = asRecord(offer['priceSpecification'])?.['listPrice'] ?? offer['highPrice'];
  const original = parsePriceToMinor(asText(listPrice), currency ?? into.currency);
  if (original !== null && into.originalPriceAmountMinor === null && original.minor !== into.priceAmountMinor) {
    into.originalPriceAmountMinor = original.minor;
    into.originalPriceText = asText(listPrice);
  }

  const shippingRate = asRecord(asRecord(offer['shippingDetails'])?.['shippingRate'] ?? null);
  if (shippingRate) {
    const shipping = parsePriceToMinor(
      asText(shippingRate['value']),
      asText(shippingRate['currency']) ?? into.currency,
    );
    if (shipping !== null) {
      into.shippingAmountMinor = shipping.minor;
      into.shippingText = asText(shippingRate['value']);
    }
  }

  into.availabilityText ??= normalizeSchemaEnum(asText(offer['availability']));
  into.conditionText ??= normalizeCondition(asText(offer['itemCondition']));
  into.quantity ??= asFiniteNumber(asRecord(offer['inventoryLevel'])?.['value'] ?? offer['inventoryLevel'] ?? null);
  into.seller ??= mapSeller(offer['seller'] ?? offer['offeredBy'], pageUrl, 'retailer');
  into.sku ??= asText(offer['sku'] ?? offer['serialNumber']);
}

/** Maps one schema.org Product node (from JSON-LD or from microdata) onto `ParsedProduct`. */
export function mapSchemaProduct(
  node: Record<string, Json>,
  pageUrl: string,
  strategy: ParsedProduct['strategy'],
): ParsedProduct {
  const out = emptyParsed(strategy);
  out.title = asText(node['name'] ?? node['title']);
  out.description = asText(node['description']);
  out.brand = asText(node['brand'] ?? node['manufacturer']);
  out.sku = asText(node['sku'] ?? node['productID'] ?? node['identifier']);
  out.canonicalUrl = resolveUrl(asText(node['url']), pageUrl);

  setIdentifier(out.identifiers, 'gtin', asText(node['gtin'] ?? node['gtin14'] ?? node['gtin13']));
  setIdentifier(out.identifiers, 'ean', asText(node['gtin13'] ?? node['ean']));
  setIdentifier(out.identifiers, 'upc', asText(node['gtin12'] ?? node['upc']));
  setIdentifier(out.identifiers, 'mpn', asText(node['mpn']));
  setIdentifier(out.identifiers, 'isbn', asText(node['isbn']));
  // Amazon publishes the ASIN as a prefixed productID rather than a field.
  const productId = asText(node['productID']);
  if (productId !== null && /^asin:/i.test(productId)) {
    setIdentifier(out.identifiers, 'asin', productId.slice(5));
  } else if (productId !== null && /^[A-Z0-9]{10}$/.test(productId) && /(^|\.)amazon\./i.test(hostnameOf(pageUrl))) {
    setIdentifier(out.identifiers, 'asin', productId);
  }

  out.conditionText = normalizeCondition(asText(node['itemCondition']));
  out.images = mapImages(node['image'], pageUrl);

  const video = asRecord(node['video']) ?? asRecord(asArray(node['video'])[0]);
  const videoUrl = video ? resolveUrl(asText(video['contentUrl'] ?? video['url']), pageUrl) : null;
  if (videoUrl !== null) {
    out.video = { url: videoUrl, durationMs: parseIso8601DurationMs(asText(video?.['duration'])) ?? 0 };
  }

  for (const property of asArray(node['additionalProperty'])) {
    const record = asRecord(property);
    if (!record) continue;
    const key = asText(record['name']);
    const value = asText(record['value']);
    if (key !== null && value !== null) out.specs.push({ key, value });
  }
  for (const inline of ['color', 'material', 'size', 'pattern', 'width', 'height', 'weight'] as const) {
    const value = asText(node[inline]);
    if (value !== null) out.specs.push({ key: inline, value });
  }

  for (const offer of asArray(node['offers'])) {
    const record = asRecord(offer);
    if (!record) continue;
    // An AggregateOffer nests the real offers one level down.
    const nested = asArray(record['offers']).map(asRecord).filter((r): r is Record<string, Json> => r !== null);
    mapOffer(record, out, pageUrl);
    for (const child of nested) mapOffer(child, out, pageUrl);
  }

  const aggregate = asRecord(node['aggregateRating']);
  if (aggregate) {
    const value = asFiniteNumber(aggregate['ratingValue']);
    if (value !== null) {
      out.aggregateRating = {
        value,
        scale: asFiniteNumber(aggregate['bestRating']) ?? 5,
        count: asFiniteNumber(aggregate['reviewCount'] ?? aggregate['ratingCount']) ?? 0,
      };
    }
  }

  for (const review of asArray(node['review'] ?? node['reviews'])) {
    const mapped = mapReview(review, pageUrl);
    if (mapped) out.reviews.push(mapped);
  }

  const category = asText(node['category']);
  if (category !== null) out.breadcrumb = category.split(/\s*[>›/|]\s*/).filter((p) => p !== '');

  return out;
}

function parseIso8601DurationMs(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw.trim());
  if (!match) {
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  }
  const hours = Number.parseFloat(match[1] ?? '0');
  const minutes = Number.parseFloat(match[2] ?? '0');
  const seconds = Number.parseFloat(match[3] ?? '0');
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function mapBreadcrumbList(node: Record<string, Json>): string[] {
  const items = asArray(node['itemListElement'])
    .map(asRecord)
    .filter((r): r is Record<string, Json> => r !== null)
    .map((r) => ({
      position: asFiniteNumber(r['position']) ?? 0,
      name: asText(r['name'] ?? r['item']) ?? '',
    }))
    .filter((r) => r.name !== '');
  items.sort((a, b) => a.position - b.position);
  return items.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Strategy 1: JSON-LD
// ---------------------------------------------------------------------------

/** Depth- and count-bounded: source pages embed graphs large enough to matter. */
function collectNodes(root: Json, out: Record<string, Json>[], depth = 0): void {
  if (depth > 8 || out.length > 4000) return;
  if (Array.isArray(root)) {
    for (const entry of root) collectNodes(entry, out, depth + 1);
    return;
  }
  const record = asRecord(root);
  if (!record) return;
  out.push(record);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasVariant', 'isSimilarTo']) {
    const child = record[key];
    if (child !== undefined) collectNodes(child, out, depth + 1);
  }
}

export function parseJsonLd(html: string, pageUrl: string): ParsedProduct {
  const blocks = parseElements(html).filter(
    (el) => el.name === 'script' && (el.attrs['type'] ?? '').toLowerCase().includes('ld+json'),
  );

  const nodes: Record<string, Json>[] = [];
  for (const block of blocks) {
    const body = contentOf(html, block).trim();
    if (body === '') continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(body) as Json;
    } catch {
      // A single malformed block must not cost us the others: retailers ship
      // pages with one broken graph and three good ones.
      log.debug('skipped unparseable json-ld block', { pageUrl, bytes: body.length });
      continue;
    }
    collectNodes(parsed, nodes);
  }

  const productNode = nodes.find((node) => isType(node, (t) => PRODUCT_TYPES.has(t)));
  const out = productNode
    ? mapSchemaProduct(productNode, pageUrl, 'json-ld')
    : emptyParsed('json-ld');

  if (out.breadcrumb.length === 0) {
    const crumbs = nodes.find((node) => isType(node, (t) => t === 'breadcrumblist'));
    if (crumbs) out.breadcrumb = mapBreadcrumbList(crumbs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategy 2: microdata
// ---------------------------------------------------------------------------

interface MicroItem {
  type: string | null;
  props: Record<string, Array<string | MicroItem>>;
}

function microValue(html: string, element: HtmlElement, pageUrl: string): string {
  const attrs = element.attrs;
  switch (element.name) {
    case 'meta':
      return attrs['content'] ?? '';
    case 'img': case 'audio': case 'embed': case 'iframe': case 'source': case 'track': case 'video':
      return resolveUrl(attrs['src'] ?? attrs['content'], pageUrl) ?? attrs['src'] ?? '';
    case 'a': case 'area': case 'link':
      return resolveUrl(attrs['href'], pageUrl) ?? attrs['href'] ?? '';
    case 'object':
      return attrs['data'] ?? '';
    case 'data':
      return attrs['value'] ?? textOf(html, element);
    case 'time':
      return attrs['datetime'] ?? textOf(html, element);
    default:
      return attrs['content'] ?? textOf(html, element);
  }
}

function buildMicroItem(html: string, elements: HtmlElement[], rootIndex: number, pageUrl: string): MicroItem {
  const root = elements[rootIndex];
  const item: MicroItem = {
    type: root ? normalizeSchemaEnum(root.attrs['itemtype'] ?? null) : null,
    props: {},
  };
  if (!root) return item;

  let skipUntil = -1;
  for (let j = rootIndex + 1; j < elements.length; j++) {
    const element = elements[j];
    if (!element || element.start >= root.contentEnd) break;
    if (element.start < skipUntil) continue;

    const propNames = (element.attrs['itemprop'] ?? '').split(/\s+/).filter((n) => n !== '');
    const opensScope = element.attrs['itemscope'] !== undefined;
    if (propNames.length === 0) {
      // An unnamed nested scope still hides its own itemprops from us.
      if (opensScope) skipUntil = element.contentEnd;
      continue;
    }

    const value: string | MicroItem = opensScope
      ? buildMicroItem(html, elements, j, pageUrl)
      : microValue(html, element, pageUrl);
    if (opensScope) skipUntil = element.contentEnd;
    if (typeof value === 'string' && collapse(value) === '') continue;

    for (const name of propNames) {
      const bucket = item.props[name];
      if (bucket) bucket.push(value);
      else item.props[name] = [value];
    }
  }
  return item;
}

/**
 * Microdata and JSON-LD describe the same vocabulary, so the item tree is
 * converted to the JSON-LD shape and run through the one schema.org mapper
 * rather than a parallel implementation that would drift from it.
 */
function microItemToJson(item: MicroItem): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (item.type !== null) out['@type'] = item.type;
  for (const [key, values] of Object.entries(item.props)) {
    const mapped: Json[] = values.map((value) =>
      typeof value === 'string' ? collapse(value) : microItemToJson(value),
    );
    const first = mapped[0];
    out[key] = mapped.length === 1 && first !== undefined ? first : mapped;
  }
  return out;
}

export function parseMicrodata(html: string, pageUrl: string): ParsedProduct {
  const elements = parseElements(html);
  const scopes = elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.attrs['itemscope'] !== undefined);

  const productScope = scopes.find(({ element }) => {
    const token = normalizeSchemaEnum(element.attrs['itemtype'] ?? null)?.toLowerCase();
    return token !== undefined && token !== null && PRODUCT_TYPES.has(token);
  });
  if (!productScope) return emptyParsed('microdata');

  const out = mapSchemaProduct(
    microItemToJson(buildMicroItem(html, elements, productScope.index, pageUrl)),
    pageUrl,
    'microdata',
  );

  if (out.breadcrumb.length === 0) {
    const crumbScope = scopes.find(
      ({ element }) => normalizeSchemaEnum(element.attrs['itemtype'] ?? null)?.toLowerCase() === 'breadcrumblist',
    );
    if (crumbScope) {
      out.breadcrumb = mapBreadcrumbList(microItemToJson(buildMicroItem(html, elements, crumbScope.index, pageUrl)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategy 3: Open Graph
// ---------------------------------------------------------------------------

export function parseOpenGraph(html: string, pageUrl: string): ParsedProduct {
  const out = emptyParsed('open-graph');
  const metas: Array<{ key: string; content: string }> = [];
  for (const element of parseElements(html)) {
    if (element.name !== 'meta') continue;
    const key = (element.attrs['property'] ?? element.attrs['name'] ?? '').toLowerCase();
    const content = element.attrs['content'];
    if (key === '' || content === undefined || content.trim() === '') continue;
    metas.push({ key, content: decodeEntities(content).trim() });
  }
  const first = new Map<string, string>();
  for (const meta of metas) if (!first.has(meta.key)) first.set(meta.key, meta.content);
  const get = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = first.get(key);
      if (value !== undefined && value !== '') return value;
    }
    return null;
  };

  out.title = get('og:title', 'twitter:title');
  out.description = get('og:description', 'twitter:description', 'description');
  out.brand = get('product:brand', 'og:brand', 'product:manufacturer');
  out.sku = get('product:retailer_item_id', 'product:sku', 'og:sku');
  out.canonicalUrl = resolveUrl(get('og:url'), pageUrl);
  setIdentifier(out.identifiers, 'gtin', get('product:gtin', 'product:gtin13'));
  setIdentifier(out.identifiers, 'upc', get('product:upc'));
  setIdentifier(out.identifiers, 'ean', get('product:ean'));
  setIdentifier(out.identifiers, 'mpn', get('product:mfr_part_no', 'product:mpn'));
  setIdentifier(out.identifiers, 'isbn', get('books:isbn', 'product:isbn'));

  const currency = get('product:price:currency', 'og:price:currency', 'product:sale_price:currency');
  const priceText = get('product:price:amount', 'og:price:amount', 'product:sale_price:amount');
  const price = parsePriceToMinor(priceText, currency);
  if (price !== null) {
    out.priceText = priceText;
    out.priceAmountMinor = price.minor;
    out.currency = price.currency;
  }
  const originalText = get('product:original_price:amount', 'product:list_price:amount');
  const original = parsePriceToMinor(originalText, currency ?? out.currency);
  if (original !== null) {
    out.originalPriceText = originalText;
    out.originalPriceAmountMinor = original.minor;
  }
  const shippingText = get('product:shipping_cost:amount');
  const shipping = parsePriceToMinor(shippingText, currency ?? out.currency);
  if (shipping !== null) {
    out.shippingText = shippingText;
    out.shippingAmountMinor = shipping.minor;
  }

  out.availabilityText = normalizeSchemaEnum(get('product:availability', 'og:availability'));
  out.conditionText = normalizeCondition(get('product:condition'));

  // og:image repeats, with width and height trailing the image they describe.
  let pending: { url: string; width: number; height: number } | null = null;
  for (const meta of metas) {
    if (meta.key === 'og:image' || meta.key === 'og:image:url' || meta.key === 'og:image:secure_url') {
      const url = resolveUrl(meta.content, pageUrl);
      if (url === null) continue;
      if (pending && pending.url === url) continue;
      pending = { url, width: 0, height: 0 };
      out.images.push(pending);
    } else if (meta.key === 'og:image:width' && pending) {
      pending.width = Number.parseInt(meta.content, 10) || 0;
    } else if (meta.key === 'og:image:height' && pending) {
      pending.height = Number.parseInt(meta.content, 10) || 0;
    }
  }
  if (out.images.length === 0) {
    const twitter = resolveUrl(get('twitter:image', 'twitter:image:src'), pageUrl);
    if (twitter !== null) out.images.push({ url: twitter, width: 0, height: 0 });
  }

  const videoUrl = resolveUrl(get('og:video:secure_url', 'og:video:url', 'og:video'), pageUrl);
  if (videoUrl !== null) {
    const seconds = Number.parseFloat(get('og:video:duration') ?? '');
    out.video = { url: videoUrl, durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function pickString(candidates: Array<string | null>, preferLongest = false): string | null {
  const present = candidates.filter((c): c is string => c !== null && c !== '');
  if (present.length === 0) return null;
  if (!preferLongest) return present[0] ?? null;
  return present.reduce((best, c) => (c.length > best.length ? c : best), present[0] ?? '');
}

/**
 * Merges strategy outputs in priority order, field by field.
 *
 * "Richer" is field-specific rather than global: the first strategy that had a
 * value wins for scalars, because JSON-LD is the merchant's own authored data,
 * but descriptions take the longest candidate (Open Graph truncates for social
 * cards) and collections union, because a page often lists its gallery in one
 * place and its hero image in another.
 */
export function mergeParsed(parsed: ParsedProduct[]): ParsedProduct {
  const out = emptyParsed('merged');
  const all = parsed.filter((p) => p !== undefined);

  out.title = pickString(all.map((p) => p.title));
  out.description = pickString(all.map((p) => p.description), true);
  out.brand = pickString(all.map((p) => p.brand));
  out.sku = pickString(all.map((p) => p.sku));
  out.canonicalUrl = pickString(all.map((p) => p.canonicalUrl));
  out.conditionText = pickString(all.map((p) => p.conditionText));
  out.availabilityText = pickString(all.map((p) => p.availabilityText));
  out.currency = pickString(all.map((p) => p.currency));

  for (const source of all) {
    for (const [key, value] of Object.entries(source.identifiers)) {
      const field = key as keyof ProductIdentifiers;
      if (typeof value === 'string' && value !== '' && out.identifiers[field] == null) {
        out.identifiers[field] = value;
      }
    }
    if (out.priceAmountMinor === null && source.priceAmountMinor !== null) {
      out.priceAmountMinor = source.priceAmountMinor;
      out.priceText = source.priceText;
      out.currency ??= source.currency;
    }
    if (out.originalPriceAmountMinor === null && source.originalPriceAmountMinor !== null) {
      out.originalPriceAmountMinor = source.originalPriceAmountMinor;
      out.originalPriceText = source.originalPriceText;
    }
    if (out.shippingAmountMinor === null && source.shippingAmountMinor !== null) {
      out.shippingAmountMinor = source.shippingAmountMinor;
      out.shippingText = source.shippingText;
    }
    out.quantity ??= source.quantity;
    out.auction ??= source.auction;
    out.video ??= source.video;
    out.seller ??= source.seller;
    out.aggregateRating ??= source.aggregateRating;
    if (out.breadcrumb.length === 0) out.breadcrumb = source.breadcrumb;
    if (source.reviews.length > out.reviews.length) out.reviews = source.reviews;
  }

  const seenImages = new Set<string>();
  for (const source of all) {
    for (const image of source.images) {
      const existing = out.images.find((i) => i.url === image.url);
      if (existing) {
        // Keep whichever strategy knew the dimensions; the media gate needs them.
        if (existing.width === 0 && image.width > 0) {
          existing.width = image.width;
          existing.height = image.height;
        }
        continue;
      }
      if (seenImages.has(image.url)) continue;
      seenImages.add(image.url);
      out.images.push({ ...image });
    }
  }

  const seenSpecs = new Set<string>();
  for (const source of all) {
    for (const spec of source.specs) {
      const key = spec.key.toLowerCase();
      if (seenSpecs.has(key)) continue;
      seenSpecs.add(key);
      out.specs.push(spec);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RawListing assembly
// ---------------------------------------------------------------------------

export interface RawListingMeta {
  domain: string;
  tier: SourceTier;
  sourceType: SourceType;
  sourceId: string;
  url: string;
  fetchedAt: Date;
}

export function toRawListing(parsed: ParsedProduct, meta: RawListingMeta): RawListing {
  return {
    sourceDomain: meta.domain,
    sourceId: meta.sourceId,
    url: parsed.canonicalUrl ?? meta.url,
    tier: meta.tier,
    sourceType: meta.sourceType,
    title: parsed.title ?? '',
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
    // A single-unit source that did not say still means one; the registry marks
    // those sources, and normalization applies the rule. Nothing is invented here.
    quantity: parsed.quantity,
    auction: parsed.auction,
    specs: parsed.specs,
    images: parsed.images,
    video: parsed.video,
    seller: parsed.seller,
    breadcrumb: parsed.breadcrumb,
    reviews: parsed.reviews,
    fetchedAt: meta.fetchedAt,
    extractionCompleteness: extractionCompleteness(parsed),
  };
}

/** Runs all three strategies over one page and merges them, highest fidelity first. */
export function extractFromHtml(html: string, pageUrl: string): ParsedProduct {
  return mergeParsed([
    parseJsonLd(html, pageUrl),
    parseMicrodata(html, pageUrl),
    parseOpenGraph(html, pageUrl),
  ]);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Identifies the crawler honestly, with a contact route. A source that wants us
 * gone must be able to say so to someone rather than by fingerprinting us.
 */
export const CRAWLER_USER_AGENT =
  'WindowBot/0.1 (+https://window.shopping/bot; product discovery; crawl-abuse@window.shopping)';

export interface FetchedPage {
  status: number;
  url: string;
  body: string;
}

export async function fetchPage(
  url: string,
  context: CrawlContext,
  domain: string,
  fetchImpl: FetchLike,
  accept = 'text/html,application/xhtml+xml',
): Promise<FetchedPage> {
  let response: Response;
  try {
    // Rate and concurrency live in `CrawlContext` and are enforced by the
    // scheduler that owns the token bucket across workers; pacing here would
    // only be correct in a single-process crawl.
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: {
        'user-agent': CRAWLER_USER_AGENT,
        accept,
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: context.signal,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SourceUnavailableError(domain, 'network', `fetch failed for ${url}: ${message}`);
  }

  // 403/429 is bot mitigation, which is precisely the condition that should
  // escalate the source to tier 3 rather than be retried at tier 2.
  if (response.status === 403 || response.status === 429 || response.status === 451) {
    throw new SourceUnavailableError(
      domain,
      'blocked',
      `${url} returned ${response.status}; tier 2 is being refused by this source`,
    );
  }
  const body = response.status === 404 || response.status === 410 ? '' : await response.text();
  return { status: response.status, url: response.url === '' ? url : response.url, body };
}

// ---------------------------------------------------------------------------
// Discovery configuration
// ---------------------------------------------------------------------------

/**
 * Two discovery strategies, both reading data the merchant publishes for
 * machines: an XML sitemap, and the public Shopify-style product JSON endpoint
 * that the aggregator long tail serves without authentication.
 */
export type Tier2Discovery =
  | { strategy: 'sitemap'; url: string; pattern: string | null }
  | { strategy: 'products-json'; url: string; pattern: string | null; limit: number };

export function parseTier2Discovery(spec: string, domain: string): Tier2Discovery {
  let raw: Json;
  try {
    raw = JSON.parse(spec) as Json;
  } catch {
    throw new SourceUnavailableError(
      domain,
      'not_configured',
      `extractors.listing must be JSON describing a tier-2 discovery strategy, got ${JSON.stringify(spec.slice(0, 80))}`,
    );
  }
  const record = asRecord(raw);
  const strategy = record ? asText(record['strategy']) : null;
  const url = record ? asText(record['url']) : null;
  if (record === null || url === null) {
    throw new SourceUnavailableError(domain, 'not_configured', 'tier-2 discovery config needs { strategy, url }');
  }
  const pattern = asText(record['pattern']);
  if (strategy === 'sitemap') return { strategy, url, pattern };
  if (strategy === 'products-json') {
    return { strategy, url, pattern, limit: asFiniteNumber(record['limit']) ?? 250 };
  }
  throw new SourceUnavailableError(
    domain,
    'not_configured',
    `unknown tier-2 discovery strategy ${JSON.stringify(strategy)}; expected "sitemap" or "products-json"`,
  );
}

function sitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const pattern = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const loc = match[1];
    if (loc !== undefined) locs.push(decodeEntities(loc.trim()));
  }
  return locs;
}

function sourceIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter((s) => s !== '').pop();
    return last ?? parsed.pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface Tier2Deps {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class Tier2StructuredAdapter implements SourceAdapter {
  readonly tier: SourceTier = 2;
  readonly domain: string;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly source: SourceDoc<string>, deps: Tier2Deps = {}) {
    this.domain = source.id;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
  }

  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const config = parseTier2Discovery(this.source.extractors.listing, this.domain);
    return config.strategy === 'sitemap'
      ? this.discoverBySitemap(config, context, cursor)
      : this.discoverByProductsJson(config, context, cursor);
  }

  /**
   * The cursor is the index of the child sitemap inside a sitemap index, which
   * costs one extra fetch of the (small, cached) index per page and in exchange
   * keeps discovery stateless — any worker can resume any source from a string.
   */
  private async discoverBySitemap(
    config: Extract<Tier2Discovery, { strategy: 'sitemap' }>,
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const index = await fetchPage(config.url, context, this.domain, this.fetchImpl, 'application/xml,text/xml');
    if (index.status >= 400) {
      throw new SourceUnavailableError(this.domain, 'network', `sitemap ${config.url} returned ${index.status}`);
    }

    const isIndex = /<sitemapindex[\s>]/i.test(index.body);
    const locs = sitemapLocs(index.body);
    let urls: string[];
    let nextCursor: string | null = null;

    if (isIndex) {
      const position = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const child = locs[Number.isFinite(position) ? position : 0];
      if (child === undefined) return { listings: [], nextCursor: null };
      const page = await fetchPage(child, context, this.domain, this.fetchImpl, 'application/xml,text/xml');
      urls = sitemapLocs(page.body);
      nextCursor = position + 1 < locs.length ? String(position + 1) : null;
    } else {
      urls = locs;
    }

    const seenAt = this.now();
    const listings = urls
      .filter((url) => config.pattern === null || url.includes(config.pattern))
      .map((url) => ({
        sourceDomain: this.domain,
        sourceId: sourceIdFromUrl(url),
        url,
        priceHint: null,
        seenAt,
      }));
    return { listings, nextCursor };
  }

  private async discoverByProductsJson(
    config: Extract<Tier2Discovery, { strategy: 'products-json' }>,
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const page = cursor === undefined ? 1 : Number.parseInt(cursor, 10) || 1;
    const endpoint = new URL(config.url);
    endpoint.searchParams.set('limit', String(config.limit));
    endpoint.searchParams.set('page', String(page));

    const response = await fetchPage(endpoint.toString(), context, this.domain, this.fetchImpl, 'application/json');
    if (response.status >= 400) {
      throw new SourceUnavailableError(
        this.domain,
        'network',
        `${endpoint.toString()} returned ${response.status}`,
      );
    }
    let body: Json;
    try {
      body = JSON.parse(response.body) as Json;
    } catch {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `${endpoint.toString()} did not return JSON; this source is not a Shopify-style products endpoint`,
      );
    }

    const products = asArray(asRecord(body)?.['products']).map(asRecord).filter((r): r is Record<string, Json> => r !== null);
    const seenAt = this.now();
    const listings: DiscoveredListing[] = [];
    for (const product of products) {
      const handle = asText(product['handle']);
      const id = asText(product['id']) ?? handle;
      if (handle === null || id === null) continue;
      const url = new URL(`/products/${handle}`, config.url).toString();
      if (config.pattern !== null && !url.includes(config.pattern)) continue;
      const variant = asRecord(asArray(product['variants'])[0]);
      const price = variant ? parsePriceToMinor(asText(variant['price'])) : null;
      listings.push({
        sourceDomain: this.domain,
        sourceId: id,
        url,
        priceHint: price?.minor ?? null,
        seenAt,
      });
    }
    // An empty page is the end of the catalog; anything else risks an endless walk.
    return { listings, nextCursor: products.length === 0 ? null : String(page + 1) };
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    const page = await fetchPage(listing.url, context, this.domain, this.fetchImpl);
    if (page.status >= 400) {
      log.debug('detail fetch returned an error status', { url: listing.url, status: page.status });
      return null;
    }

    const parsed = extractFromHtml(page.body, page.url);
    // No title from any of the three strategies means the page rendered its
    // product client-side. Returning null is what lets the fallback escalate to
    // tier 3 instead of writing an empty listing.
    if (parsed.title === null) {
      log.debug('no structured product data on page', { url: page.url, bytes: page.body.length });
      return null;
    }

    return toRawListing(parsed, {
      domain: this.domain,
      tier: this.tier,
      sourceType: this.source.sourceType,
      sourceId: listing.sourceId !== '' ? listing.sourceId : parsed.sku ?? sourceIdFromUrl(page.url),
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
    const page = await fetchPage(listing.url, context, this.domain, this.fetchImpl);
    if (page.status === 404 || page.status === 410) {
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }
    if (page.status >= 400) return null;

    const parsed = extractFromHtml(page.body, page.url);
    if (parsed.title === null && parsed.priceAmountMinor === null) return null;
    return {
      inStock: isInStock(parsed.availabilityText),
      priceAmountMinor: parsed.priceAmountMinor,
      currency: parsed.currency,
      quantity: parsed.quantity,
      removed: false,
    };
  }
}
