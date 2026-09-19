/**
 * The crawl control plane: which sources exist, how hard they may be crawled,
 * which tier serves them, and whether their circuit is currently open.
 *
 * The registry is the seed for the `sources` collection rather than a runtime
 * read path — health mutates per crawl and lives in Mongo. Keeping the static
 * half here means tier assignments and rate limits are reviewable in a diff,
 * which is the only way a crawl policy stays conservative over time.
 */

import { CIRCUIT_BREAKER, TIER_STALENESS_CEILING_HOURS, type SourceDoc, type SourceTier, type SourceType } from '@window/shared';
import { AMAZON_ENV_VARS } from './adapters/amazon-paapi.js';
import { EBAY_ENV_VARS } from './adapters/ebay-browse.js';

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

interface SourceSpec {
  domain: string;
  displayName: string;
  tier: SourceTier;
  sourceType: SourceType;
  rps: number;
  concurrency: number;
  /** [startHour, endHour) in UTC. A full day is [0, 24]. */
  allowedHours: [number, number];
  proxyPool: string;
  backoff: 'exponential' | 'linear';
  listing: string;
  detail: string;
  checkout: SourceDoc<string>['checkout'];
  status?: SourceDoc<string>['status'];
}

/** Tier-1 feed config. Credentials are named, never inlined. */
function affiliateFeed(config: {
  url: string;
  itemsPath: string;
  authHeader?: { name: string; envVar: string; prefix?: string };
  cursor?: { param: string; path?: string; startAt?: string };
  page?: { param: string; startAt: number; sizeParam?: string; size?: number };
  itemUrl?: string;
  itemPath?: string;
  urlTemplate?: string;
  sellerType?: 'retailer' | 'individual' | 'auction_house';
  mapping: Record<string, string>;
}): string {
  return JSON.stringify(config);
}

/**
 * Tier-1 config for a source served by a dedicated API client.
 *
 * eBay mints an OAuth2 token per crawl and PA-API signs every request with
 * SigV4, so neither fits `affiliateFeed`'s URL-plus-auth-header shape. The
 * bearer-token entries that used to stand here named env vars nothing ever read
 * and described requests that would have been rejected unsigned; the mapping
 * lives in the adapter now. What is left is the part of a tier-1 entry worth
 * reviewing in a diff — which credentials the source needs before it can run at
 * all, and which ones only steer it.
 */
function apiAdapter(config: {
  adapter: string;
  requires: readonly string[];
  optional?: readonly string[];
}): string {
  return JSON.stringify({ strategy: 'api-adapter', ...config });
}

function sitemap(url: string, pattern: string | null): string {
  return JSON.stringify({ strategy: 'sitemap', url, pattern });
}

function productsJson(url: string, limit = 250): string {
  return JSON.stringify({ strategy: 'products-json', url, pattern: null, limit });
}

function browserPlan(config: {
  listingUrls?: string[];
  linkPattern?: string;
  interstitialSelectors?: string[];
  readySelector?: string;
  nextPageSelector?: string;
  visionFields?: string[];
}): string {
  return JSON.stringify(config);
}

function build(spec: SourceSpec): SourceDoc<string> {
  return {
    _id: spec.domain,
    displayName: spec.displayName,
    tier: spec.tier,
    sourceType: spec.sourceType,
    crawlPolicy: {
      rps: spec.rps,
      concurrency: spec.concurrency,
      allowedHours: spec.allowedHours,
      proxyPool: spec.proxyPool,
      backoff: spec.backoff,
    },
    stalenessCeilingHours: TIER_STALENESS_CEILING_HOURS[spec.tier],
    extractors: { listing: spec.listing, detail: spec.detail },
    health: {
      errorRate: 0,
      circuitOpen: false,
      circuitOpenedAt: null,
      lastSuccessAt: null,
      window: [],
    },
    checkout: spec.checkout,
    status: spec.status ?? 'active',
  };
}

const RETAIL_CHECKOUT: SourceDoc<string>['checkout'] = {
  supported: true,
  guestCheckout: true,
  blocksAgents: false,
  protocol: null,
  stackableCoupons: false,
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Rate limits are deliberately below what these sites would tolerate. A crawler
 * that is never the reason a merchant pages someone keeps its access; the cost
 * of being conservative is latency on the cold tail, which nobody sees.
 */
export const SOURCE_REGISTRY: SourceDoc<string>[] = [
  // --- Mass retail -------------------------------------------------------
  build({
    // Tier 1: the Product Advertising API exists, and Amazon's bot mitigation
    // makes any other tier a losing fight. Served by `AmazonPaapiAdapter`,
    // because every PA-API request is a SigV4-signed POST body rather than a
    // GET with a header, which no feed config can describe.
    domain: 'amazon.com',
    displayName: 'Amazon',
    tier: 1,
    sourceType: 'new',
    rps: 1,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: apiAdapter({
      adapter: 'amazon-paapi',
      requires: [AMAZON_ENV_VARS.accessKey, AMAZON_ENV_VARS.secretKey, AMAZON_ENV_VARS.partnerTag],
      // Discovery needs one of keywords or browse node; PA-API has no
      // "list everything" mode and rejects a search carrying neither.
      optional: [
        AMAZON_ENV_VARS.tld,
        AMAZON_ENV_VARS.keywords,
        AMAZON_ENV_VARS.browseNodeId,
        AMAZON_ENV_VARS.searchIndex,
      ],
    }),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, blocksAgents: true, protocol: null },
  }),
  build({
    // Tier 1: Best Buy runs an open developer API with full catalog coverage.
    domain: 'bestbuy.com',
    displayName: 'Best Buy',
    tier: 1,
    sourceType: 'new',
    rps: 2,
    concurrency: 3,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: affiliateFeed({
      url: 'https://api.bestbuy.com/v1/products?format=json',
      itemsPath: 'products',
      authHeader: { name: 'X-API-Key', envVar: 'BESTBUY_API_KEY' },
      page: { param: 'page', startAt: 1, sizeParam: 'pageSize', size: 100 },
      itemUrl: 'https://api.bestbuy.com/v1/products/{sourceId}.json?format=json',
      mapping: {
        sourceId: 'sku',
        url: 'url',
        title: 'name',
        description: 'longDescription',
        brand: 'manufacturer',
        priceAmount: 'salePrice',
        currency: 'currency',
        originalPriceAmount: 'regularPrice',
        inStock: 'onlineAvailability',
        images: 'images.*.href',
        breadcrumb: 'categoryPath.*.name',
        upc: 'upc',
        mpn: 'modelNumber',
        specKeys: 'details.*.name',
        specValues: 'details.*.value',
        ratingValue: 'customerReviewAverage',
        reviewCount: 'customerReviewCount',
      },
    }),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, protocol: 'acp', stackableCoupons: true },
  }),
  build({
    // Tier 1: Walmart's affiliate feed covers the catalog; the storefront is
    // client-rendered and would otherwise force tier 3 on a huge source.
    domain: 'walmart.com',
    displayName: 'Walmart',
    tier: 1,
    sourceType: 'new',
    rps: 2,
    concurrency: 3,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: affiliateFeed({
      url: 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2/paginated/items',
      itemsPath: 'items',
      authHeader: { name: 'WM_SEC.ACCESS_TOKEN', envVar: 'WALMART_AFFILIATE_TOKEN' },
      cursor: { param: 'nextCursor', path: 'nextCursor' },
      itemUrl: 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2/items/{sourceId}',
      mapping: {
        sourceId: 'itemId',
        url: 'productTrackingUrl',
        title: 'name',
        description: 'shortDescription',
        brand: 'brandName',
        priceAmount: 'salePrice',
        originalPriceAmount: 'msrp',
        currency: 'currency',
        inStock: 'availableOnline',
        images: 'imageEntities.*.largeImage',
        breadcrumb: 'categoryPath',
        upc: 'upc',
        mpn: 'modelNumber',
        ratingValue: 'customerRating',
        reviewCount: 'numReviews',
      },
    }),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, protocol: 'mpp' },
  }),
  build({
    // Tier 3: Target renders price and stock client-side per store and blocks
    // plain fetches, so there is no structured payload to read server-side.
    domain: 'target.com',
    displayName: 'Target',
    tier: 3,
    sourceType: 'new',
    rps: 0.2,
    concurrency: 1,
    allowedHours: [6, 14],
    proxyPool: 'residential-us',
    backoff: 'exponential',
    listing: '',
    detail: browserPlan({
      listingUrls: ['https://www.target.com/c/new-arrivals/-/N-5xtg6'],
      linkPattern: '/p/',
      interstitialSelectors: ['#onetrust-accept-btn-handler'],
      readySelector: '[data-test="product-price"]',
      nextPageSelector: '[data-test="next"]',
      visionFields: ['price', 'availability', 'condition'],
    }),
    checkout: { ...RETAIL_CHECKOUT, blocksAgents: true },
  }),
  build({
    // Tier 2: Newegg ships complete Product JSON-LD with offers on every page.
    domain: 'newegg.com',
    displayName: 'Newegg',
    tier: 2,
    sourceType: 'new',
    rps: 0.5,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-us',
    backoff: 'exponential',
    listing: sitemap('https://www.newegg.com/sitemap_index.xml', '/p/'),
    detail: '',
    checkout: RETAIL_CHECKOUT,
  }),

  // --- Specialty retail --------------------------------------------------
  build({
    // Tier 2: REI serves full JSON-LD including specs and review aggregates.
    domain: 'rei.com',
    displayName: 'REI Co-op',
    tier: 2,
    sourceType: 'new',
    rps: 0.5,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-us',
    backoff: 'exponential',
    listing: sitemap('https://www.rei.com/sitemap-products.xml', '/product/'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, stackableCoupons: true },
  }),
  build({
    // Tier 2: B&H publishes microdata rather than JSON-LD, which the microdata
    // path handles; its spec tables are the best in the category.
    domain: 'bhphotovideo.com',
    displayName: 'B&H Photo Video',
    tier: 2,
    sourceType: 'new',
    rps: 0.4,
    concurrency: 1,
    allowedHours: [3, 12],
    proxyPool: 'datacenter-us',
    backoff: 'exponential',
    listing: sitemap('https://www.bhphotovideo.com/sitemap/sitemap-index.xml', '/c/product/'),
    detail: '',
    checkout: RETAIL_CHECKOUT,
  }),
  build({
    // Tier 2: Zappos exposes Open Graph product tags plus JSON-LD offers; the
    // size grid it does not expose is filled by normalization, not by tier 3.
    domain: 'zappos.com',
    displayName: 'Zappos',
    tier: 2,
    sourceType: 'new',
    rps: 0.5,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-us',
    backoff: 'exponential',
    listing: sitemap('https://www.zappos.com/sitemap_index.xml', '/product/'),
    detail: '',
    checkout: RETAIL_CHECKOUT,
  }),
  build({
    // Tier 3: Sephora's PDP is a hydrated SPA behind bot mitigation, and its
    // shade-level variants only exist after render.
    domain: 'sephora.com',
    displayName: 'Sephora',
    tier: 3,
    sourceType: 'new',
    rps: 0.15,
    concurrency: 1,
    allowedHours: [5, 13],
    proxyPool: 'residential-us',
    backoff: 'exponential',
    listing: '',
    detail: browserPlan({
      listingUrls: ['https://www.sephora.com/new-beauty-products'],
      linkPattern: '/product/',
      interstitialSelectors: ['#onetrust-accept-btn-handler', '[data-at="close_button"]'],
      readySelector: '[data-comp="Price"]',
      visionFields: ['price', 'availability', 'images'],
    }),
    checkout: { ...RETAIL_CHECKOUT, blocksAgents: true },
  }),

  // --- Secondhand --------------------------------------------------------
  build({
    // Tier 1: the eBay Browse API is an affiliate-eligible official feed, which
    // is the only sane way to read a catalog that churns this fast. Served by
    // `EbayBrowseAdapter`, because Browse authenticates with an OAuth2
    // client-credentials grant minted per crawl, not a static bearer token.
    domain: 'ebay.com',
    displayName: 'eBay',
    tier: 1,
    sourceType: 'secondhand',
    rps: 3,
    concurrency: 4,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: apiAdapter({
      adapter: 'ebay-browse',
      requires: [EBAY_ENV_VARS.clientId, EBAY_ENV_VARS.clientSecret],
      // Discovery needs one of query or category ids; Browse search rejects a
      // request carrying neither.
      optional: [
        EBAY_ENV_VARS.marketplaceId,
        EBAY_ENV_VARS.query,
        EBAY_ENV_VARS.categoryIds,
        EBAY_ENV_VARS.filter,
        EBAY_ENV_VARS.campaignId,
      ],
    }),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false, protocol: 'tap' },
  }),
  build({
    // Tier 3: Mercari is a client-rendered SPA with no server-side product
    // payload; single-unit stock also means a stale listing is a dead listing.
    domain: 'mercari.com',
    displayName: 'Mercari',
    tier: 3,
    sourceType: 'secondhand',
    rps: 0.15,
    concurrency: 1,
    allowedHours: [6, 14],
    proxyPool: 'residential-us',
    backoff: 'exponential',
    listing: '',
    detail: browserPlan({
      listingUrls: ['https://www.mercari.com/search/?sortBy=2'],
      linkPattern: '/item/',
      interstitialSelectors: ['[data-testid="AcceptCookies"]'],
      readySelector: '[data-testid="ItemPrice"]',
      nextPageSelector: '[data-testid="pagination-next"]',
      visionFields: ['price', 'condition', 'availability'],
    }),
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false, blocksAgents: true },
  }),
  build({
    // Tier 2: Poshmark renders Product JSON-LD server-side with condition and
    // seller handle already in it.
    domain: 'poshmark.com',
    displayName: 'Poshmark',
    tier: 2,
    sourceType: 'secondhand',
    rps: 0.4,
    concurrency: 1,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-us',
    backoff: 'exponential',
    listing: sitemap('https://poshmark.com/sitemap.xml', '/listing/'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false },
  }),
  build({
    // Tier 3: Grailed hydrates its listing data from an API the page will not
    // serve to a plain fetch, and the interesting fields are render-only.
    domain: 'grailed.com',
    displayName: 'Grailed',
    tier: 3,
    sourceType: 'secondhand',
    rps: 0.1,
    concurrency: 1,
    allowedHours: [7, 13],
    proxyPool: 'residential-us',
    backoff: 'exponential',
    listing: '',
    detail: browserPlan({
      listingUrls: ['https://www.grailed.com/shop/recently-listed'],
      linkPattern: '/listings/',
      interstitialSelectors: ['.modal__close', '#onetrust-accept-btn-handler'],
      readySelector: '[data-testid="Price"]',
      visionFields: ['price', 'condition', 'images'],
    }),
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false, blocksAgents: true },
  }),
  build({
    // Tier 2: Depop serves Open Graph product tags on every listing, which is
    // thin but enough for a single-unit card.
    domain: 'depop.com',
    displayName: 'Depop',
    tier: 2,
    sourceType: 'secondhand',
    rps: 0.3,
    concurrency: 1,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-eu',
    backoff: 'exponential',
    listing: sitemap('https://www.depop.com/sitemap.xml', '/products/'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false },
  }),
  build({
    // Registered but disabled: Marketplace is behind authentication and its
    // terms forbid automated collection. It stays here so the decision is
    // visible rather than an unexplained absence, and status keeps it uncrawled.
    domain: 'facebook.com',
    displayName: 'Facebook Marketplace',
    tier: 3,
    sourceType: 'secondhand',
    rps: 0,
    concurrency: 0,
    allowedHours: [0, 0],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: '',
    detail: '',
    checkout: { supported: false, guestCheckout: false, blocksAgents: true, protocol: null, stackableCoupons: false },
    status: 'blocked',
  }),

  // --- Auction -----------------------------------------------------------
  build({
    // Tier 2: Heritage publishes lot microdata with the current bid and close
    // time, so the urgency fields the card needs come straight off the page.
    domain: 'ha.com',
    displayName: 'Heritage Auctions',
    tier: 2,
    sourceType: 'auction',
    rps: 0.3,
    concurrency: 1,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-us',
    backoff: 'linear',
    listing: sitemap('https://www.ha.com/sitemap.xml', '/itm/'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, supported: false, guestCheckout: false },
  }),
  build({
    // Tier 2: Catawiki's lot pages carry JSON-LD; bids move continuously, so
    // the refresh priority matters more here than the tier does.
    domain: 'catawiki.com',
    displayName: 'Catawiki',
    tier: 2,
    sourceType: 'auction',
    rps: 0.3,
    concurrency: 1,
    allowedHours: [0, 24],
    proxyPool: 'datacenter-eu',
    backoff: 'linear',
    listing: sitemap('https://www.catawiki.com/sitemap.xml', '/l/'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, supported: false, guestCheckout: false },
  }),
  build({
    // Tier 3: StockX's bid book is fetched after hydration and the site
    // fingerprints plain clients aggressively.
    domain: 'stockx.com',
    displayName: 'StockX',
    tier: 3,
    sourceType: 'auction',
    rps: 0.1,
    concurrency: 1,
    allowedHours: [6, 12],
    proxyPool: 'residential-us',
    backoff: 'exponential',
    listing: '',
    detail: browserPlan({
      listingUrls: ['https://stockx.com/sneakers/most-popular'],
      linkPattern: 'stockx.com/',
      interstitialSelectors: ['#onetrust-accept-btn-handler'],
      readySelector: '[data-testid="product-price"]',
      visionFields: ['price', 'availability'],
    }),
    checkout: { ...RETAIL_CHECKOUT, guestCheckout: false, blocksAgents: true },
  }),

  // --- Aggregators (Shopify storefronts) ---------------------------------
  build({
    // Tier 2: /products.json is public structured data the platform serves by
    // design — the cheapest supply in the system and the whole long tail.
    domain: 'allbirds.com',
    displayName: 'Allbirds',
    tier: 2,
    sourceType: 'new',
    rps: 1,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: productsJson('https://www.allbirds.com/products.json'),
    detail: '',
    checkout: { ...RETAIL_CHECKOUT, protocol: 'acp', stackableCoupons: true },
  }),
  build({
    // Tier 2: same Shopify endpoint; the storefront also emits JSON-LD, so
    // detail extraction is a straight structured read.
    domain: 'gymshark.com',
    displayName: 'Gymshark',
    tier: 2,
    sourceType: 'new',
    rps: 1,
    concurrency: 2,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: productsJson('https://www.gymshark.com/products.json'),
    detail: '',
    checkout: RETAIL_CHECKOUT,
  }),
  build({
    // Tier 2: a small Shopify storefront, crawled slowly because the long tail
    // is where a careless crawler actually hurts someone.
    domain: 'huckberry.com',
    displayName: 'Huckberry',
    tier: 2,
    sourceType: 'new',
    rps: 0.5,
    concurrency: 1,
    allowedHours: [0, 24],
    proxyPool: 'none',
    backoff: 'exponential',
    listing: productsJson('https://huckberry.com/products.json', 100),
    detail: '',
    checkout: RETAIL_CHECKOUT,
  }),
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const BY_ID = new Map(SOURCE_REGISTRY.map((source) => [source._id, source]));

export function sourceById(domain: string): SourceDoc<string> | null {
  return BY_ID.get(domain) ?? null;
}

export function sourcesByTier(tier: SourceTier): SourceDoc<string>[] {
  return SOURCE_REGISTRY.filter((source) => source.tier === tier);
}

export function sourcesByType(sourceType: SourceType): SourceDoc<string>[] {
  return SOURCE_REGISTRY.filter((source) => source.sourceType === sourceType);
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Records one crawl outcome and trips or clears the breaker.
 *
 * Mutates and returns the source's health so the caller can persist exactly
 * what it decided on; the window is stored on the document rather than in
 * process memory because the crawl fleet is many workers and the breaker has to
 * mean the same thing to all of them.
 *
 * Tripping deprioritises the source's listings. It never deletes them: a source
 * that is down for an hour is not a source whose catalog stopped existing, and
 * re-ingesting it would cost far more than carrying it stale.
 */
export function recordCrawlOutcome(
  source: SourceDoc<string>,
  ok: boolean,
  now: Date = new Date(),
): SourceDoc<string>['health'] {
  const health = source.health;
  const cutoff = now.getTime() - CIRCUIT_BREAKER.windowMs;

  health.window = health.window.filter((entry) => entry.at.getTime() >= cutoff);
  health.window.push({ at: now, ok });
  if (ok) health.lastSuccessAt = now;

  const samples = health.window.length;
  const errors = health.window.filter((entry) => !entry.ok).length;
  health.errorRate = samples === 0 ? 0 : errors / samples;

  const overThreshold = samples >= CIRCUIT_BREAKER.minSamples
    && health.errorRate > CIRCUIT_BREAKER.errorRateThreshold;

  if (!health.circuitOpen && overThreshold) {
    health.circuitOpen = true;
    health.circuitOpenedAt = now;
    source.status = 'degraded';
    return health;
  }

  // Closing requires the probe traffic allowed after the cooldown to have
  // brought the rate back down, so one lucky request cannot reopen the floodgates.
  if (health.circuitOpen && !overThreshold && cooldownElapsed(health, now) && samples >= CIRCUIT_BREAKER.minSamples) {
    health.circuitOpen = false;
    health.circuitOpenedAt = null;
    if (source.status === 'degraded') source.status = 'active';
  }
  return health;
}

function cooldownElapsed(health: SourceDoc<string>['health'], now: Date): boolean {
  const openedAt = health.circuitOpenedAt;
  return openedAt === null || now.getTime() - openedAt.getTime() >= CIRCUIT_BREAKER.windowMs;
}

/**
 * Whether the scheduler should skip this source right now.
 *
 * An open circuit stops suppressing requests one window after it tripped, which
 * is what lets the source prove it has recovered. Without that half-open probe
 * the breaker would need an operator to reset it.
 */
export function isCircuitOpen(source: SourceDoc<string>, now: Date = new Date()): boolean {
  if (source.status === 'blocked') return true;
  if (!source.health.circuitOpen) return false;
  return !cooldownElapsed(source.health, now);
}
