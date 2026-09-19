import {
  CONDITION_SCALE,
  QUALITY_GATE,
  truncate,
  type Condition,
  type Money,
} from '@window/shared';
import { CONDITION_SYNONYMS, type RawListing } from './types.js';

/**
 * Normalization.
 *
 * Every source output is mapped into the canonical product schema by a
 * per-source config plus these model-independent rules. The rules are pure
 * functions over strings so each one can be tested against the real-world mess
 * that motivated it, rather than only against whatever a particular source
 * happened to return on the day it was written.
 */

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/**
 * Promotional and SEO padding that carries no product information. Ordered
 * longest-first so "free shipping worldwide" is removed before "free shipping".
 */
const SEO_CRUFT = [
  'free shipping worldwide',
  'fast free shipping',
  'free shipping',
  'free delivery',
  'ships free',
  'best price guaranteed',
  'best price',
  'lowest price',
  'on sale now',
  'hot sale',
  'flash sale',
  'big sale',
  'clearance sale',
  'limited time offer',
  'limited time',
  'limited stock',
  'in stock now',
  'in stock',
  'brand new in box',
  'new arrival',
  'top quality',
  'high quality',
  'premium quality',
  '100% authentic',
  '100% genuine',
  'authentic guaranteed',
  'us seller',
  'uk seller',
  'fast dispatch',
  'same day dispatch',
  'buy now',
  'must see',
  'rare find',
  'l@@k',
  'wow',
  'nib',
];

/** Seller boilerplate that appears as a suffix or a bracketed aside. */
const BOILERPLATE_PATTERNS = [
  /\bsold\s+by\s+[^,|]+/gi,
  /\bshipped\s+from\s+[^,|]+/gi,
  /\bofficial\s+(?:store|retailer|dealer)\b/gi,
  /\bauthori[sz]ed\s+dealer\b/gi,
  /\bwarranty\s+included\b/gi,
];

/** Size/quantity tokens that belong in variants and specs, not in the title. */
const TRAILING_SIZE = /\s*[-–—,|]?\s*\b(?:size\s*)?(?:us|uk|eu)?\s*(?:xxs|xs|s|m|l|xl|xxl|xxxl|\d{1,2}(?:\.\d)?)\s*$/i;

function stripEmptyBrackets(text: string): string {
  return text
    .replace(/\(\s*\)/g, ' ')
    .replace(/\[\s*\]/g, ' ')
    .replace(/\{\s*\}/g, ' ');
}

function collapse(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([|·•])\s*/g, ' $1 ')
    .replace(/(?:\s*[-–—|·•,:;]\s*)+$/g, '')
    .replace(/^(?:\s*[-–—|·•,:;]\s*)+/g, '')
    .trim();
}

/**
 * Strips SEO cruft, seller boilerplate and repeated brand and size tokens, then
 * caps at 120 characters. A title is the single densest thing on a card, so a
 * rule that removes real information is worse than one that leaves noise —
 * every removal here is either provably promotional or provably duplicated.
 */
export function normalizeTitle(rawTitle: string, brand: string | null): string {
  let text = rawTitle.normalize('NFKC').replace(/[\r\n\t]+/g, ' ');

  for (const pattern of BOILERPLATE_PATTERNS) text = text.replace(pattern, ' ');

  // Remove cruft anywhere, including inside brackets, then drop the husks.
  for (const phrase of SEO_CRUFT) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
  }
  text = stripEmptyBrackets(text);

  // Collapse ALL-CAPS shouting, but only when the whole title is shouting —
  // model numbers and initialisms are legitimately uppercase.
  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length > 8 && letters === letters.toUpperCase()) {
    text = text
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  text = collapse(text);

  // A brand repeated beyond its first mention is padding.
  if (brand) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    let seen = 0;
    text = text.replace(pattern, (match) => (seen++ === 0 ? match : ' '));
    text = collapse(text);
  }

  text = collapse(text.replace(TRAILING_SIZE, ''));

  return truncate(text, QUALITY_GATE.maxTitleLength);
}

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

function bigrams(text: string): string[] {
  const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

/** Sørensen-Dice over character bigrams, in [0,1]. */
export function diceCoefficient(a: string, b: string): number {
  if (a.toLowerCase() === b.toLowerCase()) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let matches = 0;
  for (const gram of right) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      matches += 1;
    }
  }
  return (2 * matches) / (left.length + right.length);
}

export const BRAND_FUZZY_THRESHOLD = 0.9;

/**
 * Matches against the brand dictionary, fuzzy at 0.9; otherwise null, never
 * guessed. A wrong brand is worse than no brand: it feeds brand affinity, the
 * brand-suppression control and the counterfeit watchlist, and every one of
 * those is a decision the user cannot see us getting wrong.
 */
export function resolveBrand(
  declaredBrand: string | null,
  title: string,
  dictionary: readonly string[],
): string | null {
  const canonical = new Map<string, string>();
  for (const brand of dictionary) canonical.set(brand.toLowerCase(), brand);

  if (declaredBrand) {
    const exact = canonical.get(declaredBrand.trim().toLowerCase());
    if (exact) return exact;

    let best: { brand: string; score: number } | null = null;
    for (const brand of dictionary) {
      const score = diceCoefficient(declaredBrand, brand);
      if (!best || score > best.score) best = { brand, score };
    }
    if (best && best.score >= BRAND_FUZZY_THRESHOLD) return best.brand;
  }

  // Fall back to an exact token-sequence match inside the title. Fuzzy matching
  // against title text is not attempted: "Nike-style" and "Nike" are one edit
  // apart and mean opposite things.
  //
  // Tokens are split on whitespace only, and internal punctuation is kept. That
  // distinction is the whole point: collapsing "Nike-style" to "nike style"
  // would make a disclaimer of non-affiliation read as a brand claim.
  const tokens = title
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);

  let longest: string | null = null;
  for (const brand of dictionary) {
    const brandTokens = brand
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
      .filter(Boolean);
    if (brandTokens.length === 0 || (brandTokens[0] as string).length < 2) continue;

    for (let i = 0; i + brandTokens.length <= tokens.length; i++) {
      const matched = brandTokens.every((token, offset) => tokens[i + offset] === token);
      if (matched && (longest === null || brand.length > longest.length)) {
        longest = brand;
        break;
      }
    }
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
};

/** Currencies with no minor unit; their "cents" are the unit itself. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

export function minorUnitFactor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

/**
 * Parses a price as written by a source into minor units plus an ISO currency.
 *
 * The hard part is the separator: "1.299,99" and "1,299.99" are the same amount
 * written by different locales, and getting it backwards is a 100x price error
 * on the card. The rule used here is that whichever separator appears last is
 * the decimal one, and a separator followed by exactly three digits with no
 * later separator is a thousands group.
 */
export function parsePrice(
  text: string | null,
  fallbackCurrency = 'USD',
): Money | null {
  if (!text) return null;

  const trimmed = text.trim();
  let currency = fallbackCurrency;

  const isoMatch = trimmed.match(/\b([A-Z]{3})\b/);
  if (isoMatch && CURRENCY_BY_SYMBOL[isoMatch[1] as string] === undefined) {
    currency = isoMatch[1] as string;
  }
  for (const [symbol, code] of Object.entries(CURRENCY_BY_SYMBOL)) {
    if (trimmed.includes(symbol)) {
      currency = code;
      break;
    }
  }

  const digits = trimmed.match(/[\d.,\s]*\d/);
  if (!digits) return null;
  let numeric = digits[0].replace(/\s/g, '');

  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');
  const lastSeparator = Math.max(lastComma, lastDot);

  if (lastSeparator === -1) {
    numeric = numeric.replace(/[.,]/g, '');
  } else {
    const trailing = numeric.length - lastSeparator - 1;
    if (trailing === 3) {
      // Three trailing digits with nothing after them is a thousands group:
      // "1.299" and "1,299" are both 1299, never 1.299.
      numeric = numeric.replace(/[.,]/g, '');
    } else {
      const whole = numeric.slice(0, lastSeparator).replace(/[.,]/g, '');
      const fraction = numeric.slice(lastSeparator + 1);
      numeric = `${whole}.${fraction}`;
    }
  }

  const value = Number.parseFloat(numeric);
  if (!Number.isFinite(value)) return null;

  return {
    amount: Math.round(value * minorUnitFactor(currency)),
    currency,
  };
}

// ---------------------------------------------------------------------------
// Condition and stock
// ---------------------------------------------------------------------------

export function normalizeCondition(text: string | null, sourceType: string): Condition {
  if (!text) return sourceType === 'new' ? 'new' : 'unknown';
  const key = text.trim().toLowerCase().replace(/\s+/g, ' ');

  const direct = CONDITION_SYNONYMS[key];
  if (direct) return direct;

  // Schema.org condition URLs, e.g. https://schema.org/UsedCondition.
  const schemaMatch = key.match(/(new|used|refurbished|damaged)condition/);
  if (schemaMatch) {
    return (
      { new: 'new', used: 'good', refurbished: 'excellent', damaged: 'poor' } as const
    )[schemaMatch[1] as 'new' | 'used' | 'refurbished' | 'damaged'];
  }

  // Longest containing synonym, so "excellent used condition" resolves to the
  // more specific "excellent" rather than the more common "used".
  let best: { condition: Condition; length: number } | null = null;
  for (const [synonym, condition] of Object.entries(CONDITION_SYNONYMS)) {
    if (key.includes(synonym) && (!best || synonym.length > best.length)) {
      best = { condition, length: synonym.length };
    }
  }
  return best?.condition ?? 'unknown';
}

export function conditionRank(condition: Condition): number {
  return CONDITION_SCALE.indexOf(condition);
}

export interface NormalizedStock {
  inStock: boolean;
  quantity: number | null;
  singleUnit: boolean;
}

const OUT_OF_STOCK = /out\s*of\s*stock|sold\s*out|unavailable|discontinued|soldout/i;
const IN_STOCK = /in\s*stock|available|instock|preorder|backorder/i;

/** Single-unit sources always set quantity 1; there is only ever one of the thing. */
export function normalizeStock(
  raw: Pick<RawListing, 'availabilityText' | 'quantity' | 'sourceType'>,
  sourceIsSingleUnit: boolean,
): NormalizedStock {
  const text = raw.availabilityText ?? '';
  let inStock: boolean;
  if (OUT_OF_STOCK.test(text)) inStock = false;
  else if (IN_STOCK.test(text)) inStock = true;
  else inStock = raw.quantity === null ? true : raw.quantity > 0;

  const singleUnit = sourceIsSingleUnit || raw.sourceType !== 'new';
  const quantity = singleUnit ? 1 : raw.quantity;

  return { inStock, quantity, singleUnit };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/** Conversions into the canonical unit for each dimension. */
const UNIT_CONVERSIONS: Record<string, { to: string; factor: number }> = {
  mm: { to: 'mm', factor: 1 },
  cm: { to: 'mm', factor: 10 },
  m: { to: 'mm', factor: 1000 },
  in: { to: 'mm', factor: 25.4 },
  inch: { to: 'mm', factor: 25.4 },
  inches: { to: 'mm', factor: 25.4 },
  '"': { to: 'mm', factor: 25.4 },
  ft: { to: 'mm', factor: 304.8 },

  g: { to: 'g', factor: 1 },
  kg: { to: 'g', factor: 1000 },
  mg: { to: 'g', factor: 0.001 },
  oz: { to: 'g', factor: 28.3495 },
  lb: { to: 'g', factor: 453.592 },
  lbs: { to: 'g', factor: 453.592 },

  w: { to: 'W', factor: 1 },
  kw: { to: 'W', factor: 1000 },
  mw: { to: 'W', factor: 0.001 },

  hz: { to: 'Hz', factor: 1 },
  khz: { to: 'Hz', factor: 1000 },
  mhz: { to: 'Hz', factor: 1_000_000 },
  ghz: { to: 'Hz', factor: 1_000_000_000 },

  ml: { to: 'ml', factor: 1 },
  l: { to: 'ml', factor: 1000 },
  cl: { to: 'ml', factor: 10 },

  mah: { to: 'mAh', factor: 1 },
  ah: { to: 'mAh', factor: 1000 },
};

export interface NormalizedSpec {
  key: string;
  value: string;
  unit: string | null;
}

function snakeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Normalizes spec values onto canonical units so that "3.5 in", "89mm" and
 * "8.9 cm" compare as the same number. Values that carry no recognised unit are
 * passed through as text, because a spec the pipeline does not understand is
 * still worth showing.
 */
export function normalizeSpecs(
  specs: ReadonlyArray<{ key: string; value: string }>,
): NormalizedSpec[] {
  const out: NormalizedSpec[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const key = snakeKey(spec.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const value = spec.value.trim();
    const match = value.match(/^([\d.,]+)\s*([a-zA-Z"]+)?$/);
    if (!match) {
      out.push({ key, value, unit: null });
      continue;
    }

    const numeric = Number.parseFloat((match[1] as string).replace(/,/g, ''));
    const rawUnit = match[2]?.toLowerCase();
    if (!Number.isFinite(numeric)) {
      out.push({ key, value, unit: null });
      continue;
    }
    if (!rawUnit) {
      out.push({ key, value: String(numeric), unit: null });
      continue;
    }

    const conversion = UNIT_CONVERSIONS[rawUnit];
    if (!conversion) {
      out.push({ key, value: String(numeric), unit: match[2] as string });
      continue;
    }

    const converted = numeric * conversion.factor;
    // Round to a sensible precision rather than carrying float noise into a
    // string that will be rendered on a card.
    const rounded = Math.abs(converted) >= 100
      ? Math.round(converted)
      : Math.round(converted * 100) / 100;
    out.push({ key, value: String(rounded), unit: conversion.to });
  }

  return out;
}
