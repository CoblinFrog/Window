import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mulberry32, hashString } from '@window/shared';
import {
  DEFAULT_RANKING_CONFIG,
  SIGNAL_WEIGHTS,
  TOPIC_ADOPTION,
  cosine,
  emaUpdate,
  meanVector,
  normalize,
  quantizeScalar,
  quantizedDot,
  riskTierFor,
  type InterestEntry,
  type UserDoc,
} from '@window/shared';
import {
  adoptTopic,
  applyAdoptionEvidence,
  demoteStaleTopics,
  drawExplorationCounter,
  explorationSlotsForPage,
  recordExplorationRejection,
} from './exploration.js';
import {
  decayInterests,
  priceBounds,
  seedInterestSet,
  seedUserVector,
  updatePricePrior,
} from './user-vector.js';
import { bloomAdd, bloomHas, createBloom, deserializeBloom, serializeBloom } from '../lib/bloom.js';

const config = DEFAULT_RANKING_CONFIG;

function mulberryFrom(seed: string): () => number {
  return mulberry32(hashString(seed));
}

function unit(seed: number, dim = 16): number[] {
  return normalize(Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1))));
}

describe('vector math', () => {
  it('normalizes to unit length', () => {
    const v = normalize([3, 4]);
    assert.ok(Math.abs(Math.hypot(v[0] as number, v[1] as number) - 1) < 1e-12);
  });

  it('leaves a zero vector alone rather than dividing by zero', () => {
    assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
    assert.equal(cosine([0, 0], [1, 0]), 0);
  });

  it('seeds the user vector as the normalized mean of three centroids', () => {
    const centroids = [unit(1), unit(2), unit(3)];
    const seeded = seedUserVector(centroids);

    assert.ok(Math.abs(Math.hypot(...seeded) - 1) < 1e-12);
    // It must sit between the three inputs, not on top of any one of them.
    for (const centroid of centroids) {
      const similarity = cosine(seeded, centroid);
      assert.ok(similarity > 0, 'seed should lean toward every chosen topic');
      assert.ok(similarity < 0.999, 'seed should not collapse onto one topic');
    }
    assert.deepEqual(seeded, meanVector(centroids));
  });
});

describe('the online update', () => {
  const user = unit(7);
  const product = unit(11);

  it('moves toward the product on a positive event', () => {
    const before = cosine(user, product);
    const after = cosine(
      emaUpdate(user, product, SIGNAL_WEIGHTS.cart_add, config.userVector.alpha),
      product,
    );
    assert.ok(after > before, `expected ${after} > ${before}`);
  });

  it('moves away on a negative event rather than toward it', () => {
    const before = cosine(user, product);
    const after = cosine(
      emaUpdate(user, product, SIGNAL_WEIGHTS.hide_product, config.userVector.alpha),
      product,
    );
    assert.ok(after < before, `expected ${after} < ${before}`);
  });

  it('moves further for a stronger signal', () => {
    const weak = cosine(
      emaUpdate(user, product, SIGNAL_WEIGHTS.dwell_short, config.userVector.alpha),
      product,
    );
    const strong = cosine(
      emaUpdate(user, product, SIGNAL_WEIGHTS.purchase, config.userVector.alpha),
      product,
    );
    assert.ok(strong > weak);
  });

  it('keeps the vector unit-normalized', () => {
    const updated = emaUpdate(user, product, SIGNAL_WEIGHTS.upvote, config.userVector.alpha);
    assert.ok(Math.abs(Math.hypot(...updated) - 1) < 1e-12);
  });

  it('is a no-op for an impression, which is a denominator only', () => {
    assert.equal(SIGNAL_WEIGHTS.impression, 0);
    const updated = emaUpdate(user, product, SIGNAL_WEIGHTS.impression, config.userVector.alpha);
    assert.ok(cosine(updated, user) > 0.999999);
  });
});

describe('interest decay', () => {
  function userWith(weights: number[], lastActiveDaysAgo: number): Pick<UserDoc, 'interestSet' | 'counters'> {
    const now = Date.now();
    return {
      interestSet: weights.map((weight, index) => ({
        topic: `t${index}`,
        weight,
        source: 'onboarding' as const,
        addedAt: new Date(now),
        lastPositiveAt: null,
      })),
      counters: {
        interactionCount: 40,
        sessionCount: 5,
        lastActiveAt: new Date(now - lastActiveDaysAgo * 86_400_000),
        lastDecayedOn: null,
      },
    };
  }

  it('decays by 0.97 per inactive day', () => {
    const result = decayInterests(userWith([1], 10), config, new Date());
    const expected = 0.97 ** 10;
    assert.ok(Math.abs((result.interestSet[0]?.weight ?? 0) - expected) < 1e-9);
  });

  it('floors at 0.1 so a dormant profile softens rather than disappearing', () => {
    const result = decayInterests(userWith([1], 400), config, new Date());
    assert.equal(result.interestSet[0]?.weight, config.userVector.decayFloor);
  });

  it('does nothing for an active user', () => {
    const result = decayInterests(userWith([0.8], 0), config, new Date());
    assert.equal(result.decayedDays, 0);
    assert.equal(result.interestSet[0]?.weight, 0.8);
  });
});

describe('the price prior', () => {
  const prior = { center: 8000, currency: 'USD', confidence: 0.4 };

  it('ignores weak signals: one impulse view is not a budget', () => {
    assert.deepEqual(updatePricePrior(prior, 90000, SIGNAL_WEIGHTS.dwell_short), prior);
  });

  it('moves toward the price on a strong signal', () => {
    const moved = updatePricePrior(prior, 40000, SIGNAL_WEIGHTS.cart_add);
    assert.ok(moved.center > prior.center);
    assert.ok(moved.center < 40000, 'must not jump straight to the observed price');
  });

  it('moves in log space, so symmetric ratios move symmetrically', () => {
    const up = updatePricePrior(prior, prior.center * 4, SIGNAL_WEIGHTS.cart_add);
    const down = updatePricePrior(prior, prior.center / 4, SIGNAL_WEIGHTS.cart_add);
    const upRatio = up.center / prior.center;
    const downRatio = prior.center / down.center;
    assert.ok(Math.abs(upRatio - downRatio) < 0.05, `${upRatio} vs ${downRatio}`);
  });

  it('derives the 0.25x to 4x hard filter band', () => {
    const bounds = priceBounds(prior, config);
    assert.equal(bounds.min, 2000);
    assert.equal(bounds.max, 32000);
  });
});

describe('exploration', () => {
  it('draws the counter from [10, 20] inclusive', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      let value = 0;
      const random = () => ((i * 37) % 400) / 400;
      value = drawExplorationCounter(config, random);
      assert.ok(value >= 10 && value <= 20, `drew ${value}`);
      seen.add(value);
    }
    assert.ok(seen.size > 1, 'the draw should not be constant');
  });

  it('keeps every gap inside 10 to 20 cards across a long scroll', () => {
    // The failure this pins down is subtle: computing only the first expiry per
    // page and carrying the rest forward yields gaps of exactly `limit` every
    // time, which still technically sits inside the range but is never
    // anywhere else in it.
    const random = mulberryFrom('cadence');
    const limit = 20;
    let counter = 14;
    const slots: number[] = [];

    for (let page = 0; page < 40; page++) {
      const result = explorationSlotsForPage(counter, limit, config, random);
      for (const position of result.positions) slots.push(page * limit + position);
      counter = result.nextCounter;
    }

    assert.ok(slots.length > 40, `only ${slots.length} slots over 800 cards`);
    const gaps = slots.slice(1).map((value, i) => value - (slots[i] as number));
    for (const gap of gaps) {
      assert.ok(
        gap >= config.exploration.counterMin && gap <= config.exploration.counterMax,
        `gap of ${gap} falls outside [10, 20]`,
      );
    }
    // And the gaps must actually vary rather than sitting on one value.
    assert.ok(new Set(gaps).size > 3, `gaps were ${[...new Set(gaps)].join(',')}`);
  });

  it('charges the interval for a page that suppresses injection', () => {
    const { positions, nextCounter } = explorationSlotsForPage(50, 20, config, () => 0.5);
    assert.deepEqual(positions, []);
    assert.equal(nextCounter, 30);
  });

  it('suppresses a topic for 30 days after two rejections', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let explorationState: UserDoc['explorationState'] = {
      counter: 12,
      lastTopic: null,
      rejected: [],
      pending: [],
    };

    explorationState = recordExplorationRejection(explorationState, 'pets', config, now);
    assert.equal(explorationState.rejected[0]?.strikes, 1);
    assert.ok(explorationState.rejected[0]?.until.getTime() ?? 0 <= now.getTime());

    explorationState = recordExplorationRejection(explorationState, 'pets', config, now);
    assert.equal(explorationState.rejected[0]?.strikes, 2);
    const days =
      ((explorationState.rejected[0]?.until.getTime() ?? 0) - now.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.001, `suppressed for ${days} days`);
  });
});

describe('topic adoption', () => {
  const empty: UserDoc['explorationState'] = {
    counter: 0,
    lastTopic: null,
    rejected: [],
    pending: [],
  };

  it('graduates on a cart add at the cart-add weight', () => {
    const outcome = applyAdoptionEvidence(
      empty,
      { topic: 'photography', sessionId: 's1', type: 'cart_add', dwellMs: null },
      [],
    );
    assert.equal(outcome.graduated?.topic, 'photography');
    assert.equal(outcome.graduated?.weight, TOPIC_ADOPTION.triggers.cartAdd.weight);
  });

  it('graduates on a long dwell at the lower dwell weight', () => {
    const outcome = applyAdoptionEvidence(
      empty,
      { topic: 'photography', sessionId: 's1', type: 'dwell_long', dwellMs: 9000 },
      [],
    );
    assert.equal(outcome.graduated?.weight, TOPIC_ADOPTION.triggers.dwell.weight);
  });

  it('does not graduate on a dwell below the threshold', () => {
    const outcome = applyAdoptionEvidence(
      empty,
      { topic: 'photography', sessionId: 's1', type: 'dwell_short', dwellMs: 3000 },
      [],
    );
    assert.equal(outcome.graduated, null);
  });

  it('graduates on two positive dwells across separate exploration cards', () => {
    let explorationState = empty;
    let outcome = applyAdoptionEvidence(
      explorationState,
      { topic: 'pets', sessionId: 's1', type: 'dwell_short', dwellMs: 6500 },
      [],
    );
    assert.equal(outcome.graduated, null, 'one dwell is not enough');
    explorationState = outcome.explorationState;

    outcome = applyAdoptionEvidence(
      explorationState,
      { topic: 'pets', sessionId: 's2', type: 'dwell_short', dwellMs: 6500 },
      [],
    );
    assert.equal(outcome.graduated?.weight, TOPIC_ADOPTION.triggers.repeatDwell.weight);
  });

  it('takes the strongest trigger when several fire', () => {
    let explorationState = empty;
    explorationState = applyAdoptionEvidence(
      explorationState,
      { topic: 'art', sessionId: 's1', type: 'reviews_open', dwellMs: null },
      [],
    ).explorationState;

    const outcome = applyAdoptionEvidence(
      explorationState,
      { topic: 'art', sessionId: 's1', type: 'cart_add', dwellMs: null },
      [],
    );
    assert.equal(outcome.graduated?.weight, TOPIC_ADOPTION.triggers.cartAdd.weight);
  });

  it('never re-graduates a topic already in the interest set', () => {
    const existing: InterestEntry[] = [
      {
        topic: 'art',
        weight: 1,
        source: 'onboarding',
        addedAt: new Date(),
        lastPositiveAt: null,
      },
    ];
    const outcome = applyAdoptionEvidence(
      empty,
      { topic: 'art', sessionId: 's1', type: 'cart_add', dwellMs: null },
      existing,
    );
    assert.equal(outcome.graduated, null);
  });

  it('enters at the granted weight, not at 1.0', () => {
    const set = adoptTopic([], 'pets', 0.3, new Date());
    assert.equal(set[0]?.weight, 0.3);
    assert.equal(set[0]?.source, 'exploration');
  });

  it('demotes a graduated topic with no positive signal across 40 impressions', () => {
    const base = {
      weight: 0.3,
      addedAt: new Date(),
      lastPositiveAt: null,
      positiveSinceAdded: 0,
    };
    const { kept, demoted } = demoteStaleTopics([
      { ...base, topic: 'stale', source: 'exploration', impressionsSinceAdded: 41 },
      { ...base, topic: 'young', source: 'exploration', impressionsSinceAdded: 12 },
      // An onboarding topic is never demoted: the user chose it.
      { ...base, topic: 'chosen', source: 'onboarding', impressionsSinceAdded: 500 },
    ]);
    assert.deepEqual(demoted, ['stale']);
    assert.deepEqual(kept.map((k) => k.topic), ['young', 'chosen']);
  });

  it('keeps a graduated topic that earned a signal', () => {
    const { demoted } = demoteStaleTopics([
      {
        topic: 'earned',
        weight: 0.3,
        source: 'exploration',
        addedAt: new Date(),
        lastPositiveAt: new Date(),
        impressionsSinceAdded: 80,
        positiveSinceAdded: 2,
      },
    ]);
    assert.deepEqual(demoted, []);
  });
});

describe('onboarding seed', () => {
  it('starts all three chosen topics at weight 1.0', () => {
    const set = seedInterestSet(['tech', 'gaming', 'audio'], new Date());
    assert.equal(set.length, 3);
    assert.ok(set.every((entry) => entry.weight === 1 && entry.source === 'onboarding'));
  });
});

describe('risk tiers', () => {
  it('maps scores onto the five enforcement tiers at the stated bounds', () => {
    assert.equal(riskTierFor(0), 'clear');
    assert.equal(riskTierFor(0.199), 'clear');
    assert.equal(riskTierFor(0.2), 'watch');
    assert.equal(riskTierFor(0.449), 'watch');
    assert.equal(riskTierFor(0.45), 'caution');
    assert.equal(riskTierFor(0.699), 'caution');
    assert.equal(riskTierFor(0.7), 'high');
    assert.equal(riskTierFor(0.879), 'high');
    assert.equal(riskTierFor(0.88), 'blocked');
    assert.equal(riskTierFor(1), 'blocked');
  });
});

describe('the seen-set Bloom filter', () => {
  it('never produces a false negative', () => {
    const bloom = createBloom();
    const ids = Array.from({ length: 5000 }, (_, i) => `product-${i}`);
    for (const id of ids) bloomAdd(bloom, id);
    for (const id of ids) {
      assert.ok(bloomHas(bloom, id), `${id} went missing, which would re-show a seen card`);
    }
  });

  it('keeps false positives rare at the configured load', () => {
    const bloom = createBloom();
    for (let i = 0; i < 5000; i++) bloomAdd(bloom, `seen-${i}`);

    let falsePositives = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      if (bloomHas(bloom, `unseen-${i}`)) falsePositives += 1;
    }
    const rate = falsePositives / trials;
    // At m=200k, k=7 and n=5k the theoretical rate is far below 1%; anything
    // above that means candidates are being discarded that were never shown.
    assert.ok(rate < 0.01, `false positive rate ${rate}`);
  });

  it('survives a serialize/deserialize round trip', () => {
    const bloom = createBloom();
    for (let i = 0; i < 500; i++) bloomAdd(bloom, `id-${i}`);

    const restored = deserializeBloom(serializeBloom(bloom, new Date()));
    for (let i = 0; i < 500; i++) assert.ok(bloomHas(restored, `id-${i}`));
    assert.equal(restored.n, bloom.n);
  });
});

describe('scalar quantization', () => {
  it('matches the index definition and preserves ranking order', () => {
    const query = unit(3, 64);
    const near = normalize(query.map((v, i) => v + (i % 7 === 0 ? 0.02 : 0)));
    const far = unit(99, 64);

    const nearScore = quantizedDot(quantizeScalar(near), query);
    const farScore = quantizedDot(quantizeScalar(far), query);
    assert.ok(nearScore > farScore);

    // The int8 round trip must stay close to the float cosine, or the local
    // index would rank differently from Atlas rather than merely less finely.
    assert.ok(Math.abs(nearScore - cosine(near, query)) < 0.01);
  });
});
