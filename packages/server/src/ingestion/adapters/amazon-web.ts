/**
 * Amazon's storefront, read directly.
 *
 * The credential-free path. Search pages hand discovery to the browse agent;
 * detail pages carry everything `RawListing` needs in the markup — title in
 * `#productTitle`, price in `#corePrice`, the gallery in the `data-a-dynamic-
 * image` attribute — so this is a DOM read, not a guess at an API.
 *
 * The parsers are exported and take an HTML string, matching tier-2's shape:
 * extraction is testable off a saved page and a regression is reproducible
 * without a network.
 */

import type { SourceDoc } from '@window/shared';
import { logger } from '../../lib/logger.js';
import {
  SourceUnavailableError,
  type CrawlContext,
  type DiscoveredListing,
  type PageCandidates,
  type RawListing,
  type RawReview,
  type WebSourceAdapter,
} from '../types.js';
import {
  decodeEntities,
  emptyParsed,
  extractFromHtml,
  fetchPage,
  isInStock,
  mergeParsed,
  parseElements,
  parsePriceToMinor,
  resolveUrl,
  toRawListing,
  type FetchedPage,
  type FetchLike,
  type HtmlElement,
  type ParsedProduct,
} from './tier2-structured.js';
import { primedFetch } from './primed-fetch.js';

const log = logger.child('ingestion.amazon-web');

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

// ---------------------------------------------------------------------------
// Small DOM helpers over tier-2's flat element scan
// ---------------------------------------------------------------------------

function elementText(html: string, element: HtmlElement): string {
  const raw = html.slice(element.contentStart, Math.max(element.contentStart, element.contentEnd));
  return decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Elements inside `root`, in document order. The scan is document-sorted. */
function inside(elements: HtmlElement[], root: HtmlElement): HtmlElement[] {
  return elements.filter((el) => el.start >= root.contentStart && el.start < root.contentEnd);
}

function findById(elements: HtmlElement[], id: string): HtmlElement | undefined {
  return elements.find((el) => el.attrs['id'] === id);
}

function hasClass(element: HtmlElement, name: string): boolean {
  return (element.attrs['class'] ?? '').split(/\s+/).includes(name);
}

function asinFrom(url: string): string | null {
  const match = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i.exec(url);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Search page → listings
// ---------------------------------------------------------------------------

export function parseAmazonSearch(html: string, pageUrl: string): PageCandidates {
  const elements = parseElements(html);
  const seenAt = new Date();
  const items: DiscoveredListing[] = [];
  const seenAsins = new Set<string>();

  for (const card of elements) {
    if (card.attrs['data-component-type'] !== 's-search-result') continue;
    const asin = card.attrs['data-asin'] ?? '';
    if (!ASIN_PATTERN.test(asin) || seenAsins.has(asin)) continue;

    const children = inside(elements, card);
    const titleEl = children.find((el) => el.name === 'h2');
    const priceEl = children.find((el) => hasClass(el, 'a-offscreen'));
    const price = priceEl ? parsePriceToMinor(elementText(html, priceEl)) : null;
    const title = titleEl ? elementText(html, titleEl) : '';
    if (title === '') continue;

    seenAsins.add(asin);
    items.push({
      sourceDomain: 'amazon.com',
      sourceId: asin,
      url: `https://www.amazon.com/dp/${asin}`,
      priceHint: price?.minor ?? null,
      titleHint: title,
      seenAt,
    });
  }

  const nav = new Set<string>();
  for (const el of elements) {
    if (el.name !== 'a') continue;
    const href = resolveUrl(el.attrs['href'], pageUrl);
    if (href === null) continue;
    // Pagination and department/browse links are the surfaces worth walking;
    // everything else on a results page is furniture.
    if (el.attrs['class']?.includes('s-pagination') || /\/(s\?|b\/|gp\/bestsellers)/.test(href)) {
      nav.add(href.split('#')[0] as string);
    }
  }

  return { items, nav: [...nav] };
}

// ---------------------------------------------------------------------------
// Detail page → ParsedProduct
// ---------------------------------------------------------------------------

const SPEC_KEY_MAP: Record<string, string> = {
  'item model number': 'mpn',
  'model number': 'mpn',
  manufacturer: 'brand',
  upc: 'upc',
  ean: 'ean',
};

export function parseAmazonDetail(html: string, pageUrl: string): ParsedProduct {
  const elements = parseElements(html);
  const out = emptyParsed('json-ld'); // strategy label only; merge overrides it
  out.strategy = 'merged';

  const titleEl = findById(elements, 'productTitle');
  if (titleEl) out.title = elementText(html, titleEl);

  const brandEl = findById(elements, 'bylineInfo');
  if (brandEl) {
    const raw = elementText(html, brandEl);
    const brand = /brand:?\s*(.+)/i.exec(raw)?.[1]
      ?? /visit the (.+?) store/i.exec(raw)?.[1]
      ?? raw;
    out.brand = brand.trim() || null;
  }

  // Price lives in one of the core-price containers; the first `.a-offscreen`
  // inside it is the rendered amount.
  const priceRoot =
    elements.find((el) => /^corePrice|^priceblock|^price_inside_buybox|^apex/i.test(el.attrs['id'] ?? ''))
    ?? findById(elements, 'ppd');
  if (priceRoot) {
    const priceEl = inside(elements, priceRoot).find((el) => hasClass(el, 'a-offscreen'));
    if (priceEl) {
      const text = elementText(html, priceEl);
      const price = parsePriceToMinor(text);
      if (price) {
        out.priceText = text;
        out.priceAmountMinor = price.minor;
        out.currency = price.currency ?? 'USD';
      }
    }
  }

  // The struck-through list price is a `.a-text-price`; whatever it shows first
  // is the "was" number.
  const listEl = elements.find((el) => hasClass(el, 'a-text-price'));
  if (listEl) {
    const offscreen = inside(elements, listEl).find((el) => hasClass(el, 'a-offscreen'));
    if (offscreen) {
      const original = parsePriceToMinor(elementText(html, offscreen), out.currency);
      if (original && original.minor !== out.priceAmountMinor) {
        out.originalPriceText = elementText(html, offscreen);
        out.originalPriceAmountMinor = original.minor;
      }
    }
  }

  const availabilityEl = findById(elements, 'availability');
  if (availabilityEl) {
    const text = elementText(html, availabilityEl);
    out.availabilityText = text;
    const left = /only (\d+) left/i.exec(text);
    if (left?.[1]) out.quantity = Number.parseInt(left[1], 10);
  }

  // Gallery URLs are the keys of the data-a-dynamic-image map: {url: [w,h]}.
  const seenImages = new Set<string>();
  for (const el of elements) {
    const dynamic = el.attrs['data-a-dynamic-image'];
    if (dynamic === undefined) continue;
    try {
      const map = JSON.parse(dynamic) as Record<string, [number, number]>;
      for (const [rawUrl, dims] of Object.entries(map)) {
        const url = resolveUrl(rawUrl, pageUrl);
        if (url === null || seenImages.has(url)) continue;
        seenImages.add(url);
        out.images.push({ url, width: dims[0] ?? 0, height: dims[1] ?? 0 });
      }
    } catch {
      const url = resolveUrl(el.attrs['src'] ?? el.attrs['data-old-hires'], pageUrl);
      if (url !== null && !seenImages.has(url)) {
        seenImages.add(url);
        out.images.push({ url, width: 0, height: 0 });
      }
    }
  }

  const bullets = findById(elements, 'feature-bullets');
  if (bullets) {
    const lines = inside(elements, bullets)
      .filter((el) => el.name === 'li')
      .map((el) => elementText(html, el))
      .filter((line) => line !== '' && !/make sure this fits/i.test(line));
    if (lines.length > 0) out.description = lines.join(' ');
  }

  const crumbs = findById(elements, 'wayfinding-breadcrumbs_feature_div');
  if (crumbs) {
    out.breadcrumb = inside(elements, crumbs)
      .filter((el) => el.name === 'a')
      .map((el) => elementText(html, el))
      .filter((text) => text !== '');
  }

  // Specs come from the product-details tables and the detail bullets list.
  const specKeys = new Set<string>();
  const pushSpec = (key: string, value: string): void => {
    const normalized = key.toLowerCase().trim();
    const specKey = SPEC_KEY_MAP[normalized] ?? normalized;
    if (specKey === '' || value === '' || specKeys.has(specKey)) return;
    specKeys.add(specKey);
    if (specKey === 'brand' && out.brand === null) out.brand = value;
    else if (specKey === 'mpn') out.identifiers.mpn ??= value;
    else if (specKey === 'upc') out.identifiers.upc ??= value;
    else if (specKey === 'ean') out.identifiers.ean ??= value;
    else out.specs.push({ key, value });
  };
  for (const row of elements.filter((el) => el.name === 'tr')) {
    const cells = inside(elements, row);
    const th = cells.find((el) => el.name === 'th');
    const td = cells.find((el) => el.name === 'td');
    if (th && td) pushSpec(elementText(html, th), elementText(html, td));
  }
  const detailBullets = findById(elements, 'detailBullets_feature_div');
  if (detailBullets) {
    for (const li of inside(elements, detailBullets).filter((el) => el.name === 'li')) {
      const [key, ...rest] = elementText(html, li).split(':');
      if (key && rest.length > 0) pushSpec(key, rest.join(':').trim());
    }
  }

  const merchant = findById(elements, 'merchant-info');
  const merchantText = merchant ? elementText(html, merchant) : '';
  const soldBy = /sold by\s+(.+?)(?:\s+and|\s+in|$)/i.exec(merchantText)?.[1]?.trim() ?? 'Amazon';
  out.seller = {
    sourceSellerId: soldBy,
    handle: soldBy,
    displayName: soldBy,
    type: 'retailer',
    avatarUrl: null,
    profileUrl: pageUrl,
    rating: null,
    ratingScale: 5,
    reviewCount: 0,
    salesCount: 0,
    memberSince: null,
    responseTime: null,
    returnWindowDays: 30,
    shippingSummary: null,
    buyerPremiumPct: null,
    listingCount: 0,
  };

  const ratingEl = findById(elements, 'acrPopover');
  const countEl = findById(elements, 'acrCustomerReviewText');
  if (ratingEl || countEl) {
    const ratingText = ratingEl?.attrs['title'] ?? '';
    const value = Number.parseFloat(/([\d.]+) out of/.exec(ratingText)?.[1] ?? '');
    const count = Number.parseInt((countEl ? elementText(html, countEl) : '').replace(/\D/g, ''), 10);
    if (Number.isFinite(value)) {
      out.aggregateRating = { value, scale: 5, count: Number.isFinite(count) ? count : 0 };
    }
  }

  const canonical = elements.find(
    (el) => el.name === 'link' && el.attrs['rel']?.includes('canonical'),
  );
  const canonicalRaw = resolveUrl(canonical?.attrs['href'], pageUrl);

  const asin = asinFrom(canonicalRaw ?? '') ?? asinFrom(pageUrl)
    ?? elements.find((el) => ASIN_PATTERN.test(el.attrs['data-asin'] ?? ''))?.attrs['data-asin'];
  if (asin) out.identifiers.asin = asin;
  // Amazon sometimes canonicalizes to a /clp/ landing page; the dp URL is the
  // buyable page and the one refresh should revisit.
  out.canonicalUrl = asin ? `https://www.amazon.com/dp/${asin}` : canonicalRaw ?? pageUrl;

  out.conditionText = 'new';
  out.reviews = parseAmazonReviews(html, pageUrl);
  return out;
}

// ---------------------------------------------------------------------------
// "Customers say" — Amazon's own review aggregation
// ---------------------------------------------------------------------------

const SENTIMENT_RATING: Record<string, number> = { positive: 5, mixed: 3, negative: 1 };

function reviewFragmentText(fragments: unknown): string {
  if (!Array.isArray(fragments)) return '';
  const text = fragments
    .map((frag) => {
      if (typeof frag !== 'object' || frag === null) return '';
      const rec = frag as Record<string, unknown>;
      if (typeof rec['text'] === 'string') return rec['text'];
      const semantic = rec['semanticContent'];
      const content =
        typeof semantic === 'object' && semantic !== null
          ? (semantic as Record<string, unknown>)['content']
          : null;
      const inner =
        typeof content === 'object' && content !== null
          ? (content as Record<string, unknown>)['text']
          : null;
      return typeof inner === 'string' ? inner : '';
    })
    .join('');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Individual review pages are sign-in-gated, but the detail page embeds
 * Amazon's review aggregation in base64 "k-injected" component payloads: the
 * "Customers say" consensus, per-aspect summaries with sentiment and mention
 * counts, and real review excerpts each carrying the excerpted review's URL.
 * Entries carry no dates — Amazon does not ship them here — so `postedAt` is
 * the epoch, meaning "unknown". The consensus keeps the page's aggregate
 * rating; aspect verdicts map positive/mixed/negative onto 5/3/1; individual
 * excerpts carry `rating: null` — the payload does not say what the reviewer
 * actually gave, and the aspect's sentiment is not their star.
 */
export function parseAmazonReviews(html: string, pageUrl: string): RawReview[] {
  const reviews: RawReview[] = [];
  const seen = new Set<string>();
  const push = (entry: RawReview, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    reviews.push(entry);
  };

  const aggregate = Number.parseFloat(
    /acrPopover[^>]*title="([\d.]+) out of/.exec(html)?.[1] ?? '',
  );
  const unknownDate = new Date(0);

  for (const match of html.matchAll(/k\+b64\s+([A-Za-z0-9+/=]+)/g)) {
    let kdata: Record<string, unknown>;
    try {
      kdata =
        (JSON.parse(Buffer.from(match[1] as string, 'base64').toString('utf8')) as {
          'k-data'?: Record<string, unknown>;
        })['k-data'] ?? {};
    } catch {
      continue;
    }

    // The "Customers say" overall consensus — Amazon's typo'd field name.
    const fragments = Array.isArray(kdata['fragments']) ? kdata['fragments'] : [];
    for (const frag of fragments) {
      const text =
        typeof (frag as Record<string, unknown>)['inertText'] === 'string'
          ? ((frag as Record<string, unknown>)['inertText'] as string).replace(/\s+/g, ' ').trim()
          : '';
      if (text === '') continue;
      push(
        {
          rating: Number.isFinite(aggregate) ? aggregate : 0,
          ratingScale: 5,
          text,
          authorHandle: 'customers-say',
          verifiedPurchase: null,
          helpfulCount: 0,
          postedAt: unknownDate,
          sourceUrl: pageUrl,
        },
        `consensus:${text}`,
      );
    }

    const aspects = Array.isArray(kdata['aspectsFlattened']) ? kdata['aspectsFlattened'] : [];
    for (const raw of aspects) {
      if (typeof raw !== 'object' || raw === null) continue;
      const aspect = raw as Record<string, unknown>;
      const label = typeof aspect['label'] === 'string' ? aspect['label'] : '';
      const summary = typeof aspect['summary'] === 'string' ? aspect['summary'].trim() : '';
      const aspectRating = SENTIMENT_RATING[aspect['sentiment'] as string] ?? 3;
      const mentions = typeof aspect['mentions'] === 'number' ? aspect['mentions'] : 0;
      if (summary !== '') {
        push(
          {
            rating: aspectRating,
            ratingScale: 5,
            text: summary,
            // The label says what the aggregate entry is about: "aspect:build quality".
            authorHandle: `aspect:${label}`,
            verifiedPurchase: null,
            helpfulCount: mentions,
            postedAt: unknownDate,
            sourceUrl: pageUrl,
          },
          `aspect:${label}:${summary}`,
        );
      }
      const snippets = Array.isArray(aspect['snippets']) ? aspect['snippets'] : [];
      for (const snip of snippets) {
        if (typeof snip !== 'object' || snip === null) continue;
        const rec = snip as Record<string, unknown>;
        const review = rec['review'];
        const reviewPath =
          typeof review === 'object' && review !== null
            ? ((review as Record<string, unknown>)['url'] as string | undefined) ?? ''
            : '';
        const text = reviewFragmentText(
          typeof rec['text'] === 'object' && rec['text'] !== null
            ? (rec['text'] as Record<string, unknown>)['fragments']
            : null,
        );
        if (text === '') continue;
        push(
          {
            rating: null,
            ratingScale: 5,
            text,
            authorHandle: null,
            verifiedPurchase: null,
            helpfulCount: 0,
            postedAt: unknownDate,
            sourceUrl: resolveUrl(reviewPath, pageUrl) ?? pageUrl,
          },
          `snippet:${reviewPath}:${text}`,
        );
      }
    }
  }
  return reviews;
}

/** Amazon's removed-product answer is a 404 or the "Sorry!" dogs page. */
export function isAmazonRemoved(html: string, status: number): boolean {
  return status === 404 || /we couldn'?t find that page/i.test(html);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AmazonWebOptions {
  /** Search terms discovery walks; the agent may wander further from there. */
  terms: string[];
  pagesPerTerm: number;
  tld: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export const AMAZON_WEB_DEFAULT_TERMS = [
  'running sneakers',
  'wireless headphones',
  'mechanical keyboard',
  'espresso machine',
  'denim jacket',
  'desk lamp',
];

export class AmazonWebAdapter implements WebSourceAdapter {
  readonly tier = 2 as const;
  readonly domain: string;
  readonly terms: string[];
  readonly pagesPerTerm: number;
  private readonly tld: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(source: SourceDoc<string>, options: Partial<AmazonWebOptions> = {}) {
    this.domain = source._id;
    this.terms = options.terms ?? AMAZON_WEB_DEFAULT_TERMS;
    this.pagesPerTerm = options.pagesPerTerm ?? 1;
    this.tld = options.tld ?? 'com';
    this.fetchImpl = options.fetchImpl ?? primedFetch;
    this.now = options.now ?? (() => new Date());
  }

  private searchUrl(term: string, page: number): string {
    return `https://www.amazon.${this.tld}/s?k=${encodeURIComponent(term)}&page=${page}`;
  }

  /**
   * The cursor is `termIndex:page` — stateless, so any caller can resume a
   * walk without shared state.
   */
  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const [termIndex, page] = (cursor ?? '0:1').split(':').map((n) => Number.parseInt(n, 10) || 0);
    const term = this.terms[termIndex ?? 0];
    if (term === undefined) return { listings: [], nextCursor: null };

    const pageNum = page === 0 || page === undefined ? 1 : page;
    const fetched = await fetchPage(this.searchUrl(term, pageNum), context, this.domain, this.fetchImpl);
    if (fetched.status >= 400) {
      throw new SourceUnavailableError(
        this.domain,
        'blocked',
        `search page ${term} p${pageNum} returned ${fetched.status}`,
      );
    }

    const { items } = parseAmazonSearch(fetched.body, fetched.url);
    const nextPage = pageNum + 1;
    const nextTerm = (termIndex ?? 0) + 1;
    const nextCursor =
      nextPage <= this.pagesPerTerm
        ? `${termIndex}:${nextPage}`
        : nextTerm < this.terms.length
          ? `${nextTerm}:1`
          : null;
    return { listings: items, nextCursor };
  }

  candidatesFromPage(html: string, pageUrl: string): PageCandidates {
    if (pageUrl.includes('/s?') || pageUrl.includes('/s/')) {
      return parseAmazonSearch(html, pageUrl);
    }
    // A detail page's follow-up surface is its variants and related searches;
    // the agent mainly lands here when a listing URL resolves to it.
    return { items: [], nav: [] };
  }

  private async detail(listing: { sourceId: string; url: string }, context: CrawlContext): Promise<{
    page: FetchedPage;
    parsed: ParsedProduct;
  } | null> {
    const asin = asinFrom(listing.url) ?? listing.sourceId;
    const url = ASIN_PATTERN.test(asin) ? `https://www.amazon.${this.tld}/dp/${asin}` : listing.url;
    const page = await fetchPage(url, context, this.domain, this.fetchImpl);
    if (page.status >= 400 || isAmazonRemoved(page.body, page.status)) return null;
    const parsed = mergeParsed([parseAmazonDetail(page.body, page.url), extractFromHtml(page.body, page.url)]);
    return { page, parsed };
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    const found = await this.detail(listing, context);
    if (!found || found.parsed.title === null) {
      log.debug('no title on detail page', { url: listing.url });
      return null;
    }
    return toRawListing(found.parsed, {
      domain: this.domain,
      tier: this.tier,
      sourceType: 'new',
      sourceId: found.parsed.identifiers.asin ?? listing.sourceId,
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
    const found = await this.detail(listing, context);
    if (found === null) {
      return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
    }
    const { parsed } = found;
    if (parsed.title === null && parsed.priceAmountMinor === null) return null;
    return {
      inStock: parsed.availabilityText === null ? true : isInStock(parsed.availabilityText),
      priceAmountMinor: parsed.priceAmountMinor,
      currency: parsed.currency,
      quantity: parsed.quantity,
      removed: false,
    };
  }
}
