/**
 * Inserts the Northwind stand-in product and its source row.
 *
 * This is what makes the browser checkout agent reachable from the app: a cart
 * line whose merchant has a field map, so the agent drives a form instead of
 * handing off. Idempotent — run it as often as you like.
 *
 * The product's media is copied from an existing row rather than generated,
 * because the point of this script is the checkout path, not the imagery.
 *
 *   npx tsx packages/server/src/scripts/seed-mock-merchant.ts
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const client = createClient(env.supabaseUrl, env.supabaseKey);
const PRODUCT_ID = '00000000-0000-4000-8000-0000000009f1';
const ORIGIN = process.env.MOCK_MERCHANT_URL ?? 'http://127.0.0.1:4545';

// Borrow an existing row's media and embedding so the card renders and the
// ranker can place it. Everything else is written explicitly below.
const { data: sample, error: sampleError } = await client
  .from('products')
  .select('media, embedding, embedding_version, seller_id, engagement, crawl')
  .limit(1)
  .single();
if (sampleError || !sample) {
  console.log('could not read a template product:', sampleError?.message);
  process.exit(1);
}

const { error: sourceError } = await client.from('sources').upsert({
  id: 'northwind.test',
  display_name: 'Northwind Supply',
  tier: 1,
  source_type: 'new',
  crawl_policy: { rps: 0.5, backoff: 'exponential', proxyPool: 'none', concurrency: 1, allowedHours: [0, 24] },
  staleness_ceiling_hours: 12,
  extractors: { detail: 'web', listing: '{"strategy":"web"}' },
  health: { window: [], errorRate: 0, circuitOpen: false, lastSuccessAt: null, circuitOpenedAt: null },
  // The agent may drive this one: it publishes a permissive robots.txt and is
  // a stand-in we control, which is exactly what a real retailer is not.
  checkout: {
    protocol: null,
    supported: true,
    blocksAgents: false,
    guestCheckout: true,
    stackableCoupons: false,
  },
  status: 'active',
});
if (sourceError) {
  console.log('sources upsert failed:', sourceError.message);
  process.exit(1);
}

const { error: productError } = await client.from('products').upsert({
  id: PRODUCT_ID,
  cluster_id: null,
  // 6400 minor units matches the subtotal the mock checkout page displays, so
  // the quote the agent reads back lines up with what the cart showed.
  price: { amount: 6400, currency: 'USD' },
  original_price: null,
  shipping: { amount: 0, currency: 'USD', freeThreshold: null },
  title: 'Northwind Field Notebook',
  raw_title: 'Northwind Field Notebook',
  brand: 'Northwind',
  identifiers: {},
  category: { l1: 'home', l2: 'home-office', l3: 'stationery' },
  condition: 'new',
  stock: { inStock: true, quantity: 12, singleUnit: false },
  auction: null,
  specs: [],
  source: { url: `${ORIGIN}/checkout`, tier: 1, domain: 'northwind.test', sourceId: 'mock-merchant' },
  source_type: 'new',
  media: sample.media,
  seller_id: sample.seller_id,
  embedding: sample.embedding,
  embedding_version: sample.embedding_version,
  engagement: sample.engagement,
  crawl: sample.crawl,
  quality: { score: 0.9, cautions: [] },
  risk: { tier: 'clear', score: 0.05, flags: [], reports: { count: 0 } },
  status: 'active',
  reject_reason: null,
});
if (productError) {
  console.log('products upsert failed:', productError.message);
  process.exit(1);
}

console.log(`seeded northwind.test — product ${PRODUCT_ID} at ${ORIGIN}`);
