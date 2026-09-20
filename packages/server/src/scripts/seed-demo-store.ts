/**
 * Seeds the demo storefront's products into the catalog.
 *
 * These are the listings the checkout path is demonstrated against, so they
 * are pinned to every page of the scroll (see `feed/pinned.ts`) and they have
 * to read as ordinary catalog rows rather than as fixtures: real copy off the
 * store, the real photograph transcoded onto our own media route, a real
 * embedding, and the store's own merchant identity rather than the hostname
 * its platform issued it.
 *
 * Run it after any change to the store's titles, prices or imagery:
 *
 *   npm run seed:demo-store -w @window/server
 *   npm run seed:demo-store -w @window/server -- --dry-run
 *
 * Ids are derived from (domain, handle), so re-running updates the same rows
 * rather than growing a second copy of them.
 */

import { createClient } from '@supabase/supabase-js';
import { CATEGORY_NODES, categoryPath } from '@window/shared';
import { demoProductId, demoSellerId, demoStore } from '../config/demo-store.js';
import { env } from '../config/env.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import { mediaPipeline } from '../media/pipeline.js';

const dryRun = process.argv.includes('--dry-run');

const store = demoStore();
if (!store) {
  console.log('No demo store configured. Set DEMO_STORE_ORIGIN, or see src/config/demo-store.ts.');
  process.exit(1);
}

const client = createClient(env.supabaseUrl, env.supabaseKey);
const media = mediaPipeline();
const embedder = localEmbeddingProvider();
const now = new Date().toISOString();

interface ShopifyImage {
  src: string;
  width: number;
  height: number;
}
interface ShopifyProduct {
  title: string;
  body_html: string;
  handle: string;
  variants: { id: number; price: string; inventory_quantity: number | null }[];
  images: ShopifyImage[];
}

/** The store's own description, as plain text and bounded. */
function descriptionOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** `"29.99"` → `2999`. Shopify prices are decimal strings in the shop currency. */
function priceMinor(price: string): number {
  return Math.round(Number.parseFloat(price) * 100);
}

async function fetchProduct(handle: string): Promise<ShopifyProduct> {
  const url = `${store!.origin}/products/${handle}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return ((await response.json()) as { product: ShopifyProduct }).product;
}

/**
 * The product photograph, transcoded onto our own media route.
 *
 * Going through the pipeline rather than storing the CDN url is what keeps the
 * card's imagery on our own origin — the same reason ordinary ingestion does
 * it. `sourceUrl` is then cleared: it is only ever a hint to clients that they
 * may load the origin's copy instead, and for this store it is the one field
 * that would name the platform the rest of this is presenting past.
 */
async function heroFor(
  product: ShopifyProduct,
  override: string | undefined,
): Promise<{
  hero: Awaited<ReturnType<typeof media.ingestImage>>;
  note: string | null;
}> {
  // A configured stand-in wins outright. Its dimensions are declared as zero
  // because nothing here knows them and nothing needs to: an http(s) source
  // routes to the fetching pipeline, which measures the bytes it actually
  // received and gates on those. The declared pair only matters to the
  // synthetic generator, which this is not.
  if (override) {
    const hero = await media.ingestImage({ sourceUrl: override, width: 0, height: 0 });
    if (hero) return { hero: { ...hero, sourceUrl: null }, note: null };
    return {
      hero: null,
      note: `configured stand-in could not be fetched or failed the 800px floor — ${override}`,
    };
  }

  const image = product.images[0];
  if (!image) return { hero: null, note: 'the store has no product image' };

  const hero = await media.ingestImage({
    sourceUrl: image.src,
    width: image.width,
    height: image.height,
  });
  if (hero) return { hero: { ...hero, sourceUrl: null }, note: null };

  // The eligibility floor is 800px on the short edge and it is measured from
  // the bytes, not from what the source claimed, so this cannot be argued
  // past from here — the fix is a larger image on the store.
  const short = Math.min(image.width, image.height);
  const generated = await media.ingestImage({
    sourceUrl: `window://generated/${store!.domain}/${product.handle}`,
    width: 1440,
    height: 1440,
  });
  return {
    hero: generated,
    note: `photograph is ${image.width}x${image.height} (${short}px short edge, floor is 800) — seeded with placeholder imagery instead`,
  };
}

function l3For(handle: string): { l1: string; l2: string; l3: string } {
  const configured = store!.products.find((p) => p.handle === handle)?.l3;
  const node = CATEGORY_NODES.find((n) => n.level === 3 && n.id === configured);
  if (!node) throw new Error(`Unknown L3 category ${JSON.stringify(configured)} for ${handle}`);
  return categoryPath(node.id);
}

// ---------------------------------------------------------------------------

const seller = {
  id: demoSellerId(store.domain),
  source_domain: store.domain,
  source_seller_id: store.domain,
  handle: store.domain.split('.')[0],
  type: 'retailer',
  display_name: store.displayName,
  avatar_url: null,
  profile_url: `https://${store.domain}`,
  metrics: {
    rating: 4.8,
    reviewCount: 96,
    salesCount: 1240,
    memberSince: now,
    responseTime: 'under 1 hour',
  },
  policies: { returnWindowDays: 30, shippingSummary: 'Free standard shipping' },
  auction_terms: null,
  live_listing_count: store.products.length,
  trust: { score: 0.94, flags: [] },
  suppressed: false,
  created_at: now,
  updated_at: now,
};

/**
 * The merchant row. `display_name` is what the checkout summary and the card
 * context read, and `id` is the domain the order is grouped under — the same
 * key `fieldMapFor` is called with, which is why it is the store's own domain
 * and not the platform hostname behind it.
 */
const source = {
  id: store.domain,
  display_name: store.displayName,
  tier: 1,
  source_type: 'new',
  crawl_policy: {
    rps: 0.5,
    backoff: 'exponential',
    proxyPool: 'none',
    concurrency: 1,
    allowedHours: [0, 24],
  },
  staleness_ceiling_hours: 12,
  extractors: { detail: 'web', listing: '{"strategy":"web"}' },
  health: { window: [], errorRate: 0, circuitOpen: false, lastSuccessAt: null, circuitOpenedAt: null },
  checkout: {
    protocol: null,
    supported: true,
    blocksAgents: false,
    guestCheckout: true,
    stackableCoupons: false,
  },
  status: 'active',
};

async function main(): Promise<void> {
  if (!env.supabaseUrl || !env.supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in packages/server/.env');
  }

  console.log(`${store!.displayName} <${store!.domain}> → ${store!.origin}\n`);

  const rows: Record<string, unknown>[] = [];
  const notes: string[] = [];

  for (const { handle, image } of store!.products) {
    const product = await fetchProduct(handle);
    const variant = product.variants[0];
    if (!variant) throw new Error(`${handle} has no purchasable variant`);

    const amount = priceMinor(variant.price);
    const category = l3For(handle);
    const { hero, note } = await heroFor(product, image);
    if (note) notes.push(`${product.title}: ${note}`);

    rows.push({
      id: demoProductId(store!.domain, handle),
      cluster_id: null,
      title: product.title,
      raw_title: product.title,
      brand: store!.displayName,
      // The variant id is what lets the checkout agent build a cart from a
      // URL rather than hunting for an add-to-cart button. Without it the
      // agent opens the checkout against an empty cart, which is not an empty
      // order — it is a redirect, and every selector then misses.
      identifiers: { variantId: String(variant.id) },
      category,
      price: { amount, currency: 'USD' },
      original_price: null,
      shipping: { amount: 0, currency: 'USD', freeThreshold: null },
      condition: 'new',
      stock: {
        inStock: true,
        quantity: variant.inventory_quantity ?? 25,
        singleUnit: false,
      },
      auction: null,
      specs: [{ name: 'Description', value: descriptionOf(product.body_html) }],
      // The link out to the listing. It is the origin's own url because that
      // is the one that resolves; it becomes the branded one by attaching a
      // custom domain to the store, not by writing a different string here.
      source: {
        url: `${store!.origin}/products/${handle}`,
        tier: 1,
        domain: store!.domain,
        sourceId: handle,
      },
      source_type: 'new',
      media: { hero, gallery: [], video: null },
      seller_id: seller.id,
      embedding: await embedder.embed({
        title: product.title,
        brand: store!.displayName,
        category,
        priceAmount: amount,
        imageDescriptor: handle,
      }),
      embedding_version: embedder.version,
      engagement: { impressions: 0, interactions: 0, ctrSmoothed: 0, cartAdds: 0 },
      crawl: { firstSeenAt: now, lastCrawledAt: now, lastChangedAt: now, failCount: 0, tier: 1 },
      quality: { score: 0.9, cautions: [] },
      risk: { tier: 'clear', score: 0.05, flags: [], reports: { count: 0 } },
      status: 'active',
      reject_reason: null,
    });

    console.log(`  ${product.title} — $${(amount / 100).toFixed(2)}  [${category.l1}/${category.l2}/${category.l3}]`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
  } else {
    const { error: sellerError } = await client.from('sellers').upsert(seller, { onConflict: 'id' });
    if (sellerError) throw sellerError;

    const { error: sourceError } = await client.from('sources').upsert(source, { onConflict: 'id' });
    if (sourceError) throw sourceError;

    const { error: productError } = await client.from('products').upsert(rows, { onConflict: 'id' });
    if (productError) throw productError;

    // Read back rather than trust the write. A row the ingestion gate has
    // rejected keeps its rejection until something clears it, and a pinned
    // product that is not `active` is dropped by `pinnedCandidates` — so the
    // failure mode is a demo that is quietly one product short. It cost an
    // afternoon once; it costs one query here.
    const { data: written, error: readError } = await client
      .from('products')
      .select('id,title,status,reject_reason')
      .in('id', store!.productIds);
    if (readError) throw readError;

    const blocked = (written ?? []).filter((row) => row.status !== 'active');
    const missing = store!.productIds.filter((id) => !(written ?? []).some((r) => r.id === id));

    console.log(`\n${rows.length} product(s) seeded and pinned to the scroll.`);
    for (const row of blocked) {
      notes.push(`${row.title} is status=${row.status} (${row.reject_reason ?? 'no reason given'}) — it will NOT appear in the feed`);
    }
    for (const id of missing) notes.push(`${id} did not come back from the database`);
  }

  for (const note of notes) console.log(`\n  warning — ${note}`);
  console.log('\nRestart the server if the vector index does not pick them up.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
