import { AmazonWebAdapter } from '../ingestion/adapters/amazon-web.js';
import { EbayWebAdapter } from '../ingestion/adapters/ebay-web.js';
import { primedFetch } from '../ingestion/adapters/primed-fetch.js';
import { sourceById } from '../ingestion/sources.js';
import type { IngestionPipeline } from '../ingestion/pipeline.js';
import type { CrawlContext, DiscoveredListing } from '../ingestion/types.js';
import type { SourceDoc } from '@window/shared';
import { logger } from '../lib/logger.js';
import { storefrontOf } from './storefront-search.js';

const log = logger.child('feed.adopt');

/**
 * Adopting an assistant's pick into the catalog.
 *
 * A pick is not a catalog row. It came off a live search page minutes ago with
 * a title, a price and a thumbnail, and nothing behind it — no cluster, no
 * seller, no reviews, no transcoded media. That is why its id is
 * `web:<domain>:<sourceId>` rather than a uuid, and why everything that needs
 * a row was switched off: it could be looked at and linked to, and that was
 * all.
 *
 * Which is fine until someone wants to buy one. The cart holds product ids and
 * verifies price and stock against stored rows, so "add to cart" on a pick had
 * nothing to add. This is the step that makes it real: fetch the listing's own
 * detail page and put it through the same pipeline every other product goes
 * through, so what comes out the other side is an ordinary catalog row with an
 * ordinary uuid, and every control that was switched off starts working for
 * the reason it was switched off in the first place.
 *
 * It is the full pipeline deliberately, not a shortcut that writes a row
 * directly. The quality gate, the clustering and the media rules are what make
 * a product row mean something; a row that skipped them would be a pick with a
 * uuid stapled to it, and the cart would then be verifying a price nothing
 * checked. So a refusal here is a real answer — the caller is expected to fall
 * back to sending the shopper to the listing, which is what it did before.
 */

const CONTEXT: CrawlContext = { rps: 1, concurrency: 1, proxyPool: 'none' };

/** Stands in when the sources table has no row for a storefront yet. */
function syntheticSource(domain: string): SourceDoc<string> {
  return {
    id: domain,
    displayName: domain,
    tier: 2,
    sourceType: domain === 'ebay.com' ? 'secondhand' : 'new',
    crawlPolicy: {
      rps: 1,
      concurrency: 1,
      allowedHours: [0, 24],
      proxyPool: 'none',
      backoff: 'exponential',
    },
    stalenessCeilingHours: 12,
    extractors: { listing: '', detail: '' },
    health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: null, window: [] },
    checkout: {
      supported: true,
      guestCheckout: false,
      blocksAgents: true,
      protocol: null,
      stackableCoupons: false,
    },
    status: 'active',
  };
}

export interface AdoptHints {
  /** The pick's own id on the storefront, when the caller still has it. */
  sourceId?: string | undefined;
  priceHint?: number | null | undefined;
  titleHint?: string | null | undefined;
  imageHint?: string | null | undefined;
}

export type AdoptOutcome =
  | { status: 'adopted'; productId: string; clusterId: string | null }
  | { status: 'refused'; reason: string };

/**
 * `web:<domain>:<sourceId>` — the id a pick carries. The source id is whatever
 * follows the second colon, which may itself contain colons, so this splits
 * twice rather than on every one.
 */
export function sourceIdFromPickId(pickId: string): string | null {
  const parts = pickId.split(':');
  if (parts.length < 3 || parts[0] !== 'web') return null;
  return parts.slice(2).join(':') || null;
}

export async function adoptListing(
  url: string,
  pipeline: IngestionPipeline,
  hints: AdoptHints = {},
  now = new Date(),
): Promise<AdoptOutcome> {
  const storefront = storefrontOf(url);
  if (storefront === null) return { status: 'refused', reason: 'not_a_storefront' };

  // Without a source id the adapters have nothing to key the listing on. The
  // URL's own path is the fallback, which is stable enough for one fetch.
  const sourceId = hints.sourceId ?? new URL(url).pathname;

  const discovered: DiscoveredListing = {
    sourceDomain: storefront,
    sourceId,
    url,
    priceHint: hints.priceHint ?? null,
    titleHint: hints.titleHint ?? null,
    imageHint: hints.imageHint ?? null,
    seenAt: now,
  };

  const source = sourceById(storefront) ?? syntheticSource(storefront);
  const adapter =
    storefront === 'ebay.com'
      ? new EbayWebAdapter(source, { fetchImpl: primedFetch })
      : new AmazonWebAdapter(source, { fetchImpl: primedFetch });

  let raw;
  try {
    raw = await adapter.fetchDetail(discovered, CONTEXT);
  } catch (error) {
    log.warn('detail fetch failed', { url, error: (error as Error).message });
    return { status: 'refused', reason: 'detail_unavailable' };
  }
  if (raw === null) return { status: 'refused', reason: 'detail_unavailable' };

  const result = await pipeline.ingest(raw, now);
  if (result.productId === null) {
    log.info('pipeline refused a pick', { url, reason: result.rejectReason });
    return { status: 'refused', reason: result.rejectReason ?? 'rejected' };
  }

  // `unchanged` is a success: the catalog already holds this listing, which is
  // exactly the row the cart wants.
  log.info('adopted a pick', { url, productId: result.productId, status: result.status });
  return { status: 'adopted', productId: result.productId, clusterId: result.clusterId };
}
