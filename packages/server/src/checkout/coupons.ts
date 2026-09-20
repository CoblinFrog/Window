import type { SupabaseTable, Coupon } from '../db/supabase-collections.js';
import { CHECKOUT_CONFIG } from '@window/shared';
import { logger } from '../lib/logger.js';
import { find, findOne, updateOne } from '../db/supabase-helpers.js';

const log = logger.child('coupons');

/**
 * Coupon automation.
 *
 * Discovery runs in parallel with cart building so it adds no wall-clock time
 * to checkout. Candidates are ordered by historic success rate on that
 * merchant, then by expected discount, and capped at eight attempts per job to
 * bound time and to avoid hammering the merchant's promo endpoint.
 *
 * Every attempt writes back success, failure reason and observed discount, so
 * the store self-corrects. This feedback loop is the whole asset: a coupon
 * database without it decays into a list of expired codes within a month.
 */

export interface CouponCandidate {
  id: string;
  code: string;
  merchantDomain: string;
  expectedDiscountPct: number;
  successRate: number;
  stackable: boolean;
  constraints: Coupon['constraints'];
}

export interface CouponAttemptOutcome {
  code: string;
  applied: boolean;
  /** Observed on the merchant's own page: pre-code total minus post-code total. */
  observedDiscount: number;
  reason: string | null;
}

export type CouponFailureReason =
  | 'invalid'
  | 'expired'
  | 'min_spend'
  | 'category_excluded'
  | 'first_order_only'
  | 'not_stackable'
  | 'unknown';

export class CouponStore {
  constructor(private readonly coupons: SupabaseTable) {}

  /**
   * Ranked candidates for a merchant. Constraints that can be evaluated before
   * the attempt — spend floor, category, expiry — filter here rather than
   * burning one of the eight attempts finding out.
   */
  async candidatesFor(
    merchantDomain: string,
    context: { subtotal: number; categories: string[]; isFirstOrder: boolean },
    now = new Date(),
    limit = CHECKOUT_CONFIG.maxCouponAttempts,
  ): Promise<CouponCandidate[]> {
    const docs = await find<Coupon>(this.coupons, { merchantDomain, status: 'active' }, {
      limit: limit * 4,
      orderBy: [
        { column: 'performance.successRate', ascending: false },
        { column: 'performance.meanDiscountPct', ascending: false },
      ],
    });

    const eligible = docs.filter((doc) => {
      const c = doc.constraints;
      if (c.expiresAt && c.expiresAt.getTime() <= now.getTime()) return false;
      if (c.minSpend !== null && context.subtotal < c.minSpend) return false;
      if (c.firstOrderOnly && !context.isFirstOrder) return false;
      if (
        c.categories.length > 0 &&
        !c.categories.some((category) => context.categories.includes(category))
      ) {
        return false;
      }
      return true;
    });

    return eligible.slice(0, limit).map((doc) => ({
      id: doc.id,
      code: doc.code,
      merchantDomain: doc.merchantDomain,
      expectedDiscountPct: doc.performance.meanDiscountPct,
      successRate: doc.performance.successRate,
      stackable: doc.stackable,
      constraints: doc.constraints,
    }));
  }

  /**
   * Records an attempt. A code failing three consecutive times on a merchant is
   * retired: at that point it is not a flaky code, it is a dead one, and every
   * further attempt costs a slot that a live code could have used.
   */
  async recordAttempt(
    merchantDomain: string,
    code: string,
    outcome: { applied: boolean; observedDiscount: number; subtotal: number; reason: string | null },
    now = new Date(),
  ): Promise<void> {
    const doc = await findOne<Coupon>(this.coupons, { merchantDomain, code });
    if (!doc) return;

    const attempts = doc.performance.attempts + 1;
    const successes = doc.performance.successes + (outcome.applied ? 1 : 0);
    const consecutiveFailures = outcome.applied ? 0 : doc.performance.consecutiveFailures + 1;

    const discountPct =
      outcome.applied && outcome.subtotal > 0
        ? (outcome.observedDiscount / outcome.subtotal) * 100
        : 0;
    const meanDiscountPct = outcome.applied
      ? (doc.performance.meanDiscountPct * doc.performance.successes + discountPct) /
        Math.max(1, successes)
      : doc.performance.meanDiscountPct;

    const retired = consecutiveFailures >= CHECKOUT_CONFIG.couponRetirementFailures;

    await updateOne<Coupon>(
      this.coupons,
      { id: doc.id },
      {
        performance: {
          ...doc.performance,
          attempts,
          successes,
          successRate: successes / attempts,
          meanDiscountPct: Math.round(meanDiscountPct * 10) / 10,
          consecutiveFailures,
          ...(outcome.applied ? { lastSuccessAt: now } : {}),
        },
        ...(retired ? { status: 'retired' as const } : {}),
      },
    );

    if (retired) {
      log.info('coupon retired after consecutive failures', { merchantDomain, code });
    }
  }
}

/**
 * Chooses the best outcome across a run of attempts.
 *
 * If the merchant applies a promotion automatically that beats every code, the
 * agent reports that and applies nothing — claiming credit for a discount the
 * user would have received anyway is exactly the behaviour that makes savings
 * claims a consumer-protection problem.
 */
export function bestCouponOutcome(
  attempts: readonly CouponAttemptOutcome[],
  automaticDiscount: number,
): { code: string | null; discount: number; attempts: number; automatic: boolean } {
  const applied = attempts.filter((a) => a.applied);
  const best = applied.sort((a, b) => b.observedDiscount - a.observedDiscount)[0];

  if (!best || automaticDiscount >= best.observedDiscount) {
    return {
      code: null,
      discount: automaticDiscount,
      attempts: attempts.length,
      automatic: automaticDiscount > 0,
    };
  }

  return {
    code: best.code,
    discount: best.observedDiscount,
    attempts: attempts.length,
    automatic: false,
  };
}

/**
 * Stacking is attempted only where the merchant permits it, learned per
 * merchant. Attempting it elsewhere reliably invalidates the first code, which
 * is worse than not trying.
 */
export function stackableSubset(
  candidates: readonly CouponCandidate[],
  merchantAllowsStacking: boolean,
): CouponCandidate[] {
  if (!merchantAllowsStacking) return [];
  return candidates.filter((c) => c.stackable);
}
