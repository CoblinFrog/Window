import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatPickResponse } from '@window/shared';
import { pickToCard, picksToCards } from './pickCard.js';

/**
 * These cards go straight into the feed, where every other card is backed by a
 * catalog row. What is being guarded is the seam: the projection must not claim
 * anything the storefront did not tell us, and must switch off every affordance
 * that would need a row behind it.
 */

function pick(overrides: Partial<ChatPickResponse> = {}): ChatPickResponse {
  return {
    productId: 'web:amazon.com:B0CLLHSWRL',
    title: 'AULA F99 Wireless Mechanical Keyboard',
    priceMinor: 6899,
    currency: 'USD',
    url: 'https://www.amazon.com/dp/B0CLLHSWRL',
    imageUrl: 'https://m.media-amazon.com/images/I/61mB8mL33pL._AC_UL1200_.jpg',
    sourceDomain: 'amazon.com',
    rating: 4.5,
    reviewCount: 3123,
    reviewNote: '4.5★ across 3,123 ratings',
    sources: [],
    ...overrides,
  };
}

describe('pickToCard', () => {
  it('carries across everything the storefront actually told us', () => {
    const card = pickToCard(pick());
    assert.equal(card.productId, 'web:amazon.com:B0CLLHSWRL');
    assert.equal(card.title, 'AULA F99 Wireless Mechanical Keyboard');
    assert.deepEqual(card.price, { amount: 6899, currency: 'USD' });
    assert.equal(card.merchant.domain, 'amazon.com');
    assert.equal(card.reviews.meanRating, 4.5);
    assert.equal(card.reviews.count, 3123);
    // The image has to land where the card readers look for it.
    assert.equal(card.media.hero.avif[0], pick().imageUrl);
    assert.equal(card.media.hero.avif[1], pick().imageUrl);
    assert.equal(card.media.hero.webp[0], pick().imageUrl);
  });

  it('switches off every affordance that would need a catalog row', () => {
    const card = pickToCard(pick());
    // No cluster: the reviews sheet and the detail route are unreachable, and
    // both would 404 against a product the catalog has never seen.
    assert.equal(card.clusterId, null);
    assert.equal(card.canAddToCart, false);
    assert.equal(card.otherOffers, null);
    assert.equal(card.badges.caution, null);
    assert.equal(card.media.gallery.length, 0);
    assert.equal(card.media.video, null);
  });

  it('never claims free shipping it cannot verify', () => {
    // The search card says nothing about shipping, and this is the one wrong
    // guess here that would cost the shopper money.
    assert.equal(pickToCard(pick()).shipping.free, false);
  });

  it('calls an unverified eBay listing secondhand rather than new', () => {
    const ebay = pickToCard(
      pick({ sourceDomain: 'ebay.com', productId: 'web:ebay.com:1', rating: null, reviewCount: null }),
    );
    assert.equal(ebay.badges.source, 'secondhand');
    assert.equal(pickToCard(pick()).badges.source, 'new');
  });

  it('only calls a product well reviewed when enough ratings back it', () => {
    assert.equal(pickToCard(pick({ rating: 4.8, reviewCount: 900 })).badges.wellReviewed, true);
    // Same stars, four ratings: not a verdict.
    assert.equal(pickToCard(pick({ rating: 4.8, reviewCount: 4 })).badges.wellReviewed, false);
    assert.equal(pickToCard(pick({ rating: null, reviewCount: null })).badges.wellReviewed, false);
  });

  it('drops picks with no picture, since a card without one is a black screen', () => {
    const cards = picksToCards([
      pick(),
      pick({ productId: 'web:ebay.com:2', imageUrl: null }),
      pick({ productId: 'web:ebay.com:3' }),
    ]);
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.media.hero.avif[0] !== undefined));
  });
});
