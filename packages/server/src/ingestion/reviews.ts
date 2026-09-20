import {
  REVIEWS_CONFIG,
  clamp,
  truncate,
  type ReviewBucket,
  type ReviewTheme,
} from '@window/shared';
import type { RawReview } from './types.js';
import type { ReviewSample } from './quality.js';

/**
 * Review aggregation.
 *
 * Reviews attach to the cluster, not the listing, so all sellers' reviews pool.
 * Window stores an excerpt, a rating, a date, an author handle and a source
 * URL — never the full text, which is the source's copyright — and every review
 * displays its source domain and links to the original. Nothing is ever
 * presented as native to Window.
 */

export interface AggregatedReview {
  source: { domain: string; url: string };
  /** `null` when the source shows review content without a per-review star rating. */
  rating: number | null;
  ratingScale: number;
  excerpt: string;
  authorHandle: string | null;
  verifiedPurchase: boolean | null;
  helpfulCount: number;
  postedAt: Date;
  bucket: ReviewBucket;
  themes: string[];
  fetchedAt: Date;
}

// ---------------------------------------------------------------------------
// Themes and sentiment
// ---------------------------------------------------------------------------

/**
 * Theme vocabulary. Themes are derived from the review corpus rather than being
 * hand-authored per product, so this maps observable words onto theme names and
 * the set of themes a product shows is whatever its reviewers actually raised.
 */
const THEME_LEXICON: Record<string, string[]> = {
  build_quality: ['build', 'quality', 'solid', 'flimsy', 'sturdy', 'cheap', 'construction', 'materials'],
  durability: ['durable', 'broke', 'broken', 'lasted', 'wore', 'wear', 'falling', 'cracked', 'snapped'],
  battery: ['battery', 'charge', 'charging', 'runtime', 'power', 'drain', 'lasts'],
  sizing: ['size', 'sizing', 'fit', 'fits', 'tight', 'loose', 'small', 'large', 'true'],
  comfort: ['comfort', 'comfortable', 'uncomfortable', 'soft', 'cushion', 'ergonomic', 'padding'],
  shipping: ['shipping', 'delivery', 'arrived', 'packaging', 'packed', 'damaged', 'late', 'fast'],
  value: ['value', 'price', 'worth', 'overpriced', 'bargain', 'expensive', 'cheap', 'money'],
  noise: ['noise', 'loud', 'quiet', 'silent', 'rattle', 'hum', 'buzz'],
  software: ['software', 'app', 'firmware', 'update', 'driver', 'buggy', 'interface'],
  accuracy: ['accurate', 'accuracy', 'precise', 'calibration', 'readings', 'consistent'],
  appearance: ['looks', 'colour', 'color', 'design', 'beautiful', 'ugly', 'photos', 'finish'],
  ease_of_use: ['easy', 'simple', 'intuitive', 'confusing', 'complicated', 'instructions', 'setup'],
  smell: ['smell', 'odour', 'odor', 'chemical', 'fragrance', 'scent'],
  performance: ['performance', 'fast', 'slow', 'responsive', 'lag', 'powerful', 'weak'],
};

const NEGATIVE_WORDS = new Set([
  'broke', 'broken', 'flimsy', 'cheap', 'uncomfortable', 'disappointed', 'disappointing',
  'terrible', 'awful', 'poor', 'waste', 'returned', 'refund', 'defective', 'faulty',
  'damaged', 'late', 'overpriced', 'buggy', 'confusing', 'loud', 'rattle', 'drain',
  'tight', 'loose', 'ugly', 'slow', 'lag', 'weak', 'failed', 'stopped', 'useless',
]);

const POSITIVE_WORDS = new Set([
  'excellent', 'great', 'perfect', 'love', 'loved', 'solid', 'sturdy', 'comfortable',
  'beautiful', 'fast', 'responsive', 'durable', 'bargain', 'recommend', 'flawless',
  'impressed', 'quality', 'worth', 'easy', 'intuitive', 'quiet', 'accurate', 'powerful',
]);

export function themesInText(text: string): string[] {
  const words = new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const found: string[] = [];
  for (const [theme, vocabulary] of Object.entries(THEME_LEXICON)) {
    if (vocabulary.some((word) => words.has(word))) found.push(theme);
  }
  return found;
}

/**
 * Sentiment in [0,1]. The star rating is the dominant signal because it is the
 * reviewer's own explicit verdict; the lexicon only adjusts it, which stops a
 * five-star review that mentions one flaw from being read as negative.
 */
export function reviewSentiment(rating: number | null, ratingScale: number, text: string): number {
  const fromRating = rating === null ? 0.5 : clamp((rating / ratingScale - 0.2) / 0.8, 0, 1);
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  let positive = 0;
  let negative = 0;
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) positive += 1;
    if (NEGATIVE_WORDS.has(word)) negative += 1;
  }
  if (positive + negative === 0) return fromRating;
  const fromText = positive / (positive + negative);
  return clamp(0.75 * fromRating + 0.25 * fromText, 0, 1);
}

// ---------------------------------------------------------------------------
// Buckets and caps
// ---------------------------------------------------------------------------

/**
 * Caps at 200 stored reviews per cluster: the 50 most recent, 50 most helpful,
 * 50 most critical and 50 most positive. A review can qualify for more than one
 * bucket, so the buckets are filled in priority order and a review is stored
 * once, under the first bucket that claimed it — which is why the stored total
 * is at most 200 rather than exactly 200.
 */
export function bucketReviews(
  reviews: readonly AggregatedReview[],
  cap = REVIEWS_CONFIG.perBucketCap,
): AggregatedReview[] {
  const claimed = new Set<AggregatedReview>();
  const out: AggregatedReview[] = [];

  const take = (bucket: ReviewBucket, sorted: readonly AggregatedReview[]) => {
    let taken = 0;
    for (const review of sorted) {
      if (taken >= cap) break;
      if (claimed.has(review)) continue;
      claimed.add(review);
      out.push({ ...review, bucket });
      taken += 1;
    }
  };

  // Unrated excerpts sort mid — never "most critical" nor "most positive".
  const normalised = (r: AggregatedReview) => (r.rating === null ? 0.5 : r.rating / r.ratingScale);

  // Helpful first: a review that is both helpful and recent is more useful
  // filed as helpful, because recency is visible on every review anyway.
  take('helpful', [...reviews].sort((a, b) => b.helpfulCount - a.helpfulCount));
  take('critical', [...reviews].sort((a, b) => normalised(a) - normalised(b)));
  take('positive', [...reviews].sort((a, b) => normalised(b) - normalised(a)));
  take('recent', [...reviews].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()));

  return out.slice(0, REVIEWS_CONFIG.totalCap);
}

export function toAggregated(
  raw: RawReview,
  sourceDomain: string,
  fetchedAt: Date,
): AggregatedReview {
  return {
    source: { domain: sourceDomain, url: raw.sourceUrl },
    rating: raw.rating,
    ratingScale: raw.ratingScale,
    // Excerpt only, capped at 400 characters. Never the full text.
    excerpt: truncate(raw.text.trim().replace(/\s+/g, ' '), REVIEWS_CONFIG.excerptMaxChars),
    authorHandle: raw.authorHandle,
    verifiedPurchase: raw.verifiedPurchase,
    helpfulCount: raw.helpfulCount,
    postedAt: raw.postedAt,
    bucket: 'recent',
    themes: themesInText(raw.text),
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Ratings math
// ---------------------------------------------------------------------------

export interface PerSourceRating {
  domain: string;
  count: number;
  meanRating: number;
}

/**
 * Per-source ratings are normalised to a 5-point scale, then combined weighted
 * by review count, with the per-source breakdown always kept so the sheet can
 * show it. Averaging the averages would let a source with nine reviews cancel
 * out one with nine hundred.
 */
/**
 * Combines a review corpus into one score.
 *
 * `count` is every review, because that is what "38 reviews" means to a reader.
 * `meanRating` averages only the ones that actually carry a score: a review
 * whose source shows text without a star is evidence of interest, not a vote,
 * and dividing the rated total by the full count dragged every product toward
 * zero — a 4.6 over 9 scored reviews out of 40 was reported as 1.03.
 */
export function combineRatings(reviews: readonly AggregatedReview[]): {
  count: number;
  meanRating: number | null;
  ratedCount: number;
  perSource: PerSourceRating[];
} {
  const bySource = new Map<string, { total: number; count: number }>();
  for (const review of reviews) {
    if (review.rating === null) continue; // unrated content carries no vote
    const entry = bySource.get(review.source.domain) ?? { total: 0, count: 0 };
    entry.total += (review.rating / review.ratingScale) * 5;
    entry.count += 1;
    bySource.set(review.source.domain, entry);
  }

  const perSource: PerSourceRating[] = [...bySource.entries()]
    .map(([domain, entry]) => ({
      domain,
      count: entry.count,
      meanRating: Math.round((entry.total / entry.count) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  const count = reviews.length;
  const ratedCount = perSource.reduce((sum, p) => sum + p.count, 0);
  const meanRating =
    ratedCount === 0
      ? null
      : Math.round(
          (perSource.reduce((s, p) => s + p.meanRating * p.count, 0) / ratedCount) * 100,
        ) / 100;

  return { count, meanRating, ratedCount, perSource };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  text: string;
  generatedAt: Date;
  modelVersion: string;
}

export interface ReviewSummarizer {
  readonly modelVersion: string;
  summarize(input: {
    themes: readonly ReviewTheme[];
    /** `null` when the corpus is text without scores. */
    meanRating: number | null;
    count: number;
    productTitle: string;
  }): Promise<string>;
}

const PRAISE_PHRASE: Record<string, string> = {
  build_quality: 'the build quality',
  durability: 'how well it holds up',
  battery: 'the battery life',
  sizing: 'the fit',
  comfort: 'the comfort',
  shipping: 'the packaging and delivery',
  value: 'the value for money',
  noise: 'how quiet it is',
  software: 'the software',
  accuracy: 'its accuracy',
  appearance: 'the way it looks',
  ease_of_use: 'how easy it is to set up',
  smell: 'the scent',
  performance: 'the performance',
};

const COMPLAINT_PHRASE: Record<string, string> = {
  build_quality: 'the build quality',
  durability: 'it wearing out early',
  battery: 'the battery degrading',
  sizing: 'the sizing running off',
  comfort: 'discomfort with extended use',
  shipping: 'damage in transit',
  value: 'the price being high for what it is',
  noise: 'it being louder than expected',
  software: 'the software being unreliable',
  accuracy: 'inconsistent readings',
  appearance: 'it not matching the photographs',
  ease_of_use: 'the instructions being unclear',
  smell: 'a chemical smell',
  performance: 'it underperforming',
};

/**
 * The extractive summarizer.
 *
 * The summary is the only synthesized content in the reviews sheet, and it is
 * always visibly labeled as such. This implementation composes it from the
 * theme statistics that were measured rather than from a generative model, so
 * every clause it emits is backed by a count the sheet also displays. A hosted
 * model implements the same interface when one is wired in; the `modelVersion`
 * recorded alongside the text is what makes the swap auditable.
 */
export class ExtractiveReviewSummarizer implements ReviewSummarizer {
  readonly modelVersion = 'summary-extractive-v1';

  async summarize(input: {
    themes: readonly ReviewTheme[];
    meanRating: number;
    count: number;
    productTitle: string;
  }): Promise<string> {
    if (input.count === 0) return 'No reviews have been collected for this product yet.';

    const ranked = [...input.themes].sort((a, b) => b.mentions - a.mentions);
    const praised = ranked.find((t) => t.positive >= 0.7 && t.mentions >= 5);
    const criticised = ranked.find((t) => t.negative >= 0.5 && t.mentions >= 5);

    const clauses: string[] = [];
    if (praised) {
      clauses.push(`Reviewers praise ${PRAISE_PHRASE[praised.name] ?? praised.name.replace(/_/g, ' ')}`);
    }
    if (criticised) {
      const share = Math.round(criticised.negative * 100);
      const lead = share >= 70 ? 'most' : share >= 50 ? 'several' : 'some';
      clauses.push(
        `${clauses.length > 0 ? lead : `${lead.charAt(0).toUpperCase()}${lead.slice(1)}`} report ${
          COMPLAINT_PHRASE[criticised.name] ?? criticised.name.replace(/_/g, ' ')
        }`,
      );
    }

    if (clauses.length === 0) {
      const verdict =
        input.meanRating >= 4.3 ? 'broadly positive' : input.meanRating >= 3.5 ? 'mixed but favourable' : 'mixed';
      return `Reviews across ${input.count} sources are ${verdict}, with no single theme dominating.`;
    }

    return `${clauses.join('; ')}.`;
  }
}

/**
 * Regenerated when the review count grows by 20% or the mean rating shifts by
 * more than 0.3. Anything more eager spends money restating the same sentence.
 */
export function shouldRegenerateSummary(
  previous: { count: number; meanRating: number | null } | null,
  current: { count: number; meanRating: number | null },
): boolean {
  if (!previous) return current.count > 0;
  if (previous.count === 0) return current.count > 0;
  const growth = (current.count - previous.count) / previous.count;
  if (growth >= REVIEWS_CONFIG.regenerateOnCountGrowth) return true;
  // A corpus that has gained or lost its scores entirely is a shift worth
  // regenerating on; one that never had any cannot shift.
  if (previous.meanRating === null || current.meanRating === null) {
    return previous.meanRating !== current.meanRating;
  }
  return Math.abs(current.meanRating - previous.meanRating) > REVIEWS_CONFIG.regenerateOnRatingShift;
}

/** Converts stored reviews into the sample shape the quality score consumes. */
export function toQualitySamples(
  reviews: readonly AggregatedReview[],
  sourceExposesVerified: (domain: string) => boolean,
  authorReviewCounts?: ReadonlyMap<string, number>,
): ReviewSample[] {
  return reviews.map((review) => ({
    rating: review.rating,
    ratingScale: review.ratingScale,
    sourceDomain: review.source.domain,
    verifiedPurchase: review.verifiedPurchase,
    sourceExposesVerified: sourceExposesVerified(review.source.domain),
    postedAt: review.postedAt,
    authorReviewCount: review.authorHandle
      ? (authorReviewCounts?.get(review.authorHandle) ?? null)
      : null,
    text: review.excerpt,
    themes: review.themes,
    sentiment: reviewSentiment(review.rating, review.ratingScale, review.excerpt),
  }));
}
