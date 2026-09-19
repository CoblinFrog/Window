import {
  PRICE_BAND_CENTERS,
  PRICE_PRIOR_CONFIDENCE,
  SIGNAL_WEIGHTS,
  clamp,
  emaUpdate,
  isoDay,
  meanVector,
  normalize,
  type InteractionType,
  type InterestEntry,
  type PriceBand,
  type RankingConfig,
  type UserDoc,
} from '@window/shared';

/**
 * The user interest model.
 *
 * Learning comes from behaviour, not forms: after the three-topic onboarding
 * the model improves from dwell time and taps alone, and the user is never
 * asked to rate anything. Everything in this file is a pure function over the
 * user document so the update path can be reasoned about — and tested — without
 * a database.
 */

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * u_0 = normalize( (1/3) · Σ c_i )
 *
 * Forcing exactly three topics rather than "three or more" keeps this vector
 * sharp; averaging seven centroids produces something close to the catalog
 * mean, which is the one thing a cold-start vector must not be.
 */
export function seedUserVector(centroids: ReadonlyArray<readonly number[]>): number[] {
  return meanVector(centroids);
}

export function seedInterestSet(topics: readonly string[], now: Date): InterestEntry[] {
  return topics.map((topic) => ({
    topic,
    weight: 1.0,
    source: 'onboarding' as const,
    addedAt: now,
    lastPositiveAt: null,
    impressionsSinceAdded: 0,
    positiveSinceAdded: 0,
  }));
}

/** A soft price prior, not a filter. Skipping the question is a valid answer. */
export function seedPricePrior(
  band: PriceBand | null,
  currency: string,
): UserDoc['pricePrior'] {
  if (!band) {
    return {
      center: PRICE_BAND_CENTERS.mid as number,
      currency,
      confidence: PRICE_PRIOR_CONFIDENCE.skipped,
    };
  }
  return {
    center: PRICE_BAND_CENTERS[band] as number,
    currency,
    confidence: PRICE_PRIOR_CONFIDENCE.stated,
  };
}

// ---------------------------------------------------------------------------
// Online updates
// ---------------------------------------------------------------------------

export interface InteractionSignal {
  type: InteractionType;
  productVector: readonly number[];
  categoryL1: string;
  brand: string | null;
  sellerId: string;
  isExploration: boolean;
}

export interface UserUpdate {
  interestVector: number[];
  interestSet: InterestEntry[];
  affinities: UserDoc['affinities'];
  pricePrior: UserDoc['pricePrior'];
}

/**
 * The online update:
 *
 *   u_{t+1} = normalize( (1 − α·w_e)·u_t + α·w_e·p_e )
 *
 * with α = 0.08 and w_e the event's signal weight. Negative events subtract
 * rather than add, which is why the blend uses |w_e| and the product term
 * carries the sign.
 */
export function applyInteraction(
  user: Pick<UserDoc, 'interestVector' | 'interestSet' | 'affinities' | 'pricePrior'>,
  signal: InteractionSignal,
  config: RankingConfig,
  now: Date,
): UserUpdate {
  const weight = SIGNAL_WEIGHTS[signal.type];

  const currentVector = user.interestVector ?? normalize(signal.productVector);
  const interestVector =
    weight === 0
      ? [...currentVector]
      : emaUpdate(currentVector, signal.productVector, weight, config.userVector.alpha);

  // Interest-set weights track the topic, not the product: a positive event
  // strengthens the topic it landed in, a negative one weakens it.
  const interestSet = user.interestSet.map((entry) => {
    if (entry.topic !== signal.categoryL1) return entry;
    const delta = config.userVector.alpha * weight;
    return {
      ...entry,
      weight: clamp(entry.weight + delta, config.userVector.decayFloor, 1),
      lastPositiveAt: weight > 0 ? now : entry.lastPositiveAt,
      impressionsSinceAdded: (entry.impressionsSinceAdded ?? 0) + (signal.type === 'impression' ? 1 : 0),
      positiveSinceAdded: (entry.positiveSinceAdded ?? 0) + (weight > 0 ? 1 : 0),
    };
  });

  const affinities = {
    brands: { ...user.affinities.brands },
    sellers: { ...user.affinities.sellers },
  };
  if (signal.brand) {
    const key = signal.brand.toLowerCase();
    affinities.brands[key] = clamp((affinities.brands[key] ?? 0) + weight * 0.25, -1, 1);
  }
  affinities.sellers[signal.sellerId] = clamp(
    (affinities.sellers[signal.sellerId] ?? 0) + weight * 0.2,
    -1,
    1,
  );

  return { interestVector, interestSet, affinities, pricePrior: user.pricePrior };
}

/**
 * The price prior is calibrated by what the user actually engages with, which
 * is why cards 13-15 of the cold start deliberately straddle the stated band.
 * It moves slowly and only on strong signals: one cheap impulse buy should not
 * convince the feed that someone is a budget shopper.
 */
export function updatePricePrior(
  prior: UserDoc['pricePrior'],
  priceAmount: number,
  eventWeight: number,
): UserDoc['pricePrior'] {
  if (eventWeight <= 0.3) return prior;
  const rate = 0.12 * eventWeight;
  // Moved in log space: the distance from $20 to $40 is the distance from $200
  // to $400, and a linear mean would let one expensive item dominate.
  const center = Math.exp(
    Math.log(Math.max(1, prior.center)) * (1 - rate) + Math.log(Math.max(1, priceAmount)) * rate,
  );
  return {
    center: Math.round(center),
    currency: prior.currency,
    confidence: clamp(prior.confidence + 0.02 * eventWeight, 0, 0.95),
  };
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/**
 * Interest-set weights decay by 0.97 per day of inactivity, floored at 0.1, so
 * a dormant user's profile softens rather than disappears. Coming back after a
 * month should feel like the feed remembers you vaguely, not like a stranger
 * and not like nothing happened.
 */
export function decayInterests(
  user: Pick<UserDoc, 'interestSet' | 'counters'>,
  config: RankingConfig,
  now: Date,
): { interestSet: InterestEntry[]; decayedDays: number; lastDecayedOn: string } {
  const today = isoDay(now);
  const last = user.counters.lastDecayedOn;
  const lastActive = user.counters.lastActiveAt;

  const inactiveDays = Math.floor(
    Math.max(0, now.getTime() - lastActive.getTime()) / 86_400_000,
  );

  if (last === today || inactiveDays === 0) {
    return { interestSet: [...user.interestSet], decayedDays: 0, lastDecayedOn: today };
  }

  const factor = config.userVector.dailyDecay ** inactiveDays;
  const interestSet = user.interestSet.map((entry) => ({
    ...entry,
    weight: Math.max(config.userVector.decayFloor, entry.weight * factor),
  }));

  return { interestSet, decayedDays: inactiveDays, lastDecayedOn: today };
}

/** A user dormant this long gets the re-entry block instead of a normal page. */
export function isReturningAfterDormancy(
  lastActiveAt: Date,
  now: Date,
  dormantDays: number,
): boolean {
  return now.getTime() - lastActiveAt.getTime() > dormantDays * 86_400_000;
}

/** The price band the hard filter uses: 0.25x to 4x the prior. */
export function priceBounds(
  prior: UserDoc['pricePrior'],
  config: RankingConfig,
): { min: number; max: number } {
  return {
    min: Math.round(prior.center * config.filters.priceLowMultiplier),
    max: Math.round(prior.center * config.filters.priceHighMultiplier),
  };
}
