import {
  COLD_START_COMPOSITION,
  COLD_START_INTERACTION_CEILING,
  RETURNING_USER,
  childrenOf,
  type ColdStartStrategy,
  type RankingConfig,
} from '@window/shared';
import type { User } from '../db/collections.js';

/**
 * Cold start.
 *
 * Cold start is the highest-risk moment in the product, so the first 20 cards
 * are composed deliberately rather than purely by vector score. The composition
 * rules exist only while `interactionCount < 20`; after that the feed hands
 * over entirely to the ranker.
 *
 * The blocks are not arbitrary. Cards 1-3 have to land, so they are known
 * crowd-pleasers with good media. Cards 4-9 prove all three chosen topics are
 * represented. Cards 10-12 show the user something adjacent they did not ask
 * for, which is the first test of whether they will tolerate discovery at all.
 * Cards 13-15 straddle the stated price band, because a price prior that is
 * never contradicted never gets calibrated.
 */

export interface ColdStartBlock {
  strategy: ColdStartStrategy;
  /** Number of cards this block contributes to the page. */
  count: number;
  /** Topics the block's retrieval is restricted to, if any. */
  topics: string[] | null;
  /** L3 ids the block's retrieval is restricted to, if any. */
  l3Scope: string[] | null;
  /** Price bounds overriding the user's prior, if any. */
  priceOverride: { min: number; max: number } | null;
  /** Ordering within the block. */
  order: 'engagement' | 'vector';
}

export function isColdStart(user: Pick<User, 'counters'>): boolean {
  return user.counters.interactionCount < COLD_START_INTERACTION_CEILING;
}

/**
 * Plans the composition for a page starting at `offset` cards into the user's
 * first session. Blocks that fall entirely behind the offset are skipped, and a
 * block straddling it contributes only its remaining cards.
 */
export function planColdStart(
  user: Pick<User, 'counters' | 'onboarding' | 'interestSet' | 'pricePrior'>,
  offset: number,
  limit: number,
  config: RankingConfig,
): ColdStartBlock[] {
  const topics =
    user.onboarding?.topics ?? user.interestSet.map((entry) => entry.topic);
  if (topics.length === 0) return [];

  // Ordered by the user's own weights, so "the top-selected topic" means the
  // one they care most about rather than the one they happened to tap first.
  const ranked = [...user.interestSet]
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.topic)
    .filter((topic) => topics.includes(topic));
  const primary = ranked[0] ?? (topics[0] as string);

  const blocks: ColdStartBlock[] = [];
  let produced = 0;

  for (const spec of COLD_START_COMPOSITION) {
    if (produced >= limit) break;

    // Convert the 1-based inclusive card range into a slice of this page.
    const blockStart = spec.from - 1;
    const blockEnd = spec.to; // exclusive
    const start = Math.max(blockStart, offset);
    const end = Math.min(blockEnd, offset + limit);
    const count = end - start;
    if (count <= 0) continue;

    blocks.push({ ...blockFor(spec.strategy, primary, topics, user, config), count });
    produced += count;
  }

  return blocks;
}

function blockFor(
  strategy: ColdStartStrategy,
  primary: string,
  topics: readonly string[],
  user: Pick<User, 'pricePrior'>,
  config: RankingConfig,
): Omit<ColdStartBlock, 'count'> {
  switch (strategy) {
    // 1-3: highest-engagement products in the top-selected topic.
    case 'top_topic_crowd_pleasers':
      return {
        strategy,
        topics: [primary],
        l3Scope: null,
        priceOverride: null,
        order: 'engagement',
      };

    // 4-9: round-robin across all three selected topics, vector-ranked within each.
    case 'round_robin_selected_topics':
      return {
        strategy,
        topics: [...topics],
        l3Scope: null,
        priceOverride: null,
        order: 'vector',
      };

    // 10-12: adjacent L2s inside the selected L1s that the user did not pick.
    case 'l2_diversification':
      return {
        strategy,
        topics: [...topics],
        l3Scope: topics.flatMap((topic) =>
          childrenOf(topic).flatMap((l2) => childrenOf(l2.id).map((l3) => l3.id)),
        ),
        priceOverride: null,
        order: 'vector',
      };

    // 13-15: one clearly below and one clearly above the stated comfort band.
    case 'price_band_spread': {
      const center = user.pricePrior.center;
      return {
        strategy,
        topics: [...topics],
        l3Scope: null,
        // Deliberately wider than the normal 0.25x-4x filter: the point is to
        // show the user something outside what they said they wanted and find
        // out whether they meant it.
        priceOverride: {
          min: Math.max(1, Math.round(center * 0.1)),
          max: Math.round(center * config.filters.priceHighMultiplier * 2),
        },
        order: 'vector',
      };
    }

    // 16-20: pure vector rank, plus the first exploration card.
    case 'pure_vector':
      return {
        strategy,
        topics: [...topics],
        l3Scope: null,
        priceOverride: null,
        order: 'vector',
      };
  }
}

/**
 * The returning-user re-entry block: three items from the strongest historic
 * interest and two from topics that have grown in global popularity since they
 * left. The second half matters more than it looks — it is the only mechanism
 * that tells a dormant user the catalog moved on without them.
 */
export interface ReentryPlan {
  strongestTopic: string;
  fromStrongest: number;
  risingTopics: string[];
  fromRising: number;
}

export function planReentry(
  user: Pick<User, 'interestSet'>,
  risingTopics: readonly string[],
): ReentryPlan | null {
  const strongest = [...user.interestSet].sort((a, b) => b.weight - a.weight)[0];
  if (!strongest) return null;

  const interest = new Set(user.interestSet.map((entry) => entry.topic));
  return {
    strongestTopic: strongest.topic,
    fromStrongest: RETURNING_USER.fromStrongestInterest,
    risingTopics: risingTopics.filter((topic) => !interest.has(topic)).slice(0, 4),
    fromRising: RETURNING_USER.fromRisingTopics,
  };
}
