import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import {
  CATEGORY_NODES,
  L1_IDS,
  QUALITY_WEIGHTS,
  clamp,
  cosine,
  hashString,
  meanVector,
  mulberry32,
  type CategoryDoc,
  type CouponDoc,
} from '@window/shared';
import { env } from '../config/env.js';
import { connectDatabase } from '../db/client.js';
import type { Category, Product } from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import { SOURCE_REGISTRY } from '../ingestion/sources.js';
import { logger } from '../lib/logger.js';
import { engagementScore } from '../ingestion/quality.js';
import { mediaPipeline } from '../media/pipeline.js';
import { generateCatalog } from '../seed/generator.js';

const log = logger.child('seed');

interface SeedOptions {
  count: number;
  seed: string;
  drop: boolean;
}

function parseArgs(): SeedOptions {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  return {
    count: Number.parseInt(get('--count', '12000'), 10),
    seed: get('--seed', 'window-2026'),
    drop: args.includes('--drop') || !args.includes('--keep'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const started = Date.now();
  const now = new Date();

  const db = await connectDatabase();
  const { collections } = db;

  if (options.drop) {
    log.info('dropping existing catalog');
    await Promise.all([
      collections.products.deleteMany({}),
      collections.clusters.deleteMany({}),
      collections.reviews.deleteMany({}),
      collections.sellers.deleteMany({}),
      collections.categories.deleteMany({}),
      collections.sources.deleteMany({}),
      collections.coupons.deleteMany({}),
    ]);
  }

  await ensureIndexes(db.db);

  // ---- Taxonomy ----------------------------------------------------------
  log.info('writing the taxonomy', { nodes: CATEGORY_NODES.length });
  const categoryDocs: Array<CategoryDoc<ObjectId>> = CATEGORY_NODES.map((node) => ({
    _id: node.id,
    level: node.level,
    parent: node.parent,
    l1: node.l1,
    displayName: node.displayName,
    centroid: null,
    centroidComputedAt: null,
    memberCount: 0,
    tile:
      node.level === 1
        ? { image: `${env.publicUrl}/media/topic/${node.id}`, order: node.tileOrder ?? 0 }
        : null,
    engagement: { medianCtr: 0.04, productCount: 0 },
    coOccurrence: [],
  }));
  await collections.categories.bulkWrite(
    categoryDocs.map((doc) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set: doc }, upsert: true },
    })),
  );

  // ---- Source registry ---------------------------------------------------
  log.info('writing the source registry', { sources: SOURCE_REGISTRY.length });
  await collections.sources.bulkWrite(
    SOURCE_REGISTRY.map((source) => ({
      updateOne: {
        filter: { _id: source._id },
        update: { $set: source as never },
        upsert: true,
      },
    })),
  );

  // ---- Catalog -----------------------------------------------------------
  log.info('generating listings', { count: options.count, seed: options.seed });
  const catalog = generateCatalog({ seed: options.seed, count: options.count, now });

  const embedder = localEmbeddingProvider();
  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  const pipeline = new IngestionPipeline({
    collections,
    embedder,
    classifier,
    media: mediaPipeline(),
    brandDictionary: catalog.brands,
    counterfeitWatchlistBrands: new Set(catalog.counterfeitWatchlist),
    blockedDomains: new Set(
      SOURCE_REGISTRY.filter((s) => s.status === 'blocked').map((s) => s._id),
    ),
  });

  const tally = { ingested: 0, rejected: 0, byReason: new Map<string, number>() };
  let processed = 0;

  for (const listing of catalog.listings) {
    const result = await pipeline.ingest(listing, now);
    if (result.status === 'ingested') tally.ingested += 1;
    else {
      tally.rejected += 1;
      const reason = result.rejectReason ?? 'unknown';
      tally.byReason.set(reason, (tally.byReason.get(reason) ?? 0) + 1);
    }

    processed += 1;
    if (processed % 1000 === 0) {
      log.info('ingestion progress', {
        processed,
        total: catalog.listings.length,
        ingested: tally.ingested,
        rejected: tally.rejected,
      });
    }
  }

  log.info('ingestion complete', {
    ingested: tally.ingested,
    rejected: tally.rejected,
    reasons: Object.fromEntries(tally.byReason),
  });

  // ---- Engagement --------------------------------------------------------
  // Real engagement is measured, not generated; seeding it is the one place
  // this script has to invent something. It is derived from listing quality so
  // that the CTR term ranks sensibly rather than adding pure noise, and it is
  // written before centroids so the "top 500 by engagement" selection is real.
  await seedEngagement(collections, options.seed);

  // ---- Centroids ---------------------------------------------------------
  await recomputeCentroids(collections, now);

  // ---- Co-occurrence -----------------------------------------------------
  await bootstrapCoOccurrence(collections);

  // ---- Coupons -----------------------------------------------------------
  await seedCoupons(collections, options.seed, now);

  const counts = {
    products: await collections.products.countDocuments({ status: 'active' }),
    rejected: await collections.products.countDocuments({ status: 'rejected' }),
    clusters: await collections.clusters.countDocuments({}),
    sellers: await collections.sellers.countDocuments({}),
    reviews: await collections.reviews.countDocuments({}),
    coupons: await collections.coupons.countDocuments({}),
    categories: await collections.categories.countDocuments({}),
  };

  const multiOfferClusters = await collections.clusters.countDocuments({ offerCount: { $gt: 1 } });
  const riskTiers = await collections.products
    .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$risk.tier', n: { $sum: 1 } } }])
    .toArray();

  log.info('seed complete', {
    ...counts,
    multiOfferClusters,
    riskTiers: Object.fromEntries(riskTiers.map((r) => [r._id, r.n])),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await db.close();
}

/**
 * Assigns engagement counters and folds the new engagement term back into the
 * quality score. Q is linear in its components, so the update is exact rather
 * than an approximation of a full recompute.
 */
async function seedEngagement(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  seed: string,
): Promise<void> {
  const random = mulberry32(hashString(`${seed}:engagement`));
  const cursor = collections.products.find(
    { status: 'active' },
    { projection: { _id: 1, quality: 1, 'category.l2': 1 } },
  );

  const operations: Array<AnyBulkWriteOperation<Product>> = [];
  let count = 0;

  for await (const product of cursor) {
    const quality = product.quality?.score ?? 0.5;
    const impressions = Math.floor(200 + random() * 4000);
    // Better listings earn a better rate, with real noise on top: a perfectly
    // quality-ordered CTR would make the ctr term redundant with the q term.
    const baseRate = clamp(0.02 + quality * 0.06 + (random() - 0.5) * 0.03, 0.002, 0.18);
    const interactions = Math.round(impressions * baseRate);
    const cartAdds = Math.round(interactions * clamp(0.08 + random() * 0.18, 0, 0.5));

    const engagementTerm = engagementScore({
      impressions,
      interactions,
      cartAdds,
      categoryMeanCtr: 0.04,
      categoryMeanCartRate: 0.012,
    });

    const previousTerm = product.quality?.engagement ?? 0;
    const previousScore = product.quality?.score ?? 0;
    const nextScore = clamp(
      previousScore + QUALITY_WEIGHTS.engagement * (engagementTerm - previousTerm),
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
              ctrSmoothed: Math.round(baseRate * 10000) / 10000,
              cartAdds,
            },
            'quality.engagement': Math.round(engagementTerm * 1000) / 1000,
            'quality.score': Math.round(nextScore * 1000) / 1000,
          },
        },
      },
    });

    if (operations.length >= 1000) {
      await collections.products.bulkWrite(operations);
      count += operations.length;
      operations.length = 0;
    }
  }

  if (operations.length > 0) {
    await collections.products.bulkWrite(operations);
    count += operations.length;
  }
  log.info('engagement seeded', { products: count });
}

/**
 * The nightly centroid recompute, run once here.
 *
 * Each category node's centroid is the mean of the embeddings of its 500
 * highest-engagement products. This is what makes a cold-start user's seed
 * meaningful before they have generated a single interaction, so an empty
 * centroid is a bug that only shows up at onboarding — which is why L2 and L3
 * centroids fall back to their children rather than being left null.
 */
export async function recomputeCentroids(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  now: Date,
): Promise<void> {
  const levels: Array<1 | 2 | 3> = [3, 2, 1];

  for (const level of levels) {
    const nodes = await collections.categories.find({ level }).toArray();
    const operations: Array<AnyBulkWriteOperation<Category>> = [];

    for (const node of nodes) {
      const field =
        level === 1 ? 'category.l1' : level === 2 ? 'category.l2' : 'category.l3';

      const members = await collections.products
        .find(
          { [field]: node._id, status: 'active' },
          { projection: { embedding: 1 }, sort: { 'engagement.ctrSmoothed': -1 }, limit: 500 },
        )
        .toArray();

      const productCount = await collections.products.countDocuments({
        [field]: node._id,
        status: 'active',
      });

      const ctrs = await collections.products
        .find(
          { [field]: node._id, status: 'active' },
          { projection: { 'engagement.ctrSmoothed': 1 }, limit: 2000 },
        )
        .toArray();
      const rates = ctrs.map((c) => c.engagement?.ctrSmoothed ?? 0).sort((a, b) => a - b);
      const medianCtr = rates.length > 0 ? (rates[Math.floor(rates.length / 2)] as number) : 0.04;

      const centroid =
        members.length > 0 ? meanVector(members.map((m) => m.embedding)) : null;

      operations.push({
        updateOne: {
          filter: { _id: node._id },
          update: {
            $set: {
              centroid,
              centroidComputedAt: centroid ? now : null,
              memberCount: Math.min(members.length, 500),
              'engagement.productCount': productCount,
              'engagement.medianCtr': Math.round(medianCtr * 10000) / 10000,
            },
          },
        },
      });
    }

    if (operations.length > 0) await collections.categories.bulkWrite(operations);
    // Named `categoryLevel` rather than `level`: the log line already has a
    // `level` field and a collision silently overwrites the severity.
    log.info('centroids computed', { categoryLevel: level, nodes: nodes.length });
  }
}

/**
 * Bootstraps the co-occurrence lift matrix.
 *
 * Lift is normally computed nightly from the interaction log: how often users
 * with one interest also engage with another topic. There is no interaction log
 * on a fresh database, so this seeds it from catalog similarity between L1
 * centroids instead — an honest prior that says "these topics are about related
 * things", which the real job overwrites with "these topics are liked by the
 * same people" as soon as there is evidence.
 */
export async function bootstrapCoOccurrence(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
): Promise<void> {
  const nodes = await collections.categories.find({ level: 1 }).toArray();
  const byId = new Map(nodes.map((n) => [n._id, n]));

  const operations: Array<AnyBulkWriteOperation<Category>> = [];
  for (const node of nodes) {
    if (!node.centroid) continue;
    const pairs: Array<{ topic: string; lift: number }> = [];

    for (const other of L1_IDS) {
      if (other === node._id) continue;
      const otherNode = byId.get(other);
      if (!otherNode?.centroid) continue;
      const similarity = cosine(node.centroid, otherNode.centroid);
      // Mapped onto a lift-shaped scale centred at 1.0, where above 1 means
      // "more likely than chance" — the same units the real job produces.
      const lift = Math.round(clamp(1 + similarity * 2.5, 0.2, 4) * 100) / 100;
      pairs.push({ topic: other, lift });
    }

    pairs.sort((a, b) => b.lift - a.lift);
    operations.push({
      updateOne: {
        filter: { _id: node._id },
        update: { $set: { coOccurrence: pairs.slice(0, 8) } },
      },
    });
  }

  if (operations.length > 0) await collections.categories.bulkWrite(operations);
  log.info('co-occurrence bootstrapped', { topics: operations.length });
}

/**
 * Seeds the coupon store.
 *
 * Real codes come from crawling public coupon aggregators, merchant newsletters
 * and on-site promo banners. These are plausible stand-ins with plausible
 * historic performance, so the candidate ranking and the retirement loop have
 * something to sort and something to retire.
 */
async function seedCoupons(
  collections: Awaited<ReturnType<typeof connectDatabase>>['collections'],
  seed: string,
  now: Date,
): Promise<void> {
  const random = mulberry32(hashString(`${seed}:coupons`));
  const codes = [
    'SAVE15',
    'WELCOME10',
    'SPRING20',
    'FREESHIP',
    'MEMBER5',
    'BUNDLE25',
    'FIRSTORDER',
    'CLEARANCE30',
    'LOYALTY12',
    'APPONLY8',
  ];

  const docs: Array<CouponDoc<ObjectId>> = [];
  for (const source of SOURCE_REGISTRY) {
    if (!source.checkout.supported) continue;
    const perMerchant = 3 + Math.floor(random() * 5);
    const shuffled = [...codes].sort(() => random() - 0.5).slice(0, perMerchant);

    for (const code of shuffled) {
      const attempts = Math.floor(random() * 400);
      const successRate = clamp(random() * 0.7, 0, 0.7);
      const successes = Math.round(attempts * successRate);
      docs.push({
        _id: new ObjectId(),
        merchantDomain: source._id,
        code,
        discovered: {
          from: random() < 0.6 ? 'aggregator' : random() < 0.5 ? 'affiliate' : 'onsite',
          url: `https://coupons.example/${source._id}/${code.toLowerCase()}`,
          at: new Date(now.getTime() - random() * 90 * 86_400_000),
        },
        constraints: {
          minSpend: random() < 0.35 ? Math.floor(random() * 10000) : null,
          categories: [],
          firstOrderOnly: code === 'FIRSTORDER' || code === 'WELCOME10',
          expiresAt:
            random() < 0.25 ? new Date(now.getTime() - random() * 30 * 86_400_000) : null,
        },
        performance: {
          attempts,
          successes,
          successRate: attempts === 0 ? 0 : successes / attempts,
          meanDiscountPct: Math.round(randomDiscount(code, random) * 10) / 10,
          lastSuccessAt: successes > 0 ? new Date(now.getTime() - random() * 20 * 86_400_000) : null,
          consecutiveFailures: successes === 0 && attempts > 0 ? Math.min(2, attempts) : 0,
        },
        stackable: random() < 0.2,
        status: 'active',
      });
    }
  }

  if (docs.length > 0) {
    await collections.coupons.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { merchantDomain: doc.merchantDomain, code: doc.code },
          update: { $set: doc },
          upsert: true,
        },
      })),
    );
  }
  log.info('coupons seeded', { coupons: docs.length });
}

function randomDiscount(code: string, random: () => number): number {
  const declared = code.match(/(\d{1,2})$/);
  if (declared) return Number.parseInt(declared[1] as string, 10);
  return 5 + random() * 15;
}

main().catch((error) => {
  log.error('seed failed', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
