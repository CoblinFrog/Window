/**
 * Internet-wide product reviews.
 *
 * A listing's own page is the worst place to learn what a product is like —
 * the storefront wants the sale. So instead of scraping the listing's review
 * section, an agent with web tools goes looking: review sites, forums,
 * retailer pages, video write-ups — anywhere but the marketplace itself — and
 * condenses what it finds into a consensus with citations.
 *
 * The digest is only as honest as its sources, so the contract is that every
 * claim is anchored to URLs the caller can display alongside it. Sources on the
 * listing's own domain are dropped here even if the model cites them — a
 * "review" of the product that lives on the seller's own storefront is an ad.
 */

import { logger } from '../lib/logger.js';
import { extractJson, type AgentLlm } from './llm.js';
import type { SearchHit } from './web-search.js';

const log = logger.child('agent.reviews');

export interface ReviewSource {
  title: string;
  url: string;
  /** One phrase: what this source contributes to the consensus. */
  note: string | null;
}

export interface ProductReviewDigest {
  /** The consensus in a few sentences: verdict, recurring praise, complaints. */
  summary: string;
  /** Where the summary came from. Always shown with it. */
  sources: ReviewSource[];
}

export interface ReviewSubject {
  title: string;
  brand: string | null;
  sourceDomain: string;
  url: string;
}

export interface ReviewDeps {
  llm: AgentLlm;
  /**
   * Server-side search. When provided the scout never touches tools — hits
   * are gathered here and the model summarizes them in one call (fast).
   * Without it the model needs WebSearch allowed and researches on its own
   * (slower, but can go deeper).
   */
  search?: (query: string) => Promise<SearchHit[]>;
}

const MAX_SOURCES = 8;
const MAX_PROMPT_HITS = 8;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function answerShape(): string[] {
  return [
    'Reply with ONLY JSON:',
    '{"summary": "3-5 sentences: the consensus verdict, recurring praise,',
    ' recurring complaints, and who the product suits.",',
    ' "sources": [{"title": "page title", "url": "https://...",',
    '              "note": "one phrase: what this source adds"}]}',
  ];
}

function researchedPrompt(subject: ReviewSubject, hits: SearchHit[]): string {
  const evidence = hits
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   "${h.snippet}"`)
    .join('\n');
  return [
    'You are summarizing what reviewers across the internet say about a product.',
    '',
    `Product: ${subject.title}`,
    `Brand: ${subject.brand ?? 'unknown'}`,
    `Seen on a ${subject.sourceDomain} listing: ${subject.url}`,
    '',
    'These search results were already gathered — titles, urls, snippets:',
    '',
    evidence,
    '',
    'Write the consensus from these snippets. Prioritize editorial coverage —',
    'review sites, blogs, retailer review pages — over forum posts.',
    '',
    ...answerShape(),
    'Cite only results listed above — 3 to 6 of them.',
    'If the snippets say nothing real, answer {"summary": "", "sources": []}.',
  ].join('\n');
}

function agentedPrompt(subject: ReviewSubject): string {
  return [
    'You are summarizing what reviewers across the internet say about a product.',
    '',
    `Product: ${subject.title}`,
    `Brand: ${subject.brand ?? 'unknown'}`,
    `Seen on a ${subject.sourceDomain} listing: ${subject.url}`,
    '',
    'Use WebSearch to find reviews of this product, or the closest identifiable',
    'model, on independent sources. Prioritize editorial coverage — review',
    'sites, blogs, retailer review pages, YouTube write-ups — over forum posts;',
    'Reddit and the like are filler for when real reviews are thin. Search',
    'snippets count as evidence — do not cite the listing itself or any page',
    `on ${subject.sourceDomain}.`,
    '',
    ...answerShape(),
    'Cite only pages you actually found via search — 3 to 6 of them.',
    'If nothing real turns up, answer {"summary": "", "sources": []}.',
  ].join('\n');
}

/**
 * Researches what the internet says about the product and returns a cited
 * consensus. With a `search` dep this is one search request plus one model
 * call; without it the model searches itself via tools. `null` means nothing
 * real was found or the answer did not parse — the caller treats that as "no
 * digest", not as an error worth surfacing.
 */
export async function internetReviews(
  subject: ReviewSubject,
  deps: ReviewDeps,
): Promise<ProductReviewDigest | null> {
  let prompt: string;
  if (deps.search !== undefined) {
    const hits = (await deps.search(`${subject.title} reviews`))
      .filter((h) => hostOf(h.url) !== hostOf(subject.url))
      .slice(0, MAX_PROMPT_HITS);
    if (hits.length === 0) {
      log.debug('review scout found no search hits', { title: subject.title });
      return null;
    }
    prompt = researchedPrompt(subject, hits);
  } else {
    prompt = agentedPrompt(subject);
  }

  const reply = await deps.llm.decide(prompt);
  const parsed = extractJson<{ summary?: unknown; sources?: unknown }>(reply);
  if (parsed === null || typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    log.debug('review scout returned no digest', { title: subject.title });
    return null;
  }

  const listingHost = hostOf(subject.url);
  const sources: ReviewSource[] = [];
  for (const raw of Array.isArray(parsed.sources) ? parsed.sources : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { title, url, note } = raw as Record<string, unknown>;
    if (typeof url !== 'string') continue;
    const host = hostOf(url);
    if (host === null || host === listingHost) continue;
    sources.push({
      title: typeof title === 'string' && title !== '' ? title : host,
      url,
      note: typeof note === 'string' && note !== '' ? note : null,
    });
    if (sources.length >= MAX_SOURCES) break;
  }

  return { summary: parsed.summary.trim(), sources };
}
