import {
  CLUSTERING,
  cosine,
  median,
  meanVector,
  type ProductIdentifiers,
  type SourceType,
} from '@window/shared';

/**
 * Deduplication and clustering.
 *
 * The same physical product appears across many sources, and the feed must
 * never show four listings of the same thing. Matching runs strongest-evidence
 * first: an identifier match is a fact, a brand-plus-model match is a strong
 * inference, and an embedding match is a guess that needs price and category
 * agreement before it is allowed to merge two listings.
 */

export type MatchStrength = 'identifier' | 'brand_model' | 'fuzzy' | 'none';

export interface MatchResult {
  clusterId: string | null;
  strength: MatchStrength;
  /** Why this cluster was chosen, recorded for dedupe-precision measurement. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Substitutability
// ---------------------------------------------------------------------------

/**
 * Secondhand and auction listings are never clustered with new listings,
 * because they are not substitutable: a used lens at 60% of retail is a
 * different purchase decision, not a cheaper offer on the same one. They may
 * cluster with each other only on an exact identifier match, which is the only
 * evidence strong enough to say two used items are the same item.
 */
export function mayCluster(
  a: SourceType,
  b: SourceType,
  strength: MatchStrength,
): boolean {
  const aIsNew = a === 'new';
  const bIsNew = b === 'new';
  if (aIsNew !== bIsNew) return false;
  if (aIsNew && bIsNew) return strength !== 'none';
  return strength === 'identifier';
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const IDENTIFIER_KEYS: Array<keyof ProductIdentifiers> = [
  'gtin',
  'upc',
  'ean',
  'isbn',
  'asin',
  'mpn',
];

function cleanIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/[\s-]/g, '');
  return cleaned.length >= 6 ? cleaned : null;
}

/**
 * GTIN-8/12/13/14 are the same number zero-padded, so they are compared at
 * width 14. Without this, the same product carries a UPC on one source and an
 * EAN on another and never matches itself.
 */
function canonicalGtin(value: string): string {
  return /^\d{8,14}$/.test(value) ? value.padStart(14, '0') : value;
}

export function identifierKeys(identifiers: ProductIdentifiers): string[] {
  const out: string[] = [];
  for (const key of IDENTIFIER_KEYS) {
    const cleaned = cleanIdentifier(identifiers[key]);
    if (!cleaned) continue;
    // ASIN and MPN are namespaced: an MPN is only unique within a brand, and an
    // ASIN is Amazon's own key, so neither may collide with a global GTIN.
    if (key === 'gtin' || key === 'upc' || key === 'ean') {
      out.push(`gtin:${canonicalGtin(cleaned)}`);
    } else {
      out.push(`${key}:${cleaned}`);
    }
  }
  return out;
}

export function identifiersMatch(a: ProductIdentifiers, b: ProductIdentifiers): boolean {
  const left = new Set(identifierKeys(a));
  if (left.size === 0) return false;
  return identifierKeys(b).some((key) => left.has(key));
}

// ---------------------------------------------------------------------------
// Model numbers
// ---------------------------------------------------------------------------

/** Years, capacities and sizes look like model numbers and are not. */
const NOT_A_MODEL =
  /^(?:19|20)\d{2}$|^\d{1,3}(?:gb|tb|mb|mm|cm|in|ml|l|g|kg|oz|w|hz|v|ah|mah)$|^(?:xs|s|m|l|xl|xxl)$/i;

/**
 * Extracts a model number from a title.
 *
 * The signal is a token mixing letters and digits, or a short all-caps token
 * followed by digits — "GMMK Pro", "WH-1000XM5", "A7 IV". Pure numbers are
 * rejected outright: every one that has ever been tested turned out to be a
 * year, a capacity or a size.
 */
export function extractModelNumber(title: string, brand: string | null): string | null {
  let text = title;
  if (brand) {
    text = text.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }

  const tokens = text.split(/[\s,|/()[\]]+/).filter(Boolean);
  const candidates: string[] = [];

  for (const token of tokens) {
    const clean = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (clean.length < 2 || clean.length > 20) continue;
    if (NOT_A_MODEL.test(clean)) continue;

    const hasDigit = /\d/.test(clean);
    const hasLetter = /[A-Za-z]/.test(clean);
    if (hasDigit && hasLetter) candidates.push(clean.toUpperCase());
  }

  if (candidates.length === 0) return null;
  // The longest candidate is the most specific: "WH-1000XM5" beats "XM5".
  candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return candidates[0] as string;
}

export function brandModelKey(brand: string | null, model: string | null): string | null {
  if (!brand || !model) return null;
  return `${brand.toLowerCase().replace(/[^a-z0-9]/g, '')}:${model.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

export function priceWithinTolerance(
  a: number,
  b: number,
  tolerance = CLUSTERING.fuzzyPriceTolerance,
): boolean {
  if (a <= 0 || b <= 0) return false;
  const larger = Math.max(a, b);
  return Math.abs(a - b) / larger <= tolerance;
}

export interface FuzzyCandidate {
  clusterId: string;
  embedding: readonly number[];
  medianPrice: number;
  categoryL3: string;
  sourceTypes: SourceType[];
}

/**
 * Embedding cosine above 0.94, plus a price within 30%, plus the same L3.
 * All three are required: cosine alone merges a lens with its lens cap, price
 * alone merges everything in a category, and category alone merges a category.
 */
export function fuzzyMatch(
  product: {
    embedding: readonly number[];
    priceAmount: number;
    categoryL3: string;
    sourceType: SourceType;
  },
  candidates: readonly FuzzyCandidate[],
): { clusterId: string; similarity: number } | null {
  let best: { clusterId: string; similarity: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.categoryL3 !== product.categoryL3) continue;
    if (!priceWithinTolerance(product.priceAmount, candidate.medianPrice)) continue;
    if (!candidate.sourceTypes.every((t) => mayCluster(product.sourceType, t, 'fuzzy'))) continue;

    const similarity = cosine(product.embedding, candidate.embedding);
    if (similarity < CLUSTERING.fuzzyCosineThreshold) continue;
    if (!best || similarity > best.similarity) {
      best = { clusterId: candidate.clusterId, similarity };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Cluster maintenance
// ---------------------------------------------------------------------------

export interface ClusterMember {
  productId: string;
  priceAmount: number;
  shippingAmount: number;
  currency: string;
  inStock: boolean;
  qualityScore: number;
  riskScore: number;
  sourceType: SourceType;
  embedding: readonly number[];
}

export interface ClusterAggregate {
  canonicalProductId: string;
  offerCount: number;
  priceRange: { min: number; max: number; median: number; currency: string };
  sourceTypes: SourceType[];
  embedding: number[];
}

/**
 * Recomputes a cluster from its members.
 *
 * The canonical representative is the best offer, and "best" is landed price
 * first — a cheap item with expensive shipping is not cheap — then quality,
 * then low risk. Out-of-stock members stay in the cluster, because an offer
 * that is temporarily unavailable is still evidence about the product, but they
 * can never be canonical.
 */
export function aggregateCluster(members: readonly ClusterMember[]): ClusterAggregate {
  if (members.length === 0) throw new Error('A cluster must have at least one member.');

  const landed = (m: ClusterMember): number => m.priceAmount + m.shippingAmount;

  const eligible = members.filter((m) => m.inStock);
  const pool = eligible.length > 0 ? eligible : members;
  const canonical = [...pool].sort(
    (a, b) =>
      landed(a) - landed(b) ||
      b.qualityScore - a.qualityScore ||
      a.riskScore - b.riskScore ||
      a.productId.localeCompare(b.productId),
  )[0] as ClusterMember;

  const prices = members.map((m) => m.priceAmount);
  const sourceTypes = [...new Set(members.map((m) => m.sourceType))].sort();

  return {
    canonicalProductId: canonical.productId,
    offerCount: members.length,
    priceRange: {
      min: Math.min(...prices),
      max: Math.max(...prices),
      median: Math.round(median(prices)),
      currency: canonical.currency,
    },
    sourceTypes,
    embedding: meanVector(members.map((m) => m.embedding)),
  };
}

/**
 * The card's "4 other sellers, from $X" affordance. Counts only offers the user
 * could actually buy instead of this one.
 */
export function otherOffers(
  members: readonly ClusterMember[],
  currentProductId: string,
): { count: number; fromAmount: number; currency: string } | null {
  const others = members.filter((m) => m.productId !== currentProductId && m.inStock);
  if (others.length === 0) return null;
  const from = Math.min(...others.map((m) => m.priceAmount + m.shippingAmount));
  return {
    count: others.length,
    fromAmount: from,
    currency: (others[0] as ClusterMember).currency,
  };
}

/**
 * The price-context badge: shown only when the spread is wide enough for the
 * comparison to mean anything.
 */
export function priceContext(
  priceAmount: number,
  clusterMedian: number,
): 'below' | 'above' | null {
  if (clusterMedian <= 0) return null;
  const delta = (priceAmount - clusterMedian) / clusterMedian;
  if (delta <= -CLUSTERING.priceContextSpread) return 'below';
  if (delta >= CLUSTERING.priceContextSpread) return 'above';
  return null;
}
