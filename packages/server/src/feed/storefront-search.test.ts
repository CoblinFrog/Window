import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  amazonSearchUrl,
  ebaySearchUrl,
  searchStorefronts,
  storefrontOf,
  upscale,
} from './storefront-search.js';
import type { FetchLike } from '../ingestion/adapters/tier2-structured.js';

const FIXTURES = new URL('../ingestion/adapters/__fixtures__/', import.meta.url);
const fixture = (name: string): Promise<string> => readFile(new URL(name, FIXTURES), 'utf8');

/** Serves each storefront its own body, and records what was requested. */
function fakeFetch(
  bodies: { amazon?: string | Error; ebay?: string | Error },
  seen: string[] = [],
): FetchLike {
  return async (input: string) => {
    seen.push(input);
    const which = input.includes('amazon.com') ? bodies.amazon : bodies.ebay;
    if (which === undefined) return new Response('', { status: 404 });
    if (which instanceof Error) throw which;
    return new Response(which, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

describe('storefrontOf', () => {
  it('accepts the storefronts and their locales, and nothing else', () => {
    assert.equal(storefrontOf('https://www.amazon.com/dp/B0CLLHSWRL'), 'amazon.com');
    assert.equal(storefrontOf('https://smile.amazon.co.uk/dp/B0CLLHSWRL'), 'amazon.com');
    assert.equal(storefrontOf('https://www.ebay.com/itm/123'), 'ebay.com');
    assert.equal(storefrontOf('https://www.ebay.co.uk/itm/123'), 'ebay.com');
    assert.equal(storefrontOf('https://www.walmart.com/ip/1'), null);
    // A lookalike that merely contains the name is not the storefront.
    assert.equal(storefrontOf('https://amazon.evil.com/dp/X'), null);
    assert.equal(storefrontOf('not a url'), null);
    assert.equal(storefrontOf(null), null);
  });
});

describe('upscale', () => {
  it('asks each CDN for a full-bleed variant of the same image', () => {
    assert.equal(
      upscale('https://m.media-amazon.com/images/I/61++ok6AqtL._AC_UY218_.jpg'),
      'https://m.media-amazon.com/images/I/61++ok6AqtL._AC_UL1200_.jpg',
    );
    assert.equal(
      upscale('https://i.ebayimg.com/images/g/fH8AAOSw/s-l225.jpg'),
      'https://i.ebayimg.com/images/g/fH8AAOSw/s-l1600.jpg',
    );
  });

  it('leaves anything it does not recognise alone', () => {
    // A small image beats a broken one, so an unknown host is never rewritten.
    assert.equal(upscale('https://example.com/pic.jpg'), 'https://example.com/pic.jpg');
    assert.equal(upscale('https://m.media-amazon.com/images/I/plain.jpg'), 'https://m.media-amazon.com/images/I/plain.jpg');
    assert.equal(upscale(null), null);
    assert.equal(upscale(''), null);
  });
});

describe('search urls', () => {
  it('states the budget as the storefront\'s own price refinement', () => {
    // Amazon's p_36 is in cents; eBay's _udhi is in whole currency units.
    assert.match(amazonSearchUrl('mechanical keyboard', 8000), /rh=p_36%3A-8000/);
    assert.match(ebaySearchUrl('mechanical keyboard', 8000), /_udhi=80\.00/);
    assert.match(ebaySearchUrl('mechanical keyboard', 8000), /LH_BIN=1/);
  });

  it('omits the refinement when no budget was stated', () => {
    assert.ok(!amazonSearchUrl('desk lamp', null).includes('p_36'));
    assert.ok(!ebaySearchUrl('desk lamp', null).includes('_udhi'));
  });
});

describe('searchStorefronts', () => {
  it('parses cards off both storefronts and interleaves them', async () => {
    const seen: string[] = [];
    const cards = await searchStorefronts('mechanical keyboard', 8000, 6, {
      fetchImpl: fakeFetch(
        { amazon: await fixture('amz-s.html'), ebay: await fixture('ebay-b.html') },
        seen,
      ),
    });
    assert.equal(seen.length, 2, 'one fetch per storefront, no detail fetches');
    assert.ok(cards.length > 0);
    assert.ok(cards.every((c) => c.title !== ''));
    assert.ok(cards.every((c) => ['amazon.com', 'ebay.com'].includes(c.storefront)));
    // Interleaved: the first two cards come from different storefronts.
    assert.notEqual(cards[0]!.storefront, cards[1]!.storefront);
    assert.ok(cards.length <= 6, 'limit respected');
  });

  it('reads price, image and rating off the Amazon card — no detail fetch', async () => {
    const cards = await searchStorefronts('mechanical keyboard', null, 20, {
      fetchImpl: fakeFetch({ amazon: await fixture('amz-s.html') }),
    });
    const amazon = cards.filter((c) => c.storefront === 'amazon.com');
    assert.ok(amazon.length > 0);
    assert.ok(amazon.some((c) => c.priceMinor !== null), 'a price the reply can quote');
    const withImage = amazon.find((c) => c.imageUrl !== null);
    assert.ok(withImage !== undefined, 'a thumbnail the card can render');
    assert.match(withImage.imageUrl as string, /^https:\/\/m\.media-amazon\.com\/images\//);
    // Card images arrive full-bleed sized, not at the search grid's ~218px.
    assert.match(withImage.imageUrl as string, /_AC_UL1200_/);
    const rated = amazon.find((c) => c.rating !== null);
    assert.ok(rated !== undefined, 'review evidence, free with the page we already fetched');
    assert.ok((rated.rating as number) > 0 && (rated.rating as number) <= 5);
    assert.ok((rated.reviewCount as number) > 0);
    assert.ok(amazon.every((c) => c.url.startsWith('https://www.amazon.com/dp/')));
  });

  it('reads the lazy-loaded thumbnail off the eBay card, never the spacer gif', async () => {
    const cards = await searchStorefronts('stamps', null, 20, {
      fetchImpl: fakeFetch({ ebay: await fixture('ebay-b.html') }),
    });
    const ebay = cards.filter((c) => c.storefront === 'ebay.com');
    assert.ok(ebay.length > 0);
    const withImage = ebay.find((c) => c.imageUrl !== null);
    assert.ok(withImage !== undefined);
    assert.match(withImage.imageUrl as string, /^https:\/\/i\.ebayimg\.com\//);
    assert.ok(
      ebay.every((c) => c.imageUrl === null || !c.imageUrl.includes('ebaystatic.com/cr/')),
      'the 1x2 placeholder is not a product image',
    );
  });

  it('still answers when one storefront fails or gates us', async () => {
    const cards = await searchStorefronts('mechanical keyboard', null, 10, {
      fetchImpl: fakeFetch({
        amazon: await fixture('amz-s.html'),
        ebay: new Error('connection reset'),
      }),
    });
    assert.ok(cards.length > 0, 'the live storefront carries the answer alone');
    assert.ok(cards.every((c) => c.storefront === 'amazon.com'));
  });

  it('returns nothing rather than throwing when both fail', async () => {
    const cards = await searchStorefronts('mechanical keyboard', null, 10, {
      fetchImpl: fakeFetch({ amazon: new Error('down'), ebay: new Error('down') }),
    });
    assert.deepEqual(cards, []);
  });

  it('does not fetch for an empty query', async () => {
    const seen: string[] = [];
    const cards = await searchStorefronts('   ', null, 10, { fetchImpl: fakeFetch({}, seen) });
    assert.deepEqual(cards, []);
    assert.equal(seen.length, 0);
  });
});
