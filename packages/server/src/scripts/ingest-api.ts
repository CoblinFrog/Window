import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import {
  QUALITY_WEIGHTS,
  clamp,
  cosine,
  meanVector,
  type SourceDoc,
} from '@window/shared';
import { connectDatabase } from '../db/client.js';
import type { Category, Product } from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import { engagementScore } from '../ingestion/quality.js';
import { EbayBrowseAdapter, fromEnv as ebayFromEnv } from '../ingestion/adapters/ebay-browse.js';
import { AmazonPaapiAdapter, fromEnv as amazonFromEnv } from '../ingestion/adapters/amazon-paapi.js';
import type { CrawlContext, RawListing, SourceAdapter } from '../ingestion/types.js';
import { logger } from '../lib/logger.js';
import { mediaPipeline } from '../media/pipeline.js';

const log = logger.child('ingest-api');

/**
 * Builds a small catalog from official marketplace APIs.
 *
 * eBay Browse and Amazon PA-API are tier 1 in the PRD's terms — "official API
 * or affiliate product feed", the tier it says to prefer wherever one exists.
 * Neither site is scraped: both disallow their item and search paths in
 * robots.txt, and both adapters refuse to run without credentials rather than
 * falling back to anything.
 *
 *   npm run ingest:api -w @window/server
 *   npm run ingest:api -w @window/server -- --count 20 --replace
 */

/**
 * One search per category so the result spreads rather than returning twenty
 * near-identical sneakers. Each term is deliberately generic: a narrow query
 * returns one model in fifteen colourways, which makes the quad-coherence
 * logic look good and tests nothing.
 */
const CATEGORIES = [
  { term: 'running sneakers', hint: 'Sneakers and streetwear' },
  { term: 'wireless headphones', hint: 'Music and audio' },
  { term: 'automatic watch', hint: 'Watches and jewelry' },
  { term: 'mirrorless camera lens', hint: 'Photography' },
  { term: 'mechanical keyboard', hint: 'Tech and gadgets' },
];

interface Options {
  count: number;
  /** Drop every existing product first, so only the API catalog remains. */
  replace: boolean;
  perCategory: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
  };
  const count = Number.parseInt(get('--count', '20'), 10);
  return {
    count,
    replace: args.includes('--replace'),
    // Over-fetch per category: listings get rejected for unfetchable images and
    // short titles, and coming up short is worse than a few extra API calls.
    perCategory: Math.max(2, Math.ceil((count / CATEGORIES.length) * 2.5)),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Configured {
  name: string;
  domain: string;
  adapter: SourceAdapter;
  /** PA-API throttles hard at 1 req/s; eBay is far more generous. */
  intervalMs: number;
  build(term: string): SourceAdapter;
}

function configure(): Configured[] {
  const out: Configured[] = [];

  const ebay = ebayFromEnv();
  if (ebay) {
    out.push({
      name: 'eBay Browse',
      domain: 'ebay.com',
      adapter: ebay,
      intervalMs: 350,
      build: (term) =>
        new EbayBrowseAdapter({
          clientId: process.env.EBAY_CLIENT_ID ?? null,
          clientSecret: process.env.EBAY_CLIENT_SECRET ?? null,
          query: term,
          ...(process.env.EBAY_MARKETPLACE_ID ? { marketplaceId: process.env.EBAY_MARKETPLACE_ID } : {}),
          ...(process.env.EBAY_CAMPAIGN_ID ? { campaignId: process.env.EBAY_CAMPAIGN_ID } : {}),
        }),
    });
  }

  const amazon = amazonFromEnv();
  if (amazon) {
    out.push({
      name: 'Amazon PA-API',
      domain: 'amazon.com',
      adapter: amazon,
      intervalMs: 1100,
      build: (term) =>
        new AmazonPaapiAdapter({
          accessKey: process.env.AMAZON_ACCESS_KEY ?? null,
          secretKey: process.env.AMAZON_SECRET_KEY ?? null,
          partnerTag: process.env.AMAZON_PARTNER_TAG ?? null,
          keywords: term,
          ...(process.env.AMAZON_MARKETPLACE_TLD ? { tld: process.env.AMAZON_MARKETPLACE_TLD } : {}),
          ...(process.env.AMAZON_SEARCH_INDEX ? { searchIndex: process.env.AMAZON_SEARCH_INDEX } : {}),
        }),
    });
  }

  return out;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const now = new Date();
  const started = Date.now();

  const sources = configure();
  if (sources.length === 0) {
    log.error('no marketplace API is configured', {
      hint:
        'Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET, and/or AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY ' +
        'and AMAZON_PARTNER_TAG, in packages/server/.env. Neither site may be scraped: both ' +
        'disallow their item and search paths in robots.txt.',
    });
    process.exit(1);
  }
  log.info('configured sources', { sources: sources.map((s) => s.name) });

  const db = await connectDatabase();
  const { collections } = db;
  await ensureIndexes(db.db);

  // ---- Collect ------------------------------------------------------------
  const collected: RawListing[] = [];
  const perSource = new Map<string, number>();
  const context: CrawlContext = { rps: 2, concurrency: 1, proxyPool: 'none' };

  for (const category of CATEGORIES) {
    for (const source of sources) {
      if (collected.length >= options.count * 2) break;

      try {
        const adapter = source.build(category.term);
        const { listings } = await adapter.discover(context);
        log.info('discovered', {
          source: source.name,
          term: category.term,
          found: listings.length,
        });

        let taken = 0;
        for (const listing of listings) {
          if (taken >= options.perCategory) break;
          await sleep(source.intervalMs);

          const detail = await adapter.fetchDetail(listing, context);
          if (!detail) continue;

          // Only listings that actually carry an image are worth fetching: the
          // whole point of this catalog is real photography, and a card with
          // no picture is one this feed cannot show.
          if (detail.images.length === 0) continue;

          detail.breadcrumb = [category.hint, ...detail.breadcrumb];
          collected.push(detail);
          perSource.set(source.name, (perSource.get(source.name) ?? 0) + 1);
          taken += 1;
        }
      } catch (error) {
        log.warn('search failed', {
          source: source.name,
          term: category.term,
          error: (error as Error).message,
        });
      }
    }
  }

  log.info('collected listings', {
    total: collected.length,
    perSource: Object.fromEntries(perSource),
  });

  if (collected.length === 0) {
    log.error('nothing was collected; the database was left untouched');
    await db.close();
    process.exit(1);
  }

  // ---- Replace ------------------------------------------------------------
  // Done only once there is something to replace it with, so a failed run
  // never leaves an empty catalog behind.
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

  for (const source of sources) {
    const doc: SourceDoc<string> = {
      _id: source.domain,
      displayName: source.name.split(' ')[0] as string,
      tier: 1,
      sourceType: source.domain === 'ebay.com' ? 'secondhand' : 'new',
      crawlPolicy: {
        rps: 1000 / source.intervalMs,
        concurrency: 1,
        allowedHours: [0, 24],
        proxyPool: 'none',
        backoff: 'exponential',
      },
      stalenessCeilingHours: 6,
      extractors: { listing: 'api', detail: 'api' },
      health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: now, window: [] },
      checkout: { supported: true, guestCheckout: true, blocksAgents: false, protocol: null, stackableCoupons: false },
      status: 'active',
    };
    await collections.sources.updateOne({ _id: source.domain }, { $set: doc as never }, { upsert: true });
  }

  // ---- Ingest -------------------------------------------------------------
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
        const reason = result.rejectReason ?? 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    } catch (error) {
      reasons.set('pipeline_error', (reasons.get('pipeline_error') ?? 0) + 1);
      log.warn('ingest failed', {
        sourceId: listing.sourceId,
        error: (error as Error).message,
      });
    }
  }

  // Anything left over after the target is met is dropped rather than stored:
  // the request was twenty products, not "as many as happened to parse".
  log.info('ingestion complete', {
    ingested,
    target: options.count,
    rejected: Object.fromEntries(reasons),
  });

  await primeEngagement(collections);
  await recomputeCentroids(collections, now);
  await bootstrapCoOccurrence(collections);

  const active = await collections.products.countDocuments({ status: 'active' });
  log.info('done', {
    activeProducts: active,
    clusters: await collections.clusters.countDocuments({}),
    sellers: await collections.sellers.countDocuments({}),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await db.close();
}

/**
 * A catalog this small has no measured engagement at all, and a zero CTR makes
 * the `ctr` term a constant rather than a signal. Everything starts at the
 * category mean, which is the honest prior for a product nobody has seen.
 */
async function primeEngagement(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
): Promise<void> {
  const operations: Array<AnyBulkWriteOperation<Product>> = [];
  for await (const product of collections.products.find(
    { status: 'active' },
    { projection: { _id: 1, quality: 1 } },
  )) {
    const term = engagementScore({
      impressions: 200,
      interactions: 8,
      cartAdds: 1,
      categoryMeanCtr: 0.04,
      categoryMeanCartRate: 0.012,
    });
    const next = clamp(
      (product.quality?.score ?? 0) +
        QUALITY_WEIGHTS.engagement * (term - (product.quality?.engagement ?? 0)),
      0,
      1,
    );
    operations.push({
      updateOne: {
        filter: { _id: product._id },
        update: {
          $set: {
            engagement: { impressions: 200, interactions: 8, ctrSmoothed: 0.04, cartAdds: 1 },
            'quality.engagement': Math.round(term * 1000) / 1000,
            'quality.score': Math.round(next * 1000) / 1000,
          },
        },
      },
    });
  }
  if (operations.length > 0) await collections.products.bulkWrite(operations);
}

/**
 * Onboarding seeds the user vector from L1 centroids, so a topic with no
 * centroid cannot be picked. With only twenty products most of the taxonomy has
 * no members at all, so every empty node falls back to its own name vector —
 * otherwise the picker offers eighteen tiles and fifteen of them produce a
 * cold-start vector of zeroes.
 */
async function recomputeCentroids(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  now: Date,
): Promise<void> {
  const embedder = localEmbeddingProvider();

  for (const level of [3, 2, 1] as const) {
    const nodes = await collections.categories.find({ level }).toArray();
    const operations: Array<AnyBulkWriteOperation<Category>> = [];

    for (const node of nodes) {
      const field = level === 1 ? 'category.l1' : level === 2 ? 'category.l2' : 'category.l3';
      const members = await collections.products
        .find({ [field]: node._id, status: 'active' }, { projection: { embedding: 1 }, limit: 500 })
        .toArray();

      const centroid =
        members.length > 0
          ? meanVector(members.map((m) => m.embedding))
          : await embedder.embedText(node.displayName);

      operations.push({
        updateOne: {
          filter: { _id: node._id },
          update: {
            $set: {
              centroid,
              centroidComputedAt: now,
              memberCount: members.length,
              'engagement.productCount': members.length,
            },
          },
        },
      });
    }
    if (operations.length > 0) await collections.categories.bulkWrite(operations);
  }
  log.info('centroids recomputed (empty categories fall back to their name vector)');
}

async function bootstrapCoOccurrence(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
): Promise<void> {
  const nodes = await collections.categories.find({ level: 1 }).toArray();
  const operations: Array<AnyBulkWriteOperation<Category>> = [];

  for (const node of nodes) {
    if (!node.centroid) continue;
    const pairs = nodes
      .filter((other) => other._id !== node._id && other.centroid)
      .map((other) => ({
        topic: other._id,
        lift:
          Math.round(clamp(1 + cosine(node.centroid as number[], other.centroid as number[]) * 2.5, 0.2, 4) * 100) /
          100,
      }))
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 8);

    operations.push({
      updateOne: { filter: { _id: node._id }, update: { $set: { coOccurrence: pairs } } },
    });
  }
  if (operations.length > 0) await collections.categories.bulkWrite(operations);
}

main().catch((error) => {
  log.error('ingest-api failed', {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });
  process.exit(1);
});
