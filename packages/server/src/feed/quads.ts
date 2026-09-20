import { childrenOf, type RankingConfig } from '@window/shared';
import type { VectorCandidate } from '../vector/types.js';

/**
 * Quad composition for Window mode.
 *
 * Window mode consumes four products per scroll, so a user burns through the
 * ranked list four times faster. Ranking must not compensate by sending
 * lower-quality items; instead the server is told the mode and returns products
 * grouped into coherent quads — four items from the same L2 category and within
 * a 2.5x price band of each other.
 *
 * This is the metaphor doing load-bearing work rather than a nicety. A real
 * shop window displays related goods; four unrelated objects read as a junk
 * drawer, not a display. A quad that fails coherence is worse than a quad that
 * is slightly less well ranked.
 */

/**
 * Half-width of the price band. Four items within sqrt(2.5) either side of the
 * seed are within 2.5x of *each other*, which is the constraint that actually
 * matters — a band defined against the seed alone lets the cheapest and dearest
 * tiles sit 6x apart.
 */
export function priceBandFor(
  seedPrice: number,
  config: RankingConfig,
): { min: number; max: number } {
  const halfWidth = Math.sqrt(config.quads.priceBandMultiplier);
  return {
    min: Math.max(1, Math.round(seedPrice / halfWidth)),
    max: Math.round(seedPrice * halfWidth),
  };
}

/** The L3 ids under an L2, used to scope the narrow per-quad query. */
export function l3ScopeFor(l2Id: string): string[] {
  return childrenOf(l2Id).map((node) => node.id);
}

export interface QuadSeed {
  candidate: VectorCandidate;
  l2: string;
  band: { min: number; max: number };
  l3Scope: string[];
}

/**
 * Chooses seeds from the ranked page: the highest-scoring candidate in each
 * distinct L2, in rank order. Seeding from distinct categories is what makes
 * consecutive panes feel like different shop windows rather than one long shelf.
 */
export function chooseQuadSeeds(
  ranked: readonly VectorCandidate[],
  config: RankingConfig,
  count: number,
): QuadSeed[] {
  const seeds: QuadSeed[] = [];
  const usedL2 = new Set<string>();

  for (const candidate of ranked) {
    if (seeds.length >= count) break;
    if (usedL2.has(candidate.category.l2)) continue;
    usedL2.add(candidate.category.l2);
    seeds.push({
      candidate,
      l2: candidate.category.l2,
      band: priceBandFor(candidate.price.amount, config),
      l3Scope: l3ScopeFor(candidate.category.l2),
    });
  }

  // If the page did not contain enough distinct L2s, fall back to repeating
  // categories rather than returning fewer panes: an empty pane is a hole in
  // the feed, and a second keyboard window is not.
  for (const candidate of ranked) {
    if (seeds.length >= count) break;
    if (seeds.some((s) => s.candidate.id === candidate.id)) continue;
    seeds.push({
      candidate,
      l2: candidate.category.l2,
      band: priceBandFor(candidate.price.amount, config),
      l3Scope: l3ScopeFor(candidate.category.l2),
    });
  }

  return seeds;
}

/**
 * Assembles one quad from its seed and the narrow query's results.
 *
 * Coherence is enforced twice: the query is already scoped to the seed's L2 and
 * price band, and anything that still falls outside 2.5x of the tiles already
 * placed is dropped here. Tiles are ordered cheapest first, because a grid the
 * eye can read by price is the whole point of the comparison mode.
 */
export function assembleQuad(
  seed: QuadSeed,
  pool: readonly VectorCandidate[],
  config: RankingConfig,
  used: ReadonlySet<string>,
): VectorCandidate[] | null {
  const size = config.quads.size;
  const quad: VectorCandidate[] = [seed.candidate];
  let min = seed.candidate.price.amount;
  let max = seed.candidate.price.amount;

  for (const candidate of pool) {
    if (quad.length >= size) break;
    const key = candidate.id;
    if (used.has(key)) continue;
    if (quad.some((q) => q.id === candidate.id)) continue;
    if (candidate.category.l2 !== seed.l2) continue;

    const nextMin = Math.min(min, candidate.price.amount);
    const nextMax = Math.max(max, candidate.price.amount);
    if (nextMin <= 0) continue;
    if (nextMax / nextMin > config.quads.priceBandMultiplier) continue;

    quad.push(candidate);
    min = nextMin;
    max = nextMax;
  }

  if (quad.length < size) return null;
  return quad.sort((a, b) => a.price.amount - b.price.amount);
}

/** Index groupings for the wire: `[[0,1,2,3],[4,5,6,7],...]`. */
export function quadIndexes(paneCount: number, size: number): number[][] {
  return Array.from({ length: paneCount }, (_, pane) =>
    Array.from({ length: size }, (_, offset) => pane * size + offset),
  );
}
