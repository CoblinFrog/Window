/**
 * Tier 3: full browser simulation — render, wait for hydration, extract via a
 * vision-and-DOM model, handle pagination and interstitials.
 *
 * This is the most expensive path in the system and the one carrying the
 * terms-of-service exposure described in the PRD's legal section, so it is a
 * fallback and never a default: the design target is under 15% of catalog
 * refresh served through this tier at steady state. It exists because several
 * important sources render their product data client-side or defeat tier 2 with
 * bot mitigation, and the alternative is not having that supply at all.
 *
 * No browser driver is installed in this environment and none may be added, so
 * the driver is an injected seam: a real deployment passes a Playwright-backed
 * `BrowserDriver` here and everything below it is unchanged. With no driver
 * injected every method throws `SourceUnavailableError(domain,
 * 'not_configured')` — it must never be possible for a missing browser fleet to
 * look like a source that simply had no products.
 *
 * Extraction itself reuses the tier-2 parsers against the *rendered* HTML,
 * because a hydrated page usually contains the same JSON-LD the server never
 * sent. The vision model is the fallback for what the DOM still did not yield,
 * not the primary path, since it costs more and is less auditable.
 */

import type { SourceDoc, SourceTier } from '@window/shared';
import { logger } from '../../lib/logger.js';
import {
  SourceUnavailableError,
  type CrawlContext,
  type DiscoveredListing,
  type RawListing,
  type SourceAdapter,
} from '../types.js';
import {
  CRAWLER_USER_AGENT,
  extractFromHtml,
  isInStock,
  parsePriceToMinor,
  resolveUrl,
  toRawListing,
  type Json,
  type ParsedProduct,
} from './tier2-structured.js';

const log = logger.child('ingestion.tier3');

// ---------------------------------------------------------------------------
// The driver seam
// ---------------------------------------------------------------------------

export interface BrowserContextOptions {
  /** Named pool from the source's `crawlPolicy`; the driver resolves it to exits. */
  proxyPool: string;
  userAgent: string;
  viewport: { width: number; height: number };
  signal?: AbortSignal;
}

/**
 * One isolated browsing context. Deliberately the smallest surface extraction
 * actually needs: anything richer would leak a specific automation library's
 * semantics into the adapter and make the seam untestable.
 */
export interface BrowserPage {
  goto(url: string, options?: { timeoutMs?: number }): Promise<{ status: number; url: string }>;
  /** Resolves when the page has stopped mutating, or rejects on timeout. */
  waitForHydration(options?: { timeoutMs?: number; selector?: string }): Promise<void>;
  /** The rendered DOM, serialized. */
  content(): Promise<string>;
  screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;
  /** Returns false when the selector was absent, which interstitials often are. */
  click(selector: string, options?: { timeoutMs?: number }): Promise<boolean>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  readonly kind: string;
  newContext(options: BrowserContextOptions): Promise<BrowserPage>;
}

/**
 * The model-based half of "vision-and-DOM". It is asked only for the fields the
 * DOM did not yield, and it is given the page URL so its output can be audited
 * against the page it came from.
 */
export interface VisionExtractor {
  readonly modelVersion: string;
  extract(input: {
    url: string;
    screenshot: Uint8Array;
    /** Rendered HTML, truncated by the caller to the model's context budget. */
    html: string;
    missingFields: string[];
  }): Promise<Partial<Record<string, string>>>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Tier3Config {
  /** Listing/category pages to walk for discovery. */
  listingUrls?: string[];
  /** Only hrefs containing this substring are treated as product links. */
  linkPattern?: string;
  /** Clicked in order before extraction: cookie walls, age gates, region pickers. */
  interstitialSelectors?: string[];
  /** Presence of this selector is the hydration signal for detail pages. */
  readySelector?: string;
  /** Clicked to page a listing view; absence ends discovery. */
  nextPageSelector?: string;
  hydrationTimeoutMs?: number;
  viewport?: { width: number; height: number };
  /** Fields the vision fallback may fill when the DOM did not yield them. */
  visionFields?: string[];
}

function parseTier3Config(spec: string): Tier3Config {
  if (spec.trim() === '') return {};
  try {
    const raw = JSON.parse(spec) as Json;
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Tier3Config) : {};
  } catch {
    // A tier-3 source with no usable config still renders; it just gets the
    // defaults, which is better than refusing to crawl over a config typo.
    log.warn('tier-3 config is not JSON; falling back to defaults', { spec: spec.slice(0, 80) });
    return {};
  }
}

const DEFAULT_VIEWPORT = { width: 1280, height: 2400 };
const DEFAULT_HYDRATION_TIMEOUT_MS = 15_000;
/** Vision prompts are billed per token; the head of the document holds the product. */
const VISION_HTML_BUDGET = 200_000;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface Tier3Deps {
  driver?: BrowserDriver;
  vision?: VisionExtractor;
  now?: () => Date;
}

export class Tier3BrowserAdapter implements SourceAdapter {
  readonly tier: SourceTier = 3;
  readonly domain: string;

  private readonly driver: BrowserDriver | null;
  private readonly vision: VisionExtractor | null;
  private readonly now: () => Date;
  private readonly config: Tier3Config;

  constructor(private readonly source: SourceDoc<string>, deps: Tier3Deps = {}) {
    this.domain = source.id;
    this.driver = deps.driver ?? null;
    this.vision = deps.vision ?? null;
    this.now = deps.now ?? (() => new Date());
    this.config = parseTier3Config(source.extractors.detail);
  }

  private requireDriver(operation: string): BrowserDriver {
    if (this.driver === null) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `tier-3 ${operation} for ${this.domain} needs a rendering browser: inject a BrowserDriver `
          + '(a Playwright-backed implementation of BrowserDriver from '
          + "ingestion/adapters/tier3-browser.ts) as `new Tier3BrowserAdapter(source, { driver })`. "
          + 'No driver is installed in this environment, so no listings can be produced for this source.',
      );
    }
    return this.driver;
  }

  private async open(context: CrawlContext, url: string): Promise<BrowserPage> {
    const driver = this.requireDriver('rendering');
    const page = await driver.newContext({
      proxyPool: context.proxyPool !== '' ? context.proxyPool : this.source.crawlPolicy.proxyPool,
      userAgent: CRAWLER_USER_AGENT,
      viewport: this.config.viewport ?? DEFAULT_VIEWPORT,
      signal: context.signal,
    });
    try {
      const response = await page.goto(url, { timeoutMs: this.config.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS });
      if (response.status === 403 || response.status === 429) {
        throw new SourceUnavailableError(
          this.domain,
          'blocked',
          `${url} returned ${response.status} to a rendered request; bot mitigation has defeated tier 3 as well`,
        );
      }
      await this.settle(page);
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  /** Clears interstitials first: a cookie wall suppresses hydration on many sites. */
  private async settle(page: BrowserPage): Promise<void> {
    for (const selector of this.config.interstitialSelectors ?? []) {
      const clicked = await page.click(selector, { timeoutMs: 2000 }).catch(() => false);
      if (clicked) log.debug('dismissed interstitial', { domain: this.domain, selector });
    }
    try {
      await page.waitForHydration({
        timeoutMs: this.config.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS,
        selector: this.config.readySelector,
      });
    } catch (cause) {
      // A hydration timeout is common and not fatal: the DOM at timeout often
      // already holds the product. Extraction decides, not this.
      log.debug('hydration timed out; extracting the DOM as it stands', {
        domain: this.domain,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async discover(
    context: CrawlContext,
    cursor?: string,
  ): Promise<{ listings: DiscoveredListing[]; nextCursor: string | null }> {
    this.requireDriver('discovery');
    const listingUrls = this.config.listingUrls ?? [];
    if (listingUrls.length === 0) {
      throw new SourceUnavailableError(
        this.domain,
        'not_configured',
        `tier-3 discovery for ${this.domain} needs extractors.detail.listingUrls; nothing to walk`,
      );
    }

    const index = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
    const listingUrl = listingUrls[index];
    if (listingUrl === undefined) return { listings: [], nextCursor: null };

    const page = await this.open(context, listingUrl);
    try {
      let html = await page.content();
      // Paging by click keeps us inside the site's own navigation rather than
      // guessing at its URL scheme, which changes more often than its markup.
      if (this.config.nextPageSelector !== undefined) {
        const advanced = await page.click(this.config.nextPageSelector, { timeoutMs: 3000 }).catch(() => false);
        if (advanced) {
          await this.settle(page);
          html = `${html}\n${await page.content()}`;
        }
      }

      const seenAt = this.now();
      const pattern = this.config.linkPattern ?? null;
      const seen = new Set<string>();
      const listings: DiscoveredListing[] = [];
      for (const href of hrefs(html)) {
        const absolute = resolveUrl(href, listingUrl);
        if (absolute === null) continue;
        if (pattern !== null && !absolute.includes(pattern)) continue;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        listings.push({
          sourceDomain: this.domain,
          sourceId: lastPathSegment(absolute),
          url: absolute,
          priceHint: null,
          seenAt,
        });
      }
      return { listings, nextCursor: index + 1 < listingUrls.length ? String(index + 1) : null };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
    this.requireDriver('detail extraction');
    const page = await this.open(context, listing.url);
    try {
      const html = await page.content();
      const parsed = extractFromHtml(html, listing.url);
      const missing = missingFields(parsed, this.config.visionFields ?? DEFAULT_VISION_FIELDS);

      if (missing.length > 0 && this.vision !== null) {
        const screenshot = await page.screenshot({ fullPage: true });
        const fields = await this.vision.extract({
          url: listing.url,
          screenshot,
          html: html.slice(0, VISION_HTML_BUDGET),
          missingFields: missing,
        });
        applyVisionFields(parsed, fields, listing.url);
        log.debug('vision fallback filled fields the DOM did not', {
          domain: this.domain,
          url: listing.url,
          requested: missing,
          modelVersion: this.vision.modelVersion,
        });
      } else if (missing.length > 0) {
        // Worth seeing on the dashboard: it is the signal that this source needs
        // a vision extractor wired up, or a different tier entirely.
        log.debug('fields missing and no vision extractor injected', {
          domain: this.domain,
          url: listing.url,
          missing,
        });
      }

      if (parsed.title === null) {
        log.warn('rendered page yielded no product', { domain: this.domain, url: listing.url });
        return null;
      }
      return toRawListing(parsed, {
        domain: this.domain,
        tier: this.tier,
        sourceType: this.source.sourceType,
        sourceId: listing.sourceId !== '' ? listing.sourceId : lastPathSegment(listing.url),
        url: listing.url,
        fetchedAt: this.now(),
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async verify(
    listing: { sourceId: string; url: string },
    context: CrawlContext,
  ): Promise<{
    inStock: boolean;
    priceAmountMinor: number | null;
    currency: string | null;
    quantity: number | null;
    removed: boolean;
  } | null> {
    this.requireDriver('verification');
    const page = await this.open(context, listing.url);
    try {
      const html = await page.content();
      const parsed = extractFromHtml(html, listing.url);
      if (parsed.title === null && parsed.priceAmountMinor === null) {
        // Rendered, hydrated, and still no product: the listing is gone even if
        // the site answered with a 200 soft-404 page.
        return { inStock: false, priceAmountMinor: null, currency: null, quantity: null, removed: true };
      }
      return {
        inStock: isInStock(parsed.availabilityText),
        priceAmountMinor: parsed.priceAmountMinor,
        currency: parsed.currency,
        quantity: parsed.quantity,
        removed: false,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// DOM-then-vision helpers
// ---------------------------------------------------------------------------

const DEFAULT_VISION_FIELDS = ['title', 'price', 'currency', 'condition', 'availability', 'brand', 'images'];

function missingFields(parsed: ParsedProduct, wanted: string[]): string[] {
  const present: Record<string, boolean> = {
    title: parsed.title !== null,
    description: parsed.description !== null,
    brand: parsed.brand !== null,
    price: parsed.priceAmountMinor !== null,
    currency: parsed.currency !== null,
    condition: parsed.conditionText !== null,
    availability: parsed.availabilityText !== null,
    images: parsed.images.length > 0,
    specs: parsed.specs.length > 0,
  };
  return wanted.filter((field) => present[field] === false);
}

/**
 * Model output only ever fills a hole. Overwriting a value the DOM asserted
 * with one a model read off a screenshot would make the pipeline's provenance
 * unauditable, and the DOM is the thing the merchant actually published.
 */
function applyVisionFields(
  parsed: ParsedProduct,
  fields: Partial<Record<string, string>>,
  pageUrl: string,
): void {
  if (parsed.title === null && fields['title'] !== undefined) parsed.title = fields['title'];
  if (parsed.description === null && fields['description'] !== undefined) parsed.description = fields['description'];
  if (parsed.brand === null && fields['brand'] !== undefined) parsed.brand = fields['brand'];
  if (parsed.conditionText === null && fields['condition'] !== undefined) parsed.conditionText = fields['condition'];
  if (parsed.availabilityText === null && fields['availability'] !== undefined) {
    parsed.availabilityText = fields['availability'];
  }
  if (parsed.priceAmountMinor === null && fields['price'] !== undefined) {
    const price = parsePriceToMinor(fields['price'], parsed.currency ?? fields['currency'] ?? null);
    if (price !== null) {
      parsed.priceAmountMinor = price.minor;
      parsed.priceText = fields['price'];
      parsed.currency ??= price.currency;
    }
  }
  if (parsed.images.length === 0 && fields['images'] !== undefined) {
    for (const candidate of fields['images'].split(/[\s,]+/)) {
      const url = resolveUrl(candidate, pageUrl);
      // Dimensions are left at zero: the media pipeline measures the bytes, and
      // a guessed size would decide feed eligibility on a guess.
      if (url !== null) parsed.images.push({ url, width: 0, height: 0 });
    }
  }
}

function* hrefs(html: string): Generator<string> {
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3];
    if (href !== undefined && href !== '') yield href;
  }
}

function lastPathSegment(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter((s) => s !== '').pop() ?? parsed.pathname;
  } catch {
    return url;
  }
}
