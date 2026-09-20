import {
  bayesianSmooth,
  clamp,
  cosine,
  type RankingConfig,
} from '@window/shared';
import type { VectorCandidate } from '../vector/types.js';

/**
 * Stage 3: scoring.
 *
 *   score(p) = w1·sim(u,p) + w2·q(p) + w3·ctr(p) + w4·f(p) + w5·b(p) − w6·pen(p)
 *
 * Every term is normalised into [0,1] before it is weighted. That is not
 * cosmetic: the weights are tuned against the north-star metric by people
 * reading them as shares of a budget, and a term that can quietly exceed one
 * makes its weight a lie.
 */

export interface ScoringContext {
  config: RankingConfig;
  /** The user's interest vector; null before onboarding completes. */
  userVector: readonly number[] | null;
  brandAffinities: Readonly<Record<string, number>>;
  sellerAffinities: Readonly<Record<string, number>>;
  /** Category mean CTR, so a low-CTR category is not penalised for being one. */
  categoryMeanCtr: ReadonlyMap<string, number>;
  now: Date;
}

export interface ScoreBreakdown {
  sim: number;
  quality: number;
  ctr: number;
  freshness: number;
  affinity: number;
  penalty: number;
  score: number;
}

/**
 * Freshness combines how recently the listing appeared with how recently we
 * verified it. Both matter and they fail differently: a stale crawl means the
 * price on the card may be wrong, while an old listing is merely less
 * interesting.
 */
export function freshness(
  candidate: VectorCandidate,
  now: Date,
  stalenessCeilingMs: number,
): number {
  const listedAgeMs = now.getTime() - candidate.crawl.firstSeenAt.getTime();
  const crawlAgeMs = now.getTime() - candidate.crawl.lastCrawledAt.getTime();

  // Listing recency decays over 30 days; after that all listings are equally old.
  const listingRecency = clamp(1 - listedAgeMs / (30 * 24 * 60 * 60 * 1000), 0, 1);
  // Crawl recency decays across the source's own staleness ceiling, so a tier-1
  // feed refreshed every 6 hours is not compared against a tier-3 page's clock.
  const crawlRecency = clamp(1 - crawlAgeMs / stalenessCeilingMs, 0, 1);

  return clamp(0.35 * listingRecency + 0.65 * crawlRecency, 0, 1);
}

/** Brand and seller affinity from this user's history, centred at 0.5. */
export function affinity(candidate: VectorCandidate, context: ScoringContext): number {
  const brandScore = candidate.brand
    ? (context.brandAffinities[candidate.brand.toLowerCase()] ?? 0)
    : 0;
  const sellerScore = context.sellerAffinities[candidate.sellerId] ?? 0;
  // Affinities accumulate in [-1, 1]; 0.5 is "no opinion", which must not
  // advantage or disadvantage a product the user has never met.
  return clamp(0.5 + 0.35 * brandScore + 0.15 * sellerScore, 0, 1);
}

export interface PenaltyContext {
  /** Products already placed on this page, most recent last. */
  placed: readonly VectorCandidate[];
  config: RankingConfig;
}

/**
 * Penalties: a near-duplicate of a recent card, the same brand within 5 cards,
 * the same seller within 10. These are what stop a page from being one brand's
 * catalog, which is the failure mode every purely similarity-ranked feed has.
 */
export function penalty(candidate: VectorCandidate, context: PenaltyContext): number {
  const { placed, config } = context;
  let total = 0;

  const brandWindow = placed.slice(-config.penalties.sameBrandWithin);
  if (candidate.brand) {
    const brand = candidate.brand.toLowerCase();
    const repeats = brandWindow.filter((p) => p.brand?.toLowerCase() === brand).length;
    if (repeats > 0) {
      // Linear in the count: two repeats inside the window is twice as bad as one.
      total += config.penalties.sameBrandPenalty * Math.min(1, repeats / 2);
    }
  }

  const sellerWindow = placed.slice(-config.penalties.sameSellerWithin);
  const sellerId = candidate.sellerId;
  const sellerRepeats = sellerWindow.filter((p) => p.sellerId === sellerId).length;
  if (sellerRepeats > 0) {
    total += config.penalties.sameSellerPenalty * Math.min(1, sellerRepeats / 2);
  }

  // Near-duplicate against the most recent cards only; comparing against the
  // whole page would be quadratic for a signal that decays within a screenful.
  const recent = placed.slice(-8);
  for (const previous of recent) {
    if (cosine(candidate.embedding, previous.embedding) >= config.penalties.nearDuplicateSimilarity) {
      total += config.penalties.nearDuplicate;
      break;
    }
  }

  return clamp(total, 0, 1);
}

export function scoreCandidate(
  candidate: VectorCandidate,
  context: ScoringContext,
  penaltyContext: PenaltyContext,
  stalenessCeilingMs: number,
): ScoreBreakdown {
  const weights = context.config.weights;

  // Retrieval already reports cosine rescaled into [0,1]. Recomputing it here
  // would be the same number at the cost of a 1024-element dot product per
  // candidate, and with no user vector it is the only term that must abstain.
  const sim = context.userVector ? candidate.vectorScore : 0.5;

  const quality = clamp(candidate.quality?.score ?? 0, 0, 1);

  const categoryMean = context.categoryMeanCtr.get(candidate.category.l2) ?? 0.04;
  const smoothedCtr = bayesianSmooth(
    candidate.engagement.interactions,
    candidate.engagement.impressions,
    categoryMean,
    context.config.ctrSmoothingPrior,
  );
  // Expressed relative to the category mean and squashed, so the term means
  // "unusually engaging for its category" rather than "in a popular category".
  const ratio = categoryMean > 0 ? smoothedCtr / categoryMean : 1;
  const ctr = clamp(ratio / (ratio + 1), 0, 1);

  const fresh = freshness(candidate, context.now, stalenessCeilingMs);
  const affinityScore = affinity(candidate, context);
  const penaltyScore = penalty(candidate, penaltyContext);

  const score =
    weights.sim * sim +
    weights.quality * quality +
    weights.ctr * ctr +
    weights.freshness * fresh +
    weights.affinity * affinityScore -
    weights.penalty * penaltyScore;

  return {
    sim,
    quality,
    ctr,
    freshness: fresh,
    affinity: affinityScore,
    penalty: penaltyScore,
    score,
  };
}
