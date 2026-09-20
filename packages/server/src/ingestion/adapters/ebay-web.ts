/**
 * eBay's storefront, read directly.
 *
 * eBay's item pages serve JSON-LD — a `WebPage` whose `mainEntity` is a
 * `WebPageElement` holding an `Offer` of `itemOffered` Products, each inner
 * offer carrying a `?iid=<itemId>` URL. Search (`/sch/`) sits behind Akamai's
 * interstitial even on a primed session, but browse pages (`/b/`, `/globaldeals`)
 * and item pages (`/itm/`) serve fine, so discovery walks category pages and
 * the agent picks the threads worth pulling.
 *
 * Parsers are exported and pure, per the tier-2 convention.
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
  type RawSeller,
  type WebSourceAdapter,
} from '../types.js';
import {
  decodeEntities,
  emptyParsed,
  fetchPage,
  isInStock,
  mergeParsed,
  normalizeSchemaEnum,
  parseElements,
  parseOpenGraph,
  parsePriceToMinor,
  resolveUrl,
  toRawListing,
  type FetchLike,
  type HtmlElement,
  type Json,
  type ParsedProduct,
} from './tier2-structured.js';
import { primedFetch } from './primed-fetch.js';

const log = logger.child('ingestion.ebay-web');

const ITEM_ID_PATTERN = /\/itm\/(?:[^/\s?]+\/)?(\d{6,})/;

function itemIdFrom(url: string): string | null {
  return ITEM_ID_PATTERN.exec(url)?.[1] ?? null;
}

function elementText(html: string, element: HtmlElement): string {
  const raw = html.slice(element.contentStart, Math.max(element.contentStart, element.contentEnd));
  // Script and style bodies are not text. Stripping only the tags left their
  // contents behind, so Amazon's `#availability` — which carries an inline
  // `a-state` script beside the words — read as `In Stock {"isInternal":...}`
  // and matched no stock token, marking every live listing out of stock.
  const withoutCode = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  return decodeEntities(withoutCode.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function inside(elements: HtmlElement[], root: HtmlElement): HtmlElement[] {
  return elements.filter((el) => el.start >= root.contentStart && el.start < root.contentEnd);
}

// ---------------------------------------------------------------------------
// Browse page → listings
// ---------------------------------------------------------------------------

export function parseEbayBrowse(html: string, pageUrl: string): PageCandidates {
  const elements = parseElements(html);
  const seenAt = new Date();
  const items: DiscoveredListing[] = [];
  const seenIds = new Set<string>();

  // Cards are li.brwrvr__item-card (browse) or plain anchors to /itm/ elsewhere;
  // the anchor is the reliable constant, so each item is found through its link
  // and titled from the card's image alt when one exists.
  for (const anchor of elements) {
    if (anchor.name !== 'a') continue;
    const href = anchor.attrs['href'];
    if (!href) continue;
    const id = itemIdFrom(href);
    if (id === null || seenIds.has(id)) continue;

    // The card's image alt carries the listing title; the anchor's own text is
    // usually empty because the link wraps the image.
    const siblings = inside(elements, anchor);
    const image = siblings.find((el) => el.name === 'img' && (el.attrs['alt'] ?? '') !== '');
    const alt = image?.attrs['alt']?.replace(/ - Image \d+ of \d+$/, '') ?? null;
    // Cards lazy-load: `src` holds a spacer gif until script runs, and the
    // real thumbnail sits in `data-src`. Take that, and refuse the spacer.
    const imageSrc = decodeEntities(image?.attrs['data-src'] ?? image?.attrs['src'] ?? '');
    const imageHint = imageSrc !== '' && !/ebaystatic\.com\/cr\//.test(imageSrc) ? imageSrc : null;

    const priceEl = elements.find(
      (el) =>
        el.start > anchor.start &&
        el.start < anchor.start + 40_000 &&
        el.name === 'span' &&
        (el.attrs['class'] ?? '').includes('price'),
    );
    const price = priceEl ? parsePriceToMinor(elementText(html, priceEl)) : null;

    seenIds.add(id);
    items.push({
      sourceDomain: 'ebay.com',
      sourceId: id,
      url: `https://www.ebay.com/itm/${id}`,
      priceHint: price?.minor ?? null,
      titleHint: alt,
      imageHint,
      seenAt,
    });
  }

  const nav = new Set<string>();
  for (const el of elements) {
    if (el.name !== 'a') continue;
    const href = resolveUrl(el.attrs['href'], pageUrl);
    if (href === null) continue;
    if (/\/b\/[^/]+\/bn_|\/globaldeals/.test(href)) {
      nav.add(href.split('#')[0] as string);
    }
  }

  return { items, nav: [...nav] };
}

// ---------------------------------------------------------------------------
// Item page → ParsedProduct
// ---------------------------------------------------------------------------

/** Depth-bounded walk over every JSON-LD node, not just the schema.org spine. */
function* walkJson(node: unknown, depth = 0): Generator<Record<string, Json>> {
  if (depth > 10 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) yield* walkJson(entry, depth + 1);
    return;
  }
  const record = node as Record<string, Json>;
  yield record;
  for (const value of Object.values(record)) yield* walkJson(value, depth + 1);
}

function jsonText(value: Json | undefined): string | null {
  if (typeof value === 'string') {
    const trimmed = decodeEntities(value).trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

function jsonNumber(value: Json | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asArray(value: Json | undefined): Record<string, Json>[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is Record<string, Json> => typeof entry === 'object' && entry !== null,
  );
}

export function parseEbayItem(html: string, pageUrl: string, itemId: string): ParsedProduct {
  const out = emptyParsed('json-ld');
  const elements = parseElements(html);

  for (const block of elements) {
    if (block.name !== 'script' || !(block.attrs['type'] ?? '').toLowerCase().includes('ld+json')) {
      continue;
    }
    const body = html.slice(block.contentStart, Math.max(block.contentStart, block.contentEnd));
    let root: Json;
    try {
      root = JSON.parse(body) as Json;
    } catch {
      continue;
    }

    for (const node of walkJson(root)) {
      const type = jsonText(node['@type'])?.toLowerCase();
      if (type === 'breadcrumblist') {
        const crumbs = asArray(node['itemListElement'])
          .map((entry) => jsonText(entry['name']) ?? '')
          .filter((name) => name !== '' && name !== 'eBay');
        if (crumbs.length > out.breadcrumb.length) out.breadcrumb = crumbs;
        continue;
      }
      if (type !== 'product') continue;

      out.title ??= jsonText(node['name']);
      out.brand ??= jsonText(node['brand']);
      out.canonicalUrl ??= resolveUrl(jsonText(node['url']), pageUrl) ?? pageUrl;
      out.identifiers.mpn ??= jsonText(node['mpn']);
      out.identifiers.gtin ??= jsonText(node['gtin13'] ?? node['gtin']);
      out.identifiers.ean ??= jsonText(node['gtin13']);
      out.identifiers.upc ??= jsonText(node['gtin12'] ?? node['upc']);

      // `image` arrives as a string, a string array, or objects with url —
      // eBay emits the string array.
      const imageRaw = node['image'];
      const imageEntries = Array.isArray(imageRaw) ? imageRaw : imageRaw === undefined ? [] : [imageRaw];
      for (const entry of imageEntries) {
        const text = typeof entry === 'string'
          ? entry
          : jsonText(asArray(entry as Json)[0]?.['url'] ?? (entry as Record<string, Json>)?.['url']);
        const url = resolveUrl(text, pageUrl);
        if (url !== null && !out.images.some((i) => i.url === url)) {
          out.images.push({ url, width: 0, height: 0 });
        }
      }

      // This item's offer is the one whose url names our item id; a product
      // graph lists every live seller's offer, and the first is not ours.
      for (const offer of asArray(node['offers'])) {
        const offerUrl = jsonText(offer['url']);
        const ours = offerUrl !== null && itemIdFrom(offerUrl) === itemId;
        const chosen = out.priceAmountMinor === null ? offer : ours ? offer : null;
        if (chosen === null) continue;
        const price = parsePriceToMinor(
          jsonText(chosen['price']), jsonText(chosen['priceCurrency']),
        );
        if (price !== null) {
          out.priceAmountMinor = price.minor;
          out.priceText = jsonText(chosen['price']) ?? String(price.minor);
          out.currency = price.currency ?? jsonText(chosen['priceCurrency']);
        }
        out.conditionText ??= normalizeSchemaEnum(jsonText(chosen['itemCondition']));
        out.availabilityText ??= normalizeSchemaEnum(jsonText(chosen['availability']));
        const shipping = asArray(chosen['shippingDetails'])[0];
        const rate = shipping ? asArray(shipping['shippingRate'])[0] ?? shipping['shippingRate'] : undefined;
        if (rate && typeof rate === 'object') {
          const amount = parsePriceToMinor(
            jsonText((rate as Record<string, Json>)['value']),
            jsonText((rate as Record<string, Json>)['currency']) ?? out.currency,
          );
          if (amount !== null) {
            out.shippingAmountMinor = amount.minor;
            out.shippingText = jsonText((rate as Record<string, Json>)['value']);
          }
        }
      }
    }
  }

  // Seller. The sellercard's visible anchors are store/chevron furniture; the
  // /usr/ anchors elsewhere on the page are review authors, not the seller.
  // The username only appears in embedded links and JSON state — the feedback
  // tab's mweb_profile URL, the feedback_profile action, the itmdesc iframe's
  // seller= param, or the USER_PROFILE nav action — so those come first.
  const username =
    /fdbk\/mweb_profile\?[^"'\s]*?username=([A-Za-z0-9._~-]+)/.exec(html)?.[1] ??
    /feedback_profile\/([A-Za-z0-9._~-]+)/.exec(html)?.[1] ??
    /itmdesc\/\d+\?[^"'\s]*?[&?]seller=([A-Za-z0-9._~-]+)/.exec(html)?.[1] ??
    /"name":"USER_PROFILE".{0,300}?"username":"([^"\\]+)"/.exec(html)?.[1] ??
    /"URL":"[^"]*?\/usr\/([^"?\s\\]+)/.exec(html)?.[1] ??
    null;

  // Anchors inside a review card name its author — exclude them so a reviewer
  // is never mistaken for the seller on layouts that do link the seller.
  const reviewBlocks = elements.filter((el) =>
    (el.attrs['class'] ?? '').includes('x-review-section'));
  const insideReview = (el: HtmlElement): boolean =>
    reviewBlocks.some((r) => el.start >= r.start && el.start < r.contentEnd);
  const sellerLink =
    elements.find(
      (el) =>
        el.name === 'a' && /ebay\.com\/usr\//.test(el.attrs['href'] ?? '') && !insideReview(el),
    ) ??
    elements.find(
      (el) =>
        el.name === 'a' &&
        /ebay\.com\/str\//.test(el.attrs['href'] ?? '') &&
        elementText(html, el).length > 2 &&
        !insideReview(el),
    );
  const linkSlug = sellerLink
    ? decodeURIComponent((sellerLink.attrs['href'] ?? '').split('/').filter(Boolean).pop() ?? '')
    : '';

  // The card's data items read "Name (feedbackScore)" and "NN.N% positive
  // feedback" — the lifetime score and the positive share, both real metrics.
  // Other layouts split them into separate spans; the name itself is most
  // reliable from the embedded JSON ("sellerName"), since bare card text also
  // carries CTA labels like "Seller's other items".
  let displayName: string | null =
    /"sellerName".{0,300}?"text":"([^"\\]+)"/.exec(html)?.[1] ?? null;
  let feedbackScore: number | null = null;
  let positivePct: number | null = null;
  for (const item of elements) {
    if (!(item.attrs['class'] ?? '').includes('x-sellercard-atf__data-item')) continue;
    const text = elementText(html, item);
    const named = /^(.*?)\s*\(([\d,]+)\)\s*$/.exec(text);
    if (named) {
      displayName ??= (named[1] ?? '').trim() || null;
      const score = Number.parseInt((named[2] ?? '').replace(/,/g, ''), 10);
      if (Number.isFinite(score)) feedbackScore = score;
      continue;
    }
    const pct = /([\d.]+)\s*%\s*positive/i.exec(text);
    if (pct) positivePct = Number.parseFloat(pct[1] as string);
  }
  if (feedbackScore === null) {
    const embedded = /"sellerNameDataItems".{0,300}?"text":"\(([\d,]+)\)"/.exec(html);
    const score = embedded ? Number.parseInt((embedded[1] ?? '').replace(/,/g, ''), 10) : NaN;
    feedbackScore = Number.isFinite(score) ? score : null;
  }

  const handle = username ?? linkSlug;
  const linkText = sellerLink ? elementText(html, sellerLink) : '';
  const name = displayName ?? (linkText.length > 2 ? linkText : handle);
  if (handle !== '' || name !== '') {
    out.seller = {
      sourceSellerId: handle || name,
      handle: handle || name,
      displayName: name || handle || 'eBay seller',
      type: 'individual',
      avatarUrl: null,
      // The JSON-embedded username is the only canonical profile URL; a /str/
      // store slug is not the member name, so keep the raw href for those.
      profileUrl:
        username !== null
          ? `https://www.ebay.com/usr/${encodeURIComponent(username)}`
          : (sellerLink?.attrs['href'] ?? pageUrl),
      rating: positivePct,
      ratingScale: 100,
      reviewCount: feedbackScore ?? 0,
      salesCount: 0,
      memberSince: null,
      responseTime: null,
      returnWindowDays: null,
      shippingSummary: null,
      buyerPremiumPct: null,
      listingCount: 0,
    };
  }

  // `x-price-primary` is the rendered price block; it rescues pages whose
  // JSON-LD names a different offer than the one being viewed.
  if (out.priceAmountMinor === null) {
    const primary = elements.find(
      (el) => (el.attrs['class'] ?? '').split(/\s+/).includes('x-price-primary'),
    );
    if (primary) {
      const price = parsePriceToMinor(elementText(html, primary));
      if (price) {
        out.priceAmountMinor = price.minor;
        out.priceText = elementText(html, primary);
        out.currency = price.currency ?? 'USD';
      }
    }
  }

  return out;
}

/** An ended eBay listing serves the page with a "this listing has ended" banner. */
export function isEbayEnded(html: string, status: number): boolean {
  return status === 404 || /this listing (has ended|was ended|is no longer available)/i.test(html);
}

// ---------------------------------------------------------------------------
// Feedback profile → seller reviews
// ---------------------------------------------------------------------------

/**
 * The WHEN column is a coarse bucket, not a date: "Past month", "Past 6
 * months", "Past year". Approximate it to the bucket's far edge — a feedback
 * ordering matters more than its exact day — and try a real date parse first
 * in case a layout serves one.
 */
const WHEN_APPROX_DAYS: Array<[RegExp, number]> = [
  [/past month|within (the )?last month/i, 30],
  [/past 6 months/i, 180],
  [/past year/i, 365],
  [/(over|more than) (a|1) year|over \d+ years?/i, 545],
];

function feedbackPostedAt(label: string, now: Date): Date {
  const parsed = Date.parse(label);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  for (const [pattern, days] of WHEN_APPROX_DAYS) {
    if (pattern.test(label)) return new Date(now.getTime() - days * 86_400_000);
  }
  return now;
}

/**
 * Reads `www.ebay.com/fdbk/feedback_profile/<handle>`: one `tr` per entry,
 * carrying a positive/neutral/negative verdict, the comment, the masked
 * author and a coarse age. The verdict maps onto the pipeline's 5-point scale
 * as 5/3/1 — that is a choice, not a measurement, but it keeps seller
 * feedback commensurable with starred reviews downstream.
 */
export function parseEbayFeedbackProfile(
  html: string,
  profileUrl: string,
  now: Date = new Date(),
): RawReview[] {
  const elements = parseElements(html);
  const reviews: RawReview[] = [];

  for (const row of elements) {
    if (row.name !== 'tr') continue;
    const feedbackId = row.attrs['data-feedback-id'];
    if (feedbackId === undefined) continue;
    const parts = inside(elements, row);
    const rowHtml = html.slice(row.start, row.contentEnd);

    const verdict = parts.find((el) => el.attrs['data-test-type'] !== undefined)
      ?.attrs['data-test-type'];
    const rating =
      verdict === 'positive' ? 5 : verdict === 'neutral' ? 3 : verdict === 'negative' ? 1 : null;
    if (rating === null) continue;

    const commentEl = parts.find((el) =>
      (el.attrs['class'] ?? '').split(/\s+/).includes('card__comment'));
    const text = commentEl ? elementText(html, commentEl) : '';
    if (text === '') continue;

    const fromEl = parts.find((el) => (el.attrs['class'] ?? '').includes('card__from'));
    const fromText = fromEl ? elementText(html, fromEl) : '';
    const author = /(?:buyer|seller)\s*:\s*(\S+)/i.exec(fromText)?.[1] ?? null;

    // The WHEN cell is the last td; its span's aria-label carries the bucket.
    const whenEl = parts.find((el) =>
      WHEN_APPROX_DAYS.some(([pattern]) => pattern.test(el.attrs['aria-label'] ?? '')));

    reviews.push({
      rating,
      ratingScale: 5,
      text,
      authorHandle: author,
      // eBay stamps "Verified purchase" on entries backed by a transaction.
      verifiedPurchase: /verified purchase/i.test(rowHtml) ? true : null,
      helpfulCount: 0,
      postedAt: feedbackPostedAt(
        whenEl ? (whenEl.attrs['aria-label'] ?? elementText(html, whenEl)) : '',
        now,
      ),
      sourceUrl: `${profileUrl}#${feedbackId}`,
    });
  }
  return reviews;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface EbayWebOptions {
  /** Browse URLs discovery starts from; the agent wanders on from these. */
  seeds: string[];
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/**
 * eBay's robots.txt advertises the BROWSE sitemap index — 504 child sitemaps
 * of leaf `/b/` pages, which are the surfaces it wants crawled and which serve
 * real item grids. `/globaldeals` is the other reliable live seed. Generic
 * category pages like `/b/Headphones` are deliberately absent: eBay fills
 * their grids with sponsored junk for unrecognized sessions.
 */
export const EBAY_WEB_DEFAULT_SEEDS = [
  'https://www.ebay.com/lst/BROWSE-0-index.xml',
  'https://www.ebay.com/globaldeals',
];

export class EbayWebAdapter implements WebSourceAdapter {
  readonly tier = 2 as const;
  readonly domain: string;
  readonly seeds: string[];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(source: SourceDoc<string>, options: Partial<EbayWebOptions> = {}) {
    this.domain = source.id;
    this.seeds = options.seeds ?? EBAY_WEB_DEFAULT_SEEDS;
    this.fetchImpl = options.fetchImpl ?? primedFetch;
    this.now = options.now ?? (() => new Date());
  }

  /** The cursor is the index into `seeds` — one page per seed. */
  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    const index = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    const seed = this.seeds[Number.isFinite(index) ? index : 0];
    if (seed === undefined) return { listings: [], nextCursor: null };

    const page = await fetchPage(seed, context, this.domain, this.fetchImpl);
    if (page.status >= 400) {
      throw new SourceUnavailableError(this.domain, 'blocked', `seed ${seed} returned ${page.status}`);
    }
    const { items } = parseEbayBrowse(page.body, page.url);
    const next = index + 1;
    return { listings: items, nextCursor: next < this.seeds.length ? String(next) : null };
  }

  candidatesFromPage(html: string, pageUrl: string): PageCandidates {
    return parseEbayBrowse(html, pageUrl);
  }

  private async detail(
    listing: { sourceId: string; url: string },
    context: CrawlContext,
  ): Promise<{ parsed: ParsedProduct; status: number } | null> {
    const id = itemIdFrom(listing.url) ?? listing.sourceId;
    const url = `https://www.ebay.com/itm/${id}`;
    const page = await fetchPage(url, context, this.domain, this.fetchImpl);
    if (isEbayEnded(page.body, page.status)) return null;
    if (page.status >= 400) {
      log.debug('item fetch returned an error status', { url, status: page.status });
      return null;
    }
    const parsed = mergeParsed([parseEbayItem(page.body, page.url, id), parseOpenGraph(page.body, page.url)]);
    return { parsed, status: page.status };
  }

  /**
   * Seller feedback is a second page — the member's feedback profile — so it
   * rides along on `fetchDetail` only: `verify` stays a cheap price-and-stock
   * read. A refused or empty profile costs the listing nothing.
   */
  private async sellerFeedback(seller: RawSeller | null, context: CrawlContext): Promise<RawReview[]> {
    const raw = seller ? /\/usr\/([^/?]+)/.exec(seller.profileUrl)?.[1] : undefined;
    if (raw === undefined) return [];
    const url = `https://www.ebay.com/fdbk/feedback_profile/${decodeURIComponent(raw)}`;
    try {
      const page = await fetchPage(url, context, this.domain, this.fetchImpl);
      if (page.status >= 400) return [];
      return parseEbayFeedbackProfile(page.body, url, this.now());
    } catch (error) {
      log.debug('feedback profile fetch failed', { url, error: (error as Error).message });
      return [];
    }
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    const found = await this.detail(listing, context);
    if (!found || found.parsed.title === null) {
      log.debug('no product data on item page', { url: listing.url });
      return null;
    }
    const parsed = found.parsed;
    parsed.reviews = [...parsed.reviews, ...(await this.sellerFeedback(parsed.seller, context))];
    return toRawListing(parsed, {
      domain: this.domain,
      tier: this.tier,
      sourceType: 'secondhand',
      sourceId: itemIdFrom(listing.url) ?? listing.sourceId,
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
      inStock: isInStock(parsed.availabilityText),
      priceAmountMinor: parsed.priceAmountMinor,
      currency: parsed.currency,
      quantity: parsed.quantity,
      removed: false,
    };
  }
}
