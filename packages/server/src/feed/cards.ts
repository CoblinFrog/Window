import {
  CLUSTERING,
  type CardBadges,
  type ProductCard,
} from '@window/shared';
import type { Cluster, Seller } from '../db/supabase-collections.js';
import { find } from '../db/supabase-helpers.js';
import { cautionText } from '../ingestion/quality.js';
import { riskFlagText } from '../ingestion/risk.js';
import type { VectorCandidate } from '../vector/types.js';

/**
 * The `ProductCard` projection.
 *
 * Deliberately flat and render-ready: ids, title, price, merchant, badges, hero
 * media in three widths with a blurhash, seller summary, review count and mean
 * rating, and the flags the rail needs. It never includes the embedding, the
 * full spec list or review bodies — a feed page is budgeted at under 60 KB
 * gzipped for twenty cards, and the embedding alone would blow that on one.
 */

export interface CardContext {
  sellers: ReadonlyMap<string, Seller>;
  clusters: ReadonlyMap<string, Cluster>;
  merchantNames: ReadonlyMap<string, string>;
  /** Quality scores across the page's categories, for the top-decile badge. */
  qualityTopDecile: number;
  /** Set for the card occupying the exploration slot. */
  explorationProductId?: string | null;
  explorationTopic?: string | null;
  /** Single mode sends the full gallery; Window mode sends the hero only. */
  includeGallery: boolean;
  now: Date;
}

function badgesFor(
  candidate: VectorCandidate,
  cluster: Cluster | undefined,
  context: CardContext,
): CardBadges {
  const clusterMedian = cluster?.priceRange.median ?? null;
  let priceContext: 'below' | 'above' | null = null;
  if (clusterMedian && clusterMedian > 0 && (cluster?.offerCount ?? 0) > 1) {
    const delta = (candidate.price.amount - clusterMedian) / clusterMedian;
    if (delta <= -CLUSTERING.priceContextSpread) priceContext = 'below';
    else if (delta >= CLUSTERING.priceContextSpread) priceContext = 'above';
  }

  const caution = candidate.quality.cautions?.[0] ?? null;

  return {
    source: candidate.sourceType,
    // The condition badge is secondhand-only; "new" on a new listing is noise.
    condition: candidate.sourceType === 'new' ? null : candidate.condition,
    priceContext,
    onlyOne: candidate.stock.singleUnit && candidate.sourceType !== 'new',
    endsAt: candidate.auction ? candidate.auction.endsAt.toISOString() : null,
    // Shown when the scam heuristic fires but the listing narrowly clears the
    // quality gate. Always specific, never "this listing may be risky".
    riskFlag: riskFlagText(candidate.risk as never),
    wellReviewed:
      candidate.quality.score >= context.qualityTopDecile &&
      (cluster?.reviews.count ?? 0) >= 10,
    caution: caution ? cautionText(caution) : null,
  };
}

export function toProductCard(
  candidate: VectorCandidate,
  context: CardContext,
): ProductCard {
  const sellerId = candidate.sellerId;
  const seller = context.sellers.get(sellerId);
  const clusterId = candidate.clusterId;
  const cluster = clusterId ? context.clusters.get(clusterId) : undefined;

  const productId = candidate.id;
  const isExploration = context.explorationProductId === productId;

  // "4 other sellers, from $X" — only offers the user could actually buy
  // instead of this one, so a cluster of one is no affordance at all.
  const otherOfferCount = Math.max(0, (cluster?.offerCount ?? 1) - 1);
  const otherOffers =
    otherOfferCount > 0 && cluster
      ? {
          count: otherOfferCount,
          fromAmount: cluster.priceRange.min,
          currency: cluster.priceRange.currency,
        }
      : null;

  return {
    productId,
    clusterId,
    title: candidate.title,
    brand: candidate.brand,
    price: candidate.price,
    originalPrice: candidate.originalPrice,
    shipping: {
      amount: candidate.shipping?.amount ?? 0,
      currency: candidate.shipping?.currency ?? candidate.price.currency,
      free: (candidate.shipping?.amount ?? 0) === 0,
    },
    merchant: {
      domain: candidate.source.domain,
      displayName: context.merchantNames.get(candidate.source.domain) ?? candidate.source.domain,
    },
    seller: {
      id: sellerId,
      handle: seller?.handle ?? candidate.source.domain,
      displayName: seller?.displayName ?? candidate.source.domain,
      avatarUrl: seller?.avatarUrl ?? null,
      type: seller?.type ?? 'retailer',
      rating: seller?.metrics.rating ?? null,
    },
    category: candidate.category,
    badges: badgesFor(candidate, cluster, context),
    media: {
      hero: candidate.media.hero,
      galleryCount: candidate.media.gallery?.length ?? 0,
      gallery: context.includeGallery ? (candidate.media.gallery ?? []) : [],
      video: candidate.media.video ?? null,
    },
    reviews: {
      count: cluster?.reviews.count ?? 0,
      meanRating: cluster && cluster.reviews.count > 0 ? cluster.reviews.meanRating : null,
    },
    upvotes: cluster?.engagement.upvotes ?? 0,
    otherOffers,
    auction: candidate.auction
      ? {
          endsAt: candidate.auction.endsAt.toISOString(),
          currentBid: candidate.auction.currentBid,
          bidCount: candidate.auction.bidCount,
        }
      : null,
    // Auction items cannot be added to cart at all; the bag button is replaced
    // by "Open to bid", which deep-links out.
    canAddToCart: candidate.sourceType !== 'auction' && candidate.risk.tier !== 'high',
    warning:
      candidate.risk.tier === 'high'
        ? (riskFlagText(candidate.risk as never) ??
          'This listing was excluded from the feed for safety reasons.')
        : null,
    isExploration,
    explorationTopic: isExploration ? (context.explorationTopic ?? null) : null,
  };
}

/** Loads the seller, cluster and merchant lookups a page of cards needs. */
export async function buildCardContext(
  candidates: readonly VectorCandidate[],
  deps: {
    sellers: any;
    clusters: any;
    merchantNames: ReadonlyMap<string, string>;
  },
  options: Omit<CardContext, 'sellers' | 'clusters' | 'merchantNames' | 'qualityTopDecile'> & {
    qualityTopDecile?: number;
  },
): Promise<CardContext> {
  const sellerIds = [...new Set(candidates.map((c) => c.sellerId))];
  const clusterIds = [
    ...new Set(
      candidates
        .map((c) => c.clusterId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const [sellers, clusters] = await Promise.all([
    find<Seller>(deps.sellers, { id: { $in: candidates.map((c) => c.sellerId) } }),
    find<Cluster>(deps.clusters, { id: { $in: candidates.map((c) => c.clusterId).filter(Boolean) } }),
  ]);

  void sellerIds;
  void clusterIds;

  const scores = candidates.map((c) => c.quality.score).sort((a, b) => a - b);
  const topDecile =
    scores.length === 0
      ? 1
      : (scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.9))] as number);

  return {
    sellers: new Map(sellers.map((s) => [s.id, s])),
    clusters: new Map(clusters.map((c) => [c.id, c])),
    merchantNames: deps.merchantNames,
    qualityTopDecile: options.qualityTopDecile ?? topDecile,
    explorationProductId: options.explorationProductId ?? null,
    explorationTopic: options.explorationTopic ?? null,
    includeGallery: options.includeGallery,
    now: options.now,
  };
}
