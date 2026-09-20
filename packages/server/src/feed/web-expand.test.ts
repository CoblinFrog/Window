import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { expandFromWeb } from './web-expand.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../ingestion/adapters/__fixtures__/${name}`, import.meta.url)),
    'utf8',
  );
}

const SITEMAP_INDEX = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://www.ebay.com/lst/BROWSE-0-0000001.xml.gz</loc></sitemap>
  <sitemap><loc>https://www.ebay.com/lst/BROWSE-0-0000002.xml.gz</loc></sitemap>
</sitemapindex>`;

const CHILD_SITEMAP = `<?xml version="1.0"?><urlset>
  <url><loc>https://www.ebay.com/b/Zep-Cleaning-Products/181939</loc></url>
  <url><loc>https://www.ebay.com/b/Headphones/112529</loc></url>
  <url><loc>https://www.ebay.com/b/Trading-Cards/261328</loc></url>
</urlset>`;

/** The whole fake web: amazon search/detail and ebay browse/item pages. */
function fakeFetch(input: string): Promise<Response> {
  if (/\/s\?k=/.test(input)) {
    return Promise.resolve(new Response(fixture('amz-s.html'), { status: 200 }));
  }
  if (input.includes('/dp/')) {
    return Promise.resolve(new Response(fixture('amz-dp2.html'), { status: 200 }));
  }
  if (input === 'https://www.ebay.com/b/Zep-Cleaning-Products/181939') {
    return Promise.resolve(new Response(fixture('ebay-b.html'), { status: 200 }));
  }
  if (input.startsWith('https://www.ebay.com/itm/')) {
    return Promise.resolve(new Response(fixture('ebay-itm-ok.html'), { status: 200 }));
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

function fakeSitemap(url: string): Promise<string | null> {
  if (url.includes('BROWSE-0-index')) return Promise.resolve(SITEMAP_INDEX);
  if (url.includes('0000001')) return Promise.resolve(CHILD_SITEMAP);
  return Promise.resolve(null);
}

const llm = { decide: async () => '{"queries": ["zep cleaner"]}' };

const DEPS = { llm, fetchImpl: fakeFetch, sitemapBody: fakeSitemap, intervalMs: 0 };

describe('expandFromWeb', () => {
  it('turns anchor titles into live listings from both storefronts', async () => {
    const found = await expandFromWeb(['Zep Commercial Bathroom Cleaner'], 8, DEPS);
    const domains = new Set(found.map((l) => l.sourceDomain));
    assert.ok(domains.has('amazon.com'), 'amazon search contributed');
    assert.ok(domains.has('ebay.com'), 'ebay sitemap leg contributed');
    for (const listing of found) {
      assert.ok(listing.title !== null && listing.title.length > 5);
      assert.ok(listing.url.startsWith('https://'));
    }
  });

  it('gives eBay a share even when Amazon could fill the whole quota', async () => {
    // Each source gets half of `needed` — eBay is a peer, not a top-up.
    const found = await expandFromWeb(['Zep Commercial Bathroom Cleaner'], 2, DEPS);
    const domains = new Set(found.map((l) => l.sourceDomain));
    assert.ok(domains.has('ebay.com'), 'ebay ran despite amazon having results');
  });

  it('respects the needed cap', async () => {
    const found = await expandFromWeb(['Zep Commercial Bathroom Cleaner'], 1, DEPS);
    assert.ok(found.length <= 1);
  });

  it('dedupes by domain + sourceId', async () => {
    const found = await expandFromWeb(['Zep Commercial Bathroom Cleaner'], 10, DEPS);
    const keys = found.map((l) => `${l.sourceDomain}:${l.sourceId}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('returns nothing for empty anchors without calling the llm', async () => {
    let called = false;
    const found = await expandFromWeb([], 5, {
      ...DEPS,
      llm: { decide: async () => { called = true; return '{}'; } },
    });
    assert.equal(found.length, 0);
    assert.equal(called, false);
  });
});
