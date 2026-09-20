/**
 * Seeds a merchant's demo products straight into the catalog.
 *
 * The normal path is `npm run ingest -- --store <domain>`, which reads a
 * store's public `/products.json`. A Shopify development store is always
 * password-protected, so that endpoint returns the password page instead of a
 * catalog and ingestion has nothing to read. This writes the rows directly,
 * which is the honest way to get a private store's dummy products in front of
 * the ranker for a demo.
 *
 * Media and embedding are borrowed from an existing row: the point is the
 * checkout path, not the imagery, and a product with no embedding cannot be
 * retrieved at all.
 *
 *   SEED_STORE_DOMAIN=my-store.myshopify.com \
 *   SEED_STORE_PRODUCTS='[{"title":"Demo Mug","price":1800,"url":"https://my-store.myshopify.com/products/demo-mug"}]' \
 *   npx tsx packages/server/src/scripts/seed-store.ts
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';

interface SeedProduct {
  title: string;
  /** Minor units. 1800 is $18.00. */
  price: number;
  /** The product page on the store. The agent never needs it, the card does. */
  url: string;
  quantity?: number;
}

const domain = process.env.SEED_STORE_DOMAIN;
const raw = process.env.SEED_STORE_PRODUCTS;
if (!domain || !raw) {
  console.log('Set SEED_STORE_DOMAIN and SEED_STORE_PRODUCTS. See the comment at the top of this file.');
  process.exit(1);
}

let products: SeedProduct[];
try {
  products = JSON.parse(raw) as SeedProduct[];
} catch (error) {
  console.log('SEED_STORE_PRODUCTS is not valid JSON:', (error as Error).message);
  process.exit(1);
}

const client = createClient(env.supabaseUrl, env.supabaseKey);

/** A stable uuid per (domain, title), so re-running updates rather than duplicates. */
function idFor(title: string): string {
  const h = createHash('sha256').update(`${domain}:${title}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}

const { data: sample, error: sampleError } = await client
  .from('products')
  .select('media, embedding, embedding_version, seller_id, engagement, crawl')
  .not('embedding', 'is', null)
  .limit(1)
  .single();
if (sampleError || !sample) {
  console.log('could not read a template product:', sampleError?.message);
  process.exit(1);
}

const { error: sourceError } = await client.from('sources').upsert({
  id: domain,
  display_name: domain.replace(/\.myshopify\.com$/, ''),
  tier: 1,
  source_type: 'new',
  crawl_policy: { rps: 0.5, backoff: 'exponential', proxyPool: 'none', concurrency: 1, allowedHours: [0, 24] },
  staleness_ceiling_hours: 12,
  extractors: { detail: 'web', listing: '{"strategy":"web"}' },
  health: { window: [], errorRate: 0, circuitOpen: false, lastSuccessAt: null, circuitOpenedAt: null },
  // Your own store, whose robots.txt you control. The driver still checks it.
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

for (const product of products) {
  const id = idFor(product.title);
  const { error } = await client.from('products').upsert({
    id,
    cluster_id: null,
    title: product.title,
    raw_title: product.title,
    brand: null,
    identifiers: {},
    category: { l1: 'home', l2: 'home-office', l3: 'stationery' },
    price: { amount: product.price, currency: 'USD' },
    original_price: null,
    shipping: { amount: 0, currency: 'USD', freeThreshold: null },
    condition: 'new',
    stock: { inStock: true, quantity: product.quantity ?? 10, singleUnit: false },
    auction: null,
    specs: [],
    source: { url: product.url, tier: 1, domain, sourceId: 'demo-store' },
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
  if (error) {
    console.log(`  ${product.title}: FAILED — ${error.message}`);
    continue;
  }
  console.log(`  seeded ${product.title} (${id})`);
}

console.log(`\n${products.length} product(s) seeded for ${domain}.`);
console.log('Restart the server if the vector index does not pick them up.');
