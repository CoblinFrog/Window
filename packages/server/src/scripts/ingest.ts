import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import {
  QUALITY_WEIGHTS,
  clamp,
  cosine,
  hashString,
  meanVector,
  mulberry32,
  type CategoryDoc,
  type SourceDoc,
} from '@window/shared';
import { env } from '../config/env.js';
import { connectDatabase } from '../db/client.js';
import type { Category, Product } from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import { engagementScore } from '../ingestion/quality.js';
import {
  detectCurrency,
  fetchProductPage,
  robotsAllows,
  type ShopifyStore,
} from '../ingestion/shopify.js';
import { logger } from '../lib/logger.js';
import { mediaPipeline } from '../media/pipeline.js';

const log = logger.child('ingest');

/**
 * Real ingestion.
 *
 * Fetches live listings from public Shopify storefronts and runs them through
 * the same pipeline the synthetic seeder uses — normalize, gate, classify,
 * embed, cluster, score. Nothing here is a separate path; the only difference
 * from the seeder is where the `RawListing`s come from.
 *
 *   npm run ingest -w @window/server                      # every store
 *   npm run ingest -w @window/server -- --store allbirds.com
 *   npm run ingest -w @window/server -- --pages 2 --fresh
 */

/**
 * The storefronts.
 *
 * Chosen for category spread rather than size, since the feed's whole argument
 * is that unrelated merchandise reads as one surface. Each is a public Shopify
 * storefront; each has its robots.txt checked at run time rather than here.
 */
const STORES: ShopifyStore[] = [
  { domain: 'allbirds.com', displayName: 'Allbirds', categoryHint: 'Sneakers and streetwear' },
  { domain: 'www.chubbiesshorts.com', displayName: 'Chubbies', categoryHint: 'Fashion (men)' },
  { domain: 'us.huel.com', displayName: 'Huel', categoryHint: 'Fitness and outdoors' },
  { domain: 'www.brooklinen.com', displayName: 'Brooklinen', categoryHint: 'Home and kitchen' },
  { domain: 'ruggable.com', displayName: 'Ruggable', categoryHint: 'Furniture and decor' },
  { domain: 'www.nomadgoods.com', displayName: 'Nomad', categoryHint: 'Tech and gadgets' },
  { domain: 'peakdesign.com', displayName: 'Peak Design', categoryHint: 'Photography' },
  { domain: 'www.deathwishcoffee.com', displayName: 'Death Wish Coffee', categoryHint: 'Home and kitchen' },
  { domain: 'drinklmnt.com', displayName: 'LMNT', categoryHint: 'Fitness and outdoors' },
  { domain: 'www.hellotushy.com', displayName: 'TUSHY', categoryHint: 'Home and kitchen' },
  { domain: 'kizik.com', displayName: 'Kizik', categoryHint: 'Sneakers and streetwear' },
  { domain: 'www.vitruvi.com', displayName: 'Vitruvi', categoryHint: 'Beauty and grooming' },
];

interface Options {
  stores: ShopifyStore[];
  pages: number;
  fresh: boolean;
  /** Conservative by default; the PRD asks for exactly that. */
  requestsPerSecond: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
  };

  const only = get('--store', '');
  return {
    stores: only ? STORES.filter((s) => s.domain === only || s.domain.endsWith(`.${only}`)) : STORES,
    pages: Number.parseInt(get('--pages', '2'), 10),
    fresh: args.includes('--fresh'),
    requestsPerSecond: Number.parseFloat(get('--rps', '0.5')),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.stores.length === 0) {
    log.error('no matching store', { hint: STORES.map((s) => s.domain).join(', ') });
    process.exit(1);
  }

  const started = Date.now();
  const now = new Date();
  const db = await connectDatabase();
  const { collections } = db;
  await ensureIndexes(db.db);

  if (options.fresh) {
    // Only the real listings are cleared; the synthetic catalog is left alone
    // so the two can coexist and be compared.
    const domains = STORES.map((s) => s.domain);
    const removed = await collections.products.deleteMany({ 'source.domain': { $in: domains } });
    log.info('cleared previous real listings', { removed: removed.deletedCount });
  }

  // Each storefront is registered as a tier-2 source so the crawl control plane
  // and the merchant name on every card have something real to point at.
  await collections.sources.bulkWrite(
    options.stores.map((store) => {
      const source: SourceDoc<string> = {
        _id: store.domain,
        displayName: store.displayName,
        tier: 2,
        sourceType: 'new',
        crawlPolicy: {
          rps: options.requestsPerSecond,
          concurrency: 1,
          allowedHours: [0, 24],
          proxyPool: 'none',
          backoff: 'exponential',
        },
        stalenessCeilingHours: 12,
        extractors: { listing: 'shopify:products.json', detail: 'shopify:products.json' },
        health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: null, window: [] },
        checkout: {
          supported: true,
          guestCheckout: true,
          blocksAgents: false,
          protocol: null,
          stackableCoupons: false,
        },
        status: 'active',
      };
      return {
        updateOne: { filter: { _id: store.domain }, update: { $set: source as never }, upsert: true },
      };
    }),
  );

  const embedder = localEmbeddingProvider();
  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  // The brand dictionary is the set of vendors these stores actually publish,
  // gathered as we go. A brand is never guessed, so a vendor string only
  // becomes a brand once a store has asserted it.
  const brands = new Set<string>();
  for (const product of await collections.products
    .find({ brand: { $ne: null } }, { projection: { brand: 1 }, limit: 5000 })
    .toArray()) {
    if (product.brand) brands.add(product.brand);
  }

  const tally = { fetched: 0, ingested: 0, rejected: 0, byReason: new Map<string, number>() };
  const perStore = new Map<string, number>();
  const intervalMs = Math.max(0, Math.round(1000 / Math.max(0.05, options.requestsPerSecond)));

  for (const store of options.stores) {
    log.info('checking robots', { domain: store.domain });
    if (!(await robotsAllows(store.domain, '/products.json'))) {
      log.warn('skipping store: robots disallows products.json', { domain: store.domain });
      continue;
    }

    const currency = await detectCurrency(store.domain);
    await sleep(intervalMs);

    const collected: Awaited<ReturnType<typeof fetchProductPage>>['listings'] = [];
    for (let page = 1; page <= options.pages; page++) {
      try {
        const result = await fetchProductPage(store, page, currency, now);
        collected.push(...result.listings);
        log.info('fetched page', {
          domain: store.domain,
          page,
          products: result.listings.length,
        });
        if (!result.hasMore) break;
      } catch (error) {
        log.warn('page fetch failed', { domain: store.domain, page, error: (error as Error).message });
        break;
      }
      await sleep(intervalMs);
    }

    for (const listing of collected) {
      if (listing.brand) brands.add(listing.brand);
    }

    // The pipeline is rebuilt per store so the brand dictionary it matches
    // against includes everything learned so far.
    const pipeline = new IngestionPipeline({
      collections,
      embedder,
      classifier,
      media: mediaPipeline(),
      brandDictionary: [...brands],
      counterfeitWatchlistBrands: new Set(),
      blockedDomains: new Set(),
    });

    for (const listing of collected) {
      tally.fetched += 1;
      try {
        const result = await pipeline.ingest(listing, now);
        if (result.status === 'ingested') {
          tally.ingested += 1;
          perStore.set(store.domain, (perStore.get(store.domain) ?? 0) + 1);
        } else {
          tally.rejected += 1;
          const reason = result.rejectReason ?? 'unknown';
          tally.byReason.set(reason, (tally.byReason.get(reason) ?? 0) + 1);
        }
      } catch (error) {
        tally.rejected += 1;
        tally.byReason.set('pipeline_error', (tally.byReason.get('pipeline_error') ?? 0) + 1);
        log.warn('ingest failed', {
          domain: store.domain,
          sourceId: listing.sourceId,
          error: (error as Error).message,
        });
      }
    }

    log.info('store complete', {
      domain: store.domain,
      ingested: perStore.get(store.domain) ?? 0,
    });
  }

  log.info('ingestion complete', {
    fetched: tally.fetched,
    ingested: tally.ingested,
    rejected: tally.rejected,
    reasons: Object.fromEntries(tally.byReason),
  });

  if (tally.ingested > 0) {
    await seedEngagement(collections, STORES.map((s) => s.domain));
    await recomputeCentroids(collections, now);
    await bootstrapCoOccurrence(collections);
  }

  const real = await collections.products.countDocuments({
    'source.domain': { $in: STORES.map((s) => s.domain) },
    status: 'active',
  });
  log.info('done', {
    realProducts: real,
    perStore: Object.fromEntries(perStore),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await db.close();
}

/**
 * Real listings arrive with no engagement history, and a zero-CTR product is
 * ranked below every synthetic one that has a seeded rate. Rather than leave
 * them invisible, they start at the category mean — the honest prior for
 * something nobody has seen yet — with noise so the CTR term is not a constant.
 */
async function seedEngagement(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  domains: string[],
): Promise<void> {
  const random = mulberry32(hashString('real-engagement'));
  const cursor = collections.products.find(
    { 'source.domain': { $in: domains }, status: 'active', 'engagement.impressions': 0 },
    { projection: { _id: 1, quality: 1 } },
  );

  const operations: Array<AnyBulkWriteOperation<Product>> = [];
  for await (const product of cursor) {
    const quality = product.quality?.score ?? 0.5;
    const impressions = Math.floor(80 + random() * 400);
    const rate = clamp(0.03 + quality * 0.03 + (random() - 0.5) * 0.02, 0.004, 0.12);
    const interactions = Math.round(impressions * rate);
    const cartAdds = Math.round(interactions * 0.12);

    const term = engagementScore({
      impressions,
      interactions,
      cartAdds,
      categoryMeanCtr: 0.04,
      categoryMeanCartRate: 0.012,
    });
    const nextScore = clamp(
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
            engagement: {
              impressions,
              interactions,
              ctrSmoothed: Math.round(rate * 10000) / 10000,
              cartAdds,
            },
            'quality.engagement': Math.round(term * 1000) / 1000,
            'quality.score': Math.round(nextScore * 1000) / 1000,
          },
        },
      },
    });
  }

  if (operations.length > 0) {
    await collections.products.bulkWrite(operations);
    log.info('engagement primed for real listings', { products: operations.length });
  }
}

/** Same nightly recompute the seeder runs; real products shift the centroids. */
async function recomputeCentroids(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  now: Date,
): Promise<void> {
  for (const level of [3, 2, 1] as const) {
    const nodes = await collections.categories.find({ level }).toArray();
    const operations: Array<AnyBulkWriteOperation<Category>> = [];

    for (const node of nodes) {
      const field = level === 1 ? 'category.l1' : level === 2 ? 'category.l2' : 'category.l3';
      const members = await collections.products
        .find(
          { [field]: node._id, status: 'active' },
          { projection: { embedding: 1 }, sort: { 'engagement.ctrSmoothed': -1 }, limit: 500 },
        )
        .toArray();
      if (members.length === 0) continue;

      const productCount = await collections.products.countDocuments({
        [field]: node._id,
        status: 'active',
      });

      operations.push({
        updateOne: {
          filter: { _id: node._id },
          update: {
            $set: {
              centroid: meanVector(members.map((m) => m.embedding)),
              centroidComputedAt: now,
              memberCount: Math.min(members.length, 500),
              'engagement.productCount': productCount,
            },
          },
        },
      });
    }
    if (operations.length > 0) await collections.categories.bulkWrite(operations);
  }
  log.info('centroids recomputed');
}

async function bootstrapCoOccurrence(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
): Promise<void> {
  const nodes = await collections.categories.find({ level: 1 }).toArray();
  const byId = new Map(nodes.map((n) => [n._id, n]));
  const operations: Array<AnyBulkWriteOperation<Category>> = [];

  for (const node of nodes) {
    if (!node.centroid) continue;
    const pairs: Array<{ topic: string; lift: number }> = [];
    for (const other of nodes) {
      if (other._id === node._id || !other.centroid) continue;
      const similarity = cosine(node.centroid, (byId.get(other._id) as CategoryDoc<ObjectId>).centroid as number[]);
      pairs.push({ topic: other._id, lift: Math.round(clamp(1 + similarity * 2.5, 0.2, 4) * 100) / 100 });
    }
    pairs.sort((a, b) => b.lift - a.lift);
    operations.push({
      updateOne: { filter: { _id: node._id }, update: { $set: { coOccurrence: pairs.slice(0, 8) } } },
    });
  }
  if (operations.length > 0) await collections.categories.bulkWrite(operations);
  log.info('co-occurrence refreshed');
}

void env;

main().catch((error) => {
  log.error('ingest failed', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
