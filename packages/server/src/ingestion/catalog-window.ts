/**
 * The catalog as a rolling window.
 *
 * The feed does not need a warehouse behind it: it needs enough fresh listings
 * ahead of the cursor to keep scrolling, and nothing behind it. This module
 * keeps the stored catalog at a fixed size by adding real listings at the head
 * and dropping the oldest from the tail.
 *
 * Adding always happens before dropping. A fetch that returns nothing then
 * costs the user nothing, where the reverse order would empty the feed and
 * leave it empty.
 */

import { claudeCli } from '../agent/llm.js';
import { expandFromWeb } from '../feed/web-expand.js';
import type { CollectionSet } from '../db/supabase-collections.js';
import { find } from '../db/supabase-helpers.js';
import { logger } from '../lib/logger.js';
import { createWebIngestion, persistWebListings } from './web-persistence.js';

const log = logger.child('catalog-window');

/**
 * Topics used when the caller has no interests of its own yet.
 *
 * Deliberately wide. One storefront search returns one shelf, and now that a
 * product already stocked from a site is rejected rather than stored twice, a
 * narrow seed list stops producing new listings long before the window is full
 * — four terms cannot fill forty-eight slots. Spreading the seeds across
 * unrelated categories is also what lets the grid assemble coherent panes,
 * since a pane needs four items from one L2 inside a price band.
 */
export const DEFAULT_WINDOW_TOPICS = [
  'wireless headphones',
  'mechanical keyboard',
  'smart watch',
  'portable speaker',
  'running shoes',
  'coffee grinder',
  'desk lamp',
  'backpack',
  'cast iron skillet',
  'yoga mat',
  'sunglasses',
  'water bottle',
];

export interface RotationStats {
  requested: number;
  attempted: number;
  added: number;
  removed: number;
  reasons: Record<string, number>;
}

/**
 * Deletes products and everything the schema hangs off them.
 *
 * `product_clusters.canonical_product_id` references `products` with
 * `ON DELETE RESTRICT`, so a product that heads a cluster cannot be removed
 * while that cluster exists. Dropping the cluster first satisfies it and takes
 * the reviews with it: `reviews.cluster_id` cascades, and `products.cluster_id`
 * is set null on the rows that survive. Interactions and reports cascade from
 * the product itself.
 */
export async function removeProducts(
  collections: CollectionSet,
  productIds: readonly string[],
): Promise<number> {
  if (productIds.length === 0) return 0;

  const products = await find<{ id: string; clusterId: string | null }>(
    collections.products,
    { id: { $in: [...productIds] } },
    { select: 'id,clusterId' },
  );
  if (products.length === 0) return 0;

  const clusterIds = [...new Set(products.map((p) => p.clusterId).filter((id): id is string => id != null))];
  if (clusterIds.length > 0) {
    const { error } = await collections.clusters.delete().in('id', clusterIds);
    if (error) throw new Error(`cluster cleanup failed: ${error.message}`);
  }

  const ids = products.map((p) => p.id);
  const { error } = await collections.products.delete().in('id', ids);
  if (error) throw new Error(`product delete failed: ${error.message}`);

  log.info('removed products', { products: ids.length, clusters: clusterIds.length });
  return ids.length;
}

/**
 * The oldest visible products, which are the ones the window drops.
 *
 * `created_at` orders by when we first saw a listing, not by feed position: the
 * feed's order is per-user and per-session, so there is no single "first item"
 * to read off the database. Oldest-first is the closest stable proxy and is
 * what makes the window roll.
 *
 * Only `active` rows are candidates. A rejected listing is a tombstone — it
 * records that a url was tried and found unusable, so it is not re-crawled —
 * and it never reaches the feed. Counting tombstones here would retire them in
 * place of real listings and let the visible catalog drift past its size.
 */
export async function oldestProductIds(
  collections: CollectionSet,
  limit: number,
  exclude: readonly string[] = [],
): Promise<string[]> {
  if (limit <= 0) return [];
  const skip = new Set(exclude);

  const { data, error } = await collections.products
    .select('id')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(limit + skip.size);
  if (error) throw new Error(`oldest lookup failed: ${error.message}`);

  return (data ?? [])
    .map((row) => (row as { id: string }).id)
    .filter((id) => !skip.has(id))
    .slice(0, limit);
}

export interface FillOptions {
  /** How many listings must actually reach the catalog. */
  count: number;
  /** Search terms the web leg is steered by. */
  topics?: readonly string[];
}

/**
 * Fetches real listings from the storefronts and writes them to the catalog.
 *
 * The web leg is asked for well more than `count`, because most of what it
 * finds does not survive the pipeline — a missing price, an image under the
 * eligibility floor, or a duplicate of something already stored are all
 * ordinary outcomes, and asking for exactly `count` reliably returns fewer.
 */
export async function fillCatalog(
  collections: CollectionSet,
  options: FillOptions,
): Promise<{ added: number; attempted: number; reasons: Record<string, number>; ids: string[] }> {
  const topics = [...(options.topics ?? [])].filter((t) => t.trim() !== '');
  const seeds = topics.length > 0 ? topics : DEFAULT_WINDOW_TOPICS;

  // Every seed is searched. `expandFromWeb` caps itself at three queries by
  // default, which is right when it is guessing queries from a few anchor
  // titles and wrong here, where each seed is a deliberate, distinct shelf —
  // leaving it at three meant nine of twelve topics were never looked at.
  const listings = await expandFromWeb(seeds, options.count * 3, {
    llm: claudeCli(),
    maxQueries: seeds.length,
  });
  log.info('collected candidate listings', { seeds, found: listings.length });
  if (listings.length === 0) {
    return { added: 0, attempted: 0, reasons: { nothing_collected: 1 }, ids: [] };
  }

  const pipeline = await createWebIngestion(collections, listings);
  const ids: string[] = [];
  const stats = await persistWebListings(
    pipeline,
    listings,
    options.count,
    new Date(),
    (listing, error) =>
      log.warn('ingest failed', { sourceId: listing.sourceId, error: (error as Error).message }),
    (result) => {
      if (result.productId) ids.push(result.productId);
    },
  );

  return { added: stats.ingested, attempted: stats.attempted, reasons: stats.reasons, ids };
}

export interface RotateOptions extends FillOptions {
  /** How many of the oldest products to drop once the new ones are in. */
  drop: number;
}

/**
 * Advances the window: add fresh listings, then drop the oldest.
 *
 * Never drops more than it added. The point of the window is to hold its size,
 * and a storefront that answers with three listings today should shrink the
 * catalog by three rather than by the eight that were asked for.
 */
export async function rotateCatalog(
  collections: CollectionSet,
  options: RotateOptions,
): Promise<RotationStats> {
  const filled = await fillCatalog(collections, options);

  const dropCount = Math.min(options.drop, filled.added);
  const doomed = await oldestProductIds(collections, dropCount, filled.ids);
  const removed = await removeProducts(collections, doomed);

  const stats: RotationStats = {
    requested: options.count,
    attempted: filled.attempted,
    added: filled.added,
    removed,
    reasons: filled.reasons,
  };
  log.info('window rotated', { ...stats });
  return stats;
}
