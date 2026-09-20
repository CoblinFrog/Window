import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RANKING_CONFIG, QUALITY_GATE, QUALITY_PARAMS } from '@window/shared';
import {
  BRAND_FUZZY_THRESHOLD,
  diceCoefficient,
  normalizeCondition,
  normalizeSpecs,
  normalizeStock,
  normalizeTitle,
  parsePrice,
  resolveBrand,
} from './normalize.js';
import {
  aggregateCluster,
  brandModelKey,
  extractModelNumber,
  identifierKeys,
  identifiersMatch,
  mayCluster,
  otherOffers,
  priceContext,
  priceWithinTolerance,
} from './dedupe.js';
import { applyQualityGate } from './gate.js';
import { cautionsFor, extractThemes, reviewCredibility, type ReviewSample } from './quality.js';
import { bucketReviews, combineRatings, reviewSentiment, type AggregatedReview } from './reviews.js';
import { RuleEnsembleRiskModel, riskFlagText, type RiskInput } from './risk.js';
import {
  AMAZON_ENV_VARS,
  AmazonPaapiAdapter,
  EBAY_ENV_VARS,
  EbayBrowseAdapter,
  adapterWithFallback,
  canServe,
  createAdapter,
  fallbackChain,
} from './adapters/index.js';
import { SOURCE_REGISTRY } from './sources.js';
import { SourceUnavailableError } from './types.js';
import { assembleQuad, priceBandFor } from '../feed/quads.js';
import { bestCouponOutcome } from '../checkout/coupons.js';
import { hashQuote } from '../checkout/orchestrator.js';

describe('title normalization', () => {
  it('strips promotional padding', () => {
    const title = normalizeTitle(
      'Keychron Q1 Mechanical Keyboard - FREE SHIPPING - 100% Authentic - HOT SALE',
      'Keychron',
    );
    assert.ok(!/free shipping/i.test(title));
    assert.ok(!/hot sale/i.test(title));
    assert.ok(!/100% authentic/i.test(title));
    assert.ok(title.includes('Keychron'));
    assert.ok(title.includes('Q1'));
  });

  it('removes a repeated brand but keeps the first mention', () => {
    const title = normalizeTitle('Nike Air Max 90 Nike Sneakers Nike', 'Nike');
    assert.equal(title.match(/Nike/g)?.length, 1);
  });

  it('strips seller boilerplate', () => {
    const title = normalizeTitle('Sony WH-1000XM5 Sold by AudioDepot', 'Sony');
    assert.ok(!/sold by/i.test(title));
    assert.ok(title.includes('WH-1000XM5'));
  });

  it('de-shouts an all-caps title without touching model numbers', () => {
    const title = normalizeTitle('VINTAGE LEATHER JACKET SIZE M', null);
    assert.ok(!/VINTAGE/.test(title), title);
    assert.ok(/Vintage/.test(title), title);
  });

  it('caps at 120 characters', () => {
    const long = normalizeTitle('x'.repeat(400), null);
    assert.ok(long.length <= QUALITY_GATE.maxTitleLength);
  });
});

describe('brand resolution', () => {
  const dictionary = ['Keychron', 'Sony', 'Nike', 'Leica'];

  it('matches exactly, ignoring case', () => {
    assert.equal(resolveBrand('sony', 'whatever', dictionary), 'Sony');
  });

  it('matches a near-miss above the fuzzy threshold', () => {
    // At a 0.9 Dice threshold the bar is deliberately high: a single
    // transposed character in an eight-letter brand scores 0.86 and is refused.
    assert.ok(diceCoefficient('Keychron', 'Keychron ') >= BRAND_FUZZY_THRESHOLD);
    assert.equal(resolveBrand('  Keychron', 'a keyboard', dictionary), 'Keychron');

    assert.ok(diceCoefficient('Keychron', 'Keychrom') < BRAND_FUZZY_THRESHOLD);
    assert.equal(
      resolveBrand('Keychrom', 'a keyboard', dictionary),
      null,
      'a brand below the threshold is left null rather than guessed',
    );
  });

  it('returns null rather than guessing on an unknown brand', () => {
    // A wrong brand feeds brand affinity, brand suppression and the counterfeit
    // watchlist; none of those may be wrong silently.
    assert.equal(resolveBrand('Totally Unknown Co', 'some product', dictionary), null);
  });

  it('finds an exact brand token inside the title', () => {
    assert.equal(resolveBrand(null, 'Brand new Leica M6 rangefinder', dictionary), 'Leica');
  });

  it('does not fuzzy-match brand-alike words in title text', () => {
    assert.equal(resolveBrand(null, 'Nike-style running shoe, unbranded', dictionary), null);
  });
});

describe('price parsing', () => {
  it('reads US formatting', () => {
    assert.deepEqual(parsePrice('$1,299.99'), { amount: 129999, currency: 'USD' });
  });

  it('reads European formatting without inverting the separators', () => {
    // Getting this backwards is a 100x price error on the card.
    assert.deepEqual(parsePrice('1.299,99 €'), { amount: 129999, currency: 'EUR' });
  });

  it('treats three trailing digits as a thousands group', () => {
    assert.deepEqual(parsePrice('$1,299'), { amount: 129900, currency: 'USD' });
    assert.deepEqual(parsePrice('1.299 EUR'), { amount: 129900, currency: 'EUR' });
  });

  it('handles zero-decimal currencies', () => {
    assert.deepEqual(parsePrice('¥12800'), { amount: 12800, currency: 'JPY' });
  });

  it('returns null on unparseable input rather than zero', () => {
    assert.equal(parsePrice('call for price'), null);
    assert.equal(parsePrice(null), null);
  });
});

describe('condition mapping', () => {
  it('maps source wording onto the 8-point scale', () => {
    assert.equal(normalizeCondition('Brand New', 'new'), 'new');
    assert.equal(normalizeCondition('New with tags', 'secondhand'), 'new');
    assert.equal(normalizeCondition('Pre-owned', 'secondhand'), 'good');
    assert.equal(normalizeCondition('For parts or not working', 'secondhand'), 'for_parts');
  });

  it('prefers the more specific synonym in a compound phrase', () => {
    assert.equal(normalizeCondition('excellent used condition', 'secondhand'), 'excellent');
  });

  it('reads schema.org condition URLs', () => {
    assert.equal(
      normalizeCondition('https://schema.org/UsedCondition', 'secondhand'),
      'good',
    );
  });

  it('falls back to unknown for secondhand rather than assuming new', () => {
    assert.equal(normalizeCondition(null, 'secondhand'), 'unknown');
    assert.equal(normalizeCondition(null, 'new'), 'new');
  });
});

describe('stock normalization', () => {
  it('forces quantity 1 on single-unit sources', () => {
    const stock = normalizeStock(
      { availabilityText: 'In stock', quantity: 5, sourceType: 'secondhand' },
      true,
    );
    assert.equal(stock.quantity, 1);
    assert.ok(stock.singleUnit);
  });

  it('reads out-of-stock wording', () => {
    const stock = normalizeStock(
      { availabilityText: 'Sold out', quantity: null, sourceType: 'new' },
      false,
    );
    assert.equal(stock.inStock, false);
  });
});

describe('spec normalization', () => {
  it('converts onto canonical units', () => {
    const specs = normalizeSpecs([
      { key: 'Switch Type', value: 'tactile' },
      { key: 'Length', value: '3.5 in' },
      { key: 'Weight', value: '1.2 kg' },
      { key: 'Polling rate', value: '1 kHz' },
    ]);
    const byKey = new Map(specs.map((s) => [s.key, s]));

    assert.equal(byKey.get('switch_type')?.value, 'tactile');
    assert.equal(byKey.get('length')?.unit, 'mm');
    assert.equal(byKey.get('length')?.value, '88.9');
    assert.equal(byKey.get('weight')?.unit, 'g');
    assert.equal(byKey.get('weight')?.value, '1200');
    assert.equal(byKey.get('polling_rate')?.unit, 'Hz');
    assert.equal(byKey.get('polling_rate')?.value, '1000');
  });

  it('passes through values it does not understand rather than dropping them', () => {
    const specs = normalizeSpecs([{ key: 'Finish', value: 'brushed anodised' }]);
    assert.equal(specs[0]?.value, 'brushed anodised');
    assert.equal(specs[0]?.unit, null);
  });
});

describe('clustering', () => {
  it('treats GTIN widths as the same number', () => {
    assert.ok(
      identifiersMatch({ upc: '012345678905' }, { ean: '0012345678905' }),
      'a UPC and its zero-padded EAN are the same product',
    );
  });

  it('namespaces ASIN and MPN so they cannot collide with a GTIN', () => {
    const keys = identifierKeys({ asin: 'B01ABCDEF0', mpn: '012345678905' });
    assert.ok(keys.some((k) => k.startsWith('asin:')));
    assert.ok(keys.some((k) => k.startsWith('mpn:')));
    assert.ok(!keys.some((k) => k.startsWith('gtin:')));
  });

  it('never clusters secondhand with new', () => {
    assert.equal(mayCluster('new', 'secondhand', 'identifier'), false);
    assert.equal(mayCluster('secondhand', 'new', 'identifier'), false);
  });

  it('clusters two secondhand listings only on an exact identifier match', () => {
    assert.equal(mayCluster('secondhand', 'secondhand', 'identifier'), true);
    assert.equal(mayCluster('secondhand', 'secondhand', 'fuzzy'), false);
    assert.equal(mayCluster('secondhand', 'secondhand', 'brand_model'), false);
  });

  it('extracts a model number and rejects years and capacities', () => {
    assert.equal(extractModelNumber('Sony WH-1000XM5 Headphones', 'Sony'), 'WH-1000XM5');
    assert.equal(extractModelNumber('Vintage Jacket 1970 Wool', null), null);
    assert.equal(extractModelNumber('Portable SSD 512GB', null), null);
  });

  it('builds a stable brand+model key', () => {
    assert.equal(brandModelKey('Sony', 'WH-1000XM5'), 'sony:WH1000XM5');
    assert.equal(brandModelKey(null, 'WH-1000XM5'), null);
  });

  it('bounds fuzzy matches by price', () => {
    assert.ok(priceWithinTolerance(10000, 12000));
    assert.ok(!priceWithinTolerance(10000, 20000));
  });
});

describe('cluster aggregation', () => {
  const member = (over: Partial<Parameters<typeof aggregateCluster>[0][number]>) => ({
    productId: 'a',
    priceAmount: 10000,
    shippingAmount: 0,
    currency: 'USD',
    inStock: true,
    qualityScore: 0.5,
    riskScore: 0.1,
    sourceType: 'new' as const,
    embedding: [1, 0, 0],
    ...over,
  });

  it('picks the best offer by landed price, not by item price', () => {
    // A cheap item with expensive shipping is not the best offer.
    const aggregate = aggregateCluster([
      member({ productId: 'cheap-item', priceAmount: 9000, shippingAmount: 2500 }),
      member({ productId: 'best-landed', priceAmount: 10000, shippingAmount: 0 }),
    ]);
    assert.equal(aggregate.canonicalProductId, 'best-landed');
  });

  it('never makes an out-of-stock member canonical', () => {
    const aggregate = aggregateCluster([
      member({ productId: 'gone', priceAmount: 5000, inStock: false }),
      member({ productId: 'available', priceAmount: 12000 }),
    ]);
    assert.equal(aggregate.canonicalProductId, 'available');
  });

  it('counts only buyable alternatives in the other-offers affordance', () => {
    const members = [
      member({ productId: 'current' }),
      member({ productId: 'other', priceAmount: 9500 }),
      member({ productId: 'gone', priceAmount: 100, inStock: false }),
    ];
    const others = otherOffers(members, 'current');
    assert.equal(others?.count, 1);
    assert.equal(others?.fromAmount, 9500);
  });

  it('shows price context only when the spread is wide enough to mean something', () => {
    assert.equal(priceContext(10000, 10000), null);
    assert.equal(priceContext(10500, 10000), null);
    assert.equal(priceContext(8000, 10000), 'below');
    assert.equal(priceContext(12000, 10000), 'above');
  });
});

describe('the quality gate', () => {
  const base = {
    title: 'A perfectly reasonable product title',
    priceAmount: 4999,
    bestImageShortEdge: 1440,
    classificationConfidence: 0.9,
    sourceDomain: 'example.com',
    blockedDomains: new Set<string>(),
    clusterMedianPrice: null,
    sellerAccountAgeDays: 400,
  };

  it('passes a healthy listing', () => {
    assert.equal(applyQualityGate(base).passed, true);
  });

  it('rejects an image below the 800px eligibility floor', () => {
    assert.equal(applyQualityGate({ ...base, bestImageShortEdge: 640 }).reason, 'no_acceptable_image');
  });

  it('rejects a missing price', () => {
    assert.equal(applyQualityGate({ ...base, priceAmount: 0 }).reason, 'price_missing');
  });

  it('rejects a low-confidence classification', () => {
    assert.equal(
      applyQualityGate({ ...base, classificationConfidence: 0.3 }).reason,
      'classification_confidence',
    );
  });

  it('fires the scam heuristic only when price and seller age combine', () => {
    const cheapFromNewAccount = applyQualityGate({
      ...base,
      priceAmount: 1000,
      clusterMedianPrice: 100000,
      sellerAccountAgeDays: 3,
    });
    assert.equal(cheapFromNewAccount.reason, 'scam_heuristic');

    // Either signal alone is common and innocent.
    assert.equal(
      applyQualityGate({ ...base, priceAmount: 1000, clusterMedianPrice: 100000 }).passed,
      true,
    );
    assert.equal(applyQualityGate({ ...base, sellerAccountAgeDays: 3 }).passed, true);
  });
});

describe('review credibility', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const review = (over: Partial<ReviewSample> = {}): ReviewSample => ({
    rating: 4,
    ratingScale: 5,
    sourceDomain: 'shop.example',
    verifiedPurchase: true,
    sourceExposesVerified: true,
    postedAt: new Date(now.getTime() - 200 * 86_400_000),
    authorReviewCount: 12,
    text: 'Solid build and it arrived quickly, no complaints after a few months.',
    themes: ['build_quality'],
    sentiment: 0.9,
    ...over,
  });

  it('leaves an organic corpus at full credibility', () => {
    // Genuinely varied wording, spread over a year. Reusing one sentence with a
    // changing index would trip the template detector — correctly, which is
    // exactly why the fixture has to be real prose.
    const bodies = [
      'The stitching held up after a winter of daily use, though the zip is stiff.',
      'Arrived faster than promised and the packaging was sensible, no plastic.',
      'Does what it says. I would have liked a longer cable in the box.',
      'Three months in and the finish has worn at the corners where I grip it.',
      'Replaced an older one that died; this feels noticeably more solid.',
      'Fine for the money but the instructions were translated badly.',
    ];
    const reviews = Array.from({ length: 30 }, (_, i) =>
      review({
        rating: 3 + (i % 3),
        postedAt: new Date(now.getTime() - (i * 9 + 5) * 86_400_000),
        text: bodies[i % bodies.length] as string,
      }),
    );
    const result = reviewCredibility(reviews, { listingAgeDays: 400, otherSourceMeanRating: 4 });
    assert.equal(result.factor, QUALITY_PARAMS.credibility.max);
  });

  it('penalises a bimodal distribution posted in a burst by single-review accounts', () => {
    const reviews = Array.from({ length: 40 }, (_, i) =>
      review({
        rating: i % 8 === 0 ? 1 : 5,
        postedAt: new Date(now.getTime() - (i % 3) * 86_400_000),
        authorReviewCount: 1,
        verifiedPurchase: false,
        text: 'Great product highly recommend to everyone very good quality item.',
      }),
    );
    const result = reviewCredibility(reviews, { listingAgeDays: 500, otherSourceMeanRating: 3.2 });

    assert.ok(result.factor < 0.8, `factor was ${result.factor}`);
    assert.ok(result.factor >= QUALITY_PARAMS.credibility.min, 'never below the floor');
    const signals = result.penalties.map((p) => p.signal);
    assert.ok(signals.includes('bimodal_distribution'));
    assert.ok(signals.includes('review_burst'));
    assert.ok(signals.includes('thin_reviewers'));
    assert.ok(signals.includes('template_text'));
  });

  it('declines to diagnose a corpus too small to judge', () => {
    const result = reviewCredibility([review(), review()], {
      listingAgeDays: 10,
      otherSourceMeanRating: null,
    });
    assert.equal(result.factor, QUALITY_PARAMS.credibility.max);
  });
});

describe('themes and cautions', () => {
  it('surfaces a caution only past both the share and the mention floor', () => {
    const samples = (count: number, negativeShare: number): ReviewSample[] =>
      Array.from({ length: count }, (_, i) => ({
        rating: 3,
        ratingScale: 5,
        sourceDomain: 'a.example',
        verifiedPurchase: true,
        sourceExposesVerified: true,
        postedAt: new Date(),
        authorReviewCount: 5,
        text: 'sizing',
        themes: ['sizing'],
        sentiment: i / count < negativeShare ? 0.1 : 0.9,
      }));

    const loud = extractThemes(samples(50, 0.8));
    assert.equal(cautionsFor(loud).length, 1);

    // Same negative share, too few mentions to be a pattern.
    const quiet = extractThemes(samples(10, 0.8));
    assert.equal(cautionsFor(quiet).length, 0);
  });
});

describe('review buckets and ratings', () => {
  const review = (over: Partial<AggregatedReview>): AggregatedReview => ({
    source: { domain: 'a.example', url: 'https://a.example/r/1' },
    rating: 4,
    ratingScale: 5,
    excerpt: 'text',
    authorHandle: null,
    verifiedPurchase: null,
    helpfulCount: 0,
    postedAt: new Date(),
    bucket: 'recent',
    themes: [],
    fetchedAt: new Date(),
    ...over,
  });

  it('caps the stored set at 200 per cluster', () => {
    const many = Array.from({ length: 900 }, (_, i) =>
      review({ rating: (i % 5) + 1, helpfulCount: i, postedAt: new Date(i * 1000) }),
    );
    assert.ok(bucketReviews(many).length <= 200);
  });

  it('files each review under exactly one bucket', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      review({ rating: (i % 5) + 1, helpfulCount: i }),
    );
    const bucketed = bucketReviews(many);
    assert.equal(new Set(bucketed).size, bucketed.length);
  });

  it('weights combined ratings by review count, not by source', () => {
    // Nine reviews on one source must not cancel nine hundred on another.
    const reviews = [
      ...Array.from({ length: 900 }, () => review({ rating: 5, source: { domain: 'big.example', url: 'u' } })),
      ...Array.from({ length: 9 }, () => review({ rating: 1, source: { domain: 'small.example', url: 'u' } })),
    ];
    const combined = combineRatings(reviews);
    // Every review here carries a score, so the mean is not the nullable case;
    // saying so first is what lets the comparison below be a comparison.
    assert.notEqual(combined.meanRating, null, 'nine hundred scores must produce a mean');
    assert.ok((combined.meanRating ?? 0) > 4.9, `mean was ${combined.meanRating}`);
    assert.equal(combined.perSource.length, 2, 'the breakdown stays visible');
  });

  it('averages over the reviews that carry a score, not over all of them', () => {
    // Most Amazon reviews are text with no star. Dividing the rated total by
    // the full count dragged a 4.5-star product down to roughly 1.0.
    const reviews = [
      ...Array.from({ length: 9 }, () => review({ rating: 4.5 })),
      ...Array.from({ length: 31 }, () => review({ rating: null })),
    ];
    const combined = combineRatings(reviews);

    assert.equal(combined.count, 40, 'every review still counts toward the total');
    assert.equal(combined.ratedCount, 9);
    assert.equal(combined.meanRating, 4.5, `mean was ${combined.meanRating}`);
  });

  it('reports no mean at all when nothing carries a score', () => {
    // Zero would render as a one-star product; the absence of a score is not
    // the same as a bad one.
    const combined = combineRatings(Array.from({ length: 12 }, () => review({ rating: null })));

    assert.equal(combined.count, 12);
    assert.equal(combined.ratedCount, 0);
    assert.equal(combined.meanRating, null);
  });

  it('lets the star rating dominate sentiment over a stray negative word', () => {
    const positive = reviewSentiment(5, 5, 'Excellent, though the box was damaged in transit.');
    assert.ok(positive > 0.5, `sentiment was ${positive}`);
  });
});

describe('the risk model', () => {
  const model = new RuleEnsembleRiskModel();
  const now = new Date();

  const input = (over: Partial<RiskInput> = {}): RiskInput => ({
    product: {
      id: 'p1',
      title: 'Leica M6 rangefinder camera',
      description: 'A well-loved film camera.',
      brand: 'Leica',
      categoryL1: 'photography',
      categoryL3: 'rangefinders',
      priceAmount: 250000,
      condition: 'good',
      sourceType: 'secondhand',
      quantity: 1,
      singleUnit: true,
      sourceDomain: 'grailed.com',
      embedding: [1, 0, 0],
      imageEmbedding: null,
      heroImageHash: 'abc',
      hasExif: true,
      imageLooksStudioGrade: false,
      listedAt: now,
    },
    cluster: { medianPrice: 260000, memberCount: 5 },
    categoryPrices: { median: 260000, p10: 180000 },
    seller: {
      type: 'individual',
      accountAgeDays: 900,
      salesCount: 120,
      rating: 4.8,
      reviewCount: 90,
      recentListingCount: 3,
      recentListingValue: 500000,
      handleChangedWithinDays: null,
      upheldReports: 0,
    },
    duplicateImageSellerIds: [],
    inconsistentCrossListings: 0,
    source: { domainReputation: 0.9, proxyIndicators: false, burnerEmailIndicators: false },
    counterfeitWatchlistBrands: new Set(['Leica', 'Nike']),
    manufacturerDescription: null,
    discontinued: false,
    now,
    ...over,
  });

  it('clears an unremarkable listing', () => {
    const risk = model.score(input());
    assert.equal(risk.tier, 'clear');
    assert.equal(riskFlagText(risk), null, 'a clear listing carries no flag');
  });

  it('treats a deep discount with no condition justification as the strongest signal', () => {
    const risk = model.score(
      input({ product: { ...input().product, priceAmount: 40000, condition: 'excellent' } }),
    );
    const priceSignal = risk.signals.find((s) => s.family === 'price_anomaly');
    assert.ok(priceSignal, 'the price anomaly must fire');
    assert.ok(priceSignal.value > 0.7, `value was ${priceSignal?.value}`);
    assert.ok(['caution', 'high', 'blocked'].includes(risk.tier), `tier was ${risk.tier}`);
  });

  it('discounts the same price gap when the condition explains it', () => {
    const harsh = model.score(
      input({ product: { ...input().product, priceAmount: 40000, condition: 'excellent' } }),
    );
    const justified = model.score(
      input({ product: { ...input().product, priceAmount: 40000, condition: 'for_parts' } }),
    );
    assert.ok(justified.score < harsh.score, `${justified.score} should be under ${harsh.score}`);
  });

  it('catches payment steering and off-platform contact', () => {
    const risk = model.score(
      input({
        product: {
          ...input().product,
          description: 'Payment by wire transfer only. WhatsApp me to arrange.',
        },
      }),
    );
    const text = risk.signals.find((s) => s.family === 'text_signals');
    assert.ok(text);
    assert.ok(text.value > 0.9);
  });

  it('catches a hero image already used by another seller', () => {
    const risk = model.score(input({ duplicateImageSellerIds: ['other-seller'] }));
    assert.ok(risk.signals.some((s) => s.family === 'media_forensics'));
  });

  it('catches multiple units offered of a one-of-one item', () => {
    const risk = model.score(input({ product: { ...input().product, quantity: 4 } }));
    assert.ok(risk.signals.some((s) => s.family === 'listing_coherence'));
  });

  it('forces a high score when reports against the seller were upheld', () => {
    const risk = model.score(
      input({ seller: { ...input().seller, upheldReports: 2 } }),
    );
    assert.ok(risk.score >= 0.7);
  });

  it('writes a specific, actionable warning rather than a vague one', () => {
    const risk = model.score(
      input({ product: { ...input().product, priceAmount: 40000, condition: 'excellent' } }),
    );
    const flag = riskFlagText(risk);
    assert.ok(flag);
    assert.ok(/\d+% below/.test(flag), `flag was "${flag}"`);
    assert.ok(!/may be risky/i.test(flag));
  });

  it('keeps the output contract stable so a trained model can swap in', () => {
    const risk = model.score(input());
    assert.equal(risk.modelVersion, 'risk-v1');
    assert.ok(typeof risk.score === 'number' && risk.score >= 0 && risk.score <= 1);
    assert.ok(Array.isArray(risk.signals));
    assert.deepEqual(risk.reports, { count: 0, upheld: 0 });
  });
});

describe('quad coherence', () => {
  const config = DEFAULT_RANKING_CONFIG;

  it('bands prices so the extremes stay within 2.5x of each other', () => {
    const band = priceBandFor(10000, config);
    assert.ok(band.max / band.min <= config.quads.priceBandMultiplier + 0.001);
  });

  const tile = (id: string, l2: string, price: number) =>
    ({
      id,
      category: { l1: 'tech', l2, l3: 'x' },
      price: { amount: price, currency: 'USD' },
    }) as never;

  it('refuses to fill a pane with an out-of-band tile', () => {
    const seed = {
      candidate: tile('seed', 'keyboards', 10000),
      l2: 'keyboards',
      band: priceBandFor(10000, config),
      l3Scope: [],
    };
    const quad = assembleQuad(
      seed,
      [tile('a', 'keyboards', 11000), tile('b', 'keyboards', 90000), tile('c', 'keyboards', 9000)],
      config,
      new Set(['seed']),
    );
    // Only three tiles are in band, so the pane cannot be made coherent and is
    // dropped rather than padded.
    assert.equal(quad, null);
  });

  it('builds a coherent pane and orders it cheapest first', () => {
    const seed = {
      candidate: tile('seed', 'keyboards', 10000),
      l2: 'keyboards',
      band: priceBandFor(10000, config),
      l3Scope: [],
    };
    const quad = assembleQuad(
      seed,
      [tile('a', 'keyboards', 11000), tile('b', 'keyboards', 8000), tile('c', 'keyboards', 12000)],
      config,
      new Set(['seed']),
    );
    assert.ok(quad);
    assert.equal(quad.length, 4);
    const prices = quad.map((t) => t.price.amount);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    assert.ok(Math.max(...prices) / Math.min(...prices) <= 2.5);
  });

  it('never mixes L2 categories into one pane', () => {
    const seed = {
      candidate: tile('seed', 'keyboards', 10000),
      l2: 'keyboards',
      band: priceBandFor(10000, config),
      l3Scope: [],
    };
    const quad = assembleQuad(
      seed,
      [
        tile('a', 'keyboards', 11000),
        tile('wrong', 'monitors', 10500),
        tile('b', 'keyboards', 9000),
        tile('c', 'keyboards', 12000),
      ],
      config,
      new Set(['seed']),
    );
    assert.ok(quad);
    assert.ok(quad.every((t) => t.category.l2 === 'keyboards'));
  });
});

describe('the authorization contract', () => {
  const base = {
    jobId: 'job_1',
    subtotal: 10000,
    shipping: 500,
    tax: 875,
    discount: 1000,
    total: 10375,
    currency: 'USD',
    productIds: ['p1', 'p2'],
  };

  it('is stable across equivalent quotes', () => {
    assert.equal(hashQuote(base), hashQuote({ ...base, productIds: ['p2', 'p1'] }));
  });

  it('changes when any number on the screen changes', () => {
    const original = hashQuote(base);
    for (const field of ['subtotal', 'shipping', 'tax', 'discount', 'total'] as const) {
      assert.notEqual(
        hashQuote({ ...base, [field]: base[field] + 1 }),
        original,
        `${field} must be covered by the hash`,
      );
    }
    assert.notEqual(hashQuote({ ...base, currency: 'EUR' }), original);
    assert.notEqual(hashQuote({ ...base, productIds: ['p1'] }), original);
    assert.notEqual(hashQuote({ ...base, jobId: 'job_2' }), original);
  });
});

describe('coupon outcomes', () => {
  it('takes the best applied code', () => {
    const outcome = bestCouponOutcome(
      [
        { code: 'A', applied: true, observedDiscount: 500, reason: null },
        { code: 'B', applied: true, observedDiscount: 1200, reason: null },
        { code: 'C', applied: false, observedDiscount: 0, reason: 'invalid' },
      ],
      0,
    );
    assert.equal(outcome.code, 'B');
    assert.equal(outcome.discount, 1200);
    assert.equal(outcome.attempts, 3);
  });

  it('applies nothing when the merchant beats every code on its own', () => {
    // Claiming credit for a discount the user would have received anyway is a
    // consumer-protection problem, not a copy choice.
    const outcome = bestCouponOutcome(
      [{ code: 'A', applied: true, observedDiscount: 500, reason: null }],
      900,
    );
    assert.equal(outcome.code, null);
    assert.equal(outcome.discount, 900);
    assert.equal(outcome.automatic, true);
  });

  it('reports no discount when nothing applied', () => {
    const outcome = bestCouponOutcome(
      [{ code: 'A', applied: false, observedDiscount: 0, reason: 'expired' }],
      0,
    );
    assert.equal(outcome.code, null);
    assert.equal(outcome.discount, 0);
    assert.equal(outcome.automatic, false);
  });
});

describe('tier-1 API adapter routing', () => {
  const sourceFor = (domain: string) => {
    const source = SOURCE_REGISTRY.find((candidate) => candidate.id === domain);
    assert.ok(source !== undefined, `${domain} must be in the registry`);
    return source;
  };
  const ebay = sourceFor('ebay.com');
  const amazon = sourceFor('amazon.com');
  // Best Buy is a genuine JSON feed and must keep taking the generic path.
  const bestbuy = sourceFor('bestbuy.com');

  const CREDENTIALS: Record<string, string> = {
    [EBAY_ENV_VARS.clientId]: 'client-id',
    [EBAY_ENV_VARS.clientSecret]: 'client-secret',
    [AMAZON_ENV_VARS.accessKey]: 'access-key',
    [AMAZON_ENV_VARS.secretKey]: 'secret-key',
    [AMAZON_ENV_VARS.partnerTag]: 'partner-20',
    BESTBUY_API_KEY: 'bestbuy-key',
  };
  const configured = (name: string): string | undefined => CREDENTIALS[name];
  const unconfigured = (): undefined => undefined;

  it('builds the dedicated API client rather than the generic feed adapter', () => {
    assert.ok(createAdapter(ebay, { secret: configured }) instanceof EbayBrowseAdapter);
    assert.ok(createAdapter(amazon, { secret: configured }) instanceof AmazonPaapiAdapter);
  });

  it('serves tier 1 only when every credential the adapter needs is present', () => {
    assert.equal(canServe(ebay, 1, { secret: configured }), true);
    assert.equal(canServe(amazon, 1, { secret: configured }), true);
    assert.equal(canServe(ebay, 1, { secret: unconfigured }), false);
    assert.equal(canServe(amazon, 1, { secret: unconfigured }), false);

    // A partial credential set is the dangerous case: it looks configured on a
    // dashboard and fails on the first request.
    for (const missing of [AMAZON_ENV_VARS.accessKey, AMAZON_ENV_VARS.secretKey, AMAZON_ENV_VARS.partnerTag]) {
      const partial = (name: string): string | undefined => (name === missing ? undefined : CREDENTIALS[name]);
      assert.equal(canServe(amazon, 1, { secret: partial }), false, `${missing} must be required`);
    }
    // Blank is absent; an empty env var is how a credential usually goes missing.
    const blank = (name: string): string => (name === EBAY_ENV_VARS.clientSecret ? '  ' : CREDENTIALS[name] ?? '');
    assert.equal(canServe(ebay, 1, { secret: blank }), false);
  });

  it('never falls back to scraping a source that is API-only', () => {
    // Both robots.txt files disallow the listing paths, so a tier-2 or tier-3
    // fallback would not be a cheaper route to the same rows.
    for (const source of [ebay, amazon]) {
      assert.deepEqual(fallbackChain(source, { secret: configured }), [1]);
      assert.deepEqual(fallbackChain(source, { secret: unconfigured }), []);
    }
    assert.throws(
      () => adapterWithFallback(ebay, { secret: unconfigured }),
      (error: unknown) =>
        error instanceof SourceUnavailableError
        && error.reason === 'not_configured'
        && error.message.includes('ebay.com'),
    );
  });

  it('names the missing keys when constructed directly without credentials', () => {
    assert.throws(
      () => createAdapter(amazon, { secret: unconfigured }),
      (error: unknown) =>
        error instanceof SourceUnavailableError
        && error.reason === 'not_configured'
        && error.message.includes(AMAZON_ENV_VARS.partnerTag),
    );
  });

  it('leaves feed-configured tier-1 sources on the generic adapter', () => {
    assert.ok(!(createAdapter(bestbuy, { secret: configured }) instanceof EbayBrowseAdapter));
    assert.equal(canServe(bestbuy, 1, { secret: unconfigured }), true);
    assert.deepEqual(fallbackChain(bestbuy, { secret: configured }), [1, 2]);
  });

  it('registers only credentials the adapters actually read', () => {
    // The previous entries named EBAY_OAUTH_TOKEN and AMAZON_PAAPI_TOKEN, which
    // nothing read and which could not have authenticated either API. A config
    // naming a key no code consumes is worse than no config at all.
    const registered = SOURCE_REGISTRY.map((source) => source.extractors.listing).join('\n');
    assert.ok(!registered.includes('EBAY_OAUTH_TOKEN'));
    assert.ok(!registered.includes('AMAZON_PAAPI_TOKEN'));

    for (const [source, required] of [
      [ebay, [EBAY_ENV_VARS.clientId, EBAY_ENV_VARS.clientSecret]],
      [amazon, [AMAZON_ENV_VARS.accessKey, AMAZON_ENV_VARS.secretKey, AMAZON_ENV_VARS.partnerTag]],
    ] as const) {
      const config = JSON.parse(source.extractors.listing) as { strategy: string; requires: string[] };
      assert.equal(config.strategy, 'api-adapter');
      assert.deepEqual(config.requires, [...required]);
    }
  });
});
