/**
 * Point lookup: "here is a marketplace link — give me everything about it."
 *
 * The web adapters already know how to read both storefronts; this is the
 * narrow door over them so a caller (the click path, a test, a script) needs
 * nothing but the URL. A link that resolves to a dead or defunct listing says
 * so explicitly rather than coming back as an empty parse.
 */

import { logger } from '../lib/logger.js';
import { internetReviews, type ProductReviewDigest, type ReviewDeps } from '../agent/product-reviews.js';
import { isInStock } from './adapters/tier2-structured.js';
import type { FetchLike } from './adapters/tier2-structured.js';
import { primedFetch } from './adapters/primed-fetch.js';
import { AmazonWebAdapter } from './adapters/amazon-web.js';
import { EbayWebAdapter } from './adapters/ebay-web.js';
import { sourceById } from './sources.js';
import type { CrawlContext, RawListing, WebSourceAdapter } from './types.js';
import type { SourceDoc } from '@window/shared';

const log = logger.child('ingestion.lookup');

export type ListingStatus =
  | 'ok'            // full detail returned
  | 'out_of_stock'  // page exists, item cannot be bought right now
  | 'gone'          // listing removed or ended
  | 'unavailable'   // source refused or the page did not parse
  | 'unsupported';  // not a marketplace we read

export interface ListingLookup {
  status: ListingStatus;
  listing: RawListing | null;
  /**
   * What the internet says about the product, with citations. Research is
   * agented and slow, so it is fired in the background: the promise resolves
   * whenever it lands and the caller may await it or drop it. `null` means
   * the `reviews` dep is not wired.
   */
  digest: Promise<ProductReviewDigest | null> | null;
}

function domainFor(url: string): 'amazon.com' | 'ebay.com' | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)amazon\.[a-z.]+$/.test(host)) return 'amazon.com';
    if (/(^|\.)ebay\.[a-z.]+$/.test(host)) return 'ebay.com';
    return null;
  } catch {
    return null;
  }
}

function sourceIdFor(domain: 'amazon.com' | 'ebay.com', url: string): string {
  if (domain === 'amazon.com') {
    return /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i.exec(url)?.[1] ?? url;
  }
  return /\/itm\/(?:[^/\s?]+\/)?(\d{6,})/.exec(url)?.[1] ?? url;
}

const LOOKUP_CONTEXT: CrawlContext = { rps: 1, concurrency: 1, proxyPool: 'none' };

/** A minimal SourceDoc when the registry row is absent — the adapters only read `_id`. */
function syntheticSource(domain: string): SourceDoc<string> {
  return {
    _id: domain,
    displayName: domain,
    tier: 2,
    sourceType: domain === 'ebay.com' ? 'secondhand' : 'new',
    crawlPolicy: { rps: 1, concurrency: 1, allowedHours: [0, 24], proxyPool: 'none', backoff: 'exponential' },
    stalenessCeilingHours: 12,
    extractors: { listing: '', detail: '' },
    health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: null, window: [] },
    checkout: { supported: true, guestCheckout: false, blocksAgents: true, protocol: null, stackableCoupons: false },
    status: 'active',
  };
}

export interface LookupDeps {
  fetchImpl?: FetchLike;
  /** Adapter override, for tests or for sources added later. */
  adapterFor?: (domain: string, source: SourceDoc<string>) => WebSourceAdapter;
  /**
   * When provided, a successful lookup also researches the product across the
   * web — in the background; `digest` on the result resolves when it lands.
   * A `search` dep gathers evidence server-side so the model just summarizes;
   * without it the model needs WebSearch allowed and researches on its own.
   */
  reviews?: ReviewDeps;
  /**
   * How long a terminal answer (ok / out_of_stock / gone) is memoized.
   * Default 60s — a tap is a network call, a re-tap is a memory read.
   * Pass 0 to disable.
   */
  cacheTtlMs?: number;
}

const TERMINAL_STATUSES = new Set<ListingStatus>(['ok', 'out_of_stock', 'gone']);
const cache = new Map<string, { at: number; result: ListingLookup }>();

async function fetchLive(
  domain: 'amazon.com' | 'ebay.com',
  url: string,
  deps: LookupDeps,
): Promise<ListingLookup> {
  const source = sourceById(domain) ?? syntheticSource(domain);
  const adapter = deps.adapterFor
    ? deps.adapterFor(domain, source)
    : domain === 'amazon.com'
      ? new AmazonWebAdapter(source, { fetchImpl: deps.fetchImpl ?? primedFetch })
      : new EbayWebAdapter(source, { fetchImpl: deps.fetchImpl ?? primedFetch });

  const discovered = {
    sourceDomain: domain,
    sourceId: sourceIdFor(domain, url),
    url,
    priceHint: null,
    seenAt: new Date(),
  };

  let listing: RawListing | null;
  try {
    listing = await adapter.fetchDetail(discovered, LOOKUP_CONTEXT);
  } catch (error) {
    log.warn('lookup fetch failed', { url, error: (error as Error).message });
    listing = null;
  }
  if (listing !== null) {
    const inStock = listing.availabilityText === null || isInStock(listing.availabilityText);
    let digest: Promise<ProductReviewDigest | null> | null = null;
    if (deps.reviews !== undefined) {
      // Not awaited: the lookup resolves on the listing and the research
      // overlaps whatever the caller does next.
      digest = internetReviews(
        { title: listing.title, brand: listing.brand, sourceDomain: domain, url },
        deps.reviews,
      ).catch((error) => {
        log.warn('review digest failed', { url, error: (error as Error).message });
        return null;
      });
    }
    return { status: inStock ? 'ok' : 'out_of_stock', listing, digest };
  }

  // fetchDetail returning null means "nothing parseable" — verify() answers
  // whether the listing itself is gone before we report a fetch failure.
  try {
    const check = await adapter.verify(
      { sourceId: discovered.sourceId, url },
      LOOKUP_CONTEXT,
    );
    if (check?.removed) return { status: 'gone', listing: null, digest: null };
    if (check !== null && !check.inStock) {
      return { status: 'out_of_stock', listing: null, digest: null };
    }
  } catch (error) {
    log.warn('lookup verify failed', { url, error: (error as Error).message });
  }
  return { status: 'unavailable', listing: null, digest: null };
}

/**
 * Resolves a marketplace link to the listing behind it. The first call for an
 * item is one live fetch; repeat calls inside `cacheTtlMs` answer from memory.
 * Transient failures are never cached — only answers the source actually gave.
 */
export async function lookupListing(url: string, deps: LookupDeps = {}): Promise<ListingLookup> {
  const domain = domainFor(url);
  if (domain === null) return { status: 'unsupported', listing: null, digest: null };

  const ttl = deps.cacheTtlMs ?? 60_000;
  const key = `${domain}:${sourceIdFor(domain, url)}`;
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttl) return hit.result;
  }

  const result = await fetchLive(domain, url, deps);
  if (ttl > 0 && TERMINAL_STATUSES.has(result.status)) {
    cache.set(key, { at: Date.now(), result });
  }
  return result;
}
