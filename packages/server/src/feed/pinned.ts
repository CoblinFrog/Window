import { demoStore } from '../config/demo-store.js';
import type { CollectionSet, User } from '../db/supabase-collections.js';
import { find } from '../db/supabase-helpers.js';
import { logger } from '../lib/logger.js';
import type { VectorCandidate } from '../vector/types.js';

const log = logger.child('feed.pinned');

/**
 * Products that appear on every page of the scroll.
 *
 * This is a deliberate hole in the feed's central rule. Everything else the
 * ranker serves is filtered through the seen-set, because a feed that repeats
 * itself is a feed people stop scrolling; the pin exists precisely so the
 * demo store's checkout path is one tap away on any page, whether or not the
 * shopper has already scrolled past it. It is not a ranking boost — a boosted
 * product still loses to the seen filter on the second page — so nothing here
 * goes through scoring at all.
 *
 * Two things are still honoured, because ignoring them would be a bug rather
 * than the intended exception. A product the shopper suppressed stays gone:
 * "always show this" was written about the catalog, not about someone who
 * explicitly asked not to see it. And a product that is out of stock or no
 * longer active is dropped, because pinning a dead listing to the top of every
 * page is worse than not pinning at all.
 */

/**
 * The pinned products, in configured order, ready for `mergePinned` to place.
 * Empty when no demo store is configured, which is the normal case.
 */
export async function pinnedCandidates(
  collections: CollectionSet,
  user: User,
  now: Date,
): Promise<VectorCandidate[]> {
  const store = demoStore();
  if (!store || store.productIds.length === 0) return [];

  const suppressed = new Set(user.suppressions.products);
  const wanted = store.productIds.filter((id) => !suppressed.has(id));
  if (wanted.length === 0) return [];

  let docs: VectorCandidate[];
  try {
    docs = (await find(
      collections.products,
      { id: { $in: wanted }, status: 'active', 'stock.inStock': true },
      { limit: wanted.length },
    )) as unknown as VectorCandidate[];
  } catch (error) {
    // The pin is an enhancement, never a reason to fail a page.
    log.warn('pinned lookup failed; serving the page unpinned', {
      error: (error as Error).message,
    });
    return [];
  }

  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const found: VectorCandidate[] = [];
  for (const id of wanted) {
    const doc = byId.get(id);
    if (!doc) continue;
    if (doc.auction && doc.auction.endsAt.getTime() <= now.getTime()) continue;
    // A pinned product is placed, not scored, so the vector score is only here
    // to satisfy the shape every downstream consumer reads.
    found.push({ ...(doc as unknown as VectorCandidate), vectorScore: 1 });
  }

  if (found.length < wanted.length) {
    // Worth saying out loud: the usual cause is that the seeder has not been
    // run against this database, and the symptom is a demo that silently has
    // no demo in it.
    log.warn('some pinned products are missing from the catalog', {
      wanted: wanted.length,
      found: found.length,
      missing: wanted.filter((id) => !byId.has(id)),
    });
  }
  return found;
}

/**
 * Places `pinned` into `items` at `offset`, once each.
 *
 * `offset` is deliberately not zero — see `pinOffset` on the config for why a
 * product held at the top of every page reads as an advertisement. A page with
 * fewer cards than the offset puts them at its end rather than dropping them,
 * which is the only sensible reading of "late" on a short page.
 *
 * A pinned product the ranker already selected is moved rather than repeated.
 * On the first page, before anything is in the seen-set, the ranker can and
 * does return it on merit, and showing it twice is the obvious failure here.
 *
 * The page keeps its length: pinning inserts cards and drops them off the
 * back, so a caller that asked for twenty still gets twenty. The slice floor
 * is the far edge of the pins, so a limit that would cut them is widened
 * instead — losing the pin silently is worse than a page one card long.
 */
export function mergePinned(
  pinned: readonly VectorCandidate[],
  items: readonly VectorCandidate[],
  limit: number,
  offset: number,
): VectorCandidate[] {
  if (pinned.length === 0) return [...items];
  const pinnedIds = new Set(pinned.map((candidate) => candidate.id));
  const rest = items.filter((candidate) => !pinnedIds.has(candidate.id));
  const at = Math.max(0, Math.min(offset, rest.length));
  const merged = [...rest.slice(0, at), ...pinned, ...rest.slice(at)];
  return merged.slice(0, Math.max(limit, at + pinned.length));
}
