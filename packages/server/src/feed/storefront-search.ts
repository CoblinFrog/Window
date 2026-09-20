/**
 * The chat retrieval leg: ask Amazon and eBay directly, once, in parallel.
 *
 * This is the whole storefront surface the assistant is allowed to see. Two
 * search pages, two adapters we already own, and the cards they parse — title,
 * price, thumbnail, item URL — are enough to answer with. Nothing here fetches
 * a detail page, reads a sitemap, or asks a model where to look, because every
 * one of those costs seconds and the search card already carries what a pick
 * needs to render.
 *
 * The budget rides in the query string rather than being filtered out after
 * the fact: both storefronts sort and page by price, so a ceiling stated in
 * the URL returns a better first page than one applied to what came back.
 */

import { logger } from '../lib/logger.js';
import { parseAmazonSearch } from '../ingestion/adapters/amazon-web.js';
import { parseEbayBrowse } from '../ingestion/adapters/ebay-web.js';
import { primedFetch } from '../ingestion/adapters/primed-fetch.js';
import { fetchPage, type FetchLike } from '../ingestion/adapters/tier2-structured.js';
import type { CrawlContext, DiscoveredListing } from '../ingestion/types.js';

const log = logger.child('feed.storefront');

/** The only domains the assistant retrieves from. */
export const STOREFRONTS = ['amazon.com', 'ebay.com'] as const;
export type Storefront = (typeof STOREFRONTS)[number];

/**
 * The registrable domain has to BE the storefront — `amazon` or `ebay`
 * followed by nothing but a public suffix. Subdomains and locales count
 * (`smile.amazon.com`, `ebay.co.uk`, `amazon.com.au`); a lookalike that only
 * contains the name does not, which is why the suffix is spelled out rather
 * than left as "letters and dots" — `amazon.evil.com` matches the loose
 * version and is exactly what this must refuse.
 */
const SUFFIX = String.raw`(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})`;
const AMAZON_HOST = new RegExp(String.raw`(^|\.)amazon\.${SUFFIX}$`);
const EBAY_HOST = new RegExp(String.raw`(^|\.)ebay\.${SUFFIX}$`);

export function storefrontOf(url: string | null): Storefront | null {
  if (url === null) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (AMAZON_HOST.test(host)) return 'amazon.com';
  if (EBAY_HOST.test(host)) return 'ebay.com';
  return null;
}

/** One search-result card, ready to render without any further fetch. */
export interface StorefrontCard {
  storefront: Storefront;
  sourceId: string;
  url: string;
  title: string;
  priceMinor: number | null;
  imageUrl: string | null;
  /** Star rating out of 5 as the card showed it; null when it showed none. */
  rating: number | null;
  /** How many ratings back that average. */
  reviewCount: number | null;
}

export interface StorefrontSearchDeps {
  fetchImpl?: FetchLike;
  /**
   * Wall-clock ceiling per storefront. A storefront that hasn't answered by
   * then is dropped, not waited on: half an answer now beats a whole one
   * after the user has given up.
   */
  timeoutMs?: number;
  /** Caller's own cancellation — an abandoned request shouldn't keep fetching. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 6_000;

/** Both requests go out at once, so pacing is per-domain and already honoured. */
const CONTEXT = (signal: AbortSignal): CrawlContext => ({
  rps: 1,
  concurrency: 1,
  proxyPool: 'none',
  signal,
});

export function amazonSearchUrl(query: string, budgetMinor: number | null): string {
  const params = new URLSearchParams({ k: query });
  // `p_36` is Amazon's price refinement and reads in cents: `-8000` is "up to
  // $80.00". Stated as a refinement it also keeps the department facets sane.
  if (budgetMinor !== null) params.set('rh', `p_36:-${budgetMinor}`);
  return `https://www.amazon.com/s?${params.toString()}`;
}

export function ebaySearchUrl(query: string, budgetMinor: number | null): string {
  const params = new URLSearchParams({ _nkw: query });
  // `_udhi` is eBay's "highest price", in whole currency units.
  if (budgetMinor !== null) params.set('_udhi', (budgetMinor / 100).toFixed(2));
  // Buy-It-Now only: an auction has no price a chat answer can quote.
  params.set('LH_BIN', '1');
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

/**
 * Search cards ship a thumbnail sized for a search grid — Amazon's is ~218px
 * tall, eBay's ~225px — and the app renders picks full-bleed. Both CDNs encode
 * the size in the filename and will serve any variant, so the larger one is a
 * string rewrite rather than another request. An unrecognised URL is returned
 * untouched: a small image beats a broken one.
 */
export function upscale(url: string | null): string | null {
  if (url === null || url === '') return null;
  // m.media-amazon.com/images/I/<id>._AC_UY218_.jpg → ._AC_UL1200_.jpg
  if (/(^|\.)media-amazon\.com\//.test(url)) {
    return url.replace(/\._[A-Za-z0-9_,]+_\.(jpg|jpeg|png|webp)$/i, '._AC_UL1200_.$1');
  }
  // i.ebayimg.com/images/g/<id>/s-l225.jpg → s-l1600.jpg
  if (/(^|\.)ebayimg\.com\//.test(url)) {
    return url.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.$1');
  }
  return url;
}

function toCards(storefront: Storefront, items: DiscoveredListing[]): StorefrontCard[] {
  const cards: StorefrontCard[] = [];
  for (const item of items) {
    const title = (item.titleHint ?? '').trim();
    if (title === '') continue;
    cards.push({
      storefront,
      sourceId: item.sourceId,
      url: item.url,
      title,
      priceMinor: item.priceHint,
      imageUrl: upscale(item.imageHint ?? null),
      rating: item.ratingHint ?? null,
      reviewCount: item.reviewCountHint ?? null,
    });
  }
  return cards;
}

async function searchOne(
  storefront: Storefront,
  url: string,
  deps: StorefrontSearchDeps,
): Promise<StorefrontCard[]> {
  const fetchImpl = deps.fetchImpl ?? primedFetch;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal =
    deps.signal === undefined ? timeout : AbortSignal.any([timeout, deps.signal]);
  const page = await fetchPage(url, CONTEXT(signal), storefront, fetchImpl);
  if (page.status >= 400) {
    log.debug('storefront search refused', { storefront, status: page.status });
    return [];
  }
  const parsed =
    storefront === 'amazon.com'
      ? parseAmazonSearch(page.body, page.url)
      : parseEbayBrowse(page.body, page.url);
  return toCards(storefront, parsed.items);
}

/**
 * Interleave the two storefronts so neither can fill the page on its own.
 * Amazon's results are usually the denser of the two, and a page of nothing
 * but Amazon is a worse answer than one that shows the shopper both markets.
 */
function interleave(lists: StorefrontCard[][], limit: number): StorefrontCard[] {
  const out: StorefrontCard[] = [];
  const seen = new Set<string>();
  const depth = Math.max(...lists.map((l) => l.length), 0);
  for (let i = 0; i < depth && out.length < limit; i += 1) {
    for (const list of lists) {
      const card = list[i];
      if (card === undefined || seen.has(card.url)) continue;
      seen.add(card.url);
      out.push(card);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Search both storefronts for `query` and return up to `limit` cards. A
 * storefront that fails, stalls, or gates us contributes nothing and is
 * logged; the other still answers, because one live market beats an error.
 */
export async function searchStorefronts(
  query: string,
  budgetMinor: number | null,
  limit: number,
  deps: StorefrontSearchDeps = {},
): Promise<StorefrontCard[]> {
  const trimmed = query.trim();
  if (trimmed === '' || limit < 1) return [];

  const legs: Array<[Storefront, string]> = [
    ['amazon.com', amazonSearchUrl(trimmed, budgetMinor)],
    ['ebay.com', ebaySearchUrl(trimmed, budgetMinor)],
  ];
  const settled = await Promise.allSettled(
    legs.map(([storefront, url]) => searchOne(storefront, url, deps)),
  );

  const lists: StorefrontCard[][] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i] as PromiseSettledResult<StorefrontCard[]>;
    const storefront = (legs[i] as [Storefront, string])[0];
    if (result.status === 'fulfilled') {
      lists.push(result.value);
      continue;
    }
    lists.push([]);
    log.warn('storefront search failed', {
      storefront,
      error: (result.reason as Error)?.message ?? String(result.reason),
    });
  }

  const cards = interleave(lists, limit);
  log.info('storefront search', {
    query: trimmed,
    budgetMinor,
    amazon: (lists[0] ?? []).length,
    ebay: (lists[1] ?? []).length,
    returned: cards.length,
  });
  return cards;
}
