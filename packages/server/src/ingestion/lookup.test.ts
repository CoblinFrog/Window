import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { lookupListing } from './lookup.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`adapters/__fixtures__/${name}`, import.meta.url)),
    'utf8',
  );
}

/** Serves fixture pages by URL pattern, no network. */
function fakeFetch(map: Array<[RegExp, { status: number; body: string }]>) {
  return async (input: string): Promise<Response> => {
    for (const [pattern, page] of map) {
      if (pattern.test(input)) return new Response(page.body, { status: page.status });
    }
    return new Response('not found', { status: 404 });
  };
}

const LIVE_MAP: Array<[RegExp, { status: number; body: string }]> = [
  [/\/dp\/B09LK73VHG/, { status: 200, body: fixture('amz-dp2.html') }],
  [/\/itm\/201908152643/, { status: 200, body: fixture('ebay-itm-ok.html') }],
];

describe('lookupListing', () => {
  it('returns full detail for an amazon /dp/ link', async () => {
    const result = await lookupListing('https://www.amazon.com/dp/B09LK73VHG', {
      fetchImpl: fakeFetch(LIVE_MAP),
    });
    assert.equal(result.status, 'ok');
    const listing = result.listing!;
    assert.ok(listing.title !== null && listing.title.length > 5);
    assert.equal(listing.priceAmountMinor, 15499);
    assert.equal(listing.currency, 'USD');
    assert.equal(listing.identifiers.asin, 'B09LK73VHG');
    assert.equal(listing.url, 'https://www.amazon.com/dp/B09LK73VHG');
    assert.equal(listing.sourceDomain, 'amazon.com');
  });

  it('returns full detail for an ebay /itm/ link', async () => {
    const result = await lookupListing('https://www.ebay.com/itm/201908152643', {
      fetchImpl: fakeFetch(LIVE_MAP),
    });
    assert.equal(result.status, 'ok');
    const listing = result.listing!;
    assert.match(listing.title ?? '', /Zep Commercial/i);
    assert.equal(listing.priceAmountMinor, 2928);
    assert.equal(listing.sourceId, '201908152643');
  });

  it('attaches seller feedback for an ebay listing', async () => {
    const result = await lookupListing('https://www.ebay.com/itm/555666777', {
      fetchImpl: fakeFetch([
        [/\/itm\//, { status: 200, body: fixture('ebay-itm-ok.html') }],
        [/\/fdbk\/feedback_profile\//, { status: 200, body: fixture('ebay-fdbk.html') }],
      ]),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.listing?.seller?.handle, 'mid-atlanticmerchants');
    assert.ok((result.listing?.reviews.length ?? 0) >= 20, 'seller feedback lands in reviews');
    assert.equal(result.digest, null, 'no digest without the reviews dep');
  });

  it('attaches an internet-wide digest when the reviews dep is wired', async () => {
    const llm = {
      async decide(): Promise<string> {
        return JSON.stringify({
          summary: 'Reviewers agree it cleans well but is heavy.',
          sources: [
            { title: 'A review site', url: 'https://reviews.example.com/zep', note: 'lab test' },
            { title: 'Own storefront', url: 'https://www.ebay.com/itm/555666777', note: 'excluded' },
          ],
        });
      },
    };
    const result = await lookupListing('https://www.ebay.com/itm/555666888', {
      fetchImpl: fakeFetch([[/.*/, { status: 200, body: fixture('ebay-itm-ok.html') }]]),
      reviews: { llm },
    });
    assert.equal(result.status, 'ok');
    // The digest is a background promise — the lookup resolves before it does.
    const digest = await result.digest;
    assert.match(digest?.summary ?? '', /cleans well/);
    // Sources on the listing's own domain are dropped — the seller's page is an ad.
    assert.equal(digest?.sources.length, 1);
    assert.equal(digest?.sources[0]?.url, 'https://reviews.example.com/zep');
  });

  it('feeds server-side search hits to the digest when a search dep is wired', async () => {
    let prompt = '';
    const llm = {
      async decide(p: string): Promise<string> {
        prompt = p;
        return JSON.stringify({
          summary: 'Snippets say it cleans well.',
          sources: [{ title: 'Review blog', url: 'https://blog.example.com/zep', note: 'tested' }],
        });
      },
    };
    const search = async () => [
      { title: 'Review blog', url: 'https://blog.example.com/zep', snippet: 'cleans well' },
      { title: 'The listing', url: 'https://www.ebay.com/itm/555666999', snippet: 'same page' },
    ];
    const result = await lookupListing('https://www.ebay.com/itm/555666999', {
      fetchImpl: fakeFetch([[/.*/, { status: 200, body: fixture('ebay-itm-ok.html') }]]),
      reviews: { llm, search },
    });
    const digest = await result.digest;
    assert.match(digest?.summary ?? '', /cleans well/);
    // Evidence lands in the prompt; the listing's own domain is filtered out.
    assert.match(prompt, /blog\.example\.com/);
    assert.doesNotMatch(prompt, /same page/);
  });

  it('reports out_of_stock when the page exists but the item cannot be bought', async () => {
    const unavailable = `<html><body>
      <span id="productTitle">Some Widget</span>
      <div id="corePrice"><span class="a-offscreen">$49.99</span></div>
      <div id="availability"><span>Currently unavailable.</span></div>
    </body></html>`;
    const result = await lookupListing('https://www.amazon.com/dp/B000TEST01', {
      fetchImpl: fakeFetch([[/.*/, { status: 200, body: unavailable }]]),
    });
    assert.equal(result.status, 'out_of_stock');
    assert.equal(result.listing?.title, 'Some Widget');
    assert.equal(result.listing?.priceAmountMinor, 4999);
  });

  it('reports gone when the source answers 404', async () => {
    const result = await lookupListing('https://www.ebay.com/itm/999999999999', {
      fetchImpl: fakeFetch([[/.*/, { status: 404, body: '' }]]),
    });
    assert.equal(result.status, 'gone');
    assert.equal(result.listing, null);
  });

  it('reports unavailable when the page has no product data and is not ended', async () => {
    const result = await lookupListing('https://www.ebay.com/itm/123456789', {
      fetchImpl: fakeFetch([[/.*/, { status: 200, body: '<html><body>hello</body></html>' }]]),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.listing, null);
  });

  it('rejects links outside the supported marketplaces', async () => {
    const result = await lookupListing('https://www.google.com/search?q=x', {
      fetchImpl: fakeFetch(LIVE_MAP),
    });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.listing, null);
  });

  it('rejects malformed urls rather than throwing', async () => {
    const result = await lookupListing('not a url', { fetchImpl: fakeFetch(LIVE_MAP) });
    assert.equal(result.status, 'unsupported');
  });

  it('memoizes terminal answers so a re-tap is a memory read', async () => {
    let fetches = 0;
    const counting = async (input: string): Promise<Response> => {
      fetches += 1;
      return fakeFetch([[/.*/, { status: 200, body: fixture('ebay-itm-ok.html') }]])(input);
    };
    const url = 'https://www.ebay.com/itm/555000111222';
    const first = await lookupListing(url, { fetchImpl: counting });
    const second = await lookupListing(url, { fetchImpl: counting });
    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    // Item page + seller feedback profile on the first call; the second is cached.
    assert.equal(fetches, 2, 'second lookup served from cache');
  });

  it('does not cache transient failures', async () => {
    let fetches = 0;
    const counting = async (input: string): Promise<Response> => {
      fetches += 1;
      return fakeFetch([[/.*/, { status: 200, body: '<html><body>hi</body></html>' }]])(input);
    };
    const url = 'https://www.ebay.com/itm/555000333444';
    await lookupListing(url, { fetchImpl: counting });
    await lookupListing(url, { fetchImpl: counting });
    // 'unavailable' is not memoized: each call pays detail + verify.
    assert.equal(fetches, 4);
  });
});
