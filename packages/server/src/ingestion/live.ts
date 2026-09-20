/**
 * Live product refresh and adapter-backed stock verification.
 *
 * Both sides of "get all the data using the link": the detail route calls
 * `refreshProduct` when a card is tapped, and the cart's just-in-time check
 * uses `AdapterVerifier` instead of trusting the stored row. Resolution order
 * prefers the official API adapters when credentials exist and falls back to
 * the web adapters that populated the catalog.
 */

import type { SourceDoc } from '@window/shared';
import type { StockVerifier, VerificationResult } from '../cart/service.js';
import type { Product } from '../db/supabase-collections.js';
import { logger } from '../lib/logger.js';
import { AmazonWebAdapter } from './adapters/amazon-web.js';
import { EbayWebAdapter } from './adapters/ebay-web.js';
import { adapterWithFallback, canServe } from './adapters/index.js';
import type { FetchLike } from './adapters/tier2-structured.js';
import { primedFetch } from './adapters/primed-fetch.js';
import type { IngestionPipeline } from './pipeline.js';
import { sourceById } from './sources.js';
import {
  SourceUnavailableError,
  type CrawlContext,
  type SourceAdapter,
} from './types.js';
import type { CollectionSet } from '../db/supabase-collections.js';
import { findOne, updateOne } from '../db/supabase-helpers.js';

const log = logger.child('ingestion.live');

/** A tapped card re-fetches at most this often; the store itself is fresher. */
export const LIVE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const WEB_ADAPTERS: Record<
  string,
  new (source: SourceDoc<string>, options?: { fetchImpl?: FetchLike }) => SourceAdapter
> = {
  'amazon.com': AmazonWebAdapter,
  'ebay.com': EbayWebAdapter,
};

const REFRESH_CONTEXT: CrawlContext = { rps: 1, concurrency: 1, proxyPool: 'none' };

/**
 * Which adapter answers a live request for this domain. The official API wins
 * when it is configured — it is the more reliable read of the same row — and
 * the web adapter answers when it is not. Other domains keep their registry
 * fallback chain (tier-2 sources fetch fine through `primedFetch`).
 */
export function liveAdapterFor(
  source: SourceDoc<string>,
  deps: { fetchImpl?: FetchLike; secret?: (name: string) => string | undefined } = {},
): SourceAdapter {
  const fetchImpl = deps.fetchImpl ?? primedFetch;
  const web = WEB_ADAPTERS[source.id];
  if (web !== undefined && !canServe(source, 1, deps)) {
    return new web(source, { fetchImpl });
  }
  return adapterWithFallback(source, { fetchImpl, secret: deps.secret });
}

export interface RefreshDeps {
  collections: CollectionSet;
  pipeline: IngestionPipeline;
  fetchImpl?: FetchLike;
  secret?: (name: string) => string | undefined;
  now?: () => Date;
}

export type RefreshOutcome = 'refreshed' | 'unchanged' | 'removed' | 'unavailable';

/**
 * Re-fetch the listing at `product.source.url` and fold it back through the
 * pipeline, which upserts on (domain, sourceId) — so a refresh is the same
 * write path as a first ingest, and the product card comes back current.
 */
export async function refreshProduct(deps: RefreshDeps, product: Product): Promise<RefreshOutcome> {
  const now = deps.now?.() ?? new Date();
  if (now.getTime() - product.crawl.lastCrawledAt.getTime() < LIVE_REFRESH_MIN_INTERVAL_MS) {
    return 'unchanged';
  }

  const source =
    (await findOne<SourceDoc<string>>(deps.collections.sources, { id: product.source.domain })) ??
    sourceById(product.source.domain);
  if (source === null || source === undefined) return 'unavailable';

  let adapter: SourceAdapter;
  try {
    adapter = liveAdapterFor(source as SourceDoc<string>, deps);
  } catch (error) {
    if (error instanceof SourceUnavailableError) return 'unavailable';
    throw error;
  }

  const discovered = {
    sourceDomain: product.source.domain,
    sourceId: product.source.sourceId,
    url: product.source.url,
    priceHint: product.price.amount,
    seenAt: now,
  };

  try {
    const detail = await adapter.fetchDetail(discovered, REFRESH_CONTEXT);
    if (detail !== null) {
      await deps.pipeline.ingest(detail, now);
      return 'refreshed';
    }

    // fetchDetail's null is ambiguous — the page may be gone or the parse may
    // have missed. verify() answers the gone half before we mark anything dead.
    const check = await adapter.verify(
      { sourceId: product.source.sourceId, url: product.source.url },
      REFRESH_CONTEXT,
    );
    if (check?.removed) {
      await updateOne(deps.collections.products, { id: product.id }, {
        status: 'dead' as const,
        stock: { ...product.stock, inStock: false },
      });
      return 'removed';
    }
    return 'unchanged';
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      log.debug('live refresh refused by source', {
        domain: product.source.domain,
        reason: error.reason,
      });
      return 'unavailable';
    }
    throw error;
  }
}

/**
 * The cart's just-in-time check against the live listing rather than the
 * stored row. A source that cannot be reached returns its stored values — a
 * price that might be stale is a better answer than no cart.
 */
export class AdapterVerifier implements StockVerifier {
  constructor(private readonly deps: RefreshDeps) {}

  async verify(products: readonly Product[]): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const product of products) {
      const stored: VerificationResult = {
        productId: product.id,
        inStock: product.stock.inStock && product.status === 'active',
        priceAmount: product.price.amount,
        currency: product.price.currency,
      };

      const source =
        (await findOne<SourceDoc<string>>(this.deps.collections.sources, { id: product.source.domain })) ??
        sourceById(product.source.domain);
      if (!source) {
        results.push(stored);
        continue;
      }

      try {
        const adapter = liveAdapterFor(source as SourceDoc<string>, this.deps);
        const check = await adapter.verify(
          { sourceId: product.source.sourceId, url: product.source.url },
          REFRESH_CONTEXT,
        );
        if (check?.removed) {
          // The listing is confirmed gone. That is a fact about the merchant.
          results.push({ ...stored, inStock: false });
          continue;
        }
        if (check === null) {
          // The probe could not determine anything — unreachable, unparseable,
          // or a page shape the adapter does not know. That is a fact about us,
          // not about the listing, and delisting on it is what this class's own
          // contract rules out: "a price that might be stale is a better answer
          // than no cart." Marking it out of stock empties the cart and blocks
          // checkout on every product the adapter cannot read.
          results.push(stored);
          continue;
        }
        results.push({
          productId: stored.productId,
          inStock: check.inStock,
          priceAmount: check.priceAmountMinor ?? stored.priceAmount,
          currency: check.currency ?? stored.currency,
        });
      } catch {
        results.push(stored);
      }
    }
    return results;
  }
}
