import { cosine, type RankingConfig } from '@window/shared';
import type { VectorCandidate } from '../vector/types.js';
import { penalty, scoreCandidate, type ScoreBreakdown, type ScoringContext } from './scoring.js';

/**
 * Stage 4: diversification.
 *
 * Maximal marginal relevance over L2 category, enforcing the guardrail of at
 * least five distinct L2 categories per 20-card page.
 *
 * Redundancy is measured over the taxonomy rather than over embeddings, which
 * is deliberate. Embedding-MMR diversifies toward whatever the model happens to
 * separate; L2-MMR diversifies toward what a browsing user perceives as "a
 * different kind of thing", and that perception is the thing the feed is
 * actually competing for.
 */

export interface SelectionResult {
  selected: VectorCandidate[];
  breakdowns: Map<string, ScoreBreakdown & { mmrScore: number; reason: string }>;
  distinctL2: number;
  /** Set when the guardrail had to force a swap. */
  guardrailEnforced: boolean;
}

/** Category redundancy in [0,1]: same L2 is total, same L1 is partial. */
function categoryRedundancy(a: VectorCandidate, b: VectorCandidate): number {
  if (a.category.l2 === b.category.l2) return 1;
  if (a.category.l1 === b.category.l1) return 0.45;
  return 0;
}

/**
 * How many candidates get the expensive near-duplicate check per slot.
 *
 * The full penalty needs a cosine against each of the last eight placed cards.
 * Running that for all 400 candidates on all 20 slots is 64,000 dot products of
 * 1024 dimensions, which does not fit the 250 ms budget for a term that only
 * ever demotes. Ranking on the cheap terms first and rescoring the top slice is
 * exact whenever the near-duplicate penalty cannot promote a candidate past the
 * slice boundary, which — since the penalty is strictly negative — it cannot.
 */
const RESCORE_SLICE = 32;

export function selectPage(
  candidates: readonly VectorCandidate[],
  context: ScoringContext,
  count: number,
  stalenessCeilingMs: number,
): SelectionResult {
  const config = context.config;
  const lambda = config.diversification.lambda;

  const remaining = new Map<string, VectorCandidate>();
  for (const candidate of candidates) remaining.set(candidate.id, candidate);

  // The terms that do not depend on what has already been placed are computed
  // once; only the penalty is recomputed as the page fills.
  const staticScores = new Map<string, ScoreBreakdown>();
  for (const candidate of candidates) {
    staticScores.set(
      candidate.id,
      scoreCandidate(candidate, context, { placed: [], config }, stalenessCeilingMs),
    );
  }

  const selected: VectorCandidate[] = [];
  const breakdowns = new Map<string, ScoreBreakdown & { mmrScore: number; reason: string }>();

  while (selected.length < count && remaining.size > 0) {
    const slice = [...remaining.values()]
      .map((candidate) => {
        const key = candidate.id;
        const base = staticScores.get(key) as ScoreBreakdown;
        const redundancy =
          selected.length === 0
            ? 0
            : Math.max(...selected.map((s) => categoryRedundancy(candidate, s)));
        return {
          candidate,
          key,
          base,
          redundancy,
          provisional: lambda * base.score - (1 - lambda) * redundancy,
        };
      })
      .sort((a, b) => b.provisional - a.provisional)
      .slice(0, RESCORE_SLICE);

    let best: {
      candidate: VectorCandidate;
      key: string;
      breakdown: ScoreBreakdown;
      mmrScore: number;
    } | null = null;

    for (const entry of slice) {
      const penaltyScore = penalty(entry.candidate, { placed: selected, config });
      const score = entry.base.score - config.weights.penalty * penaltyScore;
      const mmrScore = lambda * score - (1 - lambda) * entry.redundancy;
      if (!best || mmrScore > best.mmrScore) {
        best = {
          candidate: entry.candidate,
          key: entry.key,
          breakdown: { ...entry.base, penalty: penaltyScore, score },
          mmrScore,
        };
      }
    }

    if (!best) break;
    selected.push(best.candidate);
    remaining.delete(best.key);
    breakdowns.set(best.key, {
      ...best.breakdown,
      mmrScore: best.mmrScore,
      reason: 'mmr',
    });
  }

  const guardrail = enforceDiversityGuardrail(
    selected,
    remaining,
    staticScores,
    config,
    breakdowns,
  );

  return {
    selected,
    breakdowns,
    distinctL2: new Set(selected.map((c) => c.category.l2)).size,
    guardrailEnforced: guardrail,
  };
}

/**
 * The guardrail: at least five distinct L2 categories per 20-card page.
 *
 * MMR usually delivers this on its own. When it does not — a user with a very
 * narrow interest set, or a page where one L2 simply has the best supply — the
 * page is repaired by replacing the lowest-scoring card from the most-repeated
 * category with the best available card from an unrepresented one. A ranking
 * change that improves the north star but breaches a guardrail is reverted, so
 * the guardrail has to be enforced here rather than merely measured.
 */
function enforceDiversityGuardrail(
  selected: VectorCandidate[],
  remaining: ReadonlyMap<string, VectorCandidate>,
  staticScores: ReadonlyMap<string, ScoreBreakdown>,
  config: RankingConfig,
  breakdowns: Map<string, ScoreBreakdown & { mmrScore: number; reason: string }>,
): boolean {
  const target = config.diversification.minDistinctL2PerPage;
  if (selected.length < target) return false;

  let enforced = false;

  for (let guard = 0; guard < target; guard++) {
    const present = new Set(selected.map((c) => c.category.l2));
    if (present.size >= target) break;

    const novel = [...remaining.values()]
      .filter((c) => !present.has(c.category.l2))
      .sort(
        (a, b) =>
          ((staticScores.get(b.id) as ScoreBreakdown).score) -
          ((staticScores.get(a.id) as ScoreBreakdown).score),
      )[0];
    if (!novel) break;

    // Displace the weakest card from whichever category is over-represented.
    const counts = new Map<string, number>();
    for (const c of selected) counts.set(c.category.l2, (counts.get(c.category.l2) ?? 0) + 1);
    const crowded = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!crowded) break;

    let worstIndex = -1;
    let worstScore = Infinity;
    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i] as VectorCandidate;
      if (candidate.category.l2 !== crowded) continue;
      const score = (staticScores.get(candidate.id) as ScoreBreakdown).score;
      if (score < worstScore) {
        worstScore = score;
        worstIndex = i;
      }
    }
    if (worstIndex === -1) break;

    const displaced = selected[worstIndex] as VectorCandidate;
    breakdowns.delete(displaced.id);
    selected[worstIndex] = novel;
    const base = staticScores.get(novel.id) as ScoreBreakdown;
    breakdowns.set(novel.id, {
      ...base,
      mmrScore: base.score,
      reason: 'diversity_guardrail',
    });
    enforced = true;
  }

  return enforced;
}

/**
 * Near-duplicate detection used by the buffer swap: a product that is
 * effectively the same card as one already in the buffer never reaches the
 * viewport.
 */
export function isNearDuplicate(
  candidate: VectorCandidate,
  others: readonly VectorCandidate[],
  threshold: number,
): boolean {
  return others.some((other) => cosine(candidate.embedding, other.embedding) >= threshold);
}
