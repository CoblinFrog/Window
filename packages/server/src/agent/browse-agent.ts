/**
 * The browsing agent.
 *
 * A page fetch produces candidates — the items the page links to and the
 * pages it points at next. The model reads that compact list (never the raw
 * HTML, which is megabytes of chrome) and decides which items are worth a
 * detail fetch and which links are worth following. Everything it picks goes
 * through the source adapter's `fetchDetail`, so a chosen item is a real
 * `RawListing` by the time it leaves here.
 *
 * Budgets are the contract: `maxPages` bounds requests, `maxItems` bounds the
 * harvest, and pacing is serialized because both storefronts answer haste with
 * a challenge wall.
 */

import { logger } from '../lib/logger.js';
import { fetchPage, type FetchedPage, type FetchLike } from '../ingestion/adapters/tier2-structured.js';
import { fetchSitemapBody, primedFetch } from '../ingestion/adapters/primed-fetch.js';
import {
  SourceUnavailableError,
  type CrawlContext,
  type PageCandidates,
  type RawListing,
  type WebSourceAdapter,
} from '../ingestion/types.js';
import { extractJson, type AgentLlm } from './llm.js';

const log = logger.child('agent.browse');

interface AgentDecision {
  /** Item sourceIds the model wants opened. */
  pick: string[];
  /** Nav URLs worth visiting next. */
  follow: string[];
  /** Model's signal that this thread is exhausted. */
  done: boolean;
}

export interface BrowseAgentOptions {
  adapter: WebSourceAdapter;
  context: CrawlContext;
  llm: AgentLlm;
  /** Called for each listing the agent chose and the adapter extracted. */
  onListing(listing: RawListing): Promise<void>;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  maxPages?: number;
  maxItems?: number;
  maxPickPerPage?: number;
  maxFollowPerPage?: number;
}

export interface BrowseAgentStats {
  pagesVisited: number;
  itemsIngested: number;
  llmCalls: number;
  llmFailures: number;
  blockedPages: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export class BrowseAgent {
  private readonly adapter: WebSourceAdapter;
  private readonly context: CrawlContext;
  private readonly llm: AgentLlm;
  private readonly onListing: (listing: RawListing) => Promise<void>;
  private readonly fetchImpl: FetchLike;
  private readonly intervalMs: number;
  private readonly maxPages: number;
  private readonly maxItems: number;
  private readonly maxPickPerPage: number;
  private readonly maxFollowPerPage: number;

  constructor(options: BrowseAgentOptions) {
    this.adapter = options.adapter;
    this.context = options.context;
    this.llm = options.llm;
    this.onListing = options.onListing;
    this.fetchImpl = options.fetchImpl ?? primedFetch;
    this.intervalMs = options.intervalMs ?? 1500;
    this.maxPages = options.maxPages ?? 12;
    this.maxItems = options.maxItems ?? 30;
    this.maxPickPerPage = options.maxPickPerPage ?? 8;
    this.maxFollowPerPage = options.maxFollowPerPage ?? 3;
  }

  private fetch(url: string): Promise<FetchedPage> {
    return fetchPage(url, this.context, this.adapter.domain, this.fetchImpl);
  }

  private async fetchSitemap(url: string): Promise<FetchedPage> {
    const body = await fetchSitemapBody(url, this.context.signal);
    if (body === null) {
      throw new SourceUnavailableError(this.adapter.domain, 'blocked', `sitemap ${url} refused or failed`);
    }
    return { status: 200, url, body };
  }

  /**
   * A sitemap page has no items — only onward URLs — and a leaf index can name
   * tens of thousands, so the nav is a uniform sample rather than the head.
   */
  private candidatesFrom(page: FetchedPage): PageCandidates {
    if (/<sitemapindex|<urlset/.test(page.body.slice(0, 400))) {
      const locs = [...page.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1] as string);
      const sample = locs.length <= 200 ? locs : shuffled(locs).slice(0, 200);
      return { items: [], nav: sample };
    }
    return this.adapter.candidatesFromPage(page.body, page.url);
  }

  /**
   * Asks the model which items and which onward links are worth it. A parse
   * failure degrades to taking the first few priced items — an LLM hiccup
   * should cost a page's worth of judgment, not the whole crawl.
   */
  private async decide(
    pageUrl: string,
    candidates: { items: { sourceId: string; titleHint?: string | null; priceHint: number | null }[]; nav: string[] },
    pagesVisited: number,
  ): Promise<AgentDecision> {
    const rows = candidates.items.slice(0, 40).map((item) => {
      const price = item.priceHint === null ? '?' : `$${(item.priceHint / 100).toFixed(2)}`;
      return `${item.sourceId} | ${item.titleHint ?? '(untitled)'} | ${price}`;
    });
    const navs = candidates.nav.slice(0, 10);

    const prompt = [
      'You are curating items for Window, a shopping-discovery feed.',
      `Page: ${pageUrl}`,
      '',
      'Items on this page (id | title | price):',
      ...rows.map((r) => `- ${r}`),
      '',
      'Pages you could visit next:',
      ...navs.map((n) => `- ${n}`),
      '',
      `Visited ${pagesVisited} pages so far. Pick at most ${this.maxPickPerPage} item ids that`,
      'would make good cards: recognizable products with a clear title and a real',
      'price. Skip accessories-of-accessories, gift cards, and oddities with no',
      `obvious buyer. Pick at most ${this.maxFollowPerPage} nav links likely to lead`,
      'to more such items. Reply with ONLY JSON:',
      '{"pick": ["id"], "follow": ["url"], "done": false}.',
      'Set done to true only if nothing here is worth taking or following.',
    ].join('\n');

    const reply = await this.llm.decide(prompt);
    const parsed = extractJson<Partial<AgentDecision>>(reply);
    if (parsed === null || !Array.isArray(parsed.pick)) {
      log.warn('llm reply did not parse; taking priced head of list', { pageUrl });
      return {
        pick: candidates.items.filter((i) => i.priceHint !== null).slice(0, 4).map((i) => i.sourceId),
        follow: [],
        done: false,
      };
    }
    return {
      pick: parsed.pick.map(String),
      follow: Array.isArray(parsed.follow) ? parsed.follow.map(String) : [],
      done: parsed.done === true,
    };
  }

  async run(seeds: string[]): Promise<BrowseAgentStats> {
    const queue = [...seeds];
    const visited = new Set<string>();
    const takenItems = new Set<string>();
    const stats: BrowseAgentStats = {
      pagesVisited: 0,
      itemsIngested: 0,
      llmCalls: 0,
      llmFailures: 0,
      blockedPages: 0,
    };
    const domainHost = hostnameOf(seeds[0] ?? '');

    while (queue.length > 0 && stats.pagesVisited < this.maxPages && stats.itemsIngested < this.maxItems) {
      const url = queue.shift() as string;
      if (visited.has(url)) continue;
      visited.add(url);

      let page: FetchedPage;
      try {
        await sleep(this.intervalMs);
        // Sitemaps ship as .gz files — binary content, not a transfer encoding —
        // so the HTML fetch path would hand back mojibake.
        page = /\.xml(\.gz)?$/.test(url)
          ? await this.fetchSitemap(url)
          : await this.fetch(url);
      } catch (error) {
        if (error instanceof SourceUnavailableError && error.reason === 'blocked') {
          stats.blockedPages += 1;
          log.warn('page refused; skipping', { url });
          continue;
        }
        throw error;
      }
      if (page.status >= 400) continue;
      stats.pagesVisited += 1;

      const candidates = this.candidatesFrom(page);
      const fresh = candidates.items.filter((item) => !takenItems.has(item.sourceId));
      if (fresh.length === 0 && candidates.nav.length === 0) continue;

      stats.llmCalls += 1;
      let decision: AgentDecision;
      try {
        decision = await this.decide(page.url, { items: fresh, nav: candidates.nav }, stats.pagesVisited);
      } catch (error) {
        stats.llmFailures += 1;
        log.warn('llm call failed', { url: page.url, error: (error as Error).message });
        decision = { pick: fresh.slice(0, 4).map((i) => i.sourceId), follow: [], done: false };
      }

      const byId = new Map(fresh.map((item) => [item.sourceId, item]));
      for (const id of decision.pick.slice(0, this.maxPickPerPage)) {
        const item = byId.get(id);
        if (item === undefined || takenItems.has(id)) continue;
        takenItems.add(id);
        try {
          await sleep(this.intervalMs);
          const listing = await this.adapter.fetchDetail(item, this.context);
          if (listing === null) continue;
          await this.onListing(listing);
          stats.itemsIngested += 1;
        } catch (error) {
          log.warn('item fetch failed', { id, error: (error as Error).message });
        }
        if (stats.itemsIngested >= this.maxItems) break;
      }

      for (const nav of decision.follow.slice(0, this.maxFollowPerPage)) {
        const host = hostnameOf(nav);
        if (host === null || (domainHost !== null && host !== domainHost)) continue;
        if (!visited.has(nav)) queue.push(nav);
      }

      log.info('agent page', {
        url: page.url,
        found: fresh.length,
        picked: decision.pick.length,
        followed: decision.follow.length,
        done: decision.done,
      });
    }

    return stats;
  }
}
