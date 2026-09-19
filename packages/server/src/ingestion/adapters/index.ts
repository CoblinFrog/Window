/**
 * Adapter construction and the PRD's automatic tier fallback.
 *
 * A source's registered tier is where the crawl starts, not where it is stuck.
 * Tier 2 stops working the day a merchant turns on bot mitigation, and the
 * pipeline's answer is to escalate that one source to the next tier that can
 * serve it rather than to lose the supply until someone edits the registry.
 * Because all three tiers produce `RawListing`, the fallback is a wrapper here
 * and nothing downstream knows it happened beyond the tier stamped on the row.
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
import { Tier1AffiliateAdapter, type Tier1Deps } from './tier1-affiliate.js';
import { AMAZON_ENV_VARS, amazonPaapiFromEnv } from './amazon-paapi.js';
import { EBAY_ENV_VARS, ebayBrowseFromEnv } from './ebay-browse.js';
import { Tier2StructuredAdapter, type FetchLike } from './tier2-structured.js';
import { Tier3BrowserAdapter, type BrowserDriver, type VisionExtractor } from './tier3-browser.js';

const log = logger.child('ingestion.adapters');

export * from './tier1-affiliate.js';
export * from './tier2-structured.js';
export * from './tier3-browser.js';

// Named rather than starred: both API adapters export a `fromEnv`, and two
// `export *` offering the same name is an ambiguity TypeScript rejects. Only
// the aliases cross this barrel, so the name a caller imports says which API
// it is constructing.
export {
  AMAZON_ENV_VARS,
  AMAZON_MARKETPLACES,
  AmazonPaapiAdapter,
  amazonPaapiFromEnv,
  amazonSourceType,
  amzDate,
  deriveSigningKey,
  mapAmazonItem,
  signAwsV4,
  type AmazonPaapiDeps,
  type AmazonPaapiOptions,
  type SigV4Request,
  type SigV4Result,
} from './amazon-paapi.js';
export {
  EBAY_ENV_VARS,
  EbayBrowseAdapter,
  ebayBrowseFromEnv,
  ebaySourceType,
  isUsedCondition,
  mapEbayItem,
  type EbayBrowseDeps,
  type EbayBrowseOptions,
} from './ebay-browse.js';

export interface AdapterDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Credential lookup for tier-1 feeds. */
  secret?: (name: string) => string | undefined;
  /** Absent in this environment; tier 3 refuses to run without it. */
  browserDriver?: BrowserDriver;
  /** Optional model-based fallback for fields tier 3's DOM pass did not yield. */
  visionExtractor?: VisionExtractor;
}

/** The three deps an API adapter's `fromEnv` accepts; the rest are tier-3's. */
type ApiAdapterDeps = Pick<AdapterDeps, 'fetchImpl' | 'now' | 'secret'>;

/**
 * Tier-1 sources that are an API client rather than a feed mapping.
 *
 * eBay mints an OAuth2 token per crawl and PA-API signs every request with
 * SigV4, so neither is expressible as a URL plus a static auth header — the
 * generic tier-1 config that used to stand in for them could only ever have
 * 401'd. Routing them here is what makes the dedicated adapters reachable.
 *
 * `requires` mirrors the credentials each `fromEnv` insists on. It is restated
 * rather than inferred because `canServe` has to answer "can tier 1 serve
 * this?" without constructing anything: `fromEnv` logs on the way to returning
 * null, and Amazon's constructor throws outright on an unknown marketplace.
 */
const TIER1_API_ADAPTERS: Record<
  string,
  { requires: readonly string[]; create: (deps: ApiAdapterDeps) => SourceAdapter | null }
> = {
  'ebay.com': {
    requires: [EBAY_ENV_VARS.clientId, EBAY_ENV_VARS.clientSecret],
    create: ebayBrowseFromEnv,
  },
  'amazon.com': {
    requires: [AMAZON_ENV_VARS.accessKey, AMAZON_ENV_VARS.secretKey, AMAZON_ENV_VARS.partnerTag],
    create: amazonPaapiFromEnv,
  },
};

function hasSecrets(names: readonly string[], secret: AdapterDeps['secret']): boolean {
  const lookup = secret ?? ((name: string) => process.env[name]);
  return names.every((name) => (lookup(name) ?? '').trim() !== '');
}

export function createAdapter(source: SourceDoc<string>, deps: AdapterDeps = {}): SourceAdapter {
  return createAdapterForTier(source, source.tier, deps);
}

export function createAdapterForTier(
  source: SourceDoc<string>,
  tier: SourceTier,
  deps: AdapterDeps = {},
): SourceAdapter {
  switch (tier) {
    case 1: {
      const tier1: Tier1Deps = { fetchImpl: deps.fetchImpl, now: deps.now, secret: deps.secret };

      const api = TIER1_API_ADAPTERS[source._id];
      if (api !== undefined) {
        const adapter = api.create(tier1);
        if (adapter !== null) return adapter;
        // `canServe` has already excluded this tier for anything reaching here
        // through `fallbackChain`, so this is the direct-construction path. The
        // generic adapter below cannot stand in — these sources carry no feed
        // config — and naming the missing keys beats its parse error.
        throw new SourceUnavailableError(
          source._id,
          'not_configured',
          `${source._id} is served by a dedicated API adapter; set ${api.requires.join(', ')}`,
        );
      }

      return new Tier1AffiliateAdapter(source, tier1);
    }
    case 2:
      return new Tier2StructuredAdapter(source, { fetchImpl: deps.fetchImpl, now: deps.now });
    case 3:
      return new Tier3BrowserAdapter(source, {
        driver: deps.browserDriver,
        vision: deps.visionExtractor,
        now: deps.now,
      });
  }
}

/**
 * Whether a tier has enough configuration to be worth attempting.
 *
 * This is the difference between a fallback that recovers supply and one that
 * turns every tier-2 failure into three failures: a source with no affiliate
 * feed configured cannot be served by tier 1 no matter how cheap tier 1 is.
 */
export function canServe(source: SourceDoc<string>, tier: SourceTier, deps: AdapterDeps = {}): boolean {
  const api = TIER1_API_ADAPTERS[source._id];
  if (api !== undefined) {
    // These two are the API or nothing, at every tier. Their robots.txt
    // disallows the listing and search paths, so tier 2 and tier 3 are not
    // cheaper routes to the same rows — they are scraping a site that said no,
    // which is the one failure mode the fallback chain must not invent. With no
    // credentials the honest answer is that nothing can serve the source, and
    // `adapterWithFallback` says so rather than quietly substituting a crawler.
    return tier === 1 && hasSecrets(api.requires, deps.secret);
  }
  switch (tier) {
    case 1:
      return hasFeedConfig(source);
    case 2:
      // Tier 2 only needs a URL to fetch, which every listing already carries;
      // discovery config is checked when discovery is actually attempted.
      return true;
    case 3:
      return deps.browserDriver !== undefined;
  }
}

function hasFeedConfig(source: SourceDoc<string>): boolean {
  try {
    const parsed: unknown = JSON.parse(source.extractors.listing);
    return typeof parsed === 'object' && parsed !== null && 'itemsPath' in parsed && 'mapping' in parsed;
  } catch {
    return false;
  }
}

/** Configured tier first, then the remaining tiers cheapest-first. */
export function fallbackChain(source: SourceDoc<string>, deps: AdapterDeps = {}): SourceTier[] {
  const rest: SourceTier[] = ([1, 2, 3] as const).filter((tier) => tier !== source.tier);
  return [source.tier, ...rest].filter((tier) => canServe(source, tier, deps));
}

function isEscalatable(error: unknown): boolean {
  // A blocked or unconfigured tier is exactly what the next tier exists for.
  // Anything else — an abort, a bug — must surface rather than be papered over
  // by an expensive retry at a higher tier.
  if (error instanceof SourceUnavailableError) return error.reason !== 'circuit_open';
  return false;
}

/**
 * Wraps a source in its fallback chain.
 *
 * `tier` reports the tier the source is registered at; the tier a given listing
 * was actually served by is stamped on the `RawListing` it produced, which is
 * what the tier-3 budget is measured from.
 */
export function adapterWithFallback(source: SourceDoc<string>, deps: AdapterDeps = {}): SourceAdapter {
  const chain = fallbackChain(source, deps);
  if (chain.length === 0) {
    throw new SourceUnavailableError(
      source._id,
      'not_configured',
      `no tier can serve ${source._id}: tier ${source.tier} is registered but nothing is configured for it`,
    );
  }
  if (chain[0] !== source.tier) {
    // Running a source below its registered tier is a downgrade in capability,
    // not a routine fallback: it is how a tier-3 source quietly turns into a
    // handful of parse failures when the browser fleet is missing.
    log.warn('registered tier cannot be constructed; serving from a lower tier', {
      domain: source._id,
      registeredTier: source.tier,
      servingTiers: chain,
    });
  }
  const adapters = chain.map((tier) => createAdapterForTier(source, tier, deps));

  async function attempt<T>(
    operation: string,
    run: (adapter: SourceAdapter) => Promise<T>,
    isEmpty: (result: T) => boolean,
  ): Promise<T> {
    let lastError: unknown = null;
    for (let i = 0; i < adapters.length; i++) {
      const adapter = adapters[i];
      if (adapter === undefined) continue;
      try {
        const result = await run(adapter);
        if (!isEmpty(result) || i === adapters.length - 1) return result;
        // A tier that returned nothing has not necessarily failed — it may have
        // been defeated by client-side rendering, which the next tier handles.
        log.debug('tier produced no result; escalating', {
          domain: source._id,
          operation,
          tier: adapter.tier,
        });
      } catch (error) {
        if (!isEscalatable(error) || i === adapters.length - 1) throw error;
        lastError = error;
        log.warn('tier failed; falling back', {
          domain: source._id,
          operation,
          tier: adapter.tier,
          reason: error instanceof SourceUnavailableError ? error.reason : 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (lastError !== null) throw lastError;
    throw new SourceUnavailableError(source._id, 'not_configured', `${operation} exhausted every tier for ${source._id}`);
  }

  return {
    tier: source.tier,
    domain: source._id,

    discover(context: CrawlContext, cursor?: string) {
      return attempt(
        'discover',
        (adapter) => adapter.discover(context, cursor),
        // Only an empty first page is treated as failure: an empty later page is
        // the end of the catalog and escalating there would re-walk it forever.
        (result) => cursor === undefined && result.listings.length === 0,
      );
    },

    fetchDetail(listing: DiscoveredListing, context: CrawlContext): Promise<RawListing | null> {
      return attempt(
        'fetchDetail',
        (adapter) => adapter.fetchDetail(listing, context),
        (result) => result === null,
      );
    },

    verify(listing: { sourceId: string; url: string }, context: CrawlContext) {
      return attempt(
        'verify',
        (adapter) => adapter.verify(listing, context),
        // A confirmed removal is an answer; only a non-answer escalates.
        (result) => result === null,
      );
    },
  };
}
