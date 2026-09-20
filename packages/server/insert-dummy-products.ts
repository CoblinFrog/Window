import { createClient } from '@supabase/supabase-js';
import { env } from './src/config/env.js';
import { mediaPipeline } from './src/media/pipeline.js';
import { localEmbeddingProvider } from './src/embedding/local.js';

const client = createClient(env.supabaseUrl, env.supabaseKey);

const sellerId = '00000000-0000-4000-8000-000000000004';
const productIds = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
];

const now = new Date().toISOString();

/**
 * Dummy imagery goes through the same pipeline real ingestion uses, so the
 * URLs it writes are ones the media route can actually serve. Hand-written
 * `/media/dummy/<name>.avif` paths do not match the `/media/:key/:width` route
 * and 404, which renders the feed as four blank tiles.
 */
const media = mediaPipeline();
const image = (name: string) =>
  media.ingestImage({
    // The `window://` scheme is what routes this to the synthetic generator.
    // An http(s) identifier is sent to the fetching pipeline instead, which
    // tries to download bytes that do not exist and returns a null hero.
    sourceUrl: `window://generated/example.com/window-dummy/${name}`,
    width: 1440,
    height: 1440,
  });

const seller = {
  id: sellerId,
  source_domain: 'example.com',
  source_seller_id: 'window-dummy-seller',
  handle: 'window-demo-shop',
  type: 'retailer',
  display_name: 'Window Demo Shop',
  avatar_url: null,
  profile_url: 'https://example.com',
  metrics: { rating: 4.8, reviewCount: 124, salesCount: 980, memberSince: now, responseTime: 'under 1 hour' },
  policies: { returnWindowDays: 30, shippingSummary: 'Free standard shipping' },
  auction_terms: null,
  live_listing_count: 4,
  trust: { score: 0.92, flags: [] },
  suppressed: false,
  created_at: now,
  updated_at: now,
};

const base = {
  raw_title: '',
  original_price: null,
  shipping: { amount: 0, currency: 'USD', freeThreshold: null },
  condition: 'new',
  auction: null,
  specs: [],
  quality: {
    score: 0.9,
    reviewAdj: 0.9,
    corpusDepth: 0.8,
    sentimentConsistency: 0.9,
    listingCompleteness: 0.95,
    engagement: 0.5,
    credibilityFactor: 0.9,
    cautions: [],
    computedAt: now,
  },
  risk: {
    score: 0.05,
    tier: 'clear',
    signals: [],
    modelVersion: 'dummy-v1',
    reports: { count: 0, upheld: 0 },
    reviewedBy: null,
    reviewedAt: null,
    computedAt: now,
  },
  engagement: { impressions: 0, interactions: 0, ctrSmoothed: 0, cartAdds: 0 },
  crawl: {
    firstSeenAt: now,
    lastCrawledAt: now,
    lastChangedAt: now,
    failCount: 0,
    tier: 1,
  },
  status: 'active',
  reject_reason: null,
  seller_id: sellerId,
  cluster_id: null,
  source_type: 'new',
  source: { domain: 'example.com', sourceId: 'window-dummy', tier: 1, url: 'https://example.com' },
};

/**
 * Prices sit inside a single 2.5x band on purpose. Window mode only emits a
 * pane when it can assemble four items from one L2 whose cheapest and dearest
 * are within `quads.priceBandMultiplier` of each other; at the original
 * 8.99-49.99 spread (5.6x) no quad could form, every page fell through to the
 * popularity ladder, and the grid never showed a ranked window.
 */
const catalogue: Array<[string, string, number, string]> = [
  ['00000000-0000-4000-8000-000000000101', 'Wireless Bluetooth Headphones', 4999, 'headphones'],
  ['00000000-0000-4000-8000-000000000102', 'USB-C Charging Cable (2m, Braided)', 2199, 'charging-cable'],
  ['00000000-0000-4000-8000-000000000103', 'Portable Power Bank 10000mAh', 2999, 'power-bank'],
  ['00000000-0000-4000-8000-000000000104', 'Adjustable Aluminium Phone Stand', 2499, 'phone-stand'],
];

/**
 * The vector index is sized to `EMBEDDING_DIM` (1024) and scores by dot
 * product, so the previous 128-slot all-zero placeholder scored identically
 * against every query and left ranking with nothing to order by. Embedding
 * through the real provider gives each product a vector of the right width.
 */
const embedder = localEmbeddingProvider();

const products = await Promise.all(
  catalogue.map(async ([id, title, amount, imageName]) => ({
    ...base,
    id,
    title,
    raw_title: title,
    price: { amount, currency: 'USD' },
    stock: { inStock: true, quantity: 100, singleUnit: true },
    brand: 'Window Demo',
    identifiers: {},
    category: { l1: 'tech', l2: 'phones', l3: 'phone-accessories' },
    media: { hero: await image(imageName), gallery: [], video: null },
    embedding: await embedder.embed({
      title,
      brand: 'Window Demo',
      category: { l1: 'tech', l2: 'phones', l3: 'phone-accessories' },
      priceAmount: amount,
      imageDescriptor: imageName,
    }),
    embedding_version: embedder.version,
  })),
);

async function main(): Promise<void> {
  if (!env.supabaseUrl || !env.supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in packages/server/.env');
  }

  const { error: sellerError } = await client.from('sellers').upsert(seller, { onConflict: 'id' });
  if (sellerError) throw sellerError;

  const { error: productError } = await client.from('products').upsert(products, { onConflict: 'id' });
  if (productError) throw productError;

  const { data, error: verifyError } = await client
    .from('products')
    .select('id,title,price,status,seller_id')
    .in('id', productIds)
    .order('title');
  if (verifyError) throw verifyError;

  console.log(`Inserted/updated ${data.length} dummy products:`);
  for (const product of data) console.log(`- ${product.title} (${product.id})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
