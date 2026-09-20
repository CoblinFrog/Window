import type { SourceDoc } from '@window/shared';
import type { RawListing } from './types.js';
import { IngestionPipeline, type IngestResult } from './pipeline.js';
import type { CollectionSet } from '../db/supabase-collections.js';
import { findOne, insert, updateOne } from '../db/supabase-helpers.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { CategoryClassifier } from './classify.js';
import { mediaPipeline } from '../media/pipeline.js';

/** The registry row a web source needs before its listings can be ingested. */
export function webSourceDoc(
  domain: string,
  displayName: string,
  sourceType: SourceDoc<string>['sourceType'],
): SourceDoc<string> {
  return {
    id: domain,
    displayName,
    tier: 2,
    sourceType,
    crawlPolicy: {
      rps: 0.5,
      concurrency: 1,
      allowedHours: [0, 24],
      proxyPool: 'none',
      backoff: 'exponential',
    },
    stalenessCeilingHours: 12,
    extractors: { listing: JSON.stringify({ strategy: 'web' }), detail: 'web' },
    health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: null, window: [] },
    checkout: { supported: true, guestCheckout: false, blocksAgents: true, protocol: null, stackableCoupons: false },
    status: 'active',
  };
}

const SOURCE_LABELS: Record<string, { displayName: string; sourceType: SourceDoc<string>['sourceType'] }> = {
  'amazon.com': { displayName: 'Amazon', sourceType: 'new' },
  'ebay.com': { displayName: 'eBay', sourceType: 'secondhand' },
};

/**
 * Creates or refreshes the registry rows for the domains a batch came from.
 *
 * `updateOne` is update-only in the Supabase compatibility layer, so a fresh
 * catalog needs the insert branch — otherwise the first run fails before a
 * single listing reaches the pipeline.
 */
export async function ensureWebSources(
  collections: CollectionSet,
  domains: Iterable<string>,
): Promise<void> {
  for (const domain of new Set(domains)) {
    const label = SOURCE_LABELS[domain];
    if (!label) continue;
    const doc = webSourceDoc(domain, label.displayName, label.sourceType);
    const existing = await findOne(collections.sources, { id: domain });
    if (existing) await updateOne(collections.sources, { id: domain }, doc);
    else await insert(collections.sources, doc);
  }
}

/**
 * Builds the ingestion pipeline a web batch is written through, with the source
 * registry already in place. Every entry point — the crawler, and a lookup of a
 * single pasted link — goes through this so a product means the same thing
 * however it was found.
 */
export async function createWebIngestion(
  collections: CollectionSet,
  listings: readonly RawListing[],
): Promise<IngestionPipeline> {
  await ensureWebSources(collections, listings.map((l) => l.sourceDomain));

  const embedder = localEmbeddingProvider();
  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  return new IngestionPipeline({
    collections,
    embedder,
    classifier,
    media: mediaPipeline(),
    brandDictionary: [...new Set(listings.map((l) => l.brand).filter((b): b is string => Boolean(b)))],
    counterfeitWatchlistBrands: new Set(),
    blockedDomains: new Set(),
  });
}

export interface WebPersistenceStats {
  attempted: number;
  ingested: number;
  rejected: number;
  unchanged: number;
  errors: number;
  reasons: Record<string, number>;
}

/**
 * Sends listings discovered by a web adapter through the same normalization,
 * media, clustering, and Supabase upsert pipeline as every other source.
 * Keeping this orchestration separate makes it reusable by scripts and easy to
 * exercise without making network requests in unit tests.
 *
 * `limit` counts products actually written, not listings tried. Most of what a
 * web adapter collects does not survive the pipeline — a missing price, an
 * image below the eligibility floor and a duplicate of something already in the
 * catalog are all ordinary outcomes — so counting attempts means asking for
 * four products and getting one. The walk continues past those rejections until
 * `limit` listings have been ingested or the collected pool runs out.
 */
export async function persistWebListings(
  pipeline: IngestionPipeline,
  listings: readonly RawListing[],
  limit: number,
  now = new Date(),
  onError?: (listing: RawListing, error: unknown) => void,
  /** Called for each pipeline outcome, so callers can collect the ids written. */
  onResult?: (result: IngestResult, listing: RawListing) => void,
): Promise<WebPersistenceStats> {
  const stats: WebPersistenceStats = {
    attempted: 0,
    ingested: 0,
    rejected: 0,
    unchanged: 0,
    errors: 0,
    reasons: {},
  };

  const wanted = Math.max(0, limit);
  for (const listing of listings) {
    if (stats.ingested >= wanted) break;
    stats.attempted += 1;
    try {
      const result: IngestResult = await pipeline.ingest(listing, now);
      onResult?.(result, listing);
      if (result.status === 'ingested') stats.ingested += 1;
      else if (result.status === 'rejected') stats.rejected += 1;
      else stats.unchanged += 1;

      if (result.rejectReason) {
        stats.reasons[result.rejectReason] = (stats.reasons[result.rejectReason] ?? 0) + 1;
      }
    } catch (error) {
      stats.errors += 1;
      stats.reasons.pipeline_error = (stats.reasons.pipeline_error ?? 0) + 1;
      onError?.(listing, error);
    }
  }

  return stats;
}
