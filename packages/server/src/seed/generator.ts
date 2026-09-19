import {
  CONDITION_SCALE,
  L2_TOPICS,
  childrenOf,
  clamp,
  getCategory,
  mulberry32,
  hashString,
  weightedPick,
  type Condition,
  type SourceType,
} from '@window/shared';
import type { RawListing, RawReview, RawSeller } from '../ingestion/types.js';
import {
  COLORS,
  MODEL_CODENAMES,
  brandTier,
  brandsFor,
  profileFor,
  snippetsFor,
  type L2Profile,
} from './corpus.js';

/**
 * The synthetic catalog generator.
 *
 * Produces `RawListing`s — the same shape a source adapter emits — so the
 * seeder runs the *real* ingestion pipeline over them: normalization, the
 * quality gate, classification, embedding, clustering, quality and risk. A
 * seeder that wrote finished product documents straight into the database would
 * leave every one of those stages untested, which is the opposite of useful.
 *
 * Everything is a deterministic function of a seed, so the same seed always
 * produces the same catalog and a ranking regression can be reproduced exactly.
 */

export interface GeneratorOptions {
  seed: string;
  /** Approximate number of listings to emit. */
  count: number;
  /**
   * Deep in a few topics rather than broad and shallow. A thin catalog is
   * obvious within 20 cards and kills the retention gate, so the default
   * concentrates supply the way Phase 1 is meant to.
   */
  deepTopics?: string[];
  deepShare?: number;
  /** Share of listings that are a second offer on an existing cluster. */
  duplicateShare?: number;
  /** Share of listings that carry deliberate scam signals. */
  scamShare?: number;
  now?: Date;
}

const DEFAULT_DEEP_TOPICS = ['tech', 'sneakers', 'home', 'audio'];

interface SellerPool {
  retailers: RawSeller[];
  individuals: RawSeller[];
  auctionHouses: RawSeller[];
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/** Log-uniform, so a [19, 3999] band is not 95% expensive items. */
function priceIn(range: readonly [number, number], random: () => number): number {
  const [min, max] = range;
  const value = Math.exp(randomBetween(random, Math.log(min), Math.log(max)));
  // Round to a plausible retail ending rather than to the cent.
  const rounded = Math.round(value / 100) * 100;
  return Math.max(min, rounded + (random() < 0.7 ? 99 : 0));
}

function modelNumber(pattern: string, random: () => number): string {
  return pattern
    .replace(/\{N\}/g, () => String(Math.floor(randomBetween(random, 10, 9999))))
    .replace(/\{A\}/g, () =>
      Array.from({ length: Math.floor(randomBetween(random, 1, 4)) }, () =>
        String.fromCharCode(65 + Math.floor(random() * 26)),
      ).join(''),
    )
    .replace(/\{word\}/g, () => pick(MODEL_CODENAMES, random));
}

function buildTitle(
  profile: L2Profile,
  parts: { brand: string; model: string; l3: string; spec: string; color: string },
  random: () => number,
): string {
  const pattern = pick(profile.titlePatterns, random);
  return pattern
    .replace('{brand}', parts.brand)
    .replace('{model}', parts.model)
    .replace('{l3}', parts.l3)
    .replace('{spec}', parts.spec)
    .replace('{color}', parts.color)
    .replace(/\s+/g, ' ')
    .trim();
}

function conditionFor(profile: L2Profile, sourceType: SourceType, random: () => number): Condition {
  if (sourceType === 'new') return 'new';
  const entries = CONDITION_SCALE.filter((c) => c !== 'new').map((condition) => ({
    item: condition,
    weight: profile.conditionMix[condition] ?? 0,
  }));
  return weightedPick(entries, random) ?? 'good';
}

function makeSellers(random: () => number, now: Date): SellerPool {
  const retailerNames = [
    ['bestbuy.com', 'Best Buy'],
    ['target.com', 'Target'],
    ['walmart.com', 'Walmart'],
    ['newegg.com', 'Newegg'],
    ['rei.com', 'REI'],
    ['bhphotovideo.com', 'B&H Photo'],
    ['zappos.com', 'Zappos'],
    ['sephora.com', 'Sephora'],
    ['shopify-store.com', 'Independent Shopify storefronts'],
  ] as const;

  const handleWords = [
    'attic', 'archive', 'relay', 'foundry', 'harbor', 'lantern', 'meridian', 'oxide',
    'pine', 'quarry', 'ridge', 'sable', 'tundra', 'umber', 'vault', 'wren', 'zephyr',
    'copper', 'drift', 'ember', 'fathom', 'grove', 'hollow', 'indigo',
  ];

  const retailers: RawSeller[] = retailerNames.map(([domain, name]) => ({
    sourceSellerId: domain,
    handle: domain,
    displayName: name,
    type: 'retailer',
    avatarUrl: null,
    profileUrl: `https://${domain}`,
    rating: Math.round(randomBetween(random, 4.1, 4.8) * 10) / 10,
    ratingScale: 5,
    reviewCount: Math.floor(randomBetween(random, 2000, 90000)),
    salesCount: Math.floor(randomBetween(random, 50000, 900000)),
    memberSince: new Date(now.getTime() - randomBetween(random, 2000, 7000) * 86_400_000),
    responseTime: 'under 1 day',
    returnWindowDays: pick([14, 30, 60, 90], random),
    shippingSummary: 'Free standard shipping over $35',
    buyerPremiumPct: null,
    listingCount: Math.floor(randomBetween(random, 5000, 60000)),
  }));

  const individuals: RawSeller[] = Array.from({ length: 220 }, (_, index) => {
    const handle = `${pick(handleWords, random)}_${pick(handleWords, random)}${Math.floor(random() * 90 + 10)}`;
    // A minority of sellers are genuinely new accounts, which is what gives the
    // risk model something real to find rather than a uniformly safe catalog.
    const ageDays = random() < 0.12 ? randomBetween(random, 1, 29) : randomBetween(random, 60, 2600);
    const sales = ageDays < 30 ? Math.floor(random() * 4) : Math.floor(randomBetween(random, 5, 900));
    return {
      sourceSellerId: `u${index}`,
      handle,
      displayName: handle,
      type: 'individual',
      avatarUrl: null,
      profileUrl: `https://grailed.com/${handle}`,
      rating: sales === 0 ? null : Math.round(randomBetween(random, 3.8, 5) * 10) / 10,
      ratingScale: 5,
      reviewCount: Math.floor(sales * randomBetween(random, 0.4, 0.9)),
      salesCount: sales,
      memberSince: new Date(now.getTime() - ageDays * 86_400_000),
      responseTime: pick(['under 1 hour', 'under 1 day', 'a few days'], random),
      returnWindowDays: null,
      shippingSummary: null,
      buyerPremiumPct: null,
      listingCount: Math.floor(randomBetween(random, 1, 40)),
    };
  });

  const auctionHouses: RawSeller[] = [
    ['heritage.com', 'Heritage Auctions', 20],
    ['catawiki.com', 'Catawiki', 12.5],
    ['ebay.com', 'eBay Auctions', 0],
  ].map(([domain, name, premium]) => ({
    sourceSellerId: domain as string,
    handle: domain as string,
    displayName: name as string,
    type: 'auction_house',
    avatarUrl: null,
    profileUrl: `https://${domain}`,
    rating: 4.6,
    ratingScale: 5,
    reviewCount: 12000,
    salesCount: 400000,
    memberSince: new Date(now.getTime() - 6000 * 86_400_000),
    responseTime: null,
    returnWindowDays: null,
    shippingSummary: null,
    buyerPremiumPct: premium as number,
    listingCount: 9000,
  }));

  return { retailers, individuals, auctionHouses };
}

/** Source domains per source type, with the tier each is reached through. */
const DOMAINS: Record<SourceType, Array<{ domain: string; tier: 1 | 2 | 3 }>> = {
  new: [
    { domain: 'bestbuy.com', tier: 1 },
    { domain: 'target.com', tier: 2 },
    { domain: 'walmart.com', tier: 1 },
    { domain: 'newegg.com', tier: 2 },
    { domain: 'rei.com', tier: 2 },
    { domain: 'bhphotovideo.com', tier: 2 },
    { domain: 'zappos.com', tier: 2 },
    { domain: 'sephora.com', tier: 2 },
    { domain: 'shopify-store.com', tier: 2 },
  ],
  secondhand: [
    { domain: 'ebay.com', tier: 1 },
    { domain: 'grailed.com', tier: 3 },
    { domain: 'mercari.com', tier: 3 },
    { domain: 'poshmark.com', tier: 3 },
    { domain: 'depop.com', tier: 3 },
  ],
  auction: [
    { domain: 'ebay.com', tier: 1 },
    { domain: 'heritage.com', tier: 2 },
    { domain: 'catawiki.com', tier: 2 },
  ],
};

function makeReviews(
  profile: L2Profile,
  count: number,
  random: () => number,
  now: Date,
  sourceDomain: string,
  bias: { manipulated: boolean },
): RawReview[] {
  const reviews: RawReview[] = [];
  const themes = profile.themes;

  // One theme per product is the sore point, which is what produces the
  // negative-share cautions the card surfaces.
  const soreTheme = random() < 0.35 ? pick(themes, random) : null;

  for (let i = 0; i < count; i++) {
    const onSoreTheme = soreTheme !== null && random() < 0.45;
    const theme = onSoreTheme ? soreTheme : pick(themes, random);
    const negative = onSoreTheme ? random() < 0.75 : random() < 0.18;

    const base = profile.reviewProfile.meanRating;
    const spread = profile.reviewProfile.ratingSpread;
    let rating = negative
      ? clamp(Math.round(randomBetween(random, 1, 3)), 1, 5)
      : clamp(Math.round(base + randomBetween(random, -spread, spread)), 1, 5);

    // A manipulated corpus is bimodal at 5 and 1 with a hollow middle, posted
    // in a burst, by accounts with one review each. The credibility factor is
    // meant to catch exactly this shape.
    if (bias.manipulated) rating = random() < 0.85 ? 5 : 1;

    const polarity = rating >= 4 ? 'positive' : 'negative';
    const snippets = snippetsFor(theme, polarity);
    const text = snippets.length > 0 ? pick(snippets, random) : 'No comment provided.';

    const ageDays = bias.manipulated
      ? randomBetween(random, 0, 3)
      : randomBetween(random, 1, 900);

    reviews.push({
      rating,
      ratingScale: 5,
      text,
      authorHandle: `reviewer_${Math.floor(random() * 100000)}`,
      verifiedPurchase: bias.manipulated ? random() < 0.2 : random() < 0.82,
      helpfulCount: Math.floor(random() ** 3 * 240),
      postedAt: new Date(now.getTime() - ageDays * 86_400_000),
      sourceUrl: `https://${sourceDomain}/review/${Math.floor(random() * 1e9)}`,
    });
  }

  return reviews;
}

export interface GeneratedCatalog {
  listings: RawListing[];
  brands: string[];
  counterfeitWatchlist: string[];
}

export function generateCatalog(options: GeneratorOptions): GeneratedCatalog {
  const now = options.now ?? new Date();
  const random = mulberry32(hashString(options.seed));
  const deepTopics = options.deepTopics ?? DEFAULT_DEEP_TOPICS;
  const deepShare = options.deepShare ?? 0.55;
  const duplicateShare = options.duplicateShare ?? 0.22;
  const scamShare = options.scamShare ?? 0.03;

  const sellers = makeSellers(random, now);
  const allBrands = new Set<string>();

  // Brands that are frequently counterfeited get the watchlist treatment.
  const watchlist = new Set<string>();
  for (const topic of ['sneakers', 'watches', 'fashion-men', 'fashion-women', 'tech']) {
    for (const brand of brandsFor(topic).slice(0, 6)) watchlist.add(brand);
  }

  const deepL2 = L2_TOPICS.filter((node) => deepTopics.includes(node.l1)).map((n) => n.id);
  const shallowL2 = L2_TOPICS.filter((node) => !deepTopics.includes(node.l1)).map((n) => n.id);

  const listings: RawListing[] = [];
  /** Clusters already emitted, so duplicates can be second offers on them. */
  const emitted: Array<{
    l2: string;
    brand: string;
    model: string;
    l3: string;
    price: number;
    gtin: string | null;
    sourceType: SourceType;
  }> = [];

  let sequence = 0;

  while (listings.length < options.count) {
    const l2Id =
      random() < deepShare && deepL2.length > 0 ? pick(deepL2, random) : pick(shallowL2, random);
    const l2 = getCategory(l2Id);
    if (!l2) continue;
    const profile = profileFor(l2Id);

    const l3Nodes = childrenOf(l2Id);
    if (l3Nodes.length === 0) continue;
    const l3 = pick(l3Nodes, random);

    const brandPool = brandsFor(l2.l1);
    const sourceType =
      weightedPick(
        (['new', 'secondhand', 'auction'] as SourceType[]).map((item) => ({
          item,
          weight: profile.sourceTypeMix[item],
        })),
        random,
      ) ?? 'new';

    // A duplicate is a second offer on something already emitted: same brand,
    // same model, same identifier, different merchant. This is what gives the
    // clustering stage real work to do.
    //
    // Secondhand listings participate too, because they genuinely do carry
    // product identifiers on the marketplaces they come from. Without them the
    // catalog has no two used listings of the same item, and the whole
    // same-product price comparison — the strongest input the risk model has —
    // never has anything to compare against.
    const reuse =
      random() < duplicateShare && emitted.length > 20 && sourceType !== 'auction'
        ? emitted.filter((e) => e.l2 === l2Id && e.sourceType === sourceType && e.gtin !== null).slice(-40)
        : [];
    const template = reuse.length > 0 ? pick(reuse, random) : null;

    const brand = template?.brand ?? pick(brandPool, random);
    allBrands.add(brand);
    const model = template?.model ?? modelNumber(pick(profile.modelPatterns, random), random);
    const l3Name = template ? (getCategory(template.l3)?.displayName ?? l3.displayName) : l3.displayName;

    const tier = brandTier(brand);
    const tierMultiplier = tier === 'premium' ? 1.55 : tier === 'budget' ? 0.62 : 1;
    const specKey = pick(profile.specKeys, random);
    const specValue = pick(specKey.values, random);
    const color = pick(COLORS, random);

    const title = buildTitle(
      profile,
      { brand, model, l3: l3Name, spec: String(specValue), color },
      random,
    );

    let price = template
      ? Math.round(template.price * randomBetween(random, 0.88, 1.18))
      : Math.round(priceIn(profile.priceRange, random) * tierMultiplier);

    // Secondhand trades below retail; condition drives how far below.
    const condition = conditionFor(profile, sourceType, random);
    if (sourceType !== 'new') {
      const discount = {
        new: 1,
        like_new: 0.85,
        excellent: 0.72,
        good: 0.6,
        fair: 0.45,
        poor: 0.3,
        for_parts: 0.15,
        unknown: 0.55,
      }[condition];
      price = Math.round(price * discount);
    }

    const isScam = random() < scamShare && sourceType !== 'new';
    if (isScam) price = Math.round(price * randomBetween(random, 0.08, 0.2));

    // Separately: listings that are simply priced far under what the same item
    // goes for, with nothing else wrong. These are what the caution tier is
    // for — ranked down and flagged, but not withheld, because suppressing
    // honest sellers outright is what destroys secondhand supply.
    const isUnderpriced = !isScam && template !== null && sourceType !== 'new' && random() < 0.06;
    if (isUnderpriced) price = Math.round(template.price * randomBetween(random, 0.12, 0.22));

    const domainEntry = pick(DOMAINS[sourceType], random);
    const seller =
      sourceType === 'auction'
        ? pick(sellers.auctionHouses, random)
        : sourceType === 'secondhand'
          ? isScam
            ? // Scam listings come from the newest accounts, which is what makes
              // the price-plus-seller-age heuristic fire rather than price alone.
              (sellers.individuals.filter((s) => s.salesCount < 5)[
                Math.floor(random() * Math.max(1, sellers.individuals.filter((s) => s.salesCount < 5).length))
              ] ?? pick(sellers.individuals, random))
            : pick(sellers.individuals, random)
          : (sellers.retailers.find((r) => r.sourceSellerId === domainEntry.domain) ??
            pick(sellers.retailers, random));

    // Most secondhand listings expose an identifier; a minority genuinely do
    // not, and those are the ones that can only ever be clustered by hand.
    const carriesIdentifier = sourceType === 'new' || random() < 0.55;
    const gtin =
      carriesIdentifier && sourceType !== 'auction'
        ? (template?.gtin ??
          String(Math.floor(randomBetween(random, 1e12, 9.9e12))).padStart(13, '0'))
        : null;

    // Bucketing caps a cluster at 200 stored reviews, so generating far beyond
    // that is work whose only effect is a slower seed.
    const reviewCount =
      sourceType === 'new'
        ? Math.min(
            90,
            Math.floor(profile.reviewProfile.typicalCount * randomBetween(random, 0.2, 1.8)),
          )
        : Math.floor(random() * 6);

    // Media dimensions straddle the 800px eligibility floor so the quality gate
    // genuinely rejects some listings rather than passing everything.
    const heroEdge = random() < 0.04 ? Math.floor(randomBetween(random, 300, 780)) : 1440;
    const galleryCount = Math.floor(randomBetween(random, 1, 7));

    const specs = profile.specKeys.slice(0, 4).map((key) => ({
      key: key.key,
      value: `${pick(key.values, random)}${key.unit ? ` ${key.unit}` : ''}`,
    }));
    specs.push({ key: 'color', value: color });

    const sourceId = `${l2Id}-${sequence}`;
    sequence += 1;

    const listing: RawListing = {
      sourceDomain: domainEntry.domain,
      sourceId,
      url: `https://${domainEntry.domain}/item/${sourceId}`,
      tier: domainEntry.tier,
      sourceType,
      title: isScam
        ? `${title} — LOWEST PRICE, must see! Payment by wire transfer only`
        : title,
      description: `${brand} ${model}. ${l3Name}. ${specs
        .map((s) => `${s.key.replace(/_/g, ' ')}: ${s.value}`)
        .join('. ')}.`,
      brand,
      identifiers: {
        gtin,
        upc: null,
        ean: null,
        asin: null,
        mpn: model,
        isbn: null,
      },
      priceText: null,
      priceAmountMinor: price,
      currency: 'USD',
      originalPriceText: null,
      originalPriceAmountMinor:
        sourceType === 'new' && random() < 0.28 ? Math.round(price * randomBetween(random, 1.15, 1.6)) : null,
      shippingText: null,
      shippingAmountMinor: random() < 0.55 ? 0 : Math.floor(randomBetween(random, 399, 1499)),
      conditionText: condition.replace(/_/g, ' '),
      availabilityText: random() < 0.06 ? 'Out of stock' : 'In stock',
      quantity: sourceType === 'new' ? Math.floor(randomBetween(random, 1, 60)) : 1,
      auction:
        sourceType === 'auction'
          ? {
              endsAt: new Date(now.getTime() + randomBetween(random, 0.5, 168) * 3_600_000),
              currentBidMinor: Math.round(price * randomBetween(random, 0.3, 0.9)),
              bidCount: Math.floor(random() * 40),
            }
          : null,
      specs,
      images: Array.from({ length: galleryCount }, (_, i) => ({
        url: `window://generated/${domainEntry.domain}/${sourceId}/${i}`,
        width: i === 0 ? heroEdge : 1440,
        height: i === 0 ? heroEdge : 1440,
      })),
      video: null,
      seller,
      breadcrumb: [getCategory(l2.l1)?.displayName ?? l2.l1, l2.displayName, l3Name],
      reviews: makeReviews(profile, reviewCount, random, now, domainEntry.domain, {
        manipulated: random() < 0.04,
      }),
      fetchedAt: new Date(now.getTime() - randomBetween(random, 0, 20) * 3_600_000),
      extractionCompleteness: clamp(randomBetween(random, 0.75, 1), 0, 1),
    };

    listings.push(listing);
    if (!template && gtin) {
      emitted.push({ l2: l2Id, brand, model, l3: l3.id, price, gtin, sourceType });
    }
  }

  return {
    listings,
    brands: [...allBrands].sort(),
    counterfeitWatchlist: [...watchlist].sort(),
  };
}
