import {
  CLUSTERING,
  QUALITY_GATE,
  TIER_STALENESS_CEILING_HOURS,
  daysBetween,
  median,
  type ClusterDoc,
  type MediaImage,
  type ProductDoc,
  type SourceType,
} from '@window/shared';
import { randomUUID } from 'node:crypto';
import type { CollectionSet, Cluster, Product, Seller } from '../db/supabase-collections.js';
import { deleteMany, find, findOne, insert, insertMany, updateOne } from '../db/supabase-helpers.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { MediaPipeline } from '../media/pipeline.js';
import { logger } from '../lib/logger.js';
import { CategoryClassifier } from './classify.js';
import {
  aggregateCluster,
  brandModelKey,
  extractModelNumber,
  fuzzyMatch,
  identifierKeys,
  mayCluster,
  type ClusterMember,
  type FuzzyCandidate,
  type MatchStrength,
} from './dedupe.js';
import { applyQualityGate, type RejectReason } from './gate.js';
import {
  normalizeCondition,
  normalizeSpecs,
  normalizeStock,
  normalizeTitle,
  parsePrice,
  resolveBrand,
} from './normalize.js';
import { computeQuality, type ListingCompletenessInput } from './quality.js';
import {
  ExtractiveReviewSummarizer,
  bucketReviews,
  combineRatings,
  shouldRegenerateSummary,
  toAggregated,
  toQualitySamples,
  type ReviewSummarizer,
} from './reviews.js';
import { extractThemes } from './quality.js';
import { RuleEnsembleRiskModel, type RiskInput, type RiskModel } from './risk.js';
import type { RawListing } from './types.js';

const log = logger.child('ingest');

export interface IngestionDeps {
  collections: CollectionSet;
  embedder: EmbeddingProvider;
  classifier: CategoryClassifier;
  media: MediaPipeline;
  riskModel?: RiskModel;
  summarizer?: ReviewSummarizer;
  /** The brand dictionary; brands are matched against it, never guessed. */
  brandDictionary: readonly string[];
  blockedDomains?: ReadonlySet<string>;
  counterfeitWatchlistBrands?: ReadonlySet<string>;
  /** Category-level priors, refreshed by the nightly job. */
  categoryPriors?: ReadonlyMap<string, { meanRating: number; meanCtr: number; meanCartRate: number }>;
  /** Called after each upsert so an in-process vector index stays current. */
  onProductUpserted?: (product: Product) => void;
}

export interface IngestResult {
  status: 'ingested' | 'rejected' | 'unchanged';
  productId: string | null;
  clusterId: string | null;
  rejectReason: RejectReason | null;
  matchStrength: MatchStrength;
}

const DEFAULT_PRIORS = { meanRating: 4.1, meanCtr: 0.04, meanCartRate: 0.012 };

/**
 * The ingestion pipeline.
 *
 * Normalize, gate, embed, classify, cluster, score, store. Every stage is a
 * pure function over the previous one except the three that must touch the
 * database — seller resolution, cluster matching and the upsert — which is what
 * makes the whole thing testable a stage at a time.
 */
export class IngestionPipeline {
  private readonly riskModel: RiskModel;
  private readonly summarizer: ReviewSummarizer;

  constructor(private readonly deps: IngestionDeps) {
    this.riskModel = deps.riskModel ?? new RuleEnsembleRiskModel();
    this.summarizer = deps.summarizer ?? new ExtractiveReviewSummarizer();
  }

  async ingest(raw: RawListing, now = new Date()): Promise<IngestResult> {
    const { collections } = this.deps;

    // ---- Seller -----------------------------------------------------------
    const seller = await this.upsertSeller(raw, now);

    // ---- Normalize --------------------------------------------------------
    const brand = resolveBrand(raw.brand, raw.title, this.deps.brandDictionary);
    const title = normalizeTitle(raw.title, brand);

    const price =
      raw.priceAmountMinor !== null
        ? { amount: raw.priceAmountMinor, currency: raw.currency ?? 'USD' }
        : parsePrice(raw.priceText, raw.currency ?? 'USD');
    const originalPrice =
      raw.originalPriceAmountMinor !== null
        ? { amount: raw.originalPriceAmountMinor, currency: raw.currency ?? 'USD' }
        : parsePrice(raw.originalPriceText, raw.currency ?? 'USD');
    const shippingMoney =
      raw.shippingAmountMinor !== null
        ? { amount: raw.shippingAmountMinor, currency: raw.currency ?? 'USD' }
        : parsePrice(raw.shippingText, raw.currency ?? 'USD');

    const condition = normalizeCondition(raw.conditionText, raw.sourceType);
    const stock = normalizeStock(raw, raw.sourceType !== 'new');
    const specs = normalizeSpecs(raw.specs);

    // ---- Media ------------------------------------------------------------
    const { hero, gallery, bestShortEdge } = await this.ingestMedia(raw);

    // ---- Classification ---------------------------------------------------
    const classification = await this.deps.classifier.classify({
      title,
      brand,
      specs,
      breadcrumb: raw.breadcrumb,
    });

    // ---- Embedding --------------------------------------------------------
    const embedding = await this.deps.embedder.embed({
      title,
      brand,
      category: classification,
      specs,
      priceAmount: price?.amount,
      imageDescriptor: hero ? hero.blurhash : undefined,
    });

    // ---- Cluster matching -------------------------------------------------
    const match = await this.matchCluster({
      identifiers: raw.identifiers,
      brand,
      title,
      categoryL3: classification.l3,
      sourceType: raw.sourceType,
      priceAmount: price?.amount ?? 0,
      embedding,
    });
    const clusterMedianPrice = match.cluster?.priceRange.median ?? null;

    // ---- Quality gate -----------------------------------------------------
    const sellerAgeDays = seller.metrics.memberSince
      ? daysBetween(seller.metrics.memberSince, now)
      : null;

    const gate = applyQualityGate({
      title,
      priceAmount: price?.amount ?? null,
      bestImageShortEdge: bestShortEdge,
      classificationConfidence: classification.confidence,
      sourceDomain: raw.sourceDomain,
      blockedDomains: this.deps.blockedDomains ?? new Set(),
      clusterMedianPrice,
      sellerAccountAgeDays: sellerAgeDays,
    });

    if (!gate.passed) {
      await this.recordRejection(raw, gate.reason as RejectReason, gate.detail, now, seller.id);
      log.debug('listing rejected by the quality gate', {
        domain: raw.sourceDomain,
        sourceId: raw.sourceId,
        reason: gate.reason,
        detail: gate.detail,
      });
      return {
        status: 'rejected',
        productId: null,
        clusterId: null,
        rejectReason: gate.reason as RejectReason,
        matchStrength: match.strength,
      };
    }

    // The gate reads the source's *declared* dimensions; this is the first
    // point at which the image has actually been stored. An image that was
    // declared large but could not be fetched, decoded or measured lands here
    // as null, and a listing without a hero is not showable — so it is rejected
    // for the real reason rather than asserted away with a cast.
    if (!hero) {
      await this.recordRejection(raw, 'no_acceptable_image', 'image could not be stored', now, seller.id);
      return {
        status: 'rejected',
        productId: null,
        clusterId: null,
        rejectReason: 'no_acceptable_image',
        matchStrength: match.strength,
      };
    }
    const heroImage: MediaImage = hero;

    // ---- Reviews ----------------------------------------------------------
    const existing = await findOne(collections.products, {
      'source.domain': raw.sourceDomain,
      'source.sourceId': raw.sourceId,
    });

    // A listing we already store keeps the cluster it is already in. Matching
    // is evidence-based and a product with no identifiers routinely matches
    // nothing, so re-ingesting one minted a fresh cluster every time, repointed
    // the product at it and left the previous cluster orphaned — one leaked row
    // and its reviews per refresh.
    const reusableClusterId = match.cluster?.id ?? existing?.clusterId ?? null;
    const clusterId = reusableClusterId ?? crypto.randomUUID();
    const clusterExists = reusableClusterId !== null;

    // The corpus is resolved now because the quality score reads it, but it is
    // written after the cluster row exists; see `persistReviews`.
    const storedReviews = await this.computeReviews(raw, clusterId, now);

    // ---- Quality ----------------------------------------------------------
    const priors = this.deps.categoryPriors?.get(classification.l3) ?? DEFAULT_PRIORS;

    const completeness: ListingCompletenessInput = {
      heroShortEdge: Math.min(heroImage.width, heroImage.height),
      imageCount: 1 + gallery.length,
      specCount: specs.length,
      expectedSpecCount: 5,
      descriptionLength: raw.description?.length ?? 0,
      hasVariants: specs.some((s) => s.key === 'size' || s.key === 'color'),
      variantsFullySpecified: specs.some((s) => s.key === 'size') && specs.some((s) => s.key === 'color'),
    };

    const quality = computeQuality({
      reviews: toQualitySamples(storedReviews, () => true),
      categoryPriorRating: priors.meanRating,
      otherSourceMeanRating: match.cluster?.reviews.meanRating ?? null,
      listingAgeDays: existing?.crawl?.firstSeenAt
        ? daysBetween(existing.crawl.firstSeenAt, now)
        : 0,
      completeness,
      engagement: {
        impressions: existing?.engagement?.impressions ?? 0,
        interactions: existing?.engagement?.interactions ?? 0,
        cartAdds: existing?.engagement?.cartAdds ?? 0,
        categoryMeanCtr: priors.meanCtr,
        categoryMeanCartRate: priors.meanCartRate,
      },
      now,
    });

    // ---- Risk -------------------------------------------------------------
    const duplicateImageSellers = await this.findDuplicateImageSellers(
      heroImage.blurhash,
      seller.id,
    );
    const categoryPriceStats = await this.categoryPriceStats(classification.l3);

    const riskInput: RiskInput = {
      product: {
        id: existing?.id ?? 'pending',
        title,
        description: raw.description,
        brand,
        categoryL1: classification.l1,
        categoryL3: classification.l3,
        priceAmount: (price as { amount: number }).amount,
        condition,
        sourceType: raw.sourceType,
        quantity: stock.quantity,
        singleUnit: stock.singleUnit,
        sourceDomain: raw.sourceDomain,
        embedding,
        // A separate image tower is not wired in, so the cross-modal coherence
        // check has nothing independent to compare against and is skipped
        // rather than being fed the same vector twice, which would always agree.
        imageEmbedding: null,
        heroImageHash: heroImage.blurhash,
        hasExif: false,
        imageLooksStudioGrade: raw.sourceType === 'new',
        listedAt: existing?.crawl?.firstSeenAt ?? now,
      },
      cluster: match.cluster
        ? { medianPrice: match.cluster.priceRange.median, memberCount: match.cluster.offerCount }
        : null,
      categoryPrices: categoryPriceStats,
      seller: {
        type: seller.type,
        accountAgeDays: sellerAgeDays,
        salesCount: seller.metrics.salesCount,
        rating: seller.metrics.rating,
        reviewCount: seller.metrics.reviewCount,
        recentListingCount: seller.liveListingCount,
        recentListingValue: seller.liveListingCount * ((price as { amount: number }).amount),
        handleChangedWithinDays: null,
        upheldReports: 0,
      },
      duplicateImageSellerIds: duplicateImageSellers,
      inconsistentCrossListings: 0,
      source: { domainReputation: 0.85, proxyIndicators: false, burnerEmailIndicators: false },
      counterfeitWatchlistBrands: this.deps.counterfeitWatchlistBrands ?? new Set(),
      manufacturerDescription: null,
      discontinued: false,
      now,
    };
    const risk = this.riskModel.score(riskInput);

    // Blocked listings are stored rejected and never shown.
    const status: ProductDoc['status'] = risk.tier === 'blocked' ? 'rejected' : 'active';

    // ---- Upsert -----------------------------------------------------------
    // `products.cluster_id` and `product_clusters.canonical_product_id` point at
    // each other, and neither column is deferrable, so a brand-new pair cannot
    // be written in one order or the other. The product goes in first without a
    // cluster, the cluster is created naming it as canonical, and the product is
    // pointed at the cluster immediately below.
    const product: Omit<Product, 'id'> = {
      clusterId: clusterExists ? clusterId : null,
      source: {
        domain: raw.sourceDomain,
        sourceId: raw.sourceId,
        tier: raw.tier,
        url: raw.url,
      },
      sourceType: raw.sourceType,
      title,
      rawTitle: raw.title,
      brand,
      identifiers: raw.identifiers,
      category: classification,
      price: price as { amount: number; currency: string },
      originalPrice,
      shipping: {
        amount: shippingMoney?.amount ?? 0,
        currency: shippingMoney?.currency ?? (price as { currency: string }).currency,
        freeThreshold: null,
      },
      condition,
      stock,
      auction: raw.auction
        ? {
            endsAt: raw.auction.endsAt,
            currentBid: raw.auction.currentBidMinor,
            bidCount: raw.auction.bidCount,
          }
        : null,
      specs,
      media: { hero: heroImage, gallery, video: await this.ingestVideo(raw) },
      sellerId: seller.id,
      embedding,
      embeddingVersion: this.deps.embedder.version,
      quality,
      risk: { ...risk, reviewedBy: null },
      engagement: existing?.engagement ?? {
        impressions: 0,
        interactions: 0,
        ctrSmoothed: priors.meanCtr,
        cartAdds: 0,
      },
      crawl: {
        firstSeenAt: existing?.crawl?.firstSeenAt ?? now,
        lastCrawledAt: now,
        lastChangedAt:
          existing?.price?.amount === (price as { amount: number }).amount
            ? (existing?.crawl?.lastChangedAt ?? now)
            : now,
        failCount: 0,
        tier: raw.tier,
      },
      status,
      rejectReason: null,
    };

    // Check if product exists
    const existingProduct = await findOne(collections.products, {
      'source.domain': raw.sourceDomain,
      'source.sourceId': raw.sourceId,
    });

    let upserted: Product;
    if (existingProduct) {
      // Update existing
      upserted = await updateOne(collections.products,
        { 'source.domain': raw.sourceDomain, 'source.sourceId': raw.sourceId },
        product
      );
    } else {
      // Insert new
      upserted = await insert(collections.products, product);
    }

    const stored = upserted as Product | null;
    if (!stored) throw new Error('Product upsert returned no document.');

    if (!clusterExists) {
      await insert(collections.clusters, {
        id: clusterId,
        canonicalProductId: stored.id,
        title,
        brand,
        category: { ...classification },
        identifiers: raw.identifiers,
        offerCount: 0,
        priceRange: {
          min: (price as { amount: number }).amount,
          max: (price as { amount: number }).amount,
          median: (price as { amount: number }).amount,
          currency: (price as { currency: string }).currency,
        },
        sourceTypes: [raw.sourceType],
        embedding,
        reviews: { count: 0, meanRating: null, perSource: [], summary: null, themes: [], asOf: null },
        engagement: { impressions: 0, ctrSmoothed: 0, upvotes: 0 },
        updatedAt: now,
      });
      await updateOne(collections.products, { id: stored.id }, { clusterId });
      stored.clusterId = clusterId;
    }

    // Both the reviews and the cluster's own figures depend on the cluster row,
    // so neither can run before the block above.
    await this.persistReviews(clusterId, storedReviews);
    await this.recomputeCluster(clusterId, classification, title, brand, raw, now);
    this.deps.onProductUpserted?.(stored);

    return {
      status: 'ingested',
      productId: stored.id,
      clusterId,
      rejectReason: null,
      matchStrength: match.strength,
    };
  }

  // -------------------------------------------------------------------------

  private async ingestMedia(raw: RawListing): Promise<{
    hero: MediaImage | null;
    gallery: MediaImage[];
    bestShortEdge: number | null;
  }> {
    // The declared order is only a hint for which image to try first. The web
    // adapters parse markup that states no dimensions at all and so report
    // zeroes, and a source's own claim about its images is not evidence anyway:
    // the fetching pipeline measures the bytes and refuses anything under the
    // eligibility floor, so `bestShortEdge` is taken from what was actually
    // stored. Reading it from the declared values instead made every web
    // listing look like a 0px image and rejected the entire crawl as
    // `no_acceptable_image`.
    const sorted = [...raw.images].sort(
      (a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height),
    );

    const stored: MediaImage[] = [];
    for (const image of sorted) {
      const ingested = await this.deps.media.ingestImage({
        sourceUrl: image.url,
        width: image.width,
        height: image.height,
      });
      if (ingested) stored.push(ingested);
    }

    const shortEdgeOf = (image: MediaImage): number => Math.min(image.width, image.height);
    stored.sort((a, b) => shortEdgeOf(b) - shortEdgeOf(a));

    const hero = stored[0] ?? null;
    const gallery = stored.slice(1, 1 + QUALITY_GATE.maxGalleryImages);
    const bestShortEdge = hero ? shortEdgeOf(hero) : null;

    return { hero, gallery, bestShortEdge };
  }

  private async ingestVideo(raw: RawListing) {
    if (!raw.video) return null;
    return this.deps.media.ingestVideo({
      sourceUrl: raw.video.url,
      durationMs: raw.video.durationMs,
    });
  }

  private async upsertSeller(raw: RawListing, now: Date): Promise<Seller> {
    const { collections } = this.deps;
    const rawSeller = raw.seller;

    const key = {
      sourceDomain: raw.sourceDomain,
      sourceSellerId: rawSeller?.sourceSellerId ?? raw.sourceDomain,
    };

    const update: Omit<Seller, 'id'> = {
      sourceDomain: key.sourceDomain,
      sourceSellerId: key.sourceSellerId,
      handle: rawSeller?.handle ?? raw.sourceDomain,
      type: rawSeller?.type ?? 'retailer',
      displayName: rawSeller?.displayName ?? raw.sourceDomain,
      avatarUrl: rawSeller?.avatarUrl ?? null,
      profileUrl: rawSeller?.profileUrl ?? `https://${raw.sourceDomain}`,
      metrics: {
        // Source ratings are normalised to a 5-point scale here so that a
        // seller profile never shows two scales side by side.
        rating:
          rawSeller?.rating != null && rawSeller.ratingScale > 0
            ? Math.round((rawSeller.rating / rawSeller.ratingScale) * 5 * 100) / 100
            : null,
        reviewCount: rawSeller?.reviewCount ?? 0,
        salesCount: rawSeller?.salesCount ?? 0,
        memberSince: rawSeller?.memberSince ?? null,
        responseTime: rawSeller?.responseTime ?? null,
      },
      policies:
        rawSeller?.returnWindowDays != null
          ? {
              returnWindowDays: rawSeller.returnWindowDays,
              shippingSummary: rawSeller.shippingSummary ?? '',
            }
          : null,
      auctionTerms:
        rawSeller?.buyerPremiumPct != null
          ? { buyerPremiumPct: rawSeller.buyerPremiumPct, termsUrl: rawSeller.profileUrl }
          : null,
      liveListingCount: rawSeller?.listingCount ?? 0,
      trust: {
        score: rawSeller?.type === 'individual' ? 0.6 : 0.9,
        flags:
          rawSeller?.memberSince && daysBetween(rawSeller.memberSince, now) < 30
            ? ['new_account']
            : [],
      },
      suppressed: false,
      updatedAt: now,
    };

    const existingSeller = await findOne(collections.sellers, key);
    let result: Seller;
    if (existingSeller) {
      result = await updateOne(collections.sellers, key, update);
    } else {
      result = await insert(collections.sellers, update);
    }
    const seller = result as Seller | null;
    if (!seller) throw new Error('Seller upsert returned no document.');
    return seller;
  }

  /**
   * Matching runs strongest-evidence first and stops at the first hit, so a
   * fuzzy match can never override an identifier match.
   */
  private async matchCluster(input: {
    identifiers: RawListing['identifiers'];
    brand: string | null;
    title: string;
    categoryL3: string;
    sourceType: SourceType;
    priceAmount: number;
    embedding: number[];
  }): Promise<{ cluster: Cluster | null; strength: MatchStrength }> {
    const { collections } = this.deps;

    // 1. Exact identifier match.
    const keys = identifierKeys(input.identifiers);
    if (keys.length > 0) {
      const identifierQuery = keys
        .map((key) => {
          const [kind, value] = key.split(':', 2) as [string, string];
          return kind === 'gtin'
            ? { $or: [{ 'identifiers.gtin': value }, { 'identifiers.upc': value }, { 'identifiers.ean': value }] }
            : { [`identifiers.${kind}`]: value };
        })
        .filter(Boolean);
      const candidate = await findOne(collections.clusters, { $or: identifierQuery } as never);
      if (candidate && candidate.sourceTypes.every((t) => mayCluster(input.sourceType, t, 'identifier'))) {
        return { cluster: candidate, strength: 'identifier' };
      }
    }

    // 2. Brand plus model number.
    const model = extractModelNumber(input.title, input.brand);
    const key = brandModelKey(input.brand, model);
    if (key && input.sourceType === 'new') {
      const candidate = await findOne(collections.clusters, {
        brand: input.brand,
        'identifiers.mpn': model,
        'category.l3': input.categoryL3,
      });
      if (candidate && candidate.sourceTypes.every((t) => mayCluster(input.sourceType, t, 'brand_model'))) {
        return { cluster: candidate, strength: 'brand_model' };
      }
    }

    // 3. Fuzzy: embedding, price and category must all agree.
    if (input.sourceType === 'new') {
      const nearby = await find<Cluster>(collections.clusters, { 'category.l3': input.categoryL3 }, { limit: 200 });
      const candidates: FuzzyCandidate[] = nearby.map((c) => ({
        clusterId: c.id,
        embedding: c.embedding,
        medianPrice: c.priceRange.median,
        categoryL3: c.category.l3,
        sourceTypes: c.sourceTypes,
      }));
      const hit = fuzzyMatch(
        {
          embedding: input.embedding,
          priceAmount: input.priceAmount,
          categoryL3: input.categoryL3,
          sourceType: input.sourceType,
        },
        candidates,
      );
      if (hit) {
        const cluster = nearby.find((c) => c.id === hit.clusterId) ?? null;
        if (cluster) return { cluster, strength: 'fuzzy' };
      }
    }

    return { cluster: null, strength: 'none' };
  }

  /**
   * Resolves the cluster's review corpus without writing it.
   *
   * `reviews.cluster_id` is a foreign key onto `product_clusters`, and a
   * cluster cannot exist until one of its products does, so the rows cannot be
   * inserted at the point the quality score needs to read them. Computing here
   * and persisting in `persistReviews` once the cluster row exists keeps both
   * constraints satisfiable.
   */
  private async computeReviews(raw: RawListing, clusterId: string, now: Date) {
    const { collections } = this.deps;
    if (raw.reviews.length === 0) {
      const stored = await find(collections.reviews, { clusterId }, { limit: REVIEW_FETCH_CAP });
      return stored.map((r) => ({
        source: r.source,
        rating: r.rating,
        ratingScale: r.ratingScale,
        excerpt: r.excerpt,
        authorHandle: r.authorHandle,
        verifiedPurchase: r.verifiedPurchase,
        helpfulCount: r.helpfulCount,
        postedAt: r.postedAt,
        bucket: r.bucket,
        themes: r.themes,
        fetchedAt: r.fetchedAt,
      }));
    }

    const incoming = raw.reviews.map((r) => toAggregated(r, raw.sourceDomain, now));
    const existing = await find(collections.reviews, { clusterId }, { limit: REVIEW_FETCH_CAP });
    const merged = [
      ...existing
        .filter((r) => r.source.domain !== raw.sourceDomain)
        .map((r) => ({
          source: r.source,
          rating: r.rating,
          ratingScale: r.ratingScale,
          excerpt: r.excerpt,
          authorHandle: r.authorHandle,
          verifiedPurchase: r.verifiedPurchase,
          helpfulCount: r.helpfulCount,
          postedAt: r.postedAt,
          bucket: r.bucket,
          themes: r.themes,
          fetchedAt: r.fetchedAt,
        })),
      ...incoming,
    ];

    return bucketReviews(merged);
  }

  /**
   * The stored set is rewritten wholesale rather than diffed: bucket
   * membership is a property of the corpus, not of a review, so one new
   * critical review can move several others between buckets.
   */
  private async persistReviews(
    clusterId: string,
    bucketed: Awaited<ReturnType<IngestionPipeline['computeReviews']>>,
  ): Promise<void> {
    const { collections } = this.deps;
    await deleteMany(collections.reviews, { clusterId });
    if (bucketed.length === 0) return;

    const rows = bucketed.map((r) => ({ id: randomUUID(), clusterId, ...r }));
    try {
      await insertMany(collections.reviews, rows);
    } catch (error) {
      // `reviews.rating` is still `NOT NULL` in the deployed schema while the
      // type has been nullable since review text without a star became a
      // supported case — Amazon returns it on most reviews. Until
      // 20260920000001_nullable_review_rating.sql is applied, dropping the
      // unrated rows keeps the product whole; failing here instead aborted the
      // ingest after the product and cluster were already written, leaving a
      // half-built listing in the catalog. The retry is a no-op once migrated.
      const rated = rows.filter((r) => r.rating != null);
      if (!/rating/.test((error as Error).message) || rated.length === rows.length) throw error;

      log.warn('storing only rated reviews; apply the nullable-rating migration', {
        clusterId,
        stored: rated.length,
        dropped: rows.length - rated.length,
      });
      if (rated.length > 0) await insertMany(collections.reviews, rated);
    }
  }

  private async findDuplicateImageSellers(
    blurhash: string,
    sellerId: string,
  ): Promise<string[]> {
    const { collections } = this.deps;
    const matches = await find(collections.products,
      { 'media.hero.blurhash': blurhash, sellerId: { $ne: sellerId } },
      { select: 'sellerId', limit: 10 }
    );
    return [...new Set(matches.map((m) => m.sellerId))];
  }

  private async categoryPriceStats(
    l3: string,
  ): Promise<{ median: number; p10: number } | null> {
    const { collections } = this.deps;
    const prices = await find<Product>(
      collections.products,
      { 'category.l3': l3, status: 'active' },
      { select: 'price', limit: 500 },
    );
    if (prices.length < 5) return null;
    const amounts = prices.map((p) => p.price.amount).sort((a, b) => a - b);
    return {
      median: Math.round(median(amounts)),
      p10: amounts[Math.floor(amounts.length * 0.1)] as number,
    };
  }

  /** Recomputes the cluster from its members and refreshes the review rollup. */
  private async recomputeCluster(
    clusterId: string,
    category: { l1: string; l2: string; l3: string },
    title: string,
    brand: string | null,
    raw: RawListing,
    now: Date,
  ): Promise<void> {
    const { collections } = this.deps;

    const members = await find(collections.products,
      { clusterId, status: { $in: ['active', 'stale'] } },
      {
        select: 'id,price,shipping,stock,quality,risk,sourceType,embedding',
      }
    );

    if (members.length === 0) return;

    const aggregate = aggregateCluster(
      members.map(
        (m): ClusterMember => ({
          productId: m.id,
          priceAmount: m.price.amount,
          shippingAmount: m.shipping.amount ?? 0,
          currency: m.price.currency,
          inStock: m.stock.inStock,
          qualityScore: m.quality?.score ?? 0,
          riskScore: m.risk?.score ?? 0,
          sourceType: m.sourceType,
          embedding: m.embedding,
        }),
      ),
    );

    const storedReviews = await find(collections.reviews, { clusterId }, { limit: REVIEW_FETCH_CAP });
    const samples = toQualitySamples(
      storedReviews.map((r) => ({
        source: r.source,
        rating: r.rating,
        ratingScale: r.ratingScale,
        excerpt: r.excerpt,
        authorHandle: r.authorHandle,
        verifiedPurchase: r.verifiedPurchase,
        helpfulCount: r.helpfulCount,
        postedAt: r.postedAt,
        bucket: r.bucket,
        themes: r.themes,
        fetchedAt: r.fetchedAt,
      })),
      () => true,
    );
    const ratings = combineRatings(
      storedReviews.map((r) => ({
        source: r.source,
        rating: r.rating,
        ratingScale: r.ratingScale,
        excerpt: r.excerpt,
        authorHandle: r.authorHandle,
        verifiedPurchase: r.verifiedPurchase,
        helpfulCount: r.helpfulCount,
        postedAt: r.postedAt,
        bucket: r.bucket,
        themes: r.themes,
        fetchedAt: r.fetchedAt,
      })),
    );
    const themes = extractThemes(samples);

    const existing = await findOne(collections.clusters, { id: clusterId });
    const needsSummary = shouldRegenerateSummary(
      existing ? { count: existing.reviews.count, meanRating: existing.reviews.meanRating } : null,
      { count: ratings.count, meanRating: ratings.meanRating },
    );
    const summary =
      needsSummary && ratings.count > 0
        ? {
            text: await this.summarizer.summarize({
              themes,
              meanRating: ratings.meanRating,
              count: ratings.count,
              productTitle: title,
            }),
            generatedAt: now,
            modelVersion: this.summarizer.modelVersion,
          }
        : (existing?.reviews?.summary ?? null);

    const update: Omit<ClusterDoc<string>, 'id'> = {
      canonicalProductId: aggregate.canonicalProductId,
      title: existing?.title ?? title,
      brand: existing?.brand ?? brand,
      category: { ...category },
      identifiers: existing?.identifiers ?? raw.identifiers,
      offerCount: aggregate.offerCount,
      priceRange: aggregate.priceRange,
      sourceTypes: aggregate.sourceTypes,
      embedding: aggregate.embedding,
      reviews: {
        count: ratings.count,
        meanRating: ratings.meanRating,
        perSource: ratings.perSource,
        summary,
        themes,
        asOf: storedReviews.length > 0 ? now : null,
      },
      engagement: existing?.engagement ?? { impressions: 0, ctrSmoothed: 0, upvotes: 0 },
      updatedAt: now,
    };

    await updateOne(collections.clusters, { id: clusterId }, update);
  }

  /**
   * `sellerId` is required because `products.seller_id` is `UUID NOT NULL`. The
   * tombstone row is written after the seller has already been upserted, so the
   * real id is always available — the placeholder empty string this used to
   * write was not a uuid and failed the insert, which turned every ordinary
   * rejection into a pipeline error and aborted the listing.
   */
  private async recordRejection(
    raw: RawListing,
    reason: RejectReason,
    detail: string | null,
    now: Date,
    sellerId: string,
  ): Promise<void> {
    const existing = await findOne(this.deps.collections.products, {
      'source.domain': raw.sourceDomain,
      'source.sourceId': raw.sourceId,
    });
    
    if (existing) {
      await updateOne(this.deps.collections.products,
        { id: existing.id },
        {
          status: 'rejected',
          rejectReason: detail ? `${reason}: ${detail}` : reason,
          'crawl.lastCrawledAt': now,
          rawTitle: raw.title,
          'source.url': raw.url,
        }
      );
    } else {
      await insert(this.deps.collections.products, {
        status: 'rejected',
        rejectReason: detail ? `${reason}: ${detail}` : reason,
        'crawl.lastCrawledAt': now,
        'crawl.firstSeenAt': now,
        rawTitle: raw.title,
        'source.url': raw.url,
        source: {
          domain: raw.sourceDomain,
          sourceId: raw.sourceId,
          tier: 'tier1' as const,
          url: raw.url,
        },
        sourceType: raw.sourceType,
        title: raw.title,
        brand: null,
        identifiers: raw.identifiers,
        category: { l1: '', l2: '', l3: '' },
        price: { amount: 0, currency: 'USD' },
        originalPrice: null,
        shipping: { amount: 0, currency: 'USD', freeThreshold: null },
        condition: 'unknown',
        stock: { inStock: false, quantity: null, singleUnit: false },
        auction: null,
        specs: [],
        media: { hero: null as any, gallery: [], video: null },
        // `seller_id` is a uuid column in Postgres, where the empty string this
        // carried under Mongo is not a value: it failed the whole write with
        // "invalid input syntax for type uuid", so a rejected listing took the
        // run down instead of being recorded as rejected. `embedding_version`
        // stays an empty string — it is `TEXT NOT NULL`, and "" is the sentinel
        // meaning the listing never reached the embedder.
        sellerId,
        embedding: [],
        embeddingVersion: '',
        quality: { score: 0, cautions: [] },
        risk: { tier: 'high', score: 1, flags: [], reviewedBy: null },
        engagement: { impressions: 0, interactions: 0, ctrSmoothed: 0, cartAdds: 0 },
        clusterId: null,
      });
    }
  }
}

/** Reviews are capped at 200 per cluster, so this bound is never the binding one. */
const REVIEW_FETCH_CAP = 250;

/** Staleness ceiling for a source tier, used by the refresh scheduler. */
export function stalenessCeilingMs(tier: 1 | 2 | 3): number {
  return TIER_STALENESS_CEILING_HOURS[tier] * 60 * 60 * 1000;
}

export { CLUSTERING };
