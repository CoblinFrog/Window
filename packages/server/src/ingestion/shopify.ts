import { truncate, type ProductIdentifiers, type SourceType } from '@window/shared';
import { logger } from '../lib/logger.js';
import type { RawListing, RawSeller } from './types.js';

const log = logger.child('ingest.shopify');

/**
 * Shopify storefront ingestion.
 *
 * Every Shopify store exposes `/products.json`: structured, paginated product
 * data the platform serves deliberately for exactly this kind of consumption.
 * That makes it tier 2 in the PRD's terms — "plain HTTP fetch, parse structured
 * product data" — and it is the cheapest honest supply available, which is why
 * the PRD lists Shopify storefronts under aggregators with "enormous long tail,
 * cheap tier-2 access".
 *
 * The posture the PRD demands is followed literally here: robots is checked
 * before anything is fetched, the rate limit is conservative, nothing behind
 * authentication is touched, and the user agent identifies the crawler so a
 * store owner who objects knows who to contact.
 */

export const USER_AGENT = 'WindowBot/0.1 (+https://window.app/bot)';

export interface ShopifyStore {
  domain: string;
  displayName: string;
  /** The L1 the store mostly sells into; a hint, not an override. */
  categoryHint: string;
}

/**
 * Robots check.
 *
 * Shopify's default robots.txt disallows cart, checkout, account and the
 * faceted collection URLs, and permits `/products.json`. That is checked rather
 * than assumed, because a store owner can edit the file and the whole
 * justification for this crawl rests on it.
 */
export async function robotsAllows(
  domain: string,
  path: string,
  /**
   * The origin to ask, when it is not `https://<domain>`.
   *
   * robots.txt is defined per origin — scheme, host *and* port — so a service
   * on a non-default port has its own file. Reconstructing the URL from the
   * hostname alone silently asks the wrong server, and since an unreachable
   * robots.txt is treated as a refusal, the result is a merchant that can never
   * be driven for a reason that has nothing to do with what it permits.
   */
  origin?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${origin ?? `https://${domain}`}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    // No robots.txt at all is the permissive case by the standard.
    if (response.status === 404) return true;
    if (!response.ok) return false;

    const body = await response.text();
    const lines = body.split('\n').map((l) => l.trim());

    let inWildcard = false;
    const disallows: string[] = [];
    for (const line of lines) {
      if (/^user-agent:/i.test(line)) {
        inWildcard = line.split(':')[1]?.trim() === '*';
        continue;
      }
      if (!inWildcard) continue;
      const match = line.match(/^disallow:\s*(.*)$/i);
      if (match) {
        const rule = (match[1] ?? '').trim();
        if (rule) disallows.push(rule);
      }
    }

    for (const rule of disallows) {
      // Shopify's rules use `*` globs; anchor them and compare against the path.
      const pattern = new RegExp(
        `^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`,
      );
      if (pattern.test(path)) {
        log.warn('robots disallows this path', { domain, path, rule });
        return false;
      }
    }
    return true;
  } catch (error) {
    // A robots file we cannot read is treated as a refusal. The conservative
    // reading is the only defensible one when the whole activity depends on it.
    log.warn('robots unreadable; treating as disallowed', {
      domain,
      error: (error as Error).message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The products.json shape
// ---------------------------------------------------------------------------

interface ShopifyImage {
  src: string;
  width: number | null;
  height: number | null;
}

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  compare_at_price: string | null;
  sku: string | null;
  barcode?: string | null;
  available: boolean;
  grams?: number;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string[];
  published_at: string;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  options?: Array<{ name: string; values: string[] }>;
}

/** Strips the HTML a `body_html` field is full of, without a parser. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shopify prices are decimal strings in the shop currency. */
function toMinorUnits(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * A barcode is a GTIN when it looks like one. Shopify lets merchants type
 * anything into the field, so a value that is not 8 to 14 digits is discarded
 * rather than passed downstream, where it would be used to cluster products.
 */
function identifiersFrom(variant: ShopifyVariant | undefined): ProductIdentifiers {
  const barcode = variant?.barcode?.trim() ?? null;
  const isGtin = barcode !== null && /^\d{8,14}$/.test(barcode);
  return {
    gtin: isGtin ? barcode : null,
    upc: null,
    ean: null,
    asin: null,
    mpn: variant?.sku?.trim() || null,
    isbn: null,
  };
}

function completeness(listing: RawListing): number {
  const checks = [
    listing.title.length > 0,
    listing.description !== null && listing.description.length > 0,
    listing.brand !== null,
    listing.priceAmountMinor !== null,
    listing.images.length > 0,
    listing.specs.length > 0,
    listing.breadcrumb.length > 0,
    listing.identifiers.gtin !== null || listing.identifiers.mpn !== null,
    listing.availabilityText !== null,
  ];
  return checks.filter(Boolean).length / checks.length;
}

/**
 * Maps one Shopify product onto the canonical raw listing.
 *
 * The first available variant is chosen rather than the first variant: a store
 * whose lead variant is sold out is common, and pricing the card from a variant
 * nobody can buy is how a feed shows prices that evaporate at checkout.
 */
export function toRawListing(
  product: ShopifyProduct,
  store: ShopifyStore,
  currency: string,
  now: Date,
): RawListing | null {
  if (!product.title || product.variants.length === 0) return null;

  const variant =
    product.variants.find((v) => v.available) ?? (product.variants[0] as ShopifyVariant);
  const price = toMinorUnits(variant.price);
  if (price === null || price <= 0) return null;

  const compareAt = toMinorUnits(variant.compare_at_price);
  const description = stripHtml(product.body_html ?? '');

  const specs: Array<{ key: string; value: string }> = [];
  for (const [index, option] of (product.options ?? []).entries()) {
    const value = [variant.option1, variant.option2, variant.option3][index];
    if (option?.name && value) specs.push({ key: option.name, value });
  }
  if (product.product_type) specs.push({ key: 'product_type', value: product.product_type });
  if (variant.grams && variant.grams > 0) {
    specs.push({ key: 'weight', value: `${variant.grams} g` });
  }

  const seller: RawSeller = {
    sourceSellerId: store.domain,
    handle: store.domain,
    displayName: store.displayName,
    type: 'retailer',
    avatarUrl: null,
    profileUrl: `https://${store.domain}`,
    // A storefront exposes no rating of its own through this endpoint, and
    // inventing one would put a number on a seller sheet that nothing backs.
    rating: null,
    ratingScale: 5,
    reviewCount: 0,
    salesCount: 0,
    memberSince: null,
    responseTime: null,
    returnWindowDays: null,
    shippingSummary: null,
    buyerPremiumPct: null,
    listingCount: 0,
  };

  const listing: RawListing = {
    sourceDomain: store.domain,
    sourceId: String(product.id),
    url: `https://${store.domain}/products/${product.handle}`,
    tier: 2,
    sourceType: 'new' as SourceType,
    title: truncate(product.title, 200),
    description: description.length > 0 ? truncate(description, 2000) : null,
    brand: product.vendor?.trim() || null,
    identifiers: identifiersFrom(variant),
    priceText: null,
    priceAmountMinor: price,
    currency,
    originalPriceText: null,
    // Shopify stores often set compare_at equal to or below price; only a
    // genuinely higher value is a discount.
    originalPriceAmountMinor: compareAt !== null && compareAt > price ? compareAt : null,
    shippingText: null,
    shippingAmountMinor: null,
    conditionText: 'new',
    availabilityText: variant.available ? 'In stock' : 'Out of stock',
    quantity: null,
    auction: null,
    specs,
    images: product.images
      .filter((image) => Boolean(image.src))
      .slice(0, 8)
      .map((image) => ({
        url: image.src,
        // Declared dimensions are a hint only; the media pipeline probes the
        // real bytes before the eligibility gate sees a number.
        width: image.width ?? 0,
        height: image.height ?? 0,
      })),
    video: null,
    seller,
    breadcrumb: [store.categoryHint, product.product_type].filter(Boolean) as string[],
    // This endpoint carries no reviews. Some stores expose them through a
    // review app's own API, which is a per-store integration, not a crawl.
    reviews: [],
    fetchedAt: now,
    extractionCompleteness: 0,
  };

  listing.extractionCompleteness = completeness(listing);
  return listing;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchPageResult {
  listings: RawListing[];
  /** False once the store returns an empty page. */
  hasMore: boolean;
}

/**
 * Fetches one page of a storefront's public product feed.
 *
 * `limit` is capped at 250 by Shopify. The caller paces the calls; this does
 * not sleep, so that the rate limit lives in one place rather than being
 * re-implemented per source.
 */
export async function fetchProductPage(
  store: ShopifyStore,
  page: number,
  currency: string,
  now: Date,
  limit = 250,
): Promise<FetchPageResult> {
  const url = `https://${store.domain}/products.json?limit=${limit}&page=${page}`;
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 429 || response.status === 503) {
    throw new Error(`${store.domain} is rate limiting (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${store.domain} returned ${response.status} for products.json`);
  }

  const body = (await response.json()) as { products?: ShopifyProduct[] };
  const products = body.products ?? [];
  if (products.length === 0) return { listings: [], hasMore: false };

  const listings: RawListing[] = [];
  for (const product of products) {
    const listing = toRawListing(product, store, currency, now);
    if (listing) listings.push(listing);
  }

  return { listings, hasMore: products.length === limit };
}

/** Shopify reports the shop currency on its meta endpoint. */
export async function detectCurrency(domain: string): Promise<string> {
  try {
    const response = await fetch(`https://${domain}/meta.json`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'USD';
    const meta = (await response.json()) as { currency?: string };
    return meta.currency ?? 'USD';
  } catch {
    return 'USD';
  }
}
