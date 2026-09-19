import { EMBEDDING_DIM, hashString, mulberry32, normalize } from '@window/shared';
import type { EmbeddingInput, EmbeddingProvider } from './provider.js';

/**
 * A deterministic local embedder.
 *
 * It is a random-projection bag of features rather than a learned model: each
 * distinct token maps to a fixed pseudo-random unit vector, and a product's
 * embedding is the normalized weighted sum of its feature vectors. Because
 * distinct basis vectors are near-orthogonal in 1024 dimensions, the cosine
 * between two products approximates their weighted feature overlap — which is
 * enough for the taxonomy to dominate, for brand and spec agreement to matter,
 * and for the whole ranking pipeline to be exercised honestly without a network
 * call or an API key.
 *
 * A hosted multimodal provider implements the same interface and swaps in by
 * bumping `version`, which the schema already treats as a background re-embed
 * rather than a migration.
 */

/** Feature weights. The taxonomy dominates so quads and MMR behave sensibly. */
const WEIGHTS = {
  l1: 0.35,
  l2: 0.55,
  l3: 0.85,
  brand: 0.4,
  /** Divided across the title's tokens. */
  title: 0.45,
  /** Divided across the spec tokens. */
  specs: 0.2,
  /** Stands in for the visual component of a joint text+image space. */
  image: 0.25,
  /** Small, so price nudges neighbourhoods without defining them. */
  price: 0.08,
} as const;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'by',
  'new', 'set', 'pack', 'size', 'x', 'free', 'shipping', 'item', 'sale',
]);

/**
 * A deliberately small suffix stemmer.
 *
 * Category names and product titles describe the same things in different
 * grammatical forms — a taxonomy says "Running sneakers" and a listing says
 * "Wool Runner" — and without stemming those two share no token at all, so a
 * bag-of-features embedder scores them as unrelated. Only the endings that
 * cause that mismatch are stripped; anything more aggressive starts merging
 * words that mean different things.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ['ings', 'ing', 'ers', 'er', 'ies', 'es', 's']) {
    if (!token.endsWith(suffix)) continue;
    const root = token.slice(0, -suffix.length);
    if (root.length < 3) continue;
    // "ies" -> "y" keeps accessories/accessory together.
    if (suffix === 'ies') return `${root}y`;
    // A doubled final consonant before -ing/-er is an inflection artifact:
    // "running" -> "runn" -> "run".
    if (
      (suffix === 'ing' || suffix === 'er' || suffix === 'ers' || suffix === 'ings') &&
      root.length > 3 &&
      root[root.length - 1] === root[root.length - 2]
    ) {
      return root.slice(0, -1);
    }
    return root;
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  readonly dimensions = EMBEDDING_DIM;

  /** Basis vectors are memoized; tokens repeat heavily across a catalog. */
  private readonly basis = new Map<string, Float64Array>();

  constructor(version = 'mm-v2') {
    this.version = version;
  }

  /**
   * A fixed pseudo-random unit vector for a token. Box-Muller gives Gaussian
   * components, which is what makes distinct basis vectors near-orthogonal.
   */
  private basisFor(token: string): Float64Array {
    const cached = this.basis.get(token);
    if (cached) return cached;

    const random = mulberry32(hashString(token));
    const vector = new Float64Array(this.dimensions);
    let sumSquares = 0;
    for (let i = 0; i < this.dimensions; i += 2) {
      // Box-Muller; guard u1 away from zero so log() stays finite.
      const u1 = Math.max(random(), 1e-12);
      const u2 = random();
      const radius = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;
      const z0 = radius * Math.cos(theta);
      const z1 = radius * Math.sin(theta);
      vector[i] = z0;
      sumSquares += z0 * z0;
      if (i + 1 < this.dimensions) {
        vector[i + 1] = z1;
        sumSquares += z1 * z1;
      }
    }
    const inverseNorm = 1 / Math.sqrt(sumSquares);
    for (let i = 0; i < this.dimensions; i++) vector[i] = (vector[i] as number) * inverseNorm;

    this.basis.set(token, vector);
    return vector;
  }

  private accumulate(target: Float64Array, token: string, weight: number): void {
    if (weight === 0) return;
    const basis = this.basisFor(token);
    for (let i = 0; i < target.length; i++) {
      target[i] = (target[i] as number) + (basis[i] as number) * weight;
    }
  }

  /**
   * Price is bucketed by log2 of the amount, and adjacent buckets are both
   * credited so the feature is smooth rather than a cliff at a bucket edge.
   */
  private accumulatePrice(target: Float64Array, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const position = Math.log2(amount);
    const lower = Math.floor(position);
    const fraction = position - lower;
    this.accumulate(target, `price:${lower}`, WEIGHTS.price * (1 - fraction));
    this.accumulate(target, `price:${lower + 1}`, WEIGHTS.price * fraction);
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    return this.embedSync(input);
  }

  embedSync(input: EmbeddingInput): number[] {
    const acc = new Float64Array(this.dimensions);

    this.accumulate(acc, `l1:${input.category.l1}`, WEIGHTS.l1);
    this.accumulate(acc, `l2:${input.category.l2}`, WEIGHTS.l2);
    this.accumulate(acc, `l3:${input.category.l3}`, WEIGHTS.l3);

    if (input.brand) {
      this.accumulate(acc, `brand:${input.brand.toLowerCase()}`, WEIGHTS.brand);
    }

    const titleTokens = tokenize(input.title);
    if (titleTokens.length > 0) {
      const per = WEIGHTS.title / Math.sqrt(titleTokens.length);
      for (const token of titleTokens) this.accumulate(acc, `t:${token}`, per);
    }

    const specs = input.specs ?? [];
    if (specs.length > 0) {
      const per = WEIGHTS.specs / Math.sqrt(specs.length);
      for (const spec of specs) {
        this.accumulate(acc, `s:${spec.key}=${String(spec.value).toLowerCase()}`, per);
      }
    }

    if (input.imageDescriptor) {
      this.accumulate(acc, `img:${input.imageDescriptor}`, WEIGHTS.image);
    }

    if (input.priceAmount !== undefined) this.accumulatePrice(acc, input.priceAmount);

    return normalize(Array.from(acc));
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<number[][]> {
    return inputs.map((input) => this.embedSync(input));
  }

  async embedText(text: string): Promise<number[]> {
    const acc = new Float64Array(this.dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) return Array.from(acc);
    const per = 1 / Math.sqrt(tokens.length);
    for (const token of tokens) this.accumulate(acc, `t:${token}`, per);
    return normalize(Array.from(acc));
  }
}

let shared: LocalEmbeddingProvider | null = null;

export function localEmbeddingProvider(version?: string): LocalEmbeddingProvider {
  if (!shared) shared = new LocalEmbeddingProvider(version);
  return shared;
}
