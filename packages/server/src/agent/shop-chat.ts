/**
 * The shopping chatbot — a thin wrapper around two storefront searches, and
 * nothing else.
 *
 * One turn is: the user says what they want, the intake step guards it
 * (shopping request? budget? too vague?), Amazon and eBay are searched in
 * parallel for that item, the gate keeps only cards that are priced and in
 * budget, and one model call picks the 2–5 that are actually the product and
 * writes the reply in the same breath. The model only ever sees listings we
 * retrieved, so it cannot invent a product.
 *
 * What this deliberately does not do is research. There is no agent reading
 * buying guides, no per-product locate-and-verify pass, no per-pick review
 * digest — those bought a better-argued answer at the cost of minutes, and a
 * chat that takes minutes is not a chat. Review evidence now comes off the
 * search card itself, which is free because we already fetched the page.
 *
 * It also does not read the catalog, and that is a correction rather than an
 * omission. Blending catalog rows in was supposed to enrich the answer; what
 * it actually did was break it. The two legs score on incomparable scales —
 * the local index returns a quantized dot product (values above 4 are normal),
 * while a storefront card carries a rescaled cosine in [0,1] — so every
 * catalog row outranked every real search hit, filled the shortlist, and left
 * "budget gaming chair" answered with a keyboard, a night light and two smart
 * watches. A relevance floor cannot arbitrate between two different units.
 *
 * The storefronts are the live source of truth for what is buyable right now,
 * so the catalog was never adding a thing the search did not already have.
 *
 * The latency shape of a turn: one regex (or one small model call) for intent,
 * two parallel HTTP fetches, local embedding maths, one model call. Every
 * constraint the user states is still enforced in code after the model stage —
 * the parser can misread "under $80" and the model can misjudge a title, but
 * neither can put a $120 pick in the reply, because the gate drops it first.
 */

import { cosine } from '@window/shared';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { sessionVector, type ListingRecommendation } from '../feed/recommend.js';
import {
  searchStorefronts,
  storefrontOf,
  type Storefront,
  type StorefrontCard,
  type StorefrontSearchDeps,
} from '../feed/storefront-search.js';
import { logger } from '../lib/logger.js';
import { extractJson, type AgentLlm } from './llm.js';

const log = logger.child('agent.chat');

/** How many cards the storefront leg pulls so the gate still has 2–5 after cuts. */
const POOL_SIZE = 16;
/** The contract: a chat answer carries 2–5 listings, never more, fewer only
 *  when the pool genuinely can't fill it. */
const MIN_PICKS = 2;
const MAX_PICKS = 5;

/** Budgets below this are treated as a typo, not a price ceiling. */
const MIN_BUDGET_MINOR = 50; // $0.50
/**
 * Star floor, and how many ratings it takes before the average is worth
 * believing. A 2.1★ product with 400 ratings is a bad product; a 2.1★ product
 * with three is a product nobody has reviewed yet, and cutting it would just
 * punish new listings.
 */
const MIN_STAR_RATING = 3;
const RATINGS_FOR_CONFIDENCE = 20;
/**
 * Relevance floor, measured against the requested item alone. Rescaled cosine
 * puts orthogonal (unrelated) items at ~0.5, so anything below 0.55 is not an
 * answer to the ask.
 *
 * Hard, not soft. It used to fall back to "everything buyable" when too few
 * cleared it, on the theory that a loose answer beats an empty one. It does
 * not: with both storefronts down the pool is catalog-only, and the catalog's
 * nearest neighbours to a lighting-heavy taste vector are lamps — so
 * "mechanical keyboard under $50" answered with night lights. Saying we found
 * nothing is the honest answer, and the only one the shopper can act on.
 */
const MIN_RELEVANCE = 0.55;
/**
 * How much long-term taste may reorder items that are already the right thing.
 * Small on purpose: preferences break ties between equally relevant listings,
 * they never decide what counts as an answer. Letting them into that decision
 * is exactly what put lamps in a keyboard search.
 */
const PREFERENCE_NUDGE = 0.1;

/** One line of the conversation, oldest first. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * What earlier turns established. Carried by the client and handed back each
 * turn rather than re-derived from the transcript, so a follow-up resolves the
 * same way whether or not the model is reachable — "under $50" on its own has
 * to keep working when the intake falls back to its regex.
 */
export interface StandingIntent {
  item: string;
  budgetMinor: number | null;
  requirements: string[];
}

/** How many turns of transcript the intake is shown. */
const HISTORY_TURNS = 8;

export interface ChatSession {
  /** The user's long-term preference embedding — same vector the feed blends. */
  preferences: readonly number[];
  /**
   * Recent-history vector, optional. When present it shares the "recent" slot
   * with the parsed request, so what they just looked at still steers.
   */
  recent?: readonly number[];
  /** The conversation so far, excluding the message being answered now. */
  history?: readonly ChatTurn[];
  /** The request earlier turns settled on, for this one to build on. */
  standing?: StandingIntent | null;
}

export interface ChatDeps {
  llm: AgentLlm;
  embedder: EmbeddingProvider;
  /**
   * The retrieval seam — Amazon and eBay search, in parallel. Defaults to
   * `searchStorefronts`; tests and scripts substitute their own.
   */
  search?: (
    item: string,
    budgetMinor: number | null,
    limit: number,
  ) => Promise<StorefrontCard[]>;
  /** Passed to the default storefront leg: fetch impl, per-leg timeout, abort. */
  storefront?: StorefrontSearchDeps;
}

export interface ChatPick extends ListingRecommendation {
  sourceDomain: string | null;
  /**
   * How close this is to the shopper's long-term taste, in [0,1]. It orders
   * picks that already answer the question; it is never part of deciding
   * whether one does. `score` carries relevance to the asked item.
   */
  affinity: number;
  /** Star rating out of 5 off the search card; null when it showed none. */
  rating: number | null;
  /** How many ratings back that average. */
  reviewCount: number | null;
  /**
   * The same evidence as one line — "4.4★ across 2,248 ratings" — so a client
   * can render it without formatting. Null when the card shipped no review
   * signal, which is the normal case on eBay.
   */
  reviewNote: string | null;
  /** Where that evidence can be checked. Empty when there is none to cite. */
  sources: { title: string; url: string }[];
}

export interface ChatReply {
  kind: 'answer' | 'clarify' | 'refused';
  /** The assistant's message — always set, even when picks are empty. */
  message: string;
  picks: ChatPick[];
  /**
   * What this turn resolved the request to, for the client to hand back on the
   * next one. Null when the turn established nothing to build on — a refusal,
   * or a clarify that is still waiting to hear what the item is.
   */
  standing: StandingIntent | null;
  /** The enforced ceiling, echoed so the client can render it. */
  budgetMinor: number | null;
  /** Non-price constraints extracted from the ask, echoed for the client. */
  requirements: string[];
}

interface ParsedIntent {
  kind: 'shop' | 'clarify' | 'refused';
  item: string | null;
  budgetMinor: number | null;
  /** Non-price constraints stated verbatim: "white", "wireless", "new not used". */
  requirements: string[];
  reply: string | null;
}

const INTENT_PROMPT = (
  message: string,
  history: readonly ChatTurn[],
  standing: StandingIntent | null,
): string =>
  [
    'You are the intake parser for Window, a shopping assistant. Read the',
    'conversation and work out what the user is asking for RIGHT NOW.',
    '',
    ...(history.length > 0
      ? [
          'Conversation so far:',
          ...history.map((turn) => `${turn.role === 'user' ? 'User' : 'Window'}: ${turn.text}`),
          '',
        ]
      : []),
    ...(standing !== null
      ? [
          'What earlier turns settled on:',
          `- item: ${JSON.stringify(standing.item)}`,
          `- budget: ${standing.budgetMinor === null ? 'none' : `$${(standing.budgetMinor / 100).toFixed(2)}`}`,
          `- requirements: ${standing.requirements.length > 0 ? standing.requirements.join(', ') : 'none'}`,
          '',
        ]
      : []),
    `New user message: ${JSON.stringify(message)}`,
    '',
    'Reply with ONLY JSON, exactly one of:',
    '{"kind":"shop","item":"<the product they want, a short search phrase>","budget":<dollars|null>,"requirements":["<constraint>",...]}',
    '{"kind":"clarify","reply":"<one sentence asking for what is missing>"}',
    '{"kind":"refused","reply":"<one polite sentence: you only help find products>"}',
    '',
    'Rules:',
    '- FIRST: does this message name a product? "gaming chair", "a mouse",',
    '  "running shoes" — any product noun, even misspelled, even without a',
    '  verb. If so it is a NEW request for THAT product. Use it as the item.',
    '  Do not carry the earlier item forward. Keep the earlier budget only if',
    '  they restate it or clearly still mean it, and drop requirements that',
    '  belonged to the old product.',
    '- Only when the message names NO product is it a refinement of the settled',
    '  request: "cheaper", "in white", "under $50", "what about wireless" mean',
    '  the settled item with that change applied.',
    '- A bare answer to your own question ("a keyboard", "about $50") completes',
    '  the earlier request — return the whole resolved request, not the answer.',
    '- For a refinement, return the COMPLETE resolved request: repeat the item,',
    '  budget and requirements that still apply, even when this message did not',
    '  restate them. Drop only what the user actually changed.',
    '- Not about finding/buying a product → refused.',
    '- A request too vague to search, with nothing earlier to resolve it',
    '  against ("get me something cool") → clarify.',
    '- budget is a dollar number or null. "cheap" or "affordable" alone → null,',
    '  unless a budget is already settled, in which case keep it.',
    '- "under $80", "$80 max", "for 80 bucks" → 80.',
    '- item is what you would type into a storefront search box — the product',
    '  and its key qualifiers, nothing else. Never a whole sentence.',
    '- requirements lists every other constraint in force: color, connectivity',
    '  ("wireless"), noise ("quiet"), condition ("new", "used"), brand,',
    '  material, size. [] when none apply.',
  ].join('\n');

/**
 * The non-LLM fallback for intent. Handles the common shapes — "find me a
 * desk lamp under $60" — and refuses what has no product words at all, so the
 * bot stays useful (and guarded) even when the model is unreachable.
 */
/** Attribute words the regex path can extract without a model call. */
const REQUIREMENT_WORDS =
  /\b(wireless|wired|bluetooth|quiet|silent|white|black|silver|gray|grey|red|blue|green|pink|wood|wooden|metal|leather|compact|portable|new|used|refurbished)\b/gi;

/**
 * The words refinements are made of.
 *
 * Without a model the intake cannot tell "make it white" (a refinement) from
 * "find me a mouse" (a new product) — both are three words with a noun-shaped
 * token in them. So the fallback strips these, plus the requirement words it
 * already knows, and asks whether anything substantive is left. "make it
 * white" empties out and refines the settled request; "find me a mouse" leaves
 * "mouse" and starts a new one.
 *
 * This is a heuristic standing in for a model that is unreachable, and it is
 * deliberately biased toward refining: continuing the conversation wrongly
 * costs a re-ask, while abandoning it strands the shopper mid-thread.
 */
const REFINEMENT_WORDS =
  /\b(make|it|its|them|they|that|this|those|these|instead|rather|more|less|fewer|cheaper|pricier|dearer|expensive|cheap|affordable|same|but|also|another|other|ones?|show|something|some|any|and|or|with|without|in|on|at|about|what|how|please|prefer|like|want|maybe|just|only|still|again|version|option|kind|sort|type|bit|little|much|too|very|really|ok|okay|yes|no|thanks)\b/gi;

const VAGUE = /^(?:a|an|the|me|my|some|something|anything|stuff|things?|it|one|that|cool|nice|good|new)\b/i;

/** The message with prices and request boilerplate stripped off. */
function itemText(message: string): string {
  return message
    .replace(/\$\s*\d+(?:\.\d{1,2})?/g, ' ')
    .replace(/\b(please|find|get|me|want|need|buy|looking for|under|budget|max|for|a|an|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words left once everything a message could be *made of* is removed —
 * prices, request boilerplate, requirement adjectives, refinement particles.
 * Whatever survives is the name of a thing, and naming a thing is what marks a
 * new request rather than a change to the settled one.
 */
function substantiveTokens(message: string): string[] {
  return itemText(message)
    .replace(REQUIREMENT_WORDS, ' ')
    .replace(REFINEMENT_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !VAGUE.test(word))
    .map((word) => word.toLowerCase());
}

function fallbackIntent(message: string, standing: StandingIntent | null): ParsedIntent {
  const money = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(message);
  const statedBudget =
    money !== null ? Math.round(parseFloat(money[1] as string) * 100) : null;
  const stated = [...message.matchAll(REQUIREMENT_WORDS)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
  const item = itemText(message);
  const searchable =
    item.length >= 3 && !item.split(/\s+/).every((w) => VAGUE.test(w) || w.length <= 1);
  const substantive = substantiveTokens(message).length > 0;

  // A message that names no product is a refinement of the settled request —
  // "under $50", "in white" — not a failure to say what they want. This is the
  // whole reason the standing intent travels with the turn: without it, the
  // regex path answers a follow-up as though the conversation never happened.
  if ((!searchable || !substantive) && standing !== null) {
    return {
      kind: 'shop',
      item: standing.item,
      budgetMinor: statedBudget ?? standing.budgetMinor,
      requirements: [...new Set([...standing.requirements, ...stated])],
      reply: null,
    };
  }

  if (item.length < 3) {
    return {
      kind: 'refused',
      item: null,
      budgetMinor: statedBudget,
      requirements: stated,
      reply: "I'm Window's shopping assistant — tell me what product you're looking for.",
    };
  }
  // A "request" with no concrete noun isn't searchable — clarify, don't shop.
  if (!searchable) {
    return {
      kind: 'clarify',
      item: null,
      budgetMinor: statedBudget,
      requirements: stated,
      reply: 'What kind of item are you looking for?',
    };
  }

  // A named product is a fresh request. The budget follows it only when
  // restated: silently carrying a ceiling onto a different product hides a
  // filter the shopper never asked for on it.
  const sameItem = standing !== null && standing.item.toLowerCase() === item.toLowerCase();
  return {
    kind: 'shop',
    item,
    budgetMinor: statedBudget ?? (sameItem ? standing.budgetMinor : null),
    requirements: sameItem
      ? [...new Set([...(standing as StandingIntent).requirements, ...stated])]
      : stated,
    reply: null,
  };
}

/** Messages that obviously state a shopping ask — safe to skip the LLM parse. */
const FAST_PATH = /(?:\$|\b(?:find|get|buy|looking for|want|need|recommend|show me)\b)/i;

/**
 * Guardrail stage. A message that states an item or budget plainly goes
 * straight through the regex parser — no model call, no latency. Everything
 * else asks the model to classify, and its guardrails are applied here: a
 * "shop" intent with no searchable item degrades to clarify, a non-positive
 * or missing budget is treated as no budget rather than a hard filter, and
 * anything unparseable falls back to the regex path.
 */
async function parseIntent(
  message: string,
  history: readonly ChatTurn[],
  standing: StandingIntent | null,
  deps: ChatDeps,
): Promise<ParsedIntent> {
  let parsed: ParsedIntent | null = null;
  // The regex shortcut only holds for the first message of a conversation. Once
  // there is something to resolve against, "cheaper" and "what about wireless"
  // are the normal shapes, and no regex reads those — the model has to.
  if (FAST_PATH.test(message) && history.length === 0 && standing === null) {
    parsed = fallbackIntent(message, null);
  } else {
    try {
      const raw = await deps.llm.decide(INTENT_PROMPT(message, history, standing));
      const json = extractJson<Record<string, unknown>>(raw);
      if (json !== null && typeof json.kind === 'string') {
        const budget =
          typeof json.budget === 'number' && Number.isFinite(json.budget) && json.budget > 0
            ? Math.round(json.budget * 100)
            : null;
        const requirements = Array.isArray(json.requirements)
          ? json.requirements.filter((r): r is string => typeof r === 'string')
          : [];
        if (json.kind === 'shop' && typeof json.item === 'string' && json.item.trim() !== '') {
          parsed = { kind: 'shop', item: json.item.trim(), budgetMinor: budget, requirements, reply: null };
        } else if (
          (json.kind === 'clarify' || json.kind === 'refused') &&
          typeof json.reply === 'string'
        ) {
          parsed = { kind: json.kind, item: null, budgetMinor: null, requirements: [], reply: json.reply };
        }
      }
    } catch (error) {
      log.warn('intent parse failed; using fallback', { error: (error as Error).message });
    }
    if (parsed === null) parsed = fallbackIntent(message, standing);

    // Believe the message over the model.
    //
    // The intake is told to resolve against the conversation, and a small model
    // leans on that hard enough to keep the settled item even when this message
    // plainly names a different product — "udget gaming chair" mid-keyboard
    // conversation came back as "mechanical keyboard", and the shopper was
    // shown keyboards. So: if they typed substantive words and the resolved
    // item contains none of them, the resolution ignored what they said, and
    // the message wins.
    //
    // It fires only on zero overlap, which is a strong signal. "the AULA one"
    // resolved to "AULA mechanical keyboard" shares a word and stands.
    if (parsed.kind === 'shop' && parsed.item !== null && standing !== null) {
      const said = substantiveTokens(message);
      if (said.length > 0) {
        const resolved = parsed.item.toLowerCase();
        if (!said.some((word) => resolved.includes(word))) {
          log.warn('intake ignored the message; starting a fresh request', {
            message,
            resolvedTo: parsed.item,
          });
          parsed = fallbackIntent(message, null);
        }
      }
    }
  }
  if (parsed.budgetMinor !== null && parsed.budgetMinor < MIN_BUDGET_MINOR) {
    return {
      kind: 'clarify',
      // The item survives the question. Asking "what price did you mean?" and
      // then forgetting what they were shopping for is how a conversation
      // loses the thread.
      item: parsed.item,
      budgetMinor: null,
      requirements: parsed.requirements,
      reply: 'That budget looks too low for a real listing — what price range did you mean?',
    };
  }
  return parsed;
}

/** The storefront search box query: the item plus whatever narrows it. */
function searchQuery(item: string, requirements: readonly string[]): string {
  const lower = item.toLowerCase();
  const extra = requirements
    .map((r) => r.trim())
    .filter((r) => r !== '' && !lower.includes(r.toLowerCase()))
    .slice(0, 3);
  return [item, ...extra].join(' ').slice(0, 120);
}

/** The review line for a card, or null when it carried no review signal. */
function reviewNoteFor(rating: number | null, count: number | null): string | null {
  if (rating === null) return null;
  const stars = `${rating.toFixed(1)}★`;
  return count === null || count === 0
    ? stars
    : `${stars} across ${count.toLocaleString('en-US')} ratings`;
}

/**
 * A live search card in recommendation shape. The title is embedded once and
 * measured twice: against the requested item, which decides whether this is an
 * answer at all, and against the shopper's taste, which only orders the ones
 * that are. The title is all we have to go on — a detail fetch would measure
 * better and cost a second per listing, which is the trade the fast path makes.
 */
async function cardListing(
  card: StorefrontCard,
  item: readonly number[],
  preferences: readonly number[],
  embedder: EmbeddingProvider,
): Promise<ChatPick> {
  let score = 0.5;
  let affinity = 0.5;
  if (card.title !== '') {
    const title = await embedder.embedText(card.title);
    score = (cosine(title, item) + 1) / 2;
    if (preferences.length > 0) affinity = (cosine(title, preferences) + 1) / 2;
  }
  return {
    productId: `web:${card.storefront}:${card.sourceId}`,
    title: card.title,
    price: card.priceMinor,
    currency: 'USD',
    url: card.url,
    imageUrl: card.imageUrl,
    score,
    origin: 'web',
    sourceDomain: card.storefront,
    affinity,
    rating: card.rating,
    reviewCount: card.reviewCount,
    reviewNote: reviewNoteFor(card.rating, card.reviewCount),
    sources:
      card.rating !== null
        ? [{ title: `Ratings on ${card.storefront}`, url: card.url }]
        : [],
  };
}

/**
 * The gate. A pick survives only if every hard rule holds: it is on a
 * storefront we shop, it has a title, a link and a price, and that price is
 * inside the stated budget. Quality is a soft floor — a known-bad catalog row
 * is cut, but a fresh card legitimately has no Q score and isn't punished for
 * it.
 *
 * Relevance is the one deliberately soft rule. The floor cuts noise when there
 * is enough signal to spare, but a search that came back thin returns its best
 * candidates anyway: a shopper who asked for a niche item is better served by
 * a loose match they can judge than by "I found nothing".
 */
function gate(picks: ChatPick[], budgetMinor: number | null): ChatPick[] {
  const buyable = picks.filter((pick) => {
    if (pick.title === '' || pick.url === null) return false;
    if (storefrontOf(pick.url) === null) return false;
    if (pick.price === null) return false;
    if (budgetMinor !== null && pick.price > budgetMinor) return false;
    if (
      pick.rating !== null &&
      pick.rating < MIN_STAR_RATING &&
      (pick.reviewCount ?? 0) >= RATINGS_FOR_CONFIDENCE
    ) {
      return false;
    }
    return true;
  });
  return buyable.filter((pick) => pick.score >= MIN_RELEVANCE);
}

/**
 * One entry per listing, best first. Both storefronts can surface the same
 * item, and relevance to the ask leads the order — taste only breaks ties
 * between listings that already answer the question.
 */
function dedupe(picks: ChatPick[]): ChatPick[] {
  const byKey = new Map<string, ChatPick>();
  for (const pick of picks) {
    const key = pick.url ?? pick.productId;
    if (!byKey.has(key)) byKey.set(key, pick);
  }
  const rank = (pick: ChatPick): number => pick.score + PREFERENCE_NUDGE * pick.affinity;
  return [...byKey.values()].sort((a, b) => rank(b) - rank(a));
}

interface Judged {
  keep: number[];
  reply: string;
}

/**
 * The single model call: which of these are really the thing asked for, and
 * what do we say about them. These were two calls — a relevance filter and a
 * reply composer — and merging them halves the model round-trips in a turn
 * while giving the writer the same context the judge had.
 *
 * Both halves fail soft and independently: a refused or malformed answer keeps
 * the gated picks and templates the message, because a working retrieval
 * pipeline should not be zeroed out by one bad completion.
 */
async function judgeAndCompose(
  message: string,
  item: string,
  picks: readonly ChatPick[],
  requirements: readonly string[],
  budgetMinor: number | null,
  history: readonly ChatTurn[],
  llm: AgentLlm,
): Promise<Judged | null> {
  const rows = picks.map((pick, i) => {
    const price = pick.price === null ? '?' : `$${(pick.price / 100).toFixed(2)}`;
    const note = pick.reviewNote !== null ? ` | ${pick.reviewNote}` : '';
    return `${i + 1}. ${pick.title} — ${price} on ${pick.sourceDomain ?? 'catalog'}${note}`;
  });
  const prompt = [
    'You are Window, a shopping assistant.',
    ...(history.length > 0
      ? [
          '',
          'Conversation so far:',
          ...history.map((turn) => `${turn.role === 'user' ? 'User' : 'You'}: ${turn.text}`),
        ]
      : []),
    '',
    'The user just said:',
    JSON.stringify(message),
    '',
    `These are live Amazon and eBay listings for ${JSON.stringify(item)} — the`,
    'only products you may mention. Never invent listings, prices or reviews.',
    ...rows,
    '',
    ...(requirements.length > 0
      ? ['Every pick must satisfy these stated requirements:', ...requirements.map((r) => `- ${r}`), '']
      : []),
    budgetMinor !== null
      ? `Their budget is $${(budgetMinor / 100).toFixed(2)} — every listing above is inside it.`
      : 'They gave no budget.',
    '',
    'Reply with ONLY JSON:',
    '{"keep":[<numbers, best first>],"reply":"<1-3 sentences>"}',
    '',
    'Rules:',
    `- keep lists ${MIN_PICKS}-${MAX_PICKS} numbers, best first; the first is your lead pick.`,
    '- Drop anything that is not the product itself: accessories, spare parts,',
    '  replacement components, cleaning supplies, cases, bundles of parts.',
    '- Drop anything that breaks a stated requirement. When unsure, keep it.',
    '- reply is plain prose, no markdown, no lists. Say what you found, which',
    '  pick leads, and the review-backed reason why. Mention only kept picks.',
    ...(history.length > 0
      ? [
          '- This is a continuing conversation. Answer what they just asked',
          '  rather than reintroducing the search, and say what changed when',
          '  they have narrowed it ("cheaper ones, then" beats restating it).',
        ]
      : []),
  ].join('\n');
  try {
    const parsed = extractJson<{ keep?: unknown; reply?: unknown }>(await llm.decide(prompt));
    if (parsed === null) return null;
    const keep = Array.isArray(parsed.keep)
      ? parsed.keep
          .filter((n): n is number => typeof n === 'number')
          .map((n) => n - 1)
          .filter((i) => i >= 0 && i < picks.length)
      : [];
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    return { keep: [...new Set(keep)], reply };
  } catch (error) {
    log.warn('judge/compose failed; templating', { error: (error as Error).message });
    return null;
  }
}

/**
 * What the shopper reads when the model did not answer in time — which, at the
 * latency the CLI runs at, is often. It has to be a sentence rather than a
 * dump: a storefront title runs past a hundred characters of switch types and
 * layout codes, and pasting one whole is how "Top pick: EPOMAKER X Aula F75
 * MAX Wireless Mechanical Keyboard with TFT Screen and Knob, Gasket Gaming…"
 * happens. The price is the useful half anyway.
 */
function templatedReply(picks: readonly ChatPick[], item: string): string {
  const lead = picks[0];
  if (lead === undefined) return 'No matching listings found.';
  // Storefront titles front-load the product name and trail into spec soup;
  // the first clause is the part a person would actually say out loud.
  const short = (lead.title.split(/[,|(—–]/)[0] as string).trim().slice(0, 60);
  const price = lead.price === null ? '' : ` at $${(lead.price / 100).toFixed(2)}`;
  return `${picks.length} ${item} listing${picks.length === 1 ? '' : 's'}. Best match: ${short}${price}.`;
}

/**
 * Retrieval: Amazon and eBay, in parallel, and that is the whole of it.
 *
 * `itemVector` is the ask and nothing else — it scores the cards that come
 * back. Taste is scored separately and only orders them, because letting a
 * preference vector decide what counts as an answer is what once put lamps in
 * a keyboard search.
 */
async function retrieve(
  item: string,
  requirements: readonly string[],
  budgetMinor: number | null,
  itemVector: number[],
  preferences: readonly number[],
  deps: ChatDeps,
): Promise<ChatPick[]> {
  const search =
    deps.search ?? ((q, budget, limit) => searchStorefronts(q, budget, limit, deps.storefront ?? {}));

  const cards = await search(searchQuery(item, requirements), budgetMinor, POOL_SIZE).catch(
    (error: unknown) => {
      log.warn('storefront leg failed', { error: (error as Error).message });
      return [] as StorefrontCard[];
    },
  );

  // Embedding the titles is local CPU work, but the provider interface is
  // async because a hosted one is a network call — so they go out together.
  return dedupe(
    await Promise.all(cards.map((card) => cardListing(card, itemVector, preferences, deps.embedder))),
  );
}

/**
 * One chatbot turn. `message` is what the user typed; `session` carries their
 * preference vector; `deps` wires retrieval. Returns the reply text plus the
 * 2–5 surviving picks and the "keep scrolling" card.
 */
export async function chat(
  message: string,
  session: ChatSession,
  deps: ChatDeps,
): Promise<ChatReply> {
  const history = (session.history ?? []).slice(-HISTORY_TURNS);
  const standing = session.standing ?? null;

  const intent = await parseIntent(message, history, standing, deps);
  if (intent.kind !== 'shop' || intent.item === null) {
    return {
      kind: intent.kind === 'refused' ? 'refused' : 'clarify',
      message:
        intent.reply ??
        "I'm Window's shopping assistant — tell me what product you're looking for.",
      picks: [],
      budgetMinor: intent.budgetMinor,
      requirements: intent.requirements,
      // A refusal establishes nothing, but a clarify that already knows the
      // item keeps it, so their answer lands on the right request.
      standing:
        intent.kind === 'clarify' && intent.item !== null
          ? { item: intent.item, budgetMinor: intent.budgetMinor, requirements: intent.requirements }
          : standing,
    };
  }
  const item = intent.item;
  const resolved: StandingIntent = {
    item,
    budgetMinor: intent.budgetMinor,
    requirements: intent.requirements,
  };

  // What they asked for, on its own. The feed blends this with long-term taste
  // because a scroll has no stated intent to honour; a chat turn does, and
  // blending here is what let a lighting-heavy profile answer a keyboard
  // question with lamps. Taste still rides along as `preferences`, but only to
  // order results that already are the thing asked for.
  const itemVector = await deps.embedder.embedText(item);
  // Recent history counts as taste too — it is what they were just looking at,
  // not what they just asked for.
  const preferences = sessionVector(
    session.preferences,
    session.recent ?? [],
    session.recent !== undefined && session.recent.length > 0 ? 0.5 : 0,
  );

  const pool = gate(
    await retrieve(item, intent.requirements, intent.budgetMinor, itemVector, preferences, deps),
    intent.budgetMinor,
  );

  // Hand the model a little more than it may keep, so dropping an accessory
  // doesn't drop the answer below the floor.
  const shortlist = pool.slice(0, MAX_PICKS + 3);
  const judged =
    shortlist.length === 0
      ? null
      : await judgeAndCompose(
          message,
          item,
          shortlist,
          intent.requirements,
          intent.budgetMinor,
          history,
          deps.llm,
        );

  // The model's order is its ranking, best first. A verdict that would leave
  // us under the floor is discarded rather than obeyed — a paranoid model
  // shouldn't be able to empty a working pipeline. Its prose goes with it:
  // a reply written about picks we then overrode would describe the wrong
  // listings, and "nothing qualifies" above five cards is worse than no prose.
  const chosen = judged === null ? [] : judged.keep.map((i) => shortlist[i] as ChatPick);
  const verdictStands = chosen.length >= MIN_PICKS;
  const picks = (verdictStands ? chosen : shortlist).slice(0, MAX_PICKS);
  const composed = verdictStands && judged !== null && judged.reply !== '' ? judged.reply : null;

  const budgetSuffix =
    intent.budgetMinor !== null ? ` under $${(intent.budgetMinor / 100).toFixed(2)}` : '';
  if (picks.length < MIN_PICKS) {
    return {
      kind: 'answer',
      message:
        picks.length === 0
          ? `I couldn't find any ${item} listings${budgetSuffix} on Amazon or eBay right now.`
          : `Only found one solid ${item} listing${budgetSuffix} — here it is.`,
      picks,
      budgetMinor: intent.budgetMinor,
      requirements: intent.requirements,
      standing: resolved,
    };
  }

  return {
    kind: 'answer',
    message: composed ?? templatedReply(picks, item),
    picks,
    budgetMinor: intent.budgetMinor,
    requirements: intent.requirements,
    standing: resolved,
  };
}

export type { Storefront, StorefrontCard };
