import type { Db } from 'mongodb';
import { EMBEDDING_DIM } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { COLLECTION_NAMES } from './collections.js';

const log = logger.child('indexes');

/** Thirteen months, the interaction retention ceiling. */
const INTERACTION_TTL_SECONDS = Math.round(13 * 30.44 * 24 * 60 * 60);

/**
 * The Atlas Vector Search index definition, verbatim from the data model.
 *
 * Scalar quantization is deliberate: above a few million products the memory
 * saving is what keeps ANN search inside the latency budget, and the recall
 * loss at 1024 dims is negligible for this use case.
 */
export function productVectorIndexDefinition(name = env.vectorIndexName) {
  return {
    name,
    type: 'vectorSearch' as const,
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: EMBEDDING_DIM,
          similarity: 'cosine',
          quantization: 'scalar',
        },
        { type: 'filter', path: 'category.l1' },
        { type: 'filter', path: 'stock.inStock' },
        { type: 'filter', path: 'status' },
        { type: 'filter', path: 'sourceType' },
        { type: 'filter', path: 'price.amount' },
      ],
    },
  };
}

export function clusterVectorIndexDefinition(name = env.clusterVectorIndexName) {
  return {
    name,
    type: 'vectorSearch' as const,
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: EMBEDDING_DIM,
          similarity: 'cosine',
          quantization: 'scalar',
        },
        { type: 'filter', path: 'category.l3' },
      ],
    },
  };
}

/**
 * Creates every index in the data model. Safe to run repeatedly.
 *
 * Search indexes are an Atlas feature; on a local MongoDB the calls fail and
 * are logged rather than thrown, because the ranking service falls back to the
 * in-process vector index in exactly that case.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const products = db.collection(COLLECTION_NAMES.products);
  const clusters = db.collection(COLLECTION_NAMES.clusters);
  const users = db.collection(COLLECTION_NAMES.users);
  const interactions = db.collection(COLLECTION_NAMES.interactions);
  const carts = db.collection(COLLECTION_NAMES.carts);
  const orders = db.collection(COLLECTION_NAMES.orders);
  const coupons = db.collection(COLLECTION_NAMES.coupons);
  const reviews = db.collection(COLLECTION_NAMES.reviews);
  const sellers = db.collection(COLLECTION_NAMES.sellers);
  const categories = db.collection(COLLECTION_NAMES.categories);
  const reports = db.collection(COLLECTION_NAMES.reports);
  const merchantLinks = db.collection(COLLECTION_NAMES.merchantLinks);

  await Promise.all([
    // products — best-offer resolution, re-crawl upsert, refresh scheduling.
    products.createIndex({ clusterId: 1, 'price.amount': 1 }, { name: 'cluster_price' }),
    products.createIndex(
      { 'source.domain': 1, 'source.sourceId': 1 },
      { name: 'source_unique', unique: true },
    ),
    products.createIndex({ status: 1, 'crawl.lastCrawledAt': 1 }, { name: 'refresh_schedule' }),
    // Supports the local vector index's pre-filter and the popularity fallbacks.
    products.createIndex(
      { status: 1, 'stock.inStock': 1, 'category.l1': 1, 'engagement.ctrSmoothed': -1 },
      { name: 'eligible_by_topic' },
    ),
    products.createIndex({ 'risk.tier': 1, status: 1 }, { name: 'risk_tier' }),
    products.createIndex({ sellerId: 1, status: 1 }, { name: 'seller_listings' }),

    // clusters
    clusters.createIndex({ canonicalProductId: 1 }, { name: 'canonical' }),
    clusters.createIndex(
      { 'identifiers.gtin': 1 },
      { name: 'gtin', sparse: true },
    ),
    clusters.createIndex({ 'category.l3': 1 }, { name: 'cluster_l3' }),

    // users — identity.
    users.createIndex({ deviceUserId: 1 }, { name: 'device_identity', unique: true }),
    users.createIndex(
      { 'auth.email': 1 },
      { name: 'email_identity', sparse: true, unique: true },
    ),

    // interactions — per-user recency, engagement rollups, bounded growth.
    interactions.createIndex({ userId: 1, serverTs: -1 }, { name: 'user_recency' }),
    interactions.createIndex(
      { clusterId: 1, type: 1, serverTs: -1 },
      { name: 'engagement_rollup' },
    ),
    interactions.createIndex(
      { serverTs: 1 },
      { name: 'retention_ttl', expireAfterSeconds: INTERACTION_TTL_SECONDS },
    ),
    // The collector dedupes on the client-generated idempotency key.
    interactions.createIndex(
      { userId: 1, idempotencyKey: 1 },
      { name: 'idempotency', unique: true },
    ),
    interactions.createIndex(
      { userId: 1, 'category.l1': 1, serverTs: -1 },
      { name: 'user_topic_recency' },
    ),

    // carts — one open cart per user.
    carts.createIndex(
      { userId: 1, status: 1 },
      { name: 'open_cart', unique: true, partialFilterExpression: { status: 'open' } },
    ),

    // orders — history and job sweeps.
    orders.createIndex({ userId: 1, createdAt: -1 }, { name: 'order_history' }),
    orders.createIndex({ status: 1, updatedAt: 1 }, { name: 'job_sweep' }),
    orders.createIndex({ 'agentRun.jobId': 1 }, { name: 'job_lookup', sparse: true }),

    // coupons — ranked candidate fetch.
    coupons.createIndex(
      { merchantDomain: 1, status: 1, 'performance.successRate': -1 },
      { name: 'candidate_fetch' },
    ),
    coupons.createIndex(
      { merchantDomain: 1, code: 1 },
      { name: 'coupon_unique', unique: true },
    ),

    // reviews — sheet population.
    reviews.createIndex(
      { clusterId: 1, bucket: 1, helpfulCount: -1 },
      { name: 'sheet_population' },
    ),
    reviews.createIndex({ clusterId: 1, postedAt: -1 }, { name: 'review_recency' }),

    // sellers
    sellers.createIndex(
      { sourceDomain: 1, sourceSellerId: 1 },
      { name: 'seller_unique', unique: true },
    ),

    // categories
    categories.createIndex({ level: 1, parent: 1 }, { name: 'tree' }),
    categories.createIndex({ level: 1, 'tile.order': 1 }, { name: 'onboarding_tiles' }),

    // reports and merchant links
    reports.createIndex({ productId: 1, status: 1 }, { name: 'reports_by_product' }),
    reports.createIndex({ sellerId: 1, status: 1 }, { name: 'reports_by_seller' }),
    reports.createIndex(
      { productId: 1, userId: 1 },
      { name: 'one_report_per_user', unique: true },
    ),
    merchantLinks.createIndex(
      { userId: 1, merchantDomain: 1 },
      { name: 'link_unique', unique: true },
    ),
  ]);

  log.info('operational indexes ensured');
  await ensureVectorIndexes(db);
}

/** Atlas-only. Logged and skipped elsewhere. */
export async function ensureVectorIndexes(db: Db): Promise<boolean> {
  if (!env.atlasVectorSearch) {
    log.info('atlas vector search disabled; using the in-process vector index', {
      hint: 'set ATLAS_VECTOR_SEARCH=1 with an Atlas MONGO_URL to use $vectorSearch',
    });
    return false;
  }
  try {
    const products = db.collection(COLLECTION_NAMES.products);
    const clusters = db.collection(COLLECTION_NAMES.clusters);
    const existing = await products.listSearchIndexes().toArray();
    const names = new Set(existing.map((i) => i.name as string));

    if (!names.has(env.vectorIndexName)) {
      await products.createSearchIndex(productVectorIndexDefinition());
      log.info('created product vector index', { name: env.vectorIndexName });
    }
    const clusterExisting = await clusters.listSearchIndexes().toArray();
    if (!clusterExisting.some((i) => i.name === env.clusterVectorIndexName)) {
      await clusters.createSearchIndex(clusterVectorIndexDefinition());
      log.info('created cluster vector index', { name: env.clusterVectorIndexName });
    }
    return true;
  } catch (error) {
    log.warn('vector index creation failed; falling back to the in-process index', {
      error: (error as Error).message,
    });
    return false;
  }
}
