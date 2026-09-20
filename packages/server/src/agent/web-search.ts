/**
 * Server-side web search for the review scout.
 *
 * Letting an agent search the web itself means paying a model turn per query
 * and per page fetch. DuckDuckGo's lite endpoint is a plain HTML table — one
 * request here yields titles, URLs, and snippets, which is all the digest
 * needs as evidence. The model then summarizes in a single tool-less call.
 */

import { decodeEntities, type FetchLike } from '../ingestion/adapters/tier2-structured.js';
import { logger } from '../lib/logger.js';

const log = logger.child('agent.web-search');

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const MAX_HITS = 10;

function clean(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** lite.duckduckgo.com wraps outbound links in /l/?uddg=<encoded>. */
function realUrl(href: string): string | null {
  const wrapped = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  const target = wrapped !== undefined ? decodeURIComponent(wrapped) : href;
  return /^https?:/i.test(target) ? target : null;
}

/**
 * One query → up to MAX_HITS organic results. `[]` on any failure — search is
 * evidence gathering, not something worth throwing over.
 */
export async function duckDuckGoSearch(query: string, fetchImpl: FetchLike): Promise<SearchHit[]> {
  let html: string;
  try {
    const response = await fetchImpl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    html = await response.text();
  } catch (error) {
    log.debug('search request failed', { query, error: (error as Error).message });
    return [];
  }

  // Result rows alternate link cell / snippet cell, so document order pairs them.
  const links = [...html.matchAll(/<a\b[^>]*class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)];

  const hits: SearchHit[] = [];
  for (let i = 0; i < links.length && hits.length < MAX_HITS; i++) {
    const href = /href=["']([^"']+)["']/i.exec(links[i]?.[0] ?? '')?.[1] ?? '';
    const url = realUrl(href);
    if (url === null) continue;
    hits.push({
      title: clean(links[i]?.[1] ?? ''),
      url,
      snippet: clean(snippets[i]?.[1] ?? ''),
    });
  }
  return hits;
}
