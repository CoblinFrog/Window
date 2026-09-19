import {
  CATEGORY_NODES,
  L3_TOPICS,
  clamp,
  getCategory,
  normalize,
  type CategoryNode,
  type CategoryRef,
} from '@window/shared';
import { EMBEDDING_DIM } from '@window/shared';
import type { EmbeddingProvider } from '../embedding/provider.js';

/**
 * Category classification.
 *
 * A listing is classified to L3 by embedding nearest-neighbour against category
 * vectors, and the confidence is recorded so the quality gate can reject
 * anything below 0.4.
 *
 * Classification runs on a *text-only* vector — title, brand, specs,
 * breadcrumb — because at ingest the category is precisely the thing not yet
 * known, so the category features that dominate a finished product embedding
 * cannot be inputs here. That is why the classifier keeps its own vectors
 * rather than reusing `categories.centroid`, which lives in product space and
 * exists to seed user vectors.
 *
 * The search is flat over all 1,440 leaves, and the L2 and L1 are read off the
 * winner. An earlier version searched hierarchically — 18 L1s, then the L2s
 * under the winner — which is cheaper and was wrong in a way that only real
 * listings revealed: an L1 is chosen against its own name, and "Tech and
 * gadgets" shares no vocabulary with "Mechanical Keyboard 75% Tactile", so the
 * very first branch was close to a coin flip and everything below it inherited
 * the mistake. The vocabulary that identifies a product lives in the leaves,
 * so that is where the comparison has to happen.
 */

export interface ClassificationInput {
  title: string;
  brand: string | null;
  specs?: ReadonlyArray<{ key: string; value: string }>;
  /** The source's own category breadcrumb, used as a prior. */
  breadcrumb?: readonly string[];
}

export interface Classification extends CategoryRef {
  confidence: number;
}

/** How strongly a breadcrumb naming a node, or its ancestor, lifts that leaf. */
const BREADCRUMB_BOOST = 0.3;

/**
 * Cosine at or above this counts as full lexical agreement. Below it the
 * confidence is damped: a field of uniformly poor matches still produces a
 * clear winner, and a purely relative score would report that as certainty.
 */
const STRONG_AGREEMENT = 0.22;

function describe(node: CategoryNode): string {
  const parts = [node.displayName];
  const parent = node.parent ? getCategory(node.parent) : undefined;
  if (parent) parts.push(parent.displayName);
  const grandparent = parent?.parent ? getCategory(parent.parent) : undefined;
  if (grandparent) parts.push(grandparent.displayName);
  return parts.join(' ');
}

export class CategoryClassifier {
  /** Row-major: `leaves[i]` occupies `matrix[i * dim .. +dim]`. */
  private matrix = new Float64Array(0);
  private leaves: CategoryNode[] = [];
  private ready = false;

  constructor(private readonly embedder: EmbeddingProvider) {}

  /**
   * Builds one vector per leaf from its own name and its ancestry, so
   * "Mechanical keyboards" carries "Keyboards and input" and "Tech and gadgets"
   * with it and the winning leaf implies the whole path.
   */
  async init(): Promise<void> {
    if (this.ready) return;

    this.leaves = L3_TOPICS.filter((node) => node.level === 3);
    this.matrix = new Float64Array(this.leaves.length * EMBEDDING_DIM);

    for (const [index, node] of this.leaves.entries()) {
      const vector = await this.embedder.embedText(describe(node));
      this.matrix.set(vector.slice(0, EMBEDDING_DIM), index * EMBEDDING_DIM);
    }
    this.ready = true;
  }

  /**
   * Folds observed titles into a leaf's vector. Called alongside the nightly
   * centroid recompute: real titles teach the classifier vocabulary its
   * category names never had, which is how "GMMK Pro" ends up near mechanical
   * keyboards rather than nowhere at all.
   */
  async learnFromMembers(l3Id: string, titles: readonly string[]): Promise<void> {
    if (titles.length === 0) return;
    const index = this.leaves.findIndex((node) => node.id === l3Id);
    if (index < 0) return;

    const base = Array.from(this.matrix.subarray(index * EMBEDDING_DIM, (index + 1) * EMBEDDING_DIM));
    const memberVectors = await Promise.all(titles.map((t) => this.embedder.embedText(t)));

    const blended = base.map((value, i) => {
      const mean = memberVectors.reduce((sum, v) => sum + (v[i] ?? 0), 0) / memberVectors.length;
      // The name stays the anchor; members adjust it rather than replacing it.
      return value * 0.6 + mean * 0.4;
    });
    this.matrix.set(normalize(blended).slice(0, EMBEDDING_DIM), index * EMBEDDING_DIM);
  }

  private textFor(input: ClassificationInput): string {
    const specText = (input.specs ?? [])
      .map((s) => `${s.key.replace(/_/g, ' ')} ${s.value}`)
      .join(' ');
    return [input.title, input.brand ?? '', specText, (input.breadcrumb ?? []).join(' ')]
      .filter(Boolean)
      .join(' ');
  }

  /**
   * A breadcrumb naming a leaf, its L2 or its L1 lifts that leaf. The source's
   * own categorisation is the single most reliable hint available, so it is
   * weighted to beat a marginal lexical win — but not to override a strong one.
   */
  private breadcrumbBoost(node: CategoryNode, normalisedCrumbs: readonly string[]): number {
    if (normalisedCrumbs.length === 0) return 0;

    const l2 = node.parent ? getCategory(node.parent) : undefined;
    const l1 = l2?.parent ? getCategory(l2.parent) : undefined;
    const names: Array<[string, number]> = [
      [node.displayName.toLowerCase(), 1],
      [l2?.displayName.toLowerCase() ?? '', 0.8],
      [l1?.displayName.toLowerCase() ?? '', 0.6],
    ];

    let best = 0;
    for (const crumb of normalisedCrumbs) {
      for (const [name, weight] of names) {
        if (!name) continue;
        if (crumb === name) best = Math.max(best, BREADCRUMB_BOOST * weight);
        else if (crumb.includes(name) || name.includes(crumb)) {
          best = Math.max(best, BREADCRUMB_BOOST * weight * 0.6);
        }
      }
    }
    return best;
  }

  async classify(input: ClassificationInput): Promise<Classification> {
    if (!this.ready) await this.init();

    const query = await this.embedder.embedText(this.textFor(input));
    const crumbs = (input.breadcrumb ?? [])
      .map((c) => c.toLowerCase().trim())
      .filter(Boolean);

    // One pass over every leaf. The raw cosine is kept alongside the boosted
    // score because confidence needs to know how good the match actually was,
    // not just how it ranked.
    const scores = new Float64Array(this.leaves.length);
    let best = -Infinity;
    let bestIndex = 0;
    let bestCosine = 0;

    for (let i = 0; i < this.leaves.length; i++) {
      const base = i * EMBEDDING_DIM;
      let dot = 0;
      for (let d = 0; d < EMBEDDING_DIM; d++) {
        dot += (this.matrix[base + d] as number) * (query[d] as number);
      }
      // Both sides are unit vectors, so the dot product is the cosine.
      const boosted = dot + this.breadcrumbBoost(this.leaves[i] as CategoryNode, crumbs);
      scores[i] = boosted;
      if (boosted > best) {
        best = boosted;
        bestIndex = i;
        bestCosine = dot;
      }
    }

    const winner = this.leaves[bestIndex] as CategoryNode;
    const l2 = getCategory(winner.parent as string);
    const l1 = l2 ? getCategory(l2.parent as string) : undefined;

    return {
      l1: l1?.id ?? winner.l1,
      l2: l2?.id ?? (winner.parent as string),
      l3: winner.id,
      confidence: this.confidenceFor(scores, best, bestCosine),
    };
  }

  /**
   * Confidence combines two independent things, because either alone is
   * misleading.
   *
   * How decisively the winner beat the field is a softmax share, with the
   * temperature taken from the spread of the scores themselves — this embedder
   * is a random projection whose cosines sit in a narrow band, so any fixed
   * threshold on the raw score would be a threshold on the embedder's scale
   * rather than on certainty, and a hosted model would silently recalibrate the
   * quality gate.
   *
   * How good the winner was in absolute terms then damps it. A title sharing no
   * vocabulary with any category still yields a clear winner among equally poor
   * candidates, and reporting that as confident is how "Mechanical Keyboard"
   * ends up filed under menswear with a passing grade.
   */
  private confidenceFor(scores: Float64Array, best: number, bestCosine: number): number {
    let sum = 0;
    for (let i = 0; i < scores.length; i++) sum += scores[i] as number;
    const mean = sum / scores.length;

    let variance = 0;
    for (let i = 0; i < scores.length; i++) variance += ((scores[i] as number) - mean) ** 2;
    variance /= scores.length;

    const temperature = Math.max(Math.sqrt(variance), 1e-6);
    let partition = 0;
    for (let i = 0; i < scores.length; i++) {
      partition += Math.exp(((scores[i] as number) - best) / temperature);
    }

    // Against 1,440 candidates even a decisive winner takes a modest share, so
    // the raw share is rescaled to span the usable range.
    const decisiveness = clamp((1 / partition) * 24, 0, 1);
    const agreement = clamp(bestCosine / STRONG_AGREEMENT, 0, 1);

    return Math.round(clamp(decisiveness * 0.55 + agreement * 0.45, 0, 1) * 100) / 100;
  }
}

/** Exposed for the nightly job, which re-learns from what was actually ingested. */
export const CLASSIFIER_NODES = CATEGORY_NODES;
