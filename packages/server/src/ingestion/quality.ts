import {
  QUALITY_PARAMS,
  QUALITY_WEIGHTS,
  bayesianSmooth,
  clamp,
  mean,
  stdev,
  type ProductQuality,
  type QualityCaution,
  type ReviewTheme,
} from '@window/shared';

/**
 * Quality scoring.
 *
 *   Q = 0.40 R_adj + 0.20 C + 0.15 S + 0.15 L + 0.10 E
 *
 * Computed at the cluster level, because reviews pool across sellers of the
 * same product, then adjusted per listing for the parts that are genuinely
 * per-listing: media, specs and this listing's own engagement.
 *
 * Quality is kept strictly separate from risk. A cheap product with honest
 * mediocre reviews is low quality and zero risk; a counterfeit with five-star
 * reviews is the opposite. Collapsing them into one number makes both useless.
 */

export interface ReviewSample {
  /** `null` when the source shows review content without a per-review star rating. */
  rating: number | null;
  ratingScale: number;
  sourceDomain: string;
  verifiedPurchase: boolean | null;
  /** Whether this source exposes a verified-purchase flag at all. */
  sourceExposesVerified: boolean;
  postedAt: Date;
  /** Reviewer's total review count on the source, where exposed. */
  authorReviewCount: number | null;
  text: string;
  themes: string[];
  /** Positive share for this review's sentiment, in [0,1]. */
  sentiment: number;
}

export interface ListingCompletenessInput {
  heroShortEdge: number;
  imageCount: number;
  specCount: number;
  /** Spec keys the category typically carries, for coverage rather than raw count. */
  expectedSpecCount: number;
  descriptionLength: number;
  hasVariants: boolean;
  variantsFullySpecified: boolean;
}

export interface EngagementInput {
  impressions: number;
  interactions: number;
  cartAdds: number;
  /** Category means, so a low-CTR category is not penalised for being one. */
  categoryMeanCtr: number;
  categoryMeanCartRate: number;
}

// ---------------------------------------------------------------------------
// Review credibility
// ---------------------------------------------------------------------------

export interface CredibilityBreakdown {
  factor: number;
  penalties: Array<{ signal: string; amount: number; detail: string }>;
}

/** Each signal's maximum bite out of the credibility factor. */
const CREDIBILITY_PENALTIES = {
  bimodal: 0.16,
  burst: 0.14,
  unverified: 0.12,
  thinReviewers: 0.1,
  templateText: 0.1,
  crossSourceDivergence: 0.14,
} as const;

/** Normalised Jaccard over word sets; tight clusters of near-identical reviews. */
function textSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const setB = new Set(b.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Penalises review corpora that look manipulated. Range 0.5 to 1.0, multiplying
 * the credibility-adjusted rating — it can halve a rating's contribution but
 * never zero it, because every one of these signals also has innocent causes.
 */
export function reviewCredibility(
  reviews: readonly ReviewSample[],
  context: { listingAgeDays: number; otherSourceMeanRating: number | null },
): CredibilityBreakdown {
  const penalties: CredibilityBreakdown['penalties'] = [];
  if (reviews.length < 5) {
    // Too few reviews to diagnose manipulation; the Bayesian prior already
    // stops a thin corpus from carrying much weight.
    return { factor: QUALITY_PARAMS.credibility.max, penalties };
  }

  const rated = reviews.filter((r) => r.rating !== null);
  const normalised = rated.map((r) => ((r.rating ?? 0) / r.ratingScale) * 5);

  // 1. A distribution bimodal at 5 and 1 with a hollow middle.
  const buckets = [0, 0, 0, 0, 0];
  for (const rating of normalised) {
    buckets[clamp(Math.round(rating) - 1, 0, 4)] = (buckets[clamp(Math.round(rating) - 1, 0, 4)] as number) + 1;
  }
  const extremes = normalised.length === 0 ? 0 : ((buckets[0] as number) + (buckets[4] as number)) / normalised.length;
  const middle = normalised.length === 0 ? 1 : ((buckets[1] as number) + (buckets[2] as number) + (buckets[3] as number)) / normalised.length;
  if (extremes > 0.85 && middle < 0.1) {
    const amount = CREDIBILITY_PENALTIES.bimodal * clamp((extremes - 0.85) / 0.15, 0, 1);
    penalties.push({
      signal: 'bimodal_distribution',
      amount,
      detail: `${Math.round(extremes * 100)}% of ratings are 1 or 5`,
    });
  }

  // 2. A burst of reviews clustered relative to the listing's age.
  if (context.listingAgeDays > 7 && reviews.length >= 10) {
    const times = reviews.map((r) => r.postedAt.getTime()).sort((a, b) => a - b);
    const windowMs = 3 * 24 * 60 * 60 * 1000;
    let densest = 0;
    let start = 0;
    for (let end = 0; end < times.length; end++) {
      while ((times[end] as number) - (times[start] as number) > windowMs) start += 1;
      densest = Math.max(densest, end - start + 1);
    }
    const burstShare = densest / reviews.length;
    // Three days out of a long-lived listing holding most of its reviews is not
    // how organic review accrual looks.
    const expectedShare = Math.min(1, 3 / context.listingAgeDays);
    if (burstShare > 0.5 && burstShare > expectedShare * 4) {
      penalties.push({
        signal: 'review_burst',
        amount: CREDIBILITY_PENALTIES.burst * clamp((burstShare - 0.5) / 0.5, 0, 1),
        detail: `${Math.round(burstShare * 100)}% of reviews posted within 3 days`,
      });
    }
  }

  // 3. Unverified reviews, counted only where the source exposes the flag.
  const exposing = reviews.filter((r) => r.sourceExposesVerified);
  if (exposing.length >= 5) {
    const unverified = exposing.filter((r) => r.verifiedPurchase === false).length / exposing.length;
    if (unverified > 0.4) {
      penalties.push({
        signal: 'unverified_share',
        amount: CREDIBILITY_PENALTIES.unverified * clamp((unverified - 0.4) / 0.6, 0, 1),
        detail: `${Math.round(unverified * 100)}% unverified where the source exposes verification`,
      });
    }
  }

  // 4. Reviewer accounts with unusually low review counts.
  const withCounts = reviews.filter((r) => r.authorReviewCount !== null);
  if (withCounts.length >= 5) {
    const singletons =
      withCounts.filter((r) => (r.authorReviewCount as number) <= 1).length / withCounts.length;
    if (singletons > 0.6) {
      penalties.push({
        signal: 'thin_reviewers',
        amount: CREDIBILITY_PENALTIES.thinReviewers * clamp((singletons - 0.6) / 0.4, 0, 1),
        detail: `${Math.round(singletons * 100)}% of reviewers have one review`,
      });
    }
  }

  // 5. Template-like text, detected as tightness across the review corpus.
  const sample = reviews.slice(0, 40);
  if (sample.length >= 6) {
    let pairs = 0;
    let tight = 0;
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        pairs += 1;
        if (textSimilarity((sample[i] as ReviewSample).text, (sample[j] as ReviewSample).text) > 0.6) {
          tight += 1;
        }
      }
    }
    const tightness = pairs === 0 ? 0 : tight / pairs;
    if (tightness > 0.15) {
      penalties.push({
        signal: 'template_text',
        amount: CREDIBILITY_PENALTIES.templateText * clamp((tightness - 0.15) / 0.35, 0, 1),
        detail: `${Math.round(tightness * 100)}% of review pairs are near-identical`,
      });
    }
  }

  // 6. Rating diverging by more than 1.2 points from the same cluster elsewhere.
  if (context.otherSourceMeanRating !== null) {
    const divergence = Math.abs(mean(normalised) - context.otherSourceMeanRating);
    if (divergence > 1.2) {
      penalties.push({
        signal: 'cross_source_divergence',
        amount: CREDIBILITY_PENALTIES.crossSourceDivergence * clamp((divergence - 1.2) / 1.3, 0, 1),
        detail: `rating differs from other sources by ${divergence.toFixed(1)} points`,
      });
    }
  }

  const total = penalties.reduce((sum, p) => sum + p.amount, 0);
  return {
    factor: clamp(
      QUALITY_PARAMS.credibility.max - total,
      QUALITY_PARAMS.credibility.min,
      QUALITY_PARAMS.credibility.max,
    ),
    penalties,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Credibility-adjusted rating. The Bayesian mean against the L3 category prior
 * is what stops five reviews at 5.0 outranking eight hundred at 4.6.
 */
export function reviewAdjusted(
  reviews: readonly ReviewSample[],
  categoryPriorRating: number,
  credibilityFactor: number,
): number {
  const normalised = reviews
    .filter((r) => r.rating !== null)
    .map((r) => ((r.rating ?? 0) / r.ratingScale) * 5);
  const smoothed = bayesianSmooth(
    normalised.reduce((s, r) => s + r, 0),
    normalised.length,
    categoryPriorRating,
    QUALITY_PARAMS.ratingPriorCount,
  );
  return clamp((smoothed / 5) * credibilityFactor, 0, 1);
}

/** Log-scaled review count, capped; multi-source coverage is a bonus. */
export function corpusDepth(reviews: readonly ReviewSample[]): number {
  const count = reviews.length;
  const depth =
    count === 0
      ? 0
      : Math.log1p(count) / Math.log1p(QUALITY_PARAMS.corpusDepthSaturation);
  const sources = new Set(reviews.map((r) => r.sourceDomain)).size;
  const adjustment =
    sources > 1 ? QUALITY_PARAMS.multiSourceBonus : -QUALITY_PARAMS.singleSourcePenalty;
  return clamp(depth + (count === 0 ? 0 : adjustment), 0, 1);
}

/**
 * Agreement across sources and across time. Wide variance or a sharp recent
 * decline pulls this down — a product whose reviews just fell off a cliff is
 * usually a product whose manufacturing just changed.
 */
export function sentimentConsistency(reviews: readonly ReviewSample[], now: Date): number {
  if (reviews.length < 4) return 0.5;

  const rated = reviews.filter((r) => r.rating !== null);
  const normalised = rated.map((r) => ((r.rating ?? 0) / r.ratingScale) * 5);
  // Spread: a standard deviation of 2 on a 5-point scale is maximal disagreement.
  const spread = normalised.length === 0 ? 0.5 : clamp(1 - stdev(normalised) / 2, 0, 1);

  // Cross-source agreement.
  const bySource = new Map<string, number[]>();
  for (const review of rated) {
    const list = bySource.get(review.sourceDomain) ?? [];
    list.push(((review.rating ?? 0) / review.ratingScale) * 5);
    bySource.set(review.sourceDomain, list);
  }
  const sourceMeans = [...bySource.values()].filter((v) => v.length >= 3).map(mean);
  const crossSource = sourceMeans.length < 2 ? 0.6 : clamp(1 - stdev(sourceMeans) / 1.5, 0, 1);

  // Temporal trend: the last 90 days against everything before.
  const cutoff = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  const recent = rated.filter((r) => r.postedAt.getTime() >= cutoff);
  const older = rated.filter((r) => r.postedAt.getTime() < cutoff);
  let temporal = 0.7;
  if (recent.length >= 3 && older.length >= 3) {
    const delta =
      mean(recent.map((r) => ((r.rating ?? 0) / r.ratingScale) * 5)) -
      mean(older.map((r) => ((r.rating ?? 0) / r.ratingScale) * 5));
    // A decline is penalised; an improvement is not rewarded symmetrically,
    // because a product getting better is not evidence its reviews are consistent.
    temporal = delta < 0 ? clamp(1 + delta / 1.5, 0, 1) : clamp(0.8 + delta / 5, 0, 1);
  }

  return clamp(0.4 * spread + 0.3 * crossSource + 0.3 * temporal, 0, 1);
}

/** Media resolution and count, spec coverage, description length, variant clarity. */
export function listingCompleteness(input: ListingCompletenessInput): number {
  const resolution = clamp((input.heroShortEdge - 800) / (1600 - 800), 0, 1);
  const imageCount = clamp((input.imageCount - 1) / 5, 0, 1);
  const specCoverage =
    input.expectedSpecCount <= 0 ? 0.5 : clamp(input.specCount / input.expectedSpecCount, 0, 1);
  const description = clamp(input.descriptionLength / 600, 0, 1);
  // A listing with no variants is fully specified by definition; one with
  // variants it does not spell out is the case worth penalising.
  const variantClarity = !input.hasVariants ? 1 : input.variantsFullySpecified ? 1 : 0.4;

  return clamp(
    0.28 * resolution +
      0.22 * imageCount +
      0.24 * specCoverage +
      0.14 * description +
      0.12 * variantClarity,
    0,
    1,
  );
}

/** Smoothed CTR and cart-add rate against the category mean. */
export function engagementScore(input: EngagementInput): number {
  const ctr = bayesianSmooth(
    input.interactions,
    input.impressions,
    input.categoryMeanCtr,
    QUALITY_PARAMS.ratingPriorCount * 8,
  );
  const cartRate = bayesianSmooth(
    input.cartAdds,
    input.impressions,
    input.categoryMeanCartRate,
    QUALITY_PARAMS.ratingPriorCount * 8,
  );
  // Expressed as a ratio to the category mean and squashed, so a category with
  // a 1% CTR and one with a 6% CTR both land mid-scale when they are typical.
  const ctrRatio = input.categoryMeanCtr > 0 ? ctr / input.categoryMeanCtr : 1;
  const cartRatio = input.categoryMeanCartRate > 0 ? cartRate / input.categoryMeanCartRate : 1;
  const squash = (ratio: number) => clamp(ratio / (ratio + 1), 0, 1);
  return clamp(0.6 * squash(ctrRatio) + 0.4 * squash(cartRatio), 0, 1);
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * The five sentiment themes already extracted for the reviews sheet double as a
 * quality input. A theme over 60% negative with more than 30 mentions applies a
 * penalty and surfaces on the card as a plain-language caution.
 */
export function extractThemes(reviews: readonly ReviewSample[], maxThemes = 5): ReviewTheme[] {
  const byTheme = new Map<string, { positive: number; negative: number; mentions: number }>();

  for (const review of reviews) {
    for (const theme of review.themes) {
      const entry = byTheme.get(theme) ?? { positive: 0, negative: 0, mentions: 0 };
      entry.mentions += 1;
      if (review.sentiment >= 0.5) entry.positive += 1;
      else entry.negative += 1;
      byTheme.set(theme, entry);
    }
  }

  return [...byTheme.entries()]
    .map(([name, entry]) => ({
      name,
      positive: entry.mentions === 0 ? 0 : entry.positive / entry.mentions,
      negative: entry.mentions === 0 ? 0 : entry.negative / entry.mentions,
      mentions: entry.mentions,
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, maxThemes);
}

const THEME_PHRASES: Record<string, string> = {
  sizing: 'Reviewers commonly report sizing runs small.',
  battery: 'Reviewers commonly report the battery degrading.',
  build_quality: 'Reviewers commonly report build-quality problems.',
  durability: 'Reviewers commonly report this wearing out early.',
  shipping: 'Reviewers commonly report shipping problems.',
  value: 'Reviewers commonly say this is overpriced for what it is.',
  comfort: 'Reviewers commonly report comfort problems.',
  noise: 'Reviewers commonly report this being louder than expected.',
  software: 'Reviewers commonly report software problems.',
  accuracy: 'Reviewers commonly question its accuracy.',
  smell: 'Reviewers commonly report an unpleasant smell.',
  instructions: 'Reviewers commonly report unclear instructions.',
};

export function cautionsFor(themes: readonly ReviewTheme[]): QualityCaution[] {
  return themes
    .filter(
      (t) =>
        t.negative > QUALITY_PARAMS.cautionNegativeShare &&
        t.mentions > QUALITY_PARAMS.cautionMinMentions,
    )
    .map((t) => ({ theme: t.name, negativeShare: t.negative, mentions: t.mentions }));
}

/** Plain-language caution copy for a card badge. */
export function cautionText(caution: QualityCaution): string {
  return (
    THEME_PHRASES[caution.theme] ??
    `Reviewers commonly raise concerns about ${caution.theme.replace(/_/g, ' ')}.`
  );
}

// ---------------------------------------------------------------------------
// Q
// ---------------------------------------------------------------------------

export interface QualityInput {
  reviews: readonly ReviewSample[];
  categoryPriorRating: number;
  otherSourceMeanRating: number | null;
  listingAgeDays: number;
  completeness: ListingCompletenessInput;
  engagement: EngagementInput;
  now: Date;
}

export function computeQuality(input: QualityInput): ProductQuality {
  const credibility = reviewCredibility(input.reviews, {
    listingAgeDays: input.listingAgeDays,
    otherSourceMeanRating: input.otherSourceMeanRating,
  });

  const reviewAdj = reviewAdjusted(
    input.reviews,
    input.categoryPriorRating,
    credibility.factor,
  );
  const depth = corpusDepth(input.reviews);
  const consistency = sentimentConsistency(input.reviews, input.now);
  const completeness = listingCompleteness(input.completeness);
  const engagement = engagementScore(input.engagement);

  const themes = extractThemes(input.reviews);
  const cautions = cautionsFor(themes);

  let score =
    QUALITY_WEIGHTS.reviewAdj * reviewAdj +
    QUALITY_WEIGHTS.corpusDepth * depth +
    QUALITY_WEIGHTS.sentimentConsistency * consistency +
    QUALITY_WEIGHTS.listingCompleteness * completeness +
    QUALITY_WEIGHTS.engagement * engagement;

  // Each standing caution is a category-specific penalty on top of whatever the
  // rating already absorbed; a theme can be badly negative while the stars stay
  // respectable, and that gap is exactly what the caution exists to close.
  for (const caution of cautions) {
    const severity = clamp((caution.negativeShare - QUALITY_PARAMS.cautionNegativeShare) / 0.4, 0, 1);
    score -= 0.06 * severity;
  }

  return {
    score: clamp(Math.round(score * 1000) / 1000, 0, 1),
    reviewAdj: Math.round(reviewAdj * 1000) / 1000,
    corpusDepth: Math.round(depth * 1000) / 1000,
    sentimentConsistency: Math.round(consistency * 1000) / 1000,
    listingCompleteness: Math.round(completeness * 1000) / 1000,
    engagement: Math.round(engagement * 1000) / 1000,
    credibilityFactor: Math.round(credibility.factor * 1000) / 1000,
    cautions,
    computedAt: input.now,
  };
}
