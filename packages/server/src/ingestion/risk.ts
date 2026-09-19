import {
  COUNTERFEIT_WATCHLIST_CATEGORIES,
  RISK_FAMILY_WEIGHTS,
  clamp,
  cosine,
  riskTierFor,
  type Condition,
  type ProductRisk,
  type RiskFamily,
  type RiskSignal,
  type SourceType,
} from '@window/shared';

/**
 * Scam and counterfeit detection.
 *
 * Runs on every listing at ingest and again on every refresh, weighted heavily
 * toward secondhand and auction sources where the seller is an individual and
 * the recourse is thin.
 *
 * The eventual model is gradient-boosted over these features, trained on user
 * reports, merchant takedowns, chargebacks and orders where the agent later
 * found the listing removed. Until enough labels exist this is a weighted rule
 * ensemble over the *same* feature set with the *same* output contract, so the
 * model swaps in without touching anything downstream — which is the whole
 * reason the contract is written down here rather than inferred from callers.
 */

export interface RiskInput {
  product: {
    id: string;
    title: string;
    description: string | null;
    brand: string | null;
    categoryL1: string;
    categoryL3: string;
    priceAmount: number;
    condition: Condition;
    sourceType: SourceType;
    quantity: number | null;
    /** Whether the source treats this listing as one-of-one. */
    singleUnit: boolean;
    sourceDomain: string;
    /** Product embedding, for the cross-modal coherence check. */
    embedding: readonly number[];
    /** Embedding of the hero image alone, in the same joint space. */
    imageEmbedding: readonly number[] | null;
    heroImageHash: string | null;
    hasExif: boolean;
    imageLooksStudioGrade: boolean;
    listedAt: Date;
  };
  cluster: {
    medianPrice: number | null;
    memberCount: number;
  } | null;
  /** Price distribution for the L3, for listings with no cluster yet. */
  categoryPrices: {
    median: number;
    p10: number;
  } | null;
  seller: {
    type: 'retailer' | 'individual' | 'auction_house';
    accountAgeDays: number | null;
    salesCount: number;
    rating: number | null;
    reviewCount: number;
    /** Listings created by this seller in the last 24 hours. */
    recentListingCount: number;
    /** Sum of the asking prices of those listings. */
    recentListingValue: number;
    handleChangedWithinDays: number | null;
    /** Reports upheld against this seller. */
    upheldReports: number;
  };
  /** Other listings already using this exact hero image. */
  duplicateImageSellerIds: readonly string[];
  /** The same identifiers listed elsewhere, with fields that disagree. */
  inconsistentCrossListings: number;
  source: {
    /** Reputation in [0,1]; low is bad. */
    domainReputation: number;
    proxyIndicators: boolean;
    burnerEmailIndicators: boolean;
  };
  /** Brands on the high-counterfeit watchlist. */
  counterfeitWatchlistBrands: ReadonlySet<string>;
  /** Manufacturer copy, to detect it being pasted onto a used listing. */
  manufacturerDescription: string | null;
  /** Products discontinued by the manufacturer; a "brand new" claim is suspect. */
  discontinued: boolean;
  now: Date;
}

export interface RiskModel {
  readonly version: string;
  score(input: RiskInput): ProductRisk<string>;
}

// ---------------------------------------------------------------------------
// Text signals
// ---------------------------------------------------------------------------

const OFF_PLATFORM_CONTACT =
  /\b(?:whats\s?app|telegram|signal|wechat|dm\s+me|text\s+me\s+at|email\s+me\s+at|call\s+me\s+at)\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/i;
const PAYMENT_STEERING =
  /\b(?:wire\s+transfer|western\s+union|money\s?gram|gift\s?cards?|zelle|venmo\s+friends|cash\s?app|bitcoin|btc|usdt|crypto\s+only|bank\s+transfer\s+only)\b/i;
const URGENCY =
  /\b(?:act\s+now|today\s+only|last\s+one|hurry|don'?t\s+miss|limited\s+time\s+only|going\s+fast|final\s+call)\b/i;

/** Brand tokens misspelled by one or two characters are a classic counterfeit tell. */
function misspelledBrand(title: string, watchlist: ReadonlySet<string>): string | null {
  const tokens = title.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  for (const token of tokens) {
    for (const brand of watchlist) {
      const target = brand.toLowerCase();
      if (token === target) continue;
      if (Math.abs(token.length - target.length) > 1) continue;
      if (editDistanceAtMostTwo(token, target)) return `${token} vs ${brand}`;
    }
  }
  return null;
}

/** Bounded Levenshtein: returns true when the distance is 1 or 2. */
function editDistanceAtMostTwo(a: string, b: string): boolean {
  if (a === b) return false;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > 2) return false;

  let previous = new Array<number>(lenB + 1);
  let current = new Array<number>(lenB + 1);
  for (let j = 0; j <= lenB; j++) previous[j] = j;

  for (let i = 1; i <= lenA; i++) {
    current[0] = i;
    let rowMinimum = current[0] as number;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[j] as number);
    }
    if (rowMinimum > 2) return false;
    [previous, current] = [current, previous];
  }
  const distance = previous[lenB] as number;
  return distance >= 1 && distance <= 2;
}

function descriptionOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const setB = new Set(b.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  if (setA.size < 10 || setB.size < 10) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// The v1 rule ensemble
// ---------------------------------------------------------------------------

/** Conditions that justify a price well below the cluster median. */
const DISCOUNT_JUSTIFYING: ReadonlySet<Condition> = new Set([
  'fair',
  'poor',
  'for_parts',
]);

/**
 * A price-anomaly value at or above this corresponds to roughly a quarter of
 * the reference price with no condition that explains it — the case the PRD
 * singles out as the strongest signal in the whole model.
 */
const SEVERE_PRICE_ANOMALY = 0.6;

/** The bottom of the `caution` band: ranked down, and flagged on the card. */
const CAUTION_FLOOR = 0.46;

/** The bottom of the `high` band: out of the feed, checkout blocked. */
const HIGH_FLOOR = 0.71;

/**
 * Categorically disqualifying evidence.
 *
 * The family weights are shares of one, so a weighted sum can never let any
 * single family carry a listing past its own weight: text signals top out at
 * 0.12, which means a listing that says "payment by wire transfer only" scores
 * `clear` on that evidence alone. That is not a tuning problem, it is the wrong
 * shape of model for evidence that is conclusive rather than suggestive.
 *
 * So the ensemble keeps its job — combining weak signals — and these rules
 * handle the strong ones. Each floor is justified by what the signal means, not
 * by what score it happens to produce:
 *
 *  - Payment steering and off-platform contact are the mechanism of the
 *    advance-fee scam. There is no honest listing that needs a wire transfer.
 *  - A hero image already in use by a different seller means the goods in the
 *    photograph are not the goods being sold.
 *  - A quarter of the cluster median with nothing about the condition to
 *    explain it is the PRD's single strongest signal.
 *
 * A trained model would learn these boundaries from labels; until it has them,
 * they are stated rather than hoped for.
 */
const DISQUALIFYING: ReadonlyArray<{
  family: RiskFamily;
  atLeast: number;
  floor: number;
  why: string;
}> = [
  { family: 'text_signals', atLeast: 0.85, floor: HIGH_FLOOR, why: 'payment steering or off-platform contact' },
  { family: 'media_forensics', atLeast: 0.85, floor: CAUTION_FLOOR, why: "another seller's photographs" },
];

export class RuleEnsembleRiskModel implements RiskModel {
  readonly version = 'risk-v1';

  score(input: RiskInput): ProductRisk<string> {
    const signals: RiskSignal[] = [];
    const family = (name: RiskFamily, value: number, detail: string) => {
      if (value > 0.01) signals.push({ family: name, value: clamp(value, 0, 1), detail });
    };

    const priceAnomaly = this.priceAnomaly(input);
    family(priceAnomaly.family, priceAnomaly.value, priceAnomaly.detail);
    family(...this.sellerHistory(input));
    family(...this.mediaForensics(input));
    family(...this.textSignals(input));
    family(...this.listingCoherence(input));
    family(...this.counterfeit(input));
    family(...this.crossListing(input));
    family(...this.network(input));

    // Individual sellers on secondhand and auction supply carry thinner
    // recourse, so the same evidence justifies a higher score there.
    const exposure =
      input.seller.type === 'retailer'
        ? 0.75
        : input.product.sourceType === 'new'
          ? 0.9
          : 1.15;

    let score = 0;
    for (const signal of signals) {
      score += (RISK_FAMILY_WEIGHTS[signal.family] ?? 0) * signal.value;
    }
    score *= exposure;

    // A listing under 25% of the reference price with nothing about its
    // condition to explain it is, per the PRD, the single strongest signal in
    // the model. A purely additive ensemble cannot express that: the
    // price-anomaly family is weighted at 0.28, so even a maxed-out price
    // signal alone lands in `watch` and is shown without a flag. Flooring it at
    // the caution threshold is what makes "strongest signal" true in the
    // output rather than only in the feature table.
    if (priceAnomaly.severe) score = Math.max(score, CAUTION_FLOOR);

    for (const rule of DISQUALIFYING) {
      const signal = signals.find((s) => s.family === rule.family);
      if (signal && signal.value >= rule.atLeast) score = Math.max(score, rule.floor);
    }

    // Two upheld reports against a seller suppress every listing they have, and
    // that is enforced separately; here the history still raises the score.
    if (input.seller.upheldReports > 0) score = Math.max(score, 0.7);

    const bounded = clamp(score, 0, 1);
    return {
      score: Math.round(bounded * 1000) / 1000,
      tier: riskTierFor(bounded),
      signals,
      modelVersion: this.version,
      reports: { count: 0, upheld: 0 },
      reviewedBy: null,
      reviewedAt: null,
      computedAt: input.now,
    };
  }

  /**
   * Price versus the cluster median, and failing that versus the L3 price
   * distribution. A listing under 25% of *cluster* median with no condition
   * justification is the single strongest signal in the whole model.
   *
   * The two references are not interchangeable, and treating them as if they
   * were is how this signal turns into noise. A cluster median compares a
   * product against the same product elsewhere, so a large gap is genuinely
   * anomalous. A category median compares it against everything in its L3 —
   * a band that routinely spans two orders of magnitude, where an entry-level
   * model sits far below the median for entirely ordinary reasons. So the
   * category path compares against the 10th percentile instead, scores weaker,
   * and never qualifies as severe.
   */
  private priceAnomaly(
    input: RiskInput,
  ): { family: RiskFamily; value: number; detail: string; severe: boolean } {
    const damp = (value: number): number => {
      // A genuinely rough item is allowed to be cheap; the signal is the gap
      // between the discount and anything that would explain it.
      let damped = value;
      if (DISCOUNT_JUSTIFYING.has(input.product.condition)) damped *= 0.35;
      else if (input.product.condition === 'good' || input.product.condition === 'excellent') {
        damped *= 0.8;
      }
      // A low current bid is the mechanism of an auction, not an anomaly in it.
      if (input.product.sourceType === 'auction') damped *= 0.4;
      return damped;
    };

    // A cluster is only ever attached when the listing matched an *existing*
    // one, so a single recorded member already means one other listing of the
    // same product. Requiring more than one here would make every second
    // arrival — the first moment a comparison becomes possible — look like the
    // first, and the strongest signal in the model would never fire.
    const clusterMedian =
      input.cluster && input.cluster.memberCount >= 1 ? input.cluster.medianPrice : null;

    if (clusterMedian && clusterMedian > 0) {
      const ratio = input.product.priceAmount / clusterMedian;
      if (ratio >= 0.6) {
        return { family: 'price_anomaly', value: 0, detail: 'priced in line with other sellers', severe: false };
      }
      const value = damp(clamp((0.6 - ratio) / 0.5, 0, 1));
      return {
        family: 'price_anomaly',
        value,
        detail: `priced ${Math.round((1 - ratio) * 100)}% below what this item usually sells for`,
        severe: value >= SEVERE_PRICE_ANOMALY,
      };
    }

    const p10 = input.categoryPrices?.p10 ?? null;
    if (!p10 || p10 <= 0) {
      return { family: 'price_anomaly', value: 0, detail: 'no reference price', severe: false };
    }

    const ratio = input.product.priceAmount / p10;
    if (ratio >= 1) {
      return { family: 'price_anomaly', value: 0, detail: 'price within the category range', severe: false };
    }

    // Capped well below the severe threshold: without a same-product
    // comparison this can support a `watch`, never a flag on the card.
    const value = damp(clamp((1 - ratio) / 0.7, 0, 1) * 0.55);
    return {
      family: 'price_anomaly',
      value,
      detail: `priced below almost everything else in its category`,
      severe: false,
    };
  }

  private sellerHistory(input: RiskInput): [RiskFamily, number, string] {
    const seller = input.seller;
    if (seller.type !== 'individual') {
      return ['seller_history', 0, 'established retailer'];
    }

    const parts: Array<{ value: number; detail: string }> = [];

    if (seller.accountAgeDays !== null && seller.accountAgeDays < 30) {
      parts.push({
        value: clamp((30 - seller.accountAgeDays) / 30, 0, 1),
        detail: `account is ${Math.round(seller.accountAgeDays)} days old`,
      });
    }
    if (seller.salesCount < 5) {
      parts.push({ value: clamp((5 - seller.salesCount) / 5, 0, 1) * 0.7, detail: 'few completed sales' });
    }
    // A high rating on almost no reviews is not a high rating.
    if (seller.rating !== null && seller.rating >= 4.8 && seller.reviewCount < 5) {
      parts.push({ value: 0.5, detail: 'high rating on very few reviews' });
    }
    if (seller.handleChangedWithinDays !== null && seller.handleChangedWithinDays < 30) {
      parts.push({ value: 0.6, detail: 'handle changed recently' });
    }

    if (parts.length === 0) return ['seller_history', 0, 'seller history unremarkable'];
    const value = clamp(parts.reduce((s, p) => s + p.value, 0) / Math.max(2, parts.length), 0, 1);
    return ['seller_history', value, parts.map((p) => p.detail).join('; ')];
  }

  private mediaForensics(input: RiskInput): [RiskFamily, number, string] {
    const parts: Array<{ value: number; detail: string }> = [];

    if (input.duplicateImageSellerIds.length > 0) {
      parts.push({
        value: 0.9,
        detail: `hero image already used by ${input.duplicateImageSellerIds.length} other seller(s)`,
      });
    }
    // Studio-grade photography with no EXIF from an individual seller usually
    // means the photo came from the manufacturer's site, not from the item.
    if (
      input.seller.type === 'individual' &&
      input.product.sourceType !== 'new' &&
      !input.product.hasExif &&
      input.product.imageLooksStudioGrade
    ) {
      parts.push({ value: 0.6, detail: 'stock-style photography on a used listing' });
    }

    if (parts.length === 0) return ['media_forensics', 0, 'imagery unremarkable'];
    const value = clamp(Math.max(...parts.map((p) => p.value)), 0, 1);
    return ['media_forensics', value, parts.map((p) => p.detail).join('; ')];
  }

  private textSignals(input: RiskInput): [RiskFamily, number, string] {
    const text = `${input.product.title} ${input.product.description ?? ''}`;
    const parts: Array<{ value: number; detail: string }> = [];

    if (OFF_PLATFORM_CONTACT.test(text)) {
      parts.push({ value: 0.85, detail: 'solicits contact off the source platform' });
    }
    if (PAYMENT_STEERING.test(text)) {
      parts.push({ value: 0.95, detail: 'steers to an irreversible payment method' });
    }
    if (URGENCY.test(text)) {
      parts.push({ value: 0.25, detail: 'urgency language' });
    }
    if (
      input.manufacturerDescription &&
      input.product.sourceType !== 'new' &&
      input.product.description &&
      descriptionOverlap(input.product.description, input.manufacturerDescription) > 0.75
    ) {
      parts.push({ value: 0.45, detail: 'manufacturer copy pasted onto a used listing' });
    }
    const misspelled = misspelledBrand(input.product.title, input.counterfeitWatchlistBrands);
    if (misspelled) {
      parts.push({ value: 0.8, detail: `misspelled brand token (${misspelled})` });
    }

    if (parts.length === 0) return ['text_signals', 0, 'listing text unremarkable'];
    const value = clamp(Math.max(...parts.map((p) => p.value)), 0, 1);
    return ['text_signals', value, parts.map((p) => p.detail).join('; ')];
  }

  private listingCoherence(input: RiskInput): [RiskFamily, number, string] {
    const parts: Array<{ value: number; detail: string }> = [];

    // Title-image mismatch, measured as cross-modal embedding distance.
    if (input.product.imageEmbedding) {
      const similarity = cosine(input.product.embedding, input.product.imageEmbedding);
      if (similarity < 0.3) {
        parts.push({
          value: clamp((0.3 - similarity) / 0.3, 0, 1),
          detail: 'the photograph does not match the title',
        });
      }
    }
    // Quantity above 1 on a genuinely one-of-one item.
    if (input.product.singleUnit && (input.product.quantity ?? 1) > 1) {
      parts.push({ value: 0.7, detail: 'multiple units offered of a one-of-one item' });
    }
    // A brand-new claim on a discontinued product.
    if (input.discontinued && input.product.condition === 'new') {
      parts.push({ value: 0.4, detail: 'listed as new but discontinued by the manufacturer' });
    }

    if (parts.length === 0) return ['listing_coherence', 0, 'listing internally consistent'];
    const value = clamp(Math.max(...parts.map((p) => p.value)), 0, 1);
    return ['listing_coherence', value, parts.map((p) => p.detail).join('; ')];
  }

  /**
   * Counterfeit-specific: a watchlisted brand combined with a price anomaly.
   * The logo and serial-region checks the PRD calls for need a vision model on
   * the hero image; the seam for that is `imageLooksStudioGrade` and
   * `imageEmbedding`, and until a model is wired in this family scores on the
   * brand-plus-price combination alone rather than pretending otherwise.
   */
  private counterfeit(input: RiskInput): [RiskFamily, number, string] {
    const brand = input.product.brand;
    const watchlistedCategory = (COUNTERFEIT_WATCHLIST_CATEGORIES as readonly string[]).includes(
      input.product.categoryL1,
    );
    if (!brand || !input.counterfeitWatchlistBrands.has(brand)) {
      return ['counterfeit', 0, 'brand not on the counterfeit watchlist'];
    }

    const priceValue = this.priceAnomaly(input).value;
    if (priceValue <= 0.05) {
      return ['counterfeit', watchlistedCategory ? 0.1 : 0, 'watchlisted brand at a normal price'];
    }

    const value = clamp(priceValue * (watchlistedCategory ? 1 : 0.7), 0, 1);
    return [
      'counterfeit',
      value,
      `${brand} is frequently counterfeited and this listing is priced well below market`,
    ];
  }

  private crossListing(input: RiskInput): [RiskFamily, number, string] {
    const parts: Array<{ value: number; detail: string }> = [];

    // A new individual seller listing a lot of high-value stock at once is the
    // shape of an account that was bought or stolen rather than grown.
    if (
      input.seller.type === 'individual' &&
      input.seller.recentListingCount >= 10 &&
      input.seller.recentListingValue > 200_000
    ) {
      parts.push({
        value: clamp(input.seller.recentListingCount / 40, 0, 1),
        detail: `${input.seller.recentListingCount} high-value listings in 24 hours`,
      });
    }
    if (input.inconsistentCrossListings > 0) {
      parts.push({
        value: clamp(input.inconsistentCrossListings / 3, 0, 1),
        detail: 'the same item is listed elsewhere with contradictory details',
      });
    }

    if (parts.length === 0) return ['cross_listing', 0, 'no cross-listing anomalies'];
    const value = clamp(Math.max(...parts.map((p) => p.value)), 0, 1);
    return ['cross_listing', value, parts.map((p) => p.detail).join('; ')];
  }

  private network(input: RiskInput): [RiskFamily, number, string] {
    const parts: Array<{ value: number; detail: string }> = [];
    if (input.source.domainReputation < 0.5) {
      parts.push({
        value: clamp((0.5 - input.source.domainReputation) / 0.5, 0, 1),
        detail: 'low source-domain reputation',
      });
    }
    if (input.source.proxyIndicators) parts.push({ value: 0.4, detail: 'proxy indicators' });
    if (input.source.burnerEmailIndicators) {
      parts.push({ value: 0.5, detail: 'burner-email indicators' });
    }
    if (parts.length === 0) return ['network', 0, 'network signals clean'];
    const value = clamp(Math.max(...parts.map((p) => p.value)), 0, 1);
    return ['network', value, parts.map((p) => p.detail).join('; ')];
  }
}

// ---------------------------------------------------------------------------
// Enforcement copy
// ---------------------------------------------------------------------------

/**
 * Warnings are always specific. "This listing is priced 71% below what this
 * item usually sells for" is actionable; "this listing may be risky" trains
 * users to dismiss the banner, which is worse than showing nothing.
 */
export function riskFlagText(risk: ProductRisk<string>): string | null {
  if (risk.tier === 'clear' || risk.tier === 'watch') return null;
  const strongest = [...risk.signals].sort(
    (a, b) =>
      (RISK_FAMILY_WEIGHTS[b.family] ?? 0) * b.value -
      (RISK_FAMILY_WEIGHTS[a.family] ?? 0) * a.value,
  )[0];
  if (!strongest) return null;

  switch (strongest.family) {
    case 'price_anomaly':
    case 'counterfeit':
      return `This listing is ${strongest.detail}.`;
    case 'media_forensics':
      return `The photographs on this listing are used by other sellers.`;
    case 'text_signals':
      return `This listing ${strongest.detail}.`;
    case 'seller_history':
      return `This seller is new to the source site: ${strongest.detail}.`;
    case 'listing_coherence':
      return `This listing contradicts itself: ${strongest.detail}.`;
    case 'cross_listing':
      return `This seller's recent activity is unusual: ${strongest.detail}.`;
    case 'network':
      return `This source has a poor reputation: ${strongest.detail}.`;
  }
}

/** The interstitial shown before authorization when a caution-tier item is in the cart. */
export function checkoutInterstitial(risk: ProductRisk<string>, title: string): string | null {
  if (risk.tier !== 'caution') return null;
  const flag = riskFlagText(risk);
  return flag ? `Before you buy "${title}": ${flag}` : null;
}
