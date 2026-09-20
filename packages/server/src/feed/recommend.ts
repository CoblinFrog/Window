/**
 * Session-vector recommendation: "blend who I am with what I just looked at,
 * and give me the next batch to scroll."
 *
 * Two inputs — a long-term preferences vector and a recent-history vector —
 * are mixed into a single query direction. That direction then pulls from two
 * places: the vector index over the catalog, and (when `deps.web` is wired)
 * the live storefronts via `expandFromWeb`, so the page can contain listings
 * nobody has ingested yet. Web results are scored by embedding their titles
 * into the same space; without an embedder they rank neutrally.
 */

import { cosine, weightedMeanVector } from '@window/shared';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { RawListing } from '../ingestion/types.js';
import type { VectorCandidate, VectorFilter, VectorSearch } from '../vector/types.js';

export interface RecommendInput {
  /** Long-term taste vector (the stored user embedding). Unit-norm or not. */
  preferences: readonly number[];
  /** Recent-history vector (centroid of what was just scrolled/tapped). */
  recent: readonly number[];
  /**
   * How strongly the recent vector steers the blend, in [0, 1].
   * Default 0.6 — recent intent leads, preferences keep the drift honest.
   */
  recentWeight?: number;
  /** How many listings to return. The feed band is 10–20; default 15. */
  limit?: number;
  /**
   * How many fresh listings to ask the web leg for. Defaults to `limit` when
   * a `web` dep is supplied; ignored without one.
   */
  webCount?: number;
  /**
   * Seed topics ("mechanical keyboard") for the web leg when the catalog is
   * too cold to produce anchor titles of its own.
   */
  topics?: string[];
  /** Retrieval pre-filters; defaults to active, in-stock products. */
  filter?: VectorFilter;
  /** ANN traversal width. Only meaningful on the Atlas back end. */
  numCandidates?: number;
}

export interface RecommendDeps {
  /**
   * Fetches fresh listings from the storefronts, steered by the titles nearest
   * the session vector. `expandFromWeb` is the production implementation.
   */
  web?: (anchorTitles: string[], needed: number) => Promise<RawListing[]>;
  /**
   * Scores web listings against the session vector. Without it, web results
   * get a neutral score — present in the page but never outranking a strong
   * catalog match.
   */
  embedder?: EmbeddingProvider;
}

export interface ListingRecommendation {
  /** Hex product id for catalog rows; `web:{domain}:{sourceId}` for fresh ones. */
  productId: string;
  title: string;
  price: number | null;
  currency: string | null;
  url: string | null;
  /**
   * The listing's main image: the transcoded hero for catalog rows, the first
   * gallery image for web results. Always a URL — the bytes stay on the CDN.
   */
  imageUrl: string | null;
  /** Cosine similarity against the blended vector, rescaled to [0, 1]. */
  score: number;
  origin: 'catalog' | 'web';
}

/**
 * The blend itself, exposed so callers can compute the query vector without a
 * catalog — e.g. to hand it to an in-memory ranker in tests or scripts.
 * Degenerate inputs (a missing recent vector at cold start) fall through to
 * the other term because `weightedMeanVector` ignores zero-vector weight.
 */
export function sessionVector(
  preferences: readonly number[],
  recent: readonly number[],
  recentWeight = 0.6,
): number[] {
  const clamped = Math.max(0, Math.min(1, recentWeight));
  const entries = [
    { vector: preferences, weight: 1 - clamped },
    { vector: recent, weight: clamped },
  ].filter((entry) => entry.vector.length > 0);
  return weightedMeanVector(entries);
}

function toListing(candidate: VectorCandidate): ListingRecommendation {
  // The app's own pick: mid-width AVIF, with the 480 and WebP as fallbacks.
  const hero = candidate.media?.hero;
  return {
    productId: candidate.id,
    title: candidate.title,
    price: candidate.price?.amount ?? null,
    currency: candidate.price?.currency ?? null,
    url: candidate.source?.url ?? null,
    imageUrl: hero ? (hero.avif[1] ?? hero.avif[0] ?? hero.webp[0] ?? null) : null,
    score: candidate.vectorScore,
    origin: 'catalog',
  };
}

async function webListing(
  listing: RawListing,
  query: readonly number[],
  embedder: EmbeddingProvider | undefined,
): Promise<ListingRecommendation> {
  let score = 0.5;
  if (embedder !== undefined) {
    const text = [listing.title ?? '', listing.brand ?? ''].join(' ').trim();
    if (text !== '') {
      score = (cosine(await embedder.embedText(text), query) + 1) / 2;
    }
  }
  return {
    productId: `web:${listing.sourceDomain}:${listing.sourceId}`,
    title: listing.title ?? '',
    price: listing.priceAmountMinor,
    currency: listing.currency,
    url: listing.url,
    // Gallery order is the source's own: images[0] is the hero on both
    // storefronts.
    imageUrl: listing.images?.[0]?.url ?? null,
    score,
    origin: 'web',
  };
}

/**
 * Blend the two vectors and pull the next `limit` listings — catalog hits from
 * the vector index plus fresh ones the web leg fetched. Dedupe is by source
 * URL: a listing the web leg re-fetched beats the stale catalog row, because
 * its price is the one that is true right now.
 */
export async function recommendListings(
  vectors: VectorSearch,
  input: RecommendInput,
  deps: RecommendDeps = {},
): Promise<ListingRecommendation[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 15, 40));
  const query = sessionVector(input.preferences, input.recent, input.recentWeight);

  const candidates = await vectors.search({
    vector: query,
    numCandidates: input.numCandidates ?? limit * 8,
    limit,
    filter: {
      inStock: true,
      statusIn: ['active'],
      ...input.filter,
    },
  });
  const listings = candidates.map(toListing);

  if (deps.web !== undefined) {
    const anchors = [
      ...listings.slice(0, 6).map((l) => l.title).filter((t) => t !== ''),
      ...(input.topics ?? []),
    ].slice(0, 8);
    const fresh = await deps.web(anchors, input.webCount ?? limit);
    for (const listing of fresh) {
      listings.push(await webListing(listing, query, deps.embedder));
    }
  }

  const byUrl = new Map<string, ListingRecommendation>();
  for (const listing of listings) {
    const key = listing.url ?? listing.productId;
    const existing = byUrl.get(key);
    if (existing === undefined || (existing.origin === 'catalog' && listing.origin === 'web')) {
      byUrl.set(key, listing);
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
