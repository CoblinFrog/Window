/**
 * Live demo of the two product-facing functions.
 *
 *   node --import tsx scripts/demo-functions.ts [listing-url] [topic ...]
 *
 * `lookupListing` resolves the given Amazon/eBay link (or a real one pulled
 * off eBay's /globaldeals when no URL is passed). `recommendListings` runs
 * with no catalog behind it — Mongo isn't required — so the page it returns
 * comes entirely from the web leg, which is the interesting half anyway.
 */

import { lookupListing } from '../src/ingestion/lookup.js';
import { recommendListings } from '../src/feed/recommend.js';
import { expandFromWeb } from '../src/feed/web-expand.js';
import { localEmbeddingProvider } from '../src/embedding/local.js';
import { claudeCli } from '../src/agent/llm.js';
import { duckDuckGoSearch } from '../src/agent/web-search.js';
import { primedFetch, fetchSitemapBody } from '../src/ingestion/adapters/primed-fetch.js';
import { fetchPage } from '../src/ingestion/adapters/tier2-structured.js';
import { parseEbayBrowse } from '../src/ingestion/adapters/ebay-web.js';
import type { VectorSearch } from '../src/vector/types.js';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('http'));
const topics = args.filter((a) => !a.startsWith('http'));
const money = (minor: number | null | undefined, currency: string | null | undefined) =>
  minor === null || minor === undefined ? '?' : `${currency ?? ''}${(minor / 100).toFixed(2)}`;

/** A real live listing link to demo lookup on. */
async function someLiveListingUrl(): Promise<string> {
  try {
    const page = await fetchPage('https://www.ebay.com/globaldeals',
      { rps: 1, concurrency: 1, proxyPool: 'none' }, 'ebay.com', primedFetch);
    const item = parseEbayBrowse(page.body, page.url).items[0];
    if (item) return item.url;
  } catch {
    // Fall through to the static URL below.
  }
  return 'https://www.amazon.com/dp/B09LK73VHG';
}

const url = urlArg ?? (await someLiveListingUrl());
console.log(`\n=== lookupListing\n${url}\n`);
// The digest is real research, not the model's prior — but evidence gathering
// happens server-side (one DuckDuckGo fetch) so the model is a single cheap,
// tool-less summarization call, all of it in the background while lookup and
// the recommend leg run. The query-suggestion llm is a separate instance.
const looked = await lookupListing(url, {
  reviews: {
    llm: claudeCli({ model: 'haiku', effort: 'low', timeoutMs: 60_000 }),
    search: (query) => duckDuckGoSearch(query, primedFetch),
  },
});
console.log(`status: ${looked.status}`);
if (looked.listing) {
  const l = looked.listing;
  const landed = l.priceAmountMinor === null
    ? null
    : l.priceAmountMinor + (l.shippingAmountMinor ?? 0);
  console.log(`  title:      ${l.title}`);
  console.log(`  price:      ${money(l.priceAmountMinor, l.currency)}`);
  console.log(`  shipping:   ${money(l.shippingAmountMinor, l.currency)}${l.shippingText ? ` (${l.shippingText})` : ''}`);
  console.log(`  landed:     ${money(landed, l.currency)}`);
  console.log(`  brand:      ${l.brand ?? '-'}`);
  console.log(`  sourceId:   ${l.sourceDomain}:${l.sourceId}`);
  console.log(`  url:        ${l.url}`);
  console.log(`  in-stock?:  ${l.availabilityText ?? '(unstated)'}`);
  console.log(`  specs:      ${l.specs.length}  seller: ${l.seller?.displayName ?? '-'}`);
  console.log(`  images (${l.images.length}):`);
  for (const image of l.images) console.log(`    ${image.url}`);
  const label = l.sourceDomain === 'ebay.com' ? 'seller feedback' : 'reviews';
  console.log(`  ${label} (${l.reviews.length}):`);
  for (const review of l.reviews) {
    const text = review.text.replace(/\s+/g, ' ').trim();
    const stars = review.rating === null ? '    ' : `${review.rating}/${review.ratingScale}`;
    console.log(`    ${stars} ${review.authorHandle ?? 'anon'} — ${text.slice(0, 140)}`);
  }
}
if (looked.digest !== null) console.log('  internet reviews: researching in the background…');

console.log('\n=== recommendListings (catalog empty — web leg only)');
const embedder = localEmbeddingProvider();
const prefs = await embedder.embedText(topics.join(' ') || 'tech gadgets');
const recent = await embedder.embedText(topics[0] ?? 'sharp tv');

const emptyIndex: VectorSearch = {
  kind: 'local',
  async search() { return []; },
  async size() { return 0; },
};

const llm = claudeCli();
const page = await recommendListings(emptyIndex, {
  preferences: prefs,
  recent,
  recentWeight: 0.6,
  limit: 12,
  topics: topics.length > 0 ? topics : ['mechanical keyboard', 'sharp tv'],
}, {
  web: (anchors, needed) =>
    expandFromWeb(anchors, needed, {
      llm,
      fetchImpl: primedFetch,
      sitemapBody: fetchSitemapBody,
      intervalMs: 800,
    }),
  embedder,
});

console.log(`${page.length} listings:\n`);
for (const item of page) {
  console.log(`  ${item.score.toFixed(3)}  [${item.origin}]  ${money(item.price, item.currency)}  ${item.title}`);
  console.log(`           ${item.url}`);
  console.log(`           image: ${item.imageUrl ?? '-'}`);
}

// The digest has been researching while everything above ran — usually done.
const digest = await looked.digest;
if (digest) {
  console.log(`\n=== internet reviews — ${digest.sources.length} sources:`);
  console.log(`  ${digest.summary}`);
  for (const s of digest.sources) {
    console.log(`  - ${s.title} <${s.url}>${s.note ? ` — ${s.note}` : ''}`);
  }
} else if (looked.digest !== null) {
  console.log('\n=== internet reviews: none found');
}
