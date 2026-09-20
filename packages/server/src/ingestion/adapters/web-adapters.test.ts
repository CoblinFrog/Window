import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseAmazonDetail, parseAmazonReviews, parseAmazonSearch } from './amazon-web.js';
import { parseEbayBrowse, parseEbayFeedbackProfile, parseEbayItem } from './ebay-web.js';
import { extractJson } from '../../agent/llm.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`__fixtures__/${name}`, import.meta.url)), 'utf8');
}

describe('parseAmazonSearch', () => {
  const { items, nav } = parseAmazonSearch(fixture('amz-s.html'), 'https://www.amazon.com/s?k=test');

  it('extracts listings with real ASINs and canonical dp urls', () => {
    assert.ok(items.length > 10, `expected search results, got ${items.length}`);
    for (const item of items) {
      assert.match(item.sourceId, /^[A-Z0-9]{10}$/);
      assert.match(item.url, /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/);
    }
  });

  it('carries title and price hints from the results page', () => {
    const priced = items.filter((i) => i.priceHint !== null && i.priceHint > 0);
    assert.ok(priced.length > items.length / 2, `only ${priced.length} priced of ${items.length}`);
    assert.ok(items.every((i) => (i.titleHint ?? '').length > 5));
  });

  it('offers nav links worth following', () => {
    assert.ok(nav.length > 0);
    assert.ok(nav.every((u) => u.startsWith('https://www.amazon.com')));
  });
});

describe('parseAmazonDetail', () => {
  const parsed = parseAmazonDetail(
    fixture('amz-dp2.html'),
    'https://www.amazon.com/dp/B09LK73VHG',
  );

  it('extracts title, price, and currency', () => {
    assert.ok(parsed.title !== null && parsed.title.length > 5);
    assert.equal(parsed.priceAmountMinor, 15499);
    assert.equal(parsed.currency, 'USD');
  });

  it('extracts brand, gallery images, and the breadcrumb', () => {
    assert.ok(parsed.brand !== null && parsed.brand.length > 1);
    assert.ok(parsed.images.length >= 1);
    assert.ok(parsed.images.every((i) => i.url.startsWith('https://')));
    assert.ok(parsed.breadcrumb.length >= 2);
  });

  it('extracts the ASIN identifier and a seller', () => {
    assert.equal(parsed.identifiers.asin, 'B09LK73VHG');
    assert.ok(parsed.seller !== null);
  });
});

describe('parseAmazonReviews', () => {
  // The detail page embeds Amazon's review aggregation in base64 k-injected
  // component payloads rather than DOM markup.
  const blob = (kdata: Record<string, unknown>) =>
    `<!-- k-injected k+b64 ${Buffer.from(JSON.stringify({ 'k-data': kdata })).toString('base64')} -->`;
  const html = `<html><body>
    <a id="acrPopover" title="4.2 out of 5 stars"></a>
    ${blob({ fragments: [{ inertText: 'Customers like the keyboard overall.' }] })}
    ${blob({
      aspectsFlattened: [
        {
          label: 'build quality', sentiment: 'positive', mentions: 87,
          summary: 'Customers appreciate the sturdy build.',
          snippets: [
            {
              review: { url: '/portal/customer-reviews/srp/-/R123ABC' },
              text: { fragments: [
                { text: '...feels ' },
                { semanticContent: { strong: true, content: { text: 'solid' } } },
                { text: ' in hand...' },
              ] },
            },
          ],
        },
        {
          label: 'connectivity', sentiment: 'mixed', mentions: 111,
          summary: 'Mixed experiences with bluetooth pairing.',
          snippets: [],
        },
      ],
    })}
    ${blob({ aspectsFlattened: [
      {
        label: 'build quality', sentiment: 'positive', mentions: 87,
        summary: 'Customers appreciate the sturdy build.',
        snippets: [
          {
            review: { url: '/portal/customer-reviews/srp/-/R123ABC' },
            text: { fragments: [{ text: '...feels solid in hand...' }] },
          },
        ],
      },
    ] })}
  </body></html>`;
  const reviews = parseAmazonReviews(html, 'https://www.amazon.com/dp/B09LK73VHG');

  it('extracts the consensus, aspect verdicts, and real excerpts', () => {
    const consensus = reviews.filter((r) => r.authorHandle === 'customers-say');
    const aspects = reviews.filter((r) => r.authorHandle?.startsWith('aspect:'));
    const snippets = reviews.filter((r) => r.authorHandle === null);
    assert.equal(consensus.length, 1);
    assert.equal(consensus[0]?.rating, 4.2, 'consensus carries the page rating');
    assert.equal(aspects.length, 2);
    assert.equal(aspects[0]?.helpfulCount, 87, 'aspect entries carry the mention count');
    assert.equal(snippets.length, 1);
    assert.match(snippets[0]?.text ?? '', /feels solid in hand/);
  });

  it('maps aspect sentiment onto the 5-point scale and dedupes repeated payloads', () => {
    const build = reviews.filter((r) => r.authorHandle === 'aspect:build quality');
    const conn = reviews.filter((r) => r.authorHandle === 'aspect:connectivity');
    assert.equal(build.length, 1, 'the same aspect blob twice counts once');
    assert.equal(build[0]?.rating, 5);
    assert.equal(conn[0]?.rating, 3);
    const snippet = reviews.find((r) => r.authorHandle === null);
    // The payload does not say what the reviewer actually gave — the aspect's
    // sentiment is not their star, so excerpts carry no rating.
    assert.equal(snippet?.rating, null);
    assert.equal(snippet?.sourceUrl, 'https://www.amazon.com/portal/customer-reviews/srp/-/R123ABC');
  });
});

describe('parseEbayBrowse', () => {
  const { items, nav } = parseEbayBrowse(
    fixture('ebay-b.html'),
    'https://www.ebay.com/b/Headphones/bn_2310255',
  );

  it('extracts item links with stable numeric ids', () => {
    assert.ok(items.length >= 30, `expected ~60 cards, got ${items.length}`);
    const ids = new Set(items.map((i) => i.sourceId));
    assert.equal(ids.size, items.length, 'item ids should be unique per card');
    for (const item of items) {
      assert.match(item.sourceId, /^\d{6,}$/);
      assert.equal(item.url, `https://www.ebay.com/itm/${item.sourceId}`);
    }
  });

  it('carries title hints from the card image alt', () => {
    const titled = items.filter((i) => (i.titleHint ?? '') !== '');
    assert.ok(titled.length > items.length / 2);
  });

  it('collects category nav links, not item links', () => {
    assert.ok(nav.length > 0);
    assert.ok(nav.every((u) => !/\/itm\//.test(u)));
  });
});

describe('parseEbayItem', () => {
  const parsed = parseEbayItem(
    fixture('ebay-itm-ok.html'),
    'https://www.ebay.com/itm/201908152643',
    '201908152643',
  );

  it('extracts title, brand, and identifiers from the product graph', () => {
    assert.match(parsed.title ?? '', /Zep Commercial/i);
    assert.equal(parsed.brand, 'Zep');
    assert.equal(parsed.identifiers.gtin, '0021709009415');
  });

  it("prices the viewed item's offer, not the first offer in the graph", () => {
    assert.equal(parsed.priceAmountMinor, 2928);
    assert.equal(parsed.currency, 'USD');
  });

  it('extracts images, availability, and the breadcrumb', () => {
    assert.ok(parsed.images.length >= 2);
    assert.equal(parsed.availabilityText, 'InStock');
    assert.ok(parsed.breadcrumb.includes('Home & Garden'));
  });

  it('names the real seller, not a review author, with feedback metrics', () => {
    // The page's /usr/ anchors are review authors; the seller's username lives
    // in the embedded USER_PROFILE action.
    assert.equal(parsed.seller?.handle, 'mid-atlanticmerchants');
    assert.equal(parsed.seller?.displayName, 'Mid-Atlantic Merchants');
    assert.equal(parsed.seller?.profileUrl, 'https://www.ebay.com/usr/mid-atlanticmerchants');
    assert.equal(parsed.seller?.reviewCount, 83032);
    assert.equal(parsed.seller?.rating, 99.1);
    assert.equal(parsed.seller?.ratingScale, 100);
  });
});

describe('parseEbayFeedbackProfile', () => {
  const reviews = parseEbayFeedbackProfile(
    fixture('ebay-fdbk.html'),
    'https://www.ebay.com/fdbk/feedback_profile/mid-atlanticmerchants',
    new Date('2026-09-19T00:00:00Z'),
  );

  it('extracts one review per feedback row, none from the summary table', () => {
    // The page carries 25 entries; the verdict icons in the ratings-summary
    // table must not be counted as reviews.
    assert.equal(reviews.length, 25);
    assert.ok(reviews.every((r) => r.text.length > 0));
    assert.ok(reviews.every((r) => r.sourceUrl.startsWith('https://www.ebay.com/fdbk/')));
  });

  it('maps the verdict icon onto the 5-point scale', () => {
    const ratings = reviews.map((r) => r.rating);
    assert.ok(ratings.includes(1), 'negative feedback maps to 1');
    assert.ok(ratings.includes(5), 'positive feedback maps to 5');
    assert.ok(reviews.every((r) => r.ratingScale === 5));
  });

  it('carries masked author, verified flag, and an approximated date', () => {
    assert.ok(reviews.every((r) => r.authorHandle !== null));
    assert.ok(reviews.some((r) => r.verifiedPurchase === true));
    const oldest = reviews.reduce((a, b) => (a.postedAt < b.postedAt ? a : b));
    assert.ok(oldest.postedAt.getTime() < Date.parse('2026-03-19'), 'a "past year" row is ~365d back');
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    assert.deepEqual(extractJson('{"pick":["a"],"follow":[],"done":false}'), {
      pick: ['a'],
      follow: [],
      done: false,
    });
  });

  it('finds the object inside prose and fences', () => {
    const reply = 'Here is my plan:\n```json\n{"pick": ["x"], "follow": ["u"], "done": true}\n```\nHope that helps';
    assert.deepEqual(extractJson(reply), { pick: ['x'], follow: ['u'], done: true });
  });

  it('returns null when no object exists', () => {
    assert.equal(extractJson('no json here'), null);
  });
});
