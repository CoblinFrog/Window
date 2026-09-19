import { Router } from 'express';
import { ObjectId, type Sort } from 'mongodb';
import { z } from 'zod';
import {
  ApiError,
  REVIEW_BUCKETS,
  UPVOTE_REASONS,
  type ClusterOffer,
  type ClusterResponse,
  type ProductDetail,
  type ReviewsResponse,
  type SearchResponse,
  type SellerResponse,
  type UpvoteReason,
} from '@window/shared';
import type { AppContext } from '../context.js';
import { buildCardContext, toProductCard } from '../../feed/cards.js';
import { cautionText } from '../../ingestion/quality.js';
import { riskFlagText } from '../../ingestion/risk.js';
import type { VectorCandidate } from '../../vector/types.js';

function objectId(value: string, what: string): ObjectId {
  if (!ObjectId.isValid(value)) throw ApiError.validation(`${what} must be a valid id.`);
  return new ObjectId(value);
}

export function catalogRoutes(ctx: AppContext): Router {
  const router = Router();
  const { collections } = ctx.db;

  async function merchantNames(): Promise<Map<string, string>> {
    const sources = await collections.sources.find({}).toArray();
    return new Map(sources.map((s) => [s._id, s.displayName]));
  }

  /** Full product detail. Unlike the card, this carries specs and the source URL. */
  router.get('/products/:id', async (req, res, next) => {
    try {
      const id = objectId(req.params.id, 'Product id');
      const product = await collections.products.findOne({ _id: id });
      if (!product) throw ApiError.notFound('That product');

      const candidate = { ...(product as unknown as VectorCandidate), vectorScore: 0.5 };
      const context = await buildCardContext(
        [candidate],
        {
          sellers: collections.sellers as never,
          clusters: collections.clusters as never,
          merchantNames: await merchantNames(),
        },
        { includeGallery: true, now: new Date() },
      );

      const card = toProductCard(candidate, context);
      const detail: ProductDetail = {
        ...card,
        specs: product.specs,
        description: null,
        sourceUrl: product.source.url,
        condition: product.condition,
        sourceType: product.sourceType,
        quality: {
          score: product.quality.score,
          cautions: (product.quality.cautions ?? []).map((c) => ({
            theme: c.theme,
            text: cautionText(c),
          })),
        },
        risk: { tier: product.risk.tier, flag: riskFlagText(product.risk as never) },
        lastVerifiedAt: product.crawl.lastCrawledAt.toISOString(),
      };
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  /**
   * A cluster with all its offers, sorted by total landed price. Sorting by
   * item price alone is the classic marketplace lie: a cheap item with
   * expensive shipping is not the best offer.
   */
  router.get('/clusters/:id', async (req, res, next) => {
    try {
      const id = objectId(req.params.id, 'Cluster id');
      const cluster = await collections.clusters.findOne({ _id: id });
      if (!cluster) throw ApiError.notFound('That cluster');

      const members = await collections.products
        .find({ clusterId: id, status: 'active' })
        .toArray();
      const names = await merchantNames();

      const offers: ClusterOffer[] = members
        .map((product) => ({
          productId: product._id.toHexString(),
          merchantDomain: product.source.domain,
          merchantName: names.get(product.source.domain) ?? product.source.domain,
          sellerId: product.sellerId.toHexString(),
          price: product.price,
          shipping: {
            amount: product.shipping?.amount ?? 0,
            currency: product.shipping?.currency ?? product.price.currency,
          },
          landedPrice: {
            amount: product.price.amount + (product.shipping?.amount ?? 0),
            currency: product.price.currency,
          },
          condition: product.condition,
          sourceType: product.sourceType,
          inStock: product.stock.inStock,
          isCanonical: product._id.equals(cluster.canonicalProductId),
        }))
        .sort((a, b) => a.landedPrice.amount - b.landedPrice.amount);

      // Window's own upvotes are a separate, clearly delineated block: they are
      // not reviews and must never be presented alongside them as if they were.
      const upvotes = await collections.interactions
        .find({ clusterId: id, type: 'upvote' })
        .project<{ reason: UpvoteReason | null }>({ reason: 1 })
        .toArray();
      const reasonCounts = new Map<UpvoteReason, number>();
      for (const row of upvotes) {
        if (row.reason && (UPVOTE_REASONS as readonly string[]).includes(row.reason)) {
          reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1);
        }
      }

      const canonical = members.find((m) => m._id.equals(cluster.canonicalProductId));
      const response: ClusterResponse = {
        clusterId: id.toHexString(),
        title: cluster.title,
        brand: cluster.brand,
        category: cluster.category,
        priceRange: cluster.priceRange,
        offers,
        reviews: {
          count: cluster.reviews.count,
          meanRating: cluster.reviews.count > 0 ? cluster.reviews.meanRating : null,
          perSource: cluster.reviews.perSource,
          summary: cluster.reviews.summary
            ? {
                text: cluster.reviews.summary.text,
                generatedAt: cluster.reviews.summary.generatedAt.toISOString(),
                modelVersion: cluster.reviews.summary.modelVersion,
              }
            : null,
          themes: cluster.reviews.themes,
          asOf: cluster.reviews.asOf ? cluster.reviews.asOf.toISOString() : null,
        },
        windowUpvotes: {
          count: upvotes.length,
          reasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
        },
        media: {
          hero: canonical?.media.hero ?? (members[0]?.media.hero as ClusterResponse['media']['hero']),
          gallery: canonical?.media.gallery ?? [],
        },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  const reviewQuery = z.object({
    bucket: z.enum(REVIEW_BUCKETS).optional(),
    sort: z.enum(['helpful', 'recent', 'rating_asc', 'rating_desc']).default('helpful'),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });

  router.get('/clusters/:id/reviews', async (req, res, next) => {
    try {
      const id = objectId(req.params.id, 'Cluster id');
      const parsed = reviewQuery.safeParse(req.query);
      if (!parsed.success) throw ApiError.validation('Invalid review query.');
      const { bucket, sort, offset, limit } = parsed.data;

      const filter = bucket ? { clusterId: id, bucket } : { clusterId: id };
      // Sorted by helpfulness by default, which is what the sheet opens on.
      const SORTS: Record<typeof sort, Sort> = {
        helpful: { helpfulCount: -1 },
        recent: { postedAt: -1 },
        rating_asc: { rating: 1 },
        rating_desc: { rating: -1 },
      };
      const sortSpec = SORTS[sort];

      const [items, total, cluster] = await Promise.all([
        collections.reviews.find(filter).sort(sortSpec).skip(offset).limit(limit).toArray(),
        collections.reviews.countDocuments(filter),
        collections.clusters.findOne({ _id: id }, { projection: { 'reviews.asOf': 1 } }),
      ]);

      const response: ReviewsResponse = {
        clusterId: id.toHexString(),
        items: items.map((review) => ({
          id: review._id.toHexString(),
          rating: review.rating,
          ratingScale: review.ratingScale,
          excerpt: review.excerpt,
          authorHandle: review.authorHandle,
          verifiedPurchase: review.verifiedPurchase,
          helpfulCount: review.helpfulCount,
          postedAt: review.postedAt.toISOString(),
          bucket: review.bucket,
          themes: review.themes,
          // Every review displays its source domain and links to the original.
          // No review is ever presented as native to Window.
          source: review.source,
        })),
        total,
        nextOffset: offset + items.length < total ? offset + items.length : null,
        asOf: cluster?.reviews.asOf ? cluster.reviews.asOf.toISOString() : null,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * A seller profile is a mirror of public source-site data. Window stores the
   * handle and public metrics only, links out for anything more, and never
   * collects contact details.
   */
  router.get('/sellers/:id', async (req, res, next) => {
    try {
      const id = objectId(req.params.id, 'Seller id');
      const seller = await collections.sellers.findOne({ _id: id });
      if (!seller) throw ApiError.notFound('That seller');

      const muted = req.currentUser?.suppressions.sellers.some((s) => s.equals(id)) ?? false;
      const response: SellerResponse = {
        id: id.toHexString(),
        handle: seller.handle,
        displayName: seller.displayName,
        avatarUrl: seller.avatarUrl,
        profileUrl: seller.profileUrl,
        sourceDomain: seller.sourceDomain,
        type: seller.type,
        metrics: {
          rating: seller.metrics.rating,
          reviewCount: seller.metrics.reviewCount,
          salesCount: seller.metrics.salesCount,
          memberSince: seller.metrics.memberSince
            ? seller.metrics.memberSince.toISOString()
            : null,
          responseTime: seller.metrics.responseTime,
        },
        policies: seller.policies,
        auctionTerms: seller.auctionTerms,
        liveListingCount: seller.liveListingCount,
        muted,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get('/sellers/:id/listings', async (req, res, next) => {
    try {
      const id = objectId(req.params.id, 'Seller id');
      const products = await collections.products
        .find({ sellerId: id, status: 'active', 'stock.inStock': true })
        .sort({ 'quality.score': -1 })
        .limit(40)
        .toArray();

      const candidates = products.map((p) => ({
        ...(p as unknown as VectorCandidate),
        vectorScore: 0.5,
      }));
      if (candidates.length === 0) {
        res.json({ items: [] });
        return;
      }

      const context = await buildCardContext(
        candidates,
        {
          sellers: collections.sellers as never,
          clusters: collections.clusters as never,
          merchantNames: await merchantNames(),
        },
        { includeGallery: false, now: new Date() },
      );
      res.json({ items: candidates.map((c) => toProductCard(c, context)) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Keyword fallback search. Present but not surfaced prominently: the product
   * thesis is that the search box is the thing being replaced, and a search
   * result page that competes with the feed undermines the whole argument.
   */
  router.get('/search', async (req, res, next) => {
    try {
      const query = String(req.query.q ?? '').trim();
      if (query.length < 2) throw ApiError.validation('q must be at least two characters.');

      const vector = await ctx.embedder.embedText(query);
      const candidates = await ctx.vectors.search({
        vector,
        numCandidates: 1000,
        limit: 40,
        filter: { inStock: true, statusIn: ['active'] },
      });

      const eligible = candidates.filter(
        (c) => c.risk.tier !== 'high' && c.risk.tier !== 'blocked',
      );
      const context = await buildCardContext(
        eligible,
        {
          sellers: collections.sellers as never,
          clusters: collections.clusters as never,
          merchantNames: await merchantNames(),
        },
        { includeGallery: false, now: new Date() },
      );

      const response: SearchResponse = {
        query,
        items: eligible.map((c) => toProductCard(c, context)),
        total: eligible.length,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
