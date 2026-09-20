/**
 * The web leg of recommendation: when the catalog alone is thin — or the feed
 * should surface things nobody has ingested yet — go find listings live.
 *
 * The blended session vector cannot be inverted into keywords, so anchors do
 * the translating: the titles nearest the vector become search queries, and
 * the adapters do the walking. Amazon answers a query directly via `/s?k=`;
 * eBay's `/sch/` is gated, so its side hunts the BROWSE sitemap for leaf
 * categories whose slug names the same products (`/b/Sharp-TVs/…` is a
 * machine-readable category title, not an opaque id).
 *
 * Each source gets an equal share of `needed` — eBay is a peer, not a
 * supplement. Whichever side underfills yields its remainder to the other.
 */

import { logger } from '../lib/logger.js';
import { fetchPage, type FetchLike } from '../ingestion/adapters/tier2-structured.js';
import { fetchSitemapBody, primedFetch } from '../ingestion/adapters/primed-fetch.js';
import { AmazonWebAdapter } from '../ingestion/adapters/amazon-web.js';
import { EbayWebAdapter, parseEbayBrowse } from '../ingestion/adapters/ebay-web.js';
import { parseAmazonSearch } from '../ingestion/adapters/amazon-web.js';
import { sourceById } from '../ingestion/sources.js';
import { SourceUnavailableError, type CrawlContext, type DiscoveredListing, type RawListing } from '../ingestion/types.js';
import { extractJson, type AgentLlm } from '../agent/llm.js';
import type { SourceDoc } from '@window/shared';

const log = logger.child('feed.web');

const CONTEXT: CrawlContext = { rps: 1, concurrency: 1, proxyPool: 'none' };
const EBAY_SITEMAP_INDEX = 'https://www.ebay.com/lst/BROWSE-0-index.xml';
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'new', 'used', 'inch', 'pack', 'set', 'black', 'white',
]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** How many query tokens appear in the candidate text. */
function overlap(query: Set<string>, text: string): number {
  const words = tokens(text);
  let n = 0;
  for (const t of query) if (words.has(t)) n += 1;
  return n;
}

/** A minimal SourceDoc for a registry miss — the adapters only read `id`. */
function syntheticSource(domain: string): SourceDoc<string> {
  return {
    id: domain,
    displayName: domain,
    tier: 2,
    sourceType: domain === 'ebay.com' ? 'secondhand' : 'new',
    crawlPolicy: { rps: 1, concurrency: 1, allowedHours: [0, 24], proxyPool: 'none', backoff: 'exponential' },
    stalenessCeilingHours: 12,
    extractors: { listing: '', detail: '' },
    health: { errorRate: 0, circuitOpen: false, circuitOpenedAt: null, lastSuccessAt: null, window: [] },
    checkout: { supported: true, guestCheckout: false, blocksAgents: true, protocol: null, stackableCoupons: false },
    status: 'active',
  };
}

/** Titles → a few generic marketplace queries, via the same LLM the agent uses. */
async function suggestQueries(anchorTitles: string[], llm: AgentLlm, maxQueries: number): Promise<string[]> {
  const fallback = anchorTitles
    .slice(0, maxQueries)
    .map((t) => [...tokens(t)].slice(0, 4).join(' '))
    .filter((q) => q !== '');
  try {
    const prompt = [
      'A shopper has been browsing these products:',
      ...anchorTitles.slice(0, 8).map((t) => `- ${t}`),
      '',
      `Suggest at most ${maxQueries} short marketplace search queries (2-4 words each)`,
      'that would surface similar purchasable items on Amazon and eBay.',
      'Reply with ONLY JSON: {"queries": ["..."]}',
    ].join('\n');
    const parsed = extractJson<{ queries?: unknown }>(await llm.decide(prompt));
    const raw = Array.isArray(parsed?.queries) ? parsed.queries : [];
    const queries = raw.filter((q): q is string => typeof q === 'string' && q.trim() !== '');
    return queries.length > 0 ? queries.slice(0, maxQueries) : fallback;
  } catch (error) {
    log.warn('query suggestion failed; deriving from titles', { error: (error as Error).message });
    return fallback;
  }
}

export interface WebExpandDeps {
  llm: AgentLlm;
  fetchImpl?: FetchLike;
  /** Reads a sitemap (possibly .gz) to text; injectable so tests stay offline. */
  sitemapBody?: (url: string, signal?: AbortSignal) => Promise<string | null>;
  /** Pause between requests; marketplaces answer haste with a challenge wall. */
  intervalMs?: number;
  maxQueries?: number;
  /** eBay BROWSE sitemap children to scan while hunting leaf categories. */
  maxSitemapChildren?: number;
  /** eBay leaf category pages to open per call. */
  maxLeafPages?: number;
}

/**
 * Pull `needed` fresh listings relevant to the anchor titles. Returns
 * `RawListing`s — the caller decides whether to rank, ingest, or show them.
 */
export async function expandFromWeb(
  anchorTitles: string[],
  needed: number,
  deps: WebExpandDeps,
): Promise<RawListing[]> {
  if (needed <= 0 || anchorTitles.length === 0) return [];
  const fetchImpl = deps.fetchImpl ?? primedFetch;
  const interval = deps.intervalMs ?? 1200;
  const queries = await suggestQueries(anchorTitles, deps.llm, deps.maxQueries ?? 3);
  if (queries.length === 0) return [];

  const found = new Map<string, RawListing>();
  const take = (listing: RawListing | null): void => {
    if (listing !== null && listing.title !== null) {
      found.set(`${listing.sourceDomain}:${listing.sourceId}`, listing);
    }
  };
  const domainCount = (domain: string): number => {
    let n = 0;
    for (const listing of found.values()) if (listing.sourceDomain === domain) n += 1;
    return n;
  };

  type DetailAdapter = { fetchDetail(d: DiscoveredListing, c: CrawlContext): Promise<RawListing | null> };
  const attempted = new Set<string>();
  const fetchDetails = async (
    queue: DiscoveredListing[],
    adapter: DetailAdapter,
    domain: string,
    quota: number,
  ): Promise<void> => {
    for (const item of queue) {
      if (domainCount(domain) >= quota || found.size >= needed) break;
      const key = `${domain}:${item.sourceId}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      try {
        await sleep(interval);
        take(await adapter.fetchDetail(item, CONTEXT));
      } catch (error) {
        log.debug(`${domain} item fetch failed`, { id: item.sourceId, error: (error as Error).message });
      }
    }
  };

  // Amazon: the query goes straight into a search URL.
  const amazon = new AmazonWebAdapter(
    sourceById('amazon.com') ?? syntheticSource('amazon.com'),
    { fetchImpl },
  );
  const amazonQueue = new Map<string, DiscoveredListing>();
  for (const query of queries) {
    try {
      await sleep(interval);
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
      const page = await fetchPage(url, CONTEXT, 'amazon.com', fetchImpl);
      if (page.status >= 400) continue;
      const wanted = new Set(tokens(query));
      for (const { item } of parseAmazonSearch(page.body, page.url).items
        .map((item) => ({ item, score: overlap(wanted, item.titleHint ?? '') }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)) {
        amazonQueue.set(item.sourceId, item);
      }
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        log.warn('amazon search refused', { query });
        break;
      }
      throw error;
    }
  }

  // eBay: /sch/ is gated, so hunt the BROWSE sitemap for leaf categories whose
  // slug carries the query's vocabulary, then take items off those pages.
  const ebay = new EbayWebAdapter(
    sourceById('ebay.com') ?? syntheticSource('ebay.com'),
    { fetchImpl },
  );
  const ebayQueue = new Map<string, DiscoveredListing>();
  const sitemapBody = deps.sitemapBody ?? fetchSitemapBody;
  try {
    const index = await sitemapBody(EBAY_SITEMAP_INDEX, CONTEXT.signal);
    if (index !== null) {
      const children = [...index.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
        .map((m) => m[1] as string)
        .slice(0, deps.maxSitemapChildren ?? 4);
      const queryTokens = queries.map(tokens);
      const leafUrls: string[] = [];
      for (const child of children) {
        await sleep(interval);
        const body = await sitemapBody(child, CONTEXT.signal);
        if (body === null) continue;
        const leaves = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1] as string);
        const scored = leaves
          .filter((u) => u.includes('/b/'))
          .map((u) => ({ u, score: Math.max(...queryTokens.map((q) => overlap(q, u))) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score);
        leafUrls.push(...scored.slice(0, 3).map((s) => s.u));
      }

      for (const leaf of leafUrls.slice(0, deps.maxLeafPages ?? 3)) {
        try {
          await sleep(interval);
          const page = await fetchPage(leaf, CONTEXT, 'ebay.com', fetchImpl);
          if (page.status >= 400) continue;
          const items = parseEbayBrowse(page.body, page.url).items;
          const best = items
            .map((item) => ({ item, score: Math.max(...queryTokens.map((q) => overlap(q, item.titleHint ?? ''))) }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map((s) => s.item);
          for (const item of best.length > 0 ? best : items.slice(0, 3)) {
            ebayQueue.set(item.sourceId, item);
          }
        } catch (error) {
          if (error instanceof SourceUnavailableError) break;
          throw error;
        }
      }
    }
  } catch (error) {
    // A refused sitemap must not sink the Amazon side.
    log.warn('ebay discovery failed', { error: (error as Error).message });
  }

  // Equal shares; whoever underfills yields the remainder to the other side.
  const perSource = Math.ceil(needed / 2);
  await fetchDetails([...amazonQueue.values()], amazon, 'amazon.com', perSource);
  await fetchDetails([...ebayQueue.values()], ebay, 'ebay.com', perSource);
  await fetchDetails([...amazonQueue.values()], amazon, 'amazon.com', needed);
  await fetchDetails([...ebayQueue.values()], ebay, 'ebay.com', needed);

  return [...found.values()].slice(0, needed);
}
