/**
 * Builds the catalog from Amazon and eBay storefronts directly — no API
 * credentials. Discovery is agentic by default: a `claude` headless call reads
 * each page's candidate links and decides what is worth opening; `--no-agent`
 * falls back to walking the adapters' own discovery cursors.
 *
 * Both adapters read live HTML through `primedFetch` — plain fetch first, and
 * a browser-impersonating `curl_cffi` helper when the bot wall answers. Pages
 * that come back challenged or refused are logged and skipped, never parsed
 * into listings.
 *
 *   npm run ingest:web -w @window/server
 *   npm run ingest:web -w @window/server -- --count 40 --replace
 *   npm run ingest:web -w @window/server -- --no-agent --source ebay
 */

import type { SourceDoc } from '@window/shared';
import { BrowseAgent } from '../agent/browse-agent.js';
import { claudeCli } from '../agent/llm.js';
import { connectDatabase } from '../db/client.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import {
  AMAZON_WEB_DEFAULT_TERMS,
  AmazonWebAdapter,
} from '../ingestion/adapters/amazon-web.js';
import {
  EBAY_WEB_DEFAULT_SEEDS,
  EbayWebAdapter,
} from '../ingestion/adapters/ebay-web.js';
import { primedFetch } from '../ingestion/adapters/primed-fetch.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import type {
  CrawlContext,
  RawListing,
  WebSourceAdapter,
} from '../ingestion/types.js';
import { logger } from '../lib/logger.js';
import { mediaPipeline } from '../media/pipeline.js';
import { bootstrapCoOccurrence, primeEngagement, recomputeCentroids } from './catalog-lib.js';

const log = logger.child('ingest-web');

interface Options {
  count: number;
  replace: boolean;
  agent: boolean;
  source: 'all' | 'amazon' | 'ebay';
  maxPages: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
  };
  const source = get('--source', 'all');
  return {
    count: Number.parseInt(get('--count', '30'), 10),
    replace: args.includes('--replace'),
    agent: !args.includes('--no-agent'),
    source: source === 'amazon' || source === 'ebay' ? source : 'all',
    // A sitemap walk costs index → child → leaf before a single item exists.
    maxPages: Number.parseInt(get('--max-pages', '16'), 10),
  };
}

function sourceDoc(domain: string, displayName: string, sourceType: SourceDoc<string>['sourceType']): SourceDoc<string> {
  return {
    _id: domain,
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Cursor-walk discovery, for runs where the model should not be consulted. */
async function collectWithoutAgent(
  adapter: WebSourceAdapter,
  context: CrawlContext,
  limit: number,
  intervalMs: number,
): Promise<RawListing[]> {
  const collected: RawListing[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8 && collected.length < limit; page++) {
    const { listings, nextCursor } = await adapter.discover(context, cursor);
    cursor = nextCursor ?? undefined;
    for (const item of listings) {
      if (collected.length >= limit) break;
      try {
        await sleep(intervalMs);
        const detail = await adapter.fetchDetail(item, context);
        if (detail && detail.images.length > 0) collected.push(detail);
      } catch (error) {
        log.warn('detail fetch failed', { url: item.url, error: (error as Error).message });
      }
    }
    if (cursor === undefined) break;
  }
  return collected;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const now = new Date();
  const started = Date.now();

  const context: CrawlContext = { rps: 0.5, concurrency: 1, proxyPool: 'none' };
  const perSource = Math.ceil(options.count / (options.source === 'all' ? 2 : 1));
  const collected: RawListing[] = [];

  const targets: Array<{ domain: string; adapter: WebSourceAdapter; seeds: string[] }> = [];
  if (options.source !== 'ebay') {
    targets.push({
      domain: 'amazon.com',
      adapter: new AmazonWebAdapter(sourceDoc('amazon.com', 'Amazon', 'new'), { fetchImpl: primedFetch }),
      seeds: AMAZON_WEB_DEFAULT_TERMS.map(
        (term) => `https://www.amazon.com/s?k=${encodeURIComponent(term)}`,
      ),
    });
  }
  if (options.source !== 'amazon') {
    targets.push({
      domain: 'ebay.com',
      adapter: new EbayWebAdapter(sourceDoc('ebay.com', 'eBay', 'secondhand'), { fetchImpl: primedFetch }),
      seeds: EBAY_WEB_DEFAULT_SEEDS,
    });
  }

  for (const target of targets) {
    try {
      if (options.agent) {
        const agent = new BrowseAgent({
          adapter: target.adapter,
          context,
          llm: claudeCli(),
          fetchImpl: primedFetch,
          intervalMs: 2000,
          maxPages: options.maxPages,
          maxItems: perSource,
          onListing: async (listing) => {
            if (listing.images.length > 0) collected.push(listing);
          },
        });
        const stats = await agent.run(target.seeds);
        log.info('agent finished', { domain: target.domain, ...stats });
      } else {
        const rows = await collectWithoutAgent(target.adapter, context, perSource, 2000);
        collected.push(...rows);
      }
    } catch (error) {
      log.warn('source collection failed', {
        domain: target.domain,
        error: (error as Error).message,
      });
    }
  }

  log.info('collected listings', { total: collected.length });
  if (collected.length === 0) {
    log.error('nothing was collected; the database was left untouched');
    process.exit(1);
  }

  // ---- Persist -------------------------------------------------------------
  const db = await connectDatabase();
  const { collections } = db;
  await ensureIndexes(db.db);

  if (options.replace) {
    const removed = await Promise.all([
      collections.products.deleteMany({}),
      collections.clusters.deleteMany({}),
      collections.reviews.deleteMany({}),
      collections.sellers.deleteMany({}),
    ]);
    log.info('cleared previous catalog', {
      products: removed[0].deletedCount,
      clusters: removed[1].deletedCount,
      reviews: removed[2].deletedCount,
    });
  }

  for (const target of targets) {
    const doc = target.domain === 'amazon.com'
      ? sourceDoc('amazon.com', 'Amazon', 'new')
      : sourceDoc('ebay.com', 'eBay', 'secondhand');
    await collections.sources.updateOne({ _id: target.domain }, { $set: doc as never }, { upsert: true });
  }

  const embedder = localEmbeddingProvider();
  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  const brands = [...new Set(collected.map((l) => l.brand).filter((b): b is string => Boolean(b)))];
  const pipeline = new IngestionPipeline({
    collections,
    embedder,
    classifier,
    media: mediaPipeline(),
    brandDictionary: brands,
    counterfeitWatchlistBrands: new Set(),
    blockedDomains: new Set(),
  });

  let ingested = 0;
  const reasons = new Map<string, number>();
  for (const listing of collected) {
    if (ingested >= options.count) break;
    try {
      const result = await pipeline.ingest(listing, now);
      if (result.status === 'ingested') ingested += 1;
      else {
        const reason = result.rejectReason ?? 'unchanged';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    } catch (error) {
      reasons.set('pipeline_error', (reasons.get('pipeline_error') ?? 0) + 1);
      log.warn('ingest failed', { sourceId: listing.sourceId, error: (error as Error).message });
    }
  }

  log.info('ingestion complete', { ingested, rejected: Object.fromEntries(reasons) });

  await primeEngagement(collections);
  await recomputeCentroids(collections, now);
  await bootstrapCoOccurrence(collections);

  log.info('done', {
    activeProducts: await collections.products.countDocuments({ status: 'active' }),
    clusters: await collections.clusters.countDocuments({}),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await db.close();
}

main().catch((error) => {
  log.error('ingest-web failed', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
