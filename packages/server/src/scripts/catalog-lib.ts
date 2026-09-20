/**
 * The tail of an ingest run, shared by the API and web ingest scripts.
 */

import { QUALITY_WEIGHTS, clamp, cosine, meanVector } from '@window/shared';
import type { CollectionSet } from '../db/supabase-collections.js';
import { find, updateOne } from '../db/supabase-helpers.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { engagementScore } from '../ingestion/quality.js';
import { logger } from '../lib/logger.js';

const log = logger.child('catalog-lib');

type Collections = CollectionSet;

/**
 * A catalog this small has no measured engagement at all, and a zero CTR makes
 * the `ctr` term a constant rather than a signal. Everything starts at the
 * category mean, which is the honest prior for a product nobody has seen.
 */
export async function primeEngagement(collections: Collections): Promise<void> {
  const products = await find(collections.products, { status: 'active' }, { select: 'id,quality' });

  for (const product of products) {
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
    await updateOne(collections.products, { id: product.id }, {
      engagement: { impressions: 200, interactions: 8, ctrSmoothed: 0.04, cartAdds: 1 },
      quality: {
        ...(product.quality || {}),
        engagement: Math.round(term * 1000) / 1000,
        score: Math.round(next * 1000) / 1000,
      },
    });
  }
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
    const nodes = await find(collections.categories, { level });

    for (const node of nodes) {
      const field = level === 1 ? 'category.l1' : level === 2 ? 'category.l2' : 'category.l3';
      const members = await find(
        collections.products,
        { [field]: node.id, status: 'active' },
        { select: 'embedding', limit: 500 },
      );

      const centroid =
        members.length > 0
          ? meanVector(members.map((m) => m.embedding))
          : await embedder.embedText(node.displayName);

      await updateOne(collections.categories, { id: node.id }, {
        centroid,
        centroidComputedAt: now,
        memberCount: members.length,
        engagement: {
          ...(node.engagement || {}),
          productCount: members.length,
        },
      });
    }
  }
  log.info('centroids recomputed (empty categories fall back to their name vector)');
}

export async function bootstrapCoOccurrence(collections: Collections): Promise<void> {
  const nodes = await find(collections.categories, { level: 1 });

  for (const node of nodes) {
    if (!node.centroid) continue;
    const pairs = nodes
      .filter((other) => other.id !== node.id && other.centroid)
      .map((other) => ({
        topic: other.id,
        lift:
          Math.round(clamp(1 + cosine(node.centroid as number[], other.centroid as number[]) * 2.5, 0.2, 4) * 100) /
          100,
      }))
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 8);

    await updateOne(collections.categories, { id: node.id }, { coOccurrence: pairs });
  }
}
