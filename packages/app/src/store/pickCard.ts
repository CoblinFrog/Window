import type { ChatPickResponse, ProductCard } from '@window/shared';

/**
 * An assistant pick, rendered as a feed card.
 *
 * Tapping an answer should put you *into* the feed on that item rather than
 * bounce you out to Amazon, so the picks have to become `ProductCard`s. They
 * are not catalog rows and never were: they came off a live search page
 * minutes ago, nothing ingested them, and there is no cluster, seller record,
 * review corpus or transcoded media behind them.
 *
 * So this is an honest projection, not a fake row. Everything the feed can
 * genuinely show — image, title, price, merchant, the rating the storefront
 * published — is carried across. Everything that would need a catalog row
 * behind it is switched off rather than invented: `clusterId` is null so the
 * reviews sheet and the detail route are unreachable, `canAddToCart` is false
 * so the rail deep-links to the merchant the way it already does for auctions,
 * and there are no other offers to compare against.
 *
 * The listing URL rides on `sourceUrl`, the same field the rest of the app
 * already uses to link a card back to its storefront.
 *
 * The id keeps its `web:<domain>:<sourceId>` form. The events collector only
 * accepts UUIDs and drops everything else as `invalid_product_id`, which is
 * exactly the behaviour wanted here: scrolling a pick must not write ranking
 * signal about a product the catalog has never heard of.
 */

/** A one-image gallery. Both codec arrays hold the same URL — the storefront
 *  CDN serves one format and the card readers fall back through the list. */
function heroFrom(imageUrl: string | null): ProductCard['media']['hero'] {
  const urls = imageUrl === null ? [] : [imageUrl, imageUrl, imageUrl];
  return {
    avif: urls,
    webp: urls,
    // The real dimensions are unknown without fetching the image; 1:1 is what
    // both storefronts' product shots are cropped to.
    width: 1200,
    height: 1200,
    blurhash: '',
  };
}

export function pickToCard(pick: ChatPickResponse): ProductCard {
  const domain = pick.sourceDomain ?? 'amazon.com';
  return {
    productId: pick.productId,
    // Null: there is no cluster, so no reviews sheet and no detail route.
    clusterId: null,
    title: pick.title,
    brand: null,
    price: { amount: pick.priceMinor, currency: pick.currency },
    originalPrice: null,
    // Unknown rather than free. Claiming free shipping we cannot verify is the
    // one error here that would cost the user money.
    shipping: { amount: 0, currency: pick.currency, free: false },
    merchant: { domain, displayName: domain },
    seller: {
      id: `web:${domain}`,
      handle: domain,
      displayName: domain,
      avatarUrl: null,
      type: 'retailer',
      rating: null,
    },
    category: { l1: '', l2: '', l3: '' },
    // Main's own field for linking back to the storefront. A pick cannot be
    // bought in-app, so this is the path out to the actual listing.
    sourceUrl: pick.url,
    badges: {
      // The card never told us the condition. Amazon's `/dp/` results are new
      // goods; an eBay Buy-It-Now may be either, and of the two possible
      // mistakes, calling a new item secondhand only makes a buyer more
      // careful, while the reverse could have them overpay.
      source: domain === 'ebay.com' ? 'secondhand' : 'new',
      condition: null,
      priceContext: null,
      onlyOne: false,
      endsAt: null,
      riskFlag: null,
      // The storefront's own bar for a well-reviewed item, and only when
      // enough ratings back it to mean anything.
      wellReviewed: pick.rating !== null && pick.rating >= 4.5 && (pick.reviewCount ?? 0) >= 50,
      // Cautions come from the quality pipeline reading a review corpus. There
      // is none behind a pick, and inventing one would be worse than silence.
      caution: null,
    },
    media: { hero: heroFrom(pick.imageUrl), galleryCount: pick.imageUrl === null ? 0 : 1, gallery: [], video: null },
    reviews: { count: pick.reviewCount ?? 0, meanRating: pick.rating },
    upvotes: 0,
    otherOffers: null,
    auction: null,
    // False: there is no catalog row to add, so the rail deep-links to the
    // merchant instead — the path auction cards already take.
    canAddToCart: false,
    warning: null,
    isExploration: false,
    explorationTopic: null,
  };
}

/** Picks the feed can actually render. One without an image is a black card. */
export function picksToCards(picks: readonly ChatPickResponse[]): ProductCard[] {
  return picks.filter((pick) => pick.imageUrl !== null).map(pickToCard);
}
