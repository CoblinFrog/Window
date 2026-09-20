import { Router } from 'express';
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
import { logger } from '../../lib/logger.js';
import { buildCardContext, toProductCard } from '../../feed/cards.js';
import { cautionText } from '../../ingestion/quality.js';
import { riskFlagText } from '../../ingestion/risk.js';
import type { VectorCandidate } from '../../vector/types.js';
import { findOne, find, count } from '../../db/supabase-helpers.js';

function validateId(value: string, what: string): string {
  if (!value || value.length === 0) throw ApiError.validation(`${what} must be a valid id.`);
  return value;
}

export function catalogRoutes(ctx: AppContext): Router {
  const router = Router();
  const { collections } = ctx.db;

  async function merchantNames(): Promise<Map<string, string>> {
    const { data: sources } = await collections.sources.select('id,displayName');
    return new Map((sources || []).map((s: { id: string; displayName: string }) => [s.id, s.displayName]));
  }

  /**
   * Full product detail. Unlike the card, this carries specs and the source URL.
   *
   * `?live=1` re-fetches the listing at its source URL — but a tap cannot wait
   * on a marketplace round-trip, so the refresh races a deadline. Sources that
   * answer fast land in the response; slow ones keep refreshing in the
   * background and the stored row answers now. Either way the next read is
   * current, because a completed refresh upserts the stored document.
   */
  const LIVE_REFRESH_DEADLINE_MS = 800;

  router.get('/products/:id', async (req, res, next) => {
    try {
      const id = validateId(req.params.id, 'Product id');
      let { data: product } = await collections.products.select('*').eq('id', id).single();
      if (!product) throw ApiError.notFound('That product');

      if (req.query.live === '1' || req.query.live === 'true') {
        const refresh = ctx.refreshProduct(product);
        // A late failure must not surface as an unhandled rejection once the
        // response has already gone out.
        const outcome = await Promise.race([
          refresh.catch((error: unknown) => {
            logger.warn('background live refresh failed', {
              productId: id,
              error: error instanceof Error ? error.message : String(error),
            });
            return 'unavailable' as const;
          }),
          new Promise<'pending'>((resolve) =>
            setTimeout(() => resolve('pending'), LIVE_REFRESH_DEADLINE_MS),
          ),
        ]);
        if (outcome === 'refreshed' || outcome === 'removed') {
          const { data: fresh } = await collections.products.select('*').eq('id', id).single();
          product = fresh ?? product;
        }
        if (outcome === 'removed' && (product === null || product.status === 'dead')) {
          throw ApiError.notFound('That product');
        }
      }

      const names = await merchantNames();

      const candidate = { ...product, vectorScore: 0.5 } as unknown as VectorCandidate;
      const context = await buildCardContext(
        [candidate],
        {
          sellers: collections.sellers as never,
          clusters: collections.clusters as never,
          merchantNames: names,
        },
        { includeGallery: true, now: new Date() },
      );

      const cluster = await findOne(collections.clusters, { id: product.clusterId });

      const response: ProductDetail = {
        productId: product.id,
        clusterId: product.clusterId,
        title: product.title,
        brand: product.brand,
        price: product.price,
        originalPrice: product.originalPrice,
        shipping: {
          amount: product.shipping.amount,
          currency: product.shipping.currency,
          free: product.shipping.freeThreshold !== null && product.price.amount >= product.shipping.freeThreshold,
        },
        merchant: {
          domain: product.source.domain,
          displayName: names.get(product.source.domain) ?? product.source.domain,
        },
        seller: {
          id: product.sellerId,
          handle: context.sellers.get(product.sellerId)?.handle ?? '',
          displayName: context.sellers.get(product.sellerId)?.displayName ?? '',
          avatarUrl: context.sellers.get(product.sellerId)?.avatarUrl ?? null,
          type: context.sellers.get(product.sellerId)?.type ?? 'retailer',
          rating: context.sellers.get(product.sellerId)?.metrics.rating ?? null,
        },
        category: product.category,
        badges: toProductCard(candidate, context).badges,
        media: {
          hero: product.media.hero,
          galleryCount: product.media.gallery.length,
          gallery: product.media.gallery,
          video: product.media.video,
        },
        reviews: { count: cluster?.reviews.count ?? 0, meanRating: cluster?.reviews.meanRating ?? null },
        upvotes: cluster?.engagement.upvotes ?? 0,
        otherOffers: null,
        auction: product.auction ? {
          endsAt: product.auction.endsAt.toISOString(),
          currentBid: product.auction.currentBid,
          bidCount: product.auction.bidCount,
        } : null,
        canAddToCart: product.sourceType !== 'auction',
        warning: riskFlagText(product.risk) || cautionText(product.quality) || null,
        isExploration: false,
        explorationTopic: null,
        specs: product.specs,
        sourceUrl: product.source.url,
        description: null,
        condition: product.condition,
        sourceType: product.sourceType,
        quality: {
          score: product.quality.score,
          cautions: (product.quality.cautions ?? []).map((c: { theme: string }) => ({
            theme: c.theme,
            text: cautionText(c as never),
          })),
        },
        risk: { tier: product.risk.tier, flag: riskFlagText(product.risk as never) },
        lastVerifiedAt: product.crawl.lastCrawledAt.toISOString(),
      };
      res.json(response);
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
      const id = validateId(req.params.id, 'Cluster id');
      const cluster = await findOne(collections.clusters, { id });
      if (!cluster) throw ApiError.notFound('That cluster');

      const members = await find(collections.products, { clusterId: id, status: 'active' });
      const names = await merchantNames();

      const offers: ClusterOffer[] = members
        .map((product) => ({
          productId: product.id,
          merchantDomain: product.source.domain,
          merchantName: names.get(product.source.domain) ?? product.source.domain,
          sellerId: product.sellerId,
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
          isCanonical: product.id === cluster.canonicalProductId,
        }))
        .sort((a, b) => a.landedPrice.amount - b.landedPrice.amount);

      // Window's own upvotes are a separate, clearly delineated block: they are
      // not reviews and must never be presented alongside them as if they were.
      const upvotes = await find(collections.interactions, { clusterId: id, type: 'upvote' }, { select: 'reason' });
      const reasonCounts = new Map<UpvoteReason, number>();
      for (const row of upvotes) {
        if (row.reason && (UPVOTE_REASONS as readonly string[]).includes(row.reason)) {
          reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1);
        }
      }

      const canonical = members.find((m) => m.id === cluster.canonicalProductId);
      const response: ClusterResponse = {
        clusterId: id,
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
      const id = validateId(req.params.id, 'Cluster id');
      const parsed = reviewQuery.safeParse(req.query);
      if (!parsed.success) throw ApiError.validation('Invalid review query.');
      const { bucket, sort, offset, limit } = parsed.data;

      const filter = bucket ? { clusterId: id, bucket } : { clusterId: id };
      // Sorted by helpfulness by default, which is what the sheet opens on.
      const SORTS: Record<typeof sort, { column: string; ascending: boolean }> = {
        helpful: { column: 'helpfulCount', ascending: false },
        recent: { column: 'postedAt', ascending: false },
        rating_asc: { column: 'rating', ascending: true },
        rating_desc: { column: 'rating', ascending: false },
      };
      const sortSpec = SORTS[sort];

      const [items, total, cluster] = await Promise.all([
        find(collections.reviews, filter, { skip: offset, limit, orderBy: sortSpec }),
        count(collections.reviews, filter),
        findOne(collections.clusters, { id }, { select: 'reviews.asOf' }),
      ]);

      const response: ReviewsResponse = {
        clusterId: id,
        items: items.map((review) => ({
          id: review.id,
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
      const id = validateId(req.params.id, 'Seller id');
      const seller = await findOne(collections.sellers, { id });
      if (!seller) throw ApiError.notFound('That seller');

      const muted = req.currentUser?.suppressions.sellers.includes(id) ?? false;
      const response: SellerResponse = {
        id: id,
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
      const id = validateId(req.params.id, 'Seller id');
      const products = await find(collections.products, 
        { sellerId: id, status: 'active', 'stock.inStock': true },
        { limit: 40, orderBy: { column: 'quality.score', ascending: false } }
      );

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
