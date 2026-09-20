/**
 * The tail of an ingest run, shared by the API and web ingest scripts.
 */

import type { AnyBulkWriteOperation } from 'mongodb';
import { QUALITY_WEIGHTS, clamp, cosine, meanVector } from '@window/shared';
import type { connectDatabase } from '../db/client.js';
import type { Category, Product } from '../db/collections.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { engagementScore } from '../ingestion/quality.js';
import { logger } from '../lib/logger.js';

const log = logger.child('catalog-lib');

type Collections = Awaited<ReturnType<typeof connectDatabase>>['collections'];

/**
 * A catalog this small has no measured engagement at all, and a zero CTR makes
 * the `ctr` term a constant rather than a signal. Everything starts at the
 * category mean, which is the honest prior for a product nobody has seen.
 */
export async function primeEngagement(collections: Collections): Promise<void> {
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
export async function recomputeCentroids(collections: Collections, now: Date): Promise<void> {
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

export async function bootstrapCoOccurrence(collections: Collections): Promise<void> {
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
