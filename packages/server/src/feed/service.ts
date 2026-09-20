import {
  BUFFER_CONFIG,
  RETURNING_USER,
  seededRandom,
  type FeedMode,
  type FeedPageRequest,
  type FeedPageResponse,
  type ProductCard,
  type RankingConfig,
} from '@window/shared';
import type { CollectionSet, User } from '../db/supabase-collections.js';
import { count, find, findOne, updateOne } from '../db/supabase-helpers.js';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import { logger } from '../lib/logger.js';
import { RankingService } from '../ranking/service.js';
import {
  chooseExplorationTopic,
  drawExplorationCounter,
  explorationSlotsForPage,
} from '../ranking/exploration.js';
import { isReturningAfterDormancy } from '../ranking/user-vector.js';
import { bloomHas, deserializeBloom } from '../lib/bloom.js';
import type { VectorCandidate, VectorSearch } from '../vector/types.js';
import { buildCardContext, toProductCard } from './cards.js';
import { isColdStart, planColdStart, planReentry } from './coldstart.js';
import { assembleQuad, chooseQuadSeeds, quadIndexes } from './quads.js';

const log = logger.child('feed');

export type Degradation = FeedPageResponse['degraded'];

export interface FeedDeps {
  collections: CollectionSet;
  ranking: RankingService;
  vectors: VectorSearch;
  cache: KeyValueCache;
}

export interface FeedPageResult extends FeedPageResponse {
  /** Ids the caller must record into the user's seen-set. */
  servedProductIds: string[];
  explorationProductId: string | null;
  explorationTopic: string | null;
  /** The exploration interval left over once this page is charged against it. */
  nextExplorationCounter: number;
}

/**
 * The feed service.
 *
 * It owns page assembly, the cold-start composition rules, mode-aware quad
 * grouping and exploration placement. The ranked page is computed on demand —
 * there is no precomputed feed table, because price and stock change too fast
 * to bake — with a short per-user buffer in front of it to absorb rapid paging.
 */
export class FeedService {
  constructor(private readonly deps: FeedDeps) {}

  private get config(): RankingConfig {
    return this.deps.ranking.getConfig();
  }

  async page(
    user: User,
    request: FeedPageRequest,
    now = new Date(),
  ): Promise<FeedPageResult> {
    const limit = Math.max(1, Math.min(request.limit, 40));

    // The buffer absorbs rapid paging within a 90-second window. It is keyed by
    // mode because the two modes want different shapes of the same ranked list.
    const cacheKey = cacheKeys.rankedBuffer(user.id, request.mode);
    const cached = await this.deps.cache.get<{ productIds: string[]; at: number }>(cacheKey);

    try {
      const result =
        request.mode === 'window'
          ? await this.windowPage(user, request, limit, now)
          : await this.singlePage(user, request, limit, now);

      // A ranked page with nothing in it is a failure that did not throw: an
      // empty or stale vector index produces no candidates, and returning the
      // empty page as-is leaves the client with a buffer it cannot fill and no
      // reason why. The ladder below reaches the catalog directly, so it still
      // has something to serve.
      if (result.items.length === 0) {
        log.warn('ranked page came back empty; descending the degradation ladder', {
          userId: user.id,
          mode: request.mode,
        });
        return this.degrade(user, request, limit, cached?.productIds ?? [], now);
      }

      await this.deps.cache.set(
        cacheKey,
        { productIds: result.servedProductIds, at: now.getTime() },
        this.config.cache.bufferTtlMs,
      );

      // The ranker computed what the interval has left over after this page;
      // the feed service is simply the thing that persists it. Decrementing
      // from anywhere else means two writers racing on one number.
      await updateOne(
        this.deps.collections.users,
        { id: user.id },
        { explorationState: { ...user.explorationState, counter: result.nextExplorationCounter } },
      );

      return result;
    } catch (error) {
      log.error('ranking failed; descending the degradation ladder', {
        error: (error as Error).message,
        userId: user.id,
      });
      return this.degrade(user, request, limit, cached?.productIds ?? [], now);
    }
  }

  // -------------------------------------------------------------------------
  // Single mode
  // -------------------------------------------------------------------------

  private async singlePage(
    user: User,
    request: FeedPageRequest,
    limit: number,
    now: Date,
  ): Promise<FeedPageResult> {
    const candidates = await this.composeCandidates(user, request, limit, now);
    const cards = await this.project(candidates.items, true, candidates.explorationProductId, candidates.explorationTopic, now);

    return {
      items: cards,
      quads: null,
      explorationIndexes: candidates.explorationIndexes,
      rankingConfigVersion: candidates.rankingConfigVersion,
      nextCursorHint: request.cursor + cards.length,
      ttlMs: this.config.cache.bufferTtlMs,
      degraded: null,
      servedProductIds: cards.map((c) => c.productId),
      explorationProductId: candidates.explorationProductId,
      explorationTopic: candidates.explorationTopic,
      nextExplorationCounter: candidates.nextExplorationCounter,
    };
  }

  // -------------------------------------------------------------------------
  // Window mode
  // -------------------------------------------------------------------------

  /**
   * Window mode runs the normal pipeline to pick seeds, then one narrow query
   * per quad to fill each pane with items from the seed's L2 inside its price
   * band. The extra queries are the price of coherence, and they are cheap:
   * each is scoped to eight L3s and a 2.5x price window.
   */
  private async windowPage(
    user: User,
    request: FeedPageRequest,
    limit: number,
    now: Date,
  ): Promise<FeedPageResult> {
    const config = this.config;
    const size = config.quads.size;
    const paneCount = Math.max(1, Math.floor(limit / size));

    const ranked = await this.deps.ranking.rank(
      {
        user,
        mode: 'window',
        limit: paneCount * 2,
        sessionId: request.sessionId,
        seenIds: request.seenIds,
        injectExploration: false,
      },
      now,
    );

    const seeds = chooseQuadSeeds(ranked.items, config, paneCount);
    const used = new Set<string>(seeds.map((s) => s.candidate.id));
    const panes: VectorCandidate[][] = [];

    for (const seed of seeds) {
      const pool = await this.deps.vectors.search({
        vector: user.interestVector ?? [],
        numCandidates: config.retrieval.quadNumCandidates,
        limit: config.retrieval.quadLimit,
        filter: {
          inStock: true,
          statusIn: ['active'],
          categoryL3In: seed.l3Scope,
          priceMin: seed.band.min,
          priceMax: seed.band.max,
          excludeIds: [
            ...user.suppressions.products,
            ...request.seenIds,
            ...[...used],
          ],
          excludeBrands: user.suppressions.brands,
          excludeSellerIds: user.suppressions.sellers,
        },
      });

      const quad = assembleQuad(
        seed,
        pool.filter((c) => c.risk.tier !== 'high' && c.risk.tier !== 'blocked'),
        config,
        used,
      );
      // A pane that cannot be made coherent is dropped rather than padded with
      // unrelated tiles; four unrelated objects read as a junk drawer.
      if (!quad) continue;

      for (const tile of quad) used.add(tile.id);
      panes.push(quad);
    }

    // Controlled discovery has to survive the grid being the main mode. A single
    // off-topic tile would break a quad's coherence — four unrelated objects
    // read as a junk drawer — so the exploration slot takes a whole pane: an
    // entire unfamiliar storefront, presented at its best. That is a truer
    // reading of the shop-window metaphor than one odd item on a shelf.
    const explorationRandom = seededRandom(
      `${user.id}:${request.sessionId}:${request.seenIds.length}:explore-pane`,
    );
    const slots = explorationSlotsForPage(
      user.explorationState.counter,
      limit,
      config,
      explorationRandom,
    );

    let explorationProductId: string | null = null;
    let explorationTopic: string | null = null;
    const explorationIndexes: number[] = [];

    if (slots.positions.length > 0 && panes.length > 0) {
      const categories = await find(this.deps.collections.categories, { level: 1 });
      const topic = chooseExplorationTopic(
        user,
        new Map(categories.map((c) => [c.id, c])) as never,
        config,
        explorationRandom,
        now,
      );

      if (topic) {
        const pane = await this.explorationPane(topic, user, used, now);
        if (pane) {
          const paneIndex = Math.min(
            Math.floor((slots.positions[0] as number) / size),
            panes.length - 1,
          );
          panes[paneIndex] = pane;
          explorationTopic = topic;
          explorationProductId = (pane[0] as VectorCandidate).id;
          for (let offset = 0; offset < pane.length; offset++) {
            explorationIndexes.push(paneIndex * size + offset);
          }
        }
      }
    }

    const items = panes.flat();
    const cards = await this.project(items, false, explorationProductId, explorationTopic, now);

    return {
      items: cards,
      quads: quadIndexes(panes.length, size),
      explorationIndexes,
      rankingConfigVersion: ranked.rankingConfigVersion,
      nextCursorHint: request.cursor + cards.length,
      ttlMs: this.config.cache.bufferTtlMs,
      degraded: null,
      servedProductIds: cards.map((c) => c.productId),
      explorationProductId,
      explorationTopic,
      nextExplorationCounter: slots.nextCounter,
    };
  }

  /**
   * Four products from one L2 inside an unexplored topic.
   *
   * Ordered by quality rather than by similarity to the user: the point of the
   * slot is to present the topic at its best, and a mediocre example of an
   * unfamiliar category teaches the user that exploration panes are noise.
   */
  private async explorationPane(
    topic: string,
    user: User,
    used: ReadonlySet<string>,
    now: Date,
  ): Promise<VectorCandidate[] | null> {
    const size = this.config.quads.size;
    const seen = deserializeBloom(user.seenFilter);

    const docs = await find(
      this.deps.collections.products,
      {
        'category.l1': topic,
        status: 'active',
        'stock.inStock': true,
        'risk.tier': { $in: ['clear', 'watch'] },
        id: { $nin: user.suppressions.products },
      },
      { limit: 240, orderBy: [{ column: 'quality.score', ascending: false }, { column: 'engagement.ctrSmoothed', ascending: false }] },
    );

    // Grouped by L2 so the pane is still one coherent window rather than a
    // sampler of the whole topic.
    const byL2 = new Map<string, VectorCandidate[]>();
    for (const doc of docs) {
      const key = doc.id;
      if (used.has(key) || bloomHas(seen, key)) continue;
      if (doc.auction && doc.auction.endsAt.getTime() <= now.getTime()) continue;

      const group = byL2.get(doc.category.l2) ?? [];
      group.push({ ...(doc as unknown as VectorCandidate), vectorScore: 0.5 });
      byL2.set(doc.category.l2, group);
    }

    for (const group of byL2.values()) {
      if (group.length < size) continue;
      // The same 2.5x band the ordinary quads honour.
      const sorted = [...group].sort((a, b) => a.price.amount - b.price.amount);
      for (let start = 0; start + size <= sorted.length; start++) {
        const window = sorted.slice(start, start + size);
        const low = (window[0] as VectorCandidate).price.amount;
        const high = (window[size - 1] as VectorCandidate).price.amount;
        if (low > 0 && high / low <= this.config.quads.priceBandMultiplier) return window;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  private async composeCandidates(
    user: User,
    request: FeedPageRequest,
    limit: number,
    now: Date,
  ): Promise<{
    items: VectorCandidate[];
    explorationIndexes: number[];
    explorationProductId: string | null;
    explorationTopic: string | null;
    nextExplorationCounter: number;
    rankingConfigVersion: string;
  }> {
    // A user returning after more than 14 days gets a five-card re-entry block
    // before the ranker takes over.
    if (
      isReturningAfterDormancy(user.counters.lastActiveAt, now, RETURNING_USER.dormantDays) &&
      user.interestSet.length > 0 &&
      request.cursor === 0
    ) {
      const reentry = await this.reentryBlock(user, request, now);
      if (reentry.length > 0) {
        const remainder = await this.deps.ranking.rank(
          {
            user,
            mode: 'single',
            limit: limit - reentry.length,
            sessionId: request.sessionId,
            seenIds: [...request.seenIds, ...reentry.map((c) => c.id)],
          },
          now,
        );
        return {
          items: [...reentry, ...remainder.items].slice(0, limit),
          explorationIndexes: remainder.explorationIndexes.map((i) => i + reentry.length),
          explorationProductId:
            remainder.explorationIndexes.length > 0
              ? (remainder.items[remainder.explorationIndexes[0] as number]?.id ?? null)
              : null,
          explorationTopic: remainder.explorationTopic,
          nextExplorationCounter: remainder.nextExplorationCounter,
          rankingConfigVersion: remainder.rankingConfigVersion,
        };
      }
    }

    if (!isColdStart(user)) {
      const ranked = await this.deps.ranking.rank(
        {
          user,
          mode: 'single',
          limit,
          sessionId: request.sessionId,
          seenIds: request.seenIds,
        },
        now,
      );
      return {
        items: ranked.items,
        explorationIndexes: ranked.explorationIndexes,
        explorationProductId:
          ranked.explorationIndexes.length > 0
            ? (ranked.items[ranked.explorationIndexes[0] as number]?.id ?? null)
            : null,
        explorationTopic: ranked.explorationTopic,
        nextExplorationCounter: ranked.nextExplorationCounter,
        rankingConfigVersion: ranked.rankingConfigVersion,
      };
    }

    return this.composeColdStart(user, request, limit, now);
  }

  private async composeColdStart(
    user: User,
    request: FeedPageRequest,
    limit: number,
    now: Date,
  ): Promise<{
    items: VectorCandidate[];
    explorationIndexes: number[];
    explorationProductId: string | null;
    explorationTopic: string | null;
    nextExplorationCounter: number;
    rankingConfigVersion: string;
  }> {
    const config = this.config;
    const blocks = planColdStart(user, user.counters.interactionCount, limit, config);
    const items: VectorCandidate[] = [];
    const seen = new Set<string>(request.seenIds);
    let rankingConfigVersion = config.version;
    let explorationTopic: string | null = null;
    let explorationProductId: string | null = null;
    let nextExplorationCounter = user.explorationState.counter;
    const explorationIndexes: number[] = [];

    for (const block of blocks) {
      const remaining = limit - items.length;
      if (remaining <= 0) break;

      const ranked = await this.deps.ranking.rank(
        {
          user,
          mode: 'single',
          limit: Math.min(block.count, remaining),
          sessionId: request.sessionId,
          seenIds: [...seen],
          restrictToTopics: block.topics,
          restrictToL3: block.l3Scope,
          priceOverride: block.priceOverride,
          // Only the final block carries the first exploration card.
          injectExploration: block.strategy === 'pure_vector',
        },
        now,
      );
      rankingConfigVersion = ranked.rankingConfigVersion;
      // Only the block that carries the slot advances the interval; the others
      // ran with injection suppressed and must not charge it twice.
      if (block.strategy === 'pure_vector') nextExplorationCounter = ranked.nextExplorationCounter;

      let blockItems = ranked.items;
      // The crowd-pleaser block orders by engagement rather than by similarity:
      // cards 1-3 have to land, and "most similar to a three-topic average" is
      // not the same thing as "known to delight".
      if (block.order === 'engagement') {
        blockItems = [...blockItems].sort(
          (a, b) =>
            b.engagement.ctrSmoothed - a.engagement.ctrSmoothed ||
            b.quality.score - a.quality.score,
        );
      }
      // Round-robin interleaves the selected topics so all three are visible
      // within the first screenful rather than one dominating.
      if (block.strategy === 'round_robin_selected_topics') {
        blockItems = roundRobinByTopic(blockItems);
      }

      if (ranked.explorationTopic) explorationTopic = ranked.explorationTopic;
      for (const index of ranked.explorationIndexes) {
        const card = ranked.items[index];
        if (card) {
          explorationProductId = card.id;
          explorationIndexes.push(items.length + blockItems.findIndex((c) => c.id === card.id));
        }
      }

      for (const candidate of blockItems) {
        const key = candidate.id;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(candidate);
      }
    }

    // End of ranked supply is never shown. If composition came up short, the
    // ranker backfills without the block restrictions.
    if (items.length < limit) {
      const backfill = await this.deps.ranking.rank(
        {
          user,
          mode: 'single',
          limit: limit - items.length,
          sessionId: request.sessionId,
          seenIds: [...seen],
        },
        now,
      );
      for (const candidate of backfill.items) {
        if (items.length >= limit) break;
        if (seen.has(candidate.id)) continue;
        items.push(candidate);
      }
    }

    return {
      items: items.slice(0, limit),
      explorationIndexes: explorationIndexes.filter((i) => i >= 0 && i < limit),
      explorationProductId,
      explorationTopic,
      nextExplorationCounter,
      rankingConfigVersion,
    };
  }

  private async reentryBlock(
    user: User,
    request: FeedPageRequest,
    now: Date,
  ): Promise<VectorCandidate[]> {
    const plan = planReentry(user, await this.risingTopics());
    if (!plan) return [];

    const strongest = await this.deps.ranking.rank(
      {
        user,
        mode: 'single',
        limit: plan.fromStrongest,
        sessionId: request.sessionId,
        seenIds: request.seenIds,
        restrictToTopics: [plan.strongestTopic],
        injectExploration: false,
      },
      now,
    );

    if (plan.risingTopics.length === 0) return strongest.items;

    const rising = await this.deps.ranking.rank(
      {
        user,
        mode: 'single',
        limit: plan.fromRising,
        sessionId: request.sessionId,
        seenIds: [...request.seenIds, ...strongest.items.map((c) => c.id)],
        restrictToTopics: plan.risingTopics,
        injectExploration: false,
      },
      now,
    );

    return [...strongest.items, ...rising.items];
  }

  /** Topics whose engagement has grown since the nightly rollup. */
  private async risingTopics(): Promise<string[]> {
    const docs = await find(
      this.deps.collections.categories,
      { level: 1 },
      { limit: 6, orderBy: [{ column: 'engagement.medianCtr', ascending: false }] },
    );
    return docs.map((d) => d.id);
  }

  // -------------------------------------------------------------------------
  // Projection and degradation
  // -------------------------------------------------------------------------

  private async project(
    candidates: readonly VectorCandidate[],
    includeGallery: boolean,
    explorationProductId: string | null,
    explorationTopic: string | null,
    now: Date,
  ): Promise<ProductCard[]> {
    if (candidates.length === 0) return [];

    const sources = await find(this.deps.collections.sources, {});
    const context = await buildCardContext(
      candidates,
      {
        sellers: this.deps.collections.sellers as never,
        clusters: this.deps.collections.clusters as never,
        merchantNames: new Map(sources.map((s) => [s.id, s.displayName])),
      },
      { includeGallery, explorationProductId, explorationTopic, now },
    );

    return candidates.map((candidate) => toProductCard(candidate, context));
  }

  /**
   * The graceful degradation ladder: the cached per-user buffer, then a
   * per-topic popularity feed, then a global popularity feed. The user always
   * sees products — the feed never surfaces a network error, it just stops
   * advancing, and stopping is worse than showing something slightly stale.
   */
  private async degrade(
    user: User,
    request: FeedPageRequest,
    limit: number,
    cachedIds: string[],
    now: Date,
  ): Promise<FeedPageResult> {
    const { collections } = this.deps;
    let level: Degradation = 'cache';
    let docs: VectorCandidate[] = [];

    if (cachedIds.length > 0) {
      docs = (await find(
        collections.products,
        { id: { $in: cachedIds }, status: 'active', 'stock.inStock': true },
        { limit },
      )) as unknown as VectorCandidate[];
    }

    if (docs.length < limit) {
      const topics = user.interestSet.map((entry) => entry.topic);
      if (topics.length > 0) {
        level = 'topic_popularity';
        docs = (await find(
          collections.products,
          {
            'category.l1': { $in: topics },
            status: 'active',
            'stock.inStock': true,
            'risk.tier': { $in: ['clear', 'watch'] },
          },
          { limit, orderBy: [{ column: 'engagement.ctrSmoothed', ascending: false }, { column: 'quality.score', ascending: false }] },
        )) as unknown as VectorCandidate[];
      }
    }

    if (docs.length < limit) {
      level = 'global_popularity';
      docs = (await find(
        collections.products,
        {
          status: 'active',
          'stock.inStock': true,
          'risk.tier': { $in: ['clear', 'watch'] },
        },
        { limit, orderBy: [{ column: 'engagement.ctrSmoothed', ascending: false }, { column: 'quality.score', ascending: false }] },
      )) as unknown as VectorCandidate[];
    }

    const withScores = docs.map((doc) => ({ ...doc, vectorScore: 0.5 }));
    const cards = await this.project(withScores, request.mode === 'single', null, null, now);

    return {
      items: cards,
      quads:
        request.mode === 'window'
          ? quadIndexes(Math.floor(cards.length / this.config.quads.size), this.config.quads.size)
          : null,
      explorationIndexes: [],
      rankingConfigVersion: this.config.version,
      nextCursorHint: request.cursor + cards.length,
      ttlMs: 30_000,
      degraded: level,
      servedProductIds: cards.map((c) => c.productId),
      explorationProductId: null,
      explorationTopic: null,
      // A degraded page is not a ranked one; the interval is left untouched so
      // the user does not lose their place in it because ranking had a bad minute.
      nextExplorationCounter: user.explorationState.counter,
    };
  }

  /**
   * Redraws the interval after an exploration card is served, and records which
   * topic it was, so a topic that produces nothing can be struck later.
   */
  /** Session bootstrap: the exploration counter is drawn once per user, not per session. */
  explorationCounterFor(user: User): number {
    if (user.explorationState.counter > 0) return user.explorationState.counter;
    return drawExplorationCounter(
      this.config,
      seededRandom(`${user.id}:exploration`),
    );
  }

  /** The buffer and prefetch rules the client bootstraps from. */
  bufferConfig(): typeof BUFFER_CONFIG {
    return BUFFER_CONFIG;
  }
}

/**
 * Interleaves by L1 so a round-robin block shows topic A, B, C, A, B, C rather
 * than three of A followed by three of B.
 */
function roundRobinByTopic(candidates: readonly VectorCandidate[]): VectorCandidate[] {
  const byTopic = new Map<string, VectorCandidate[]>();
  for (const candidate of candidates) {
    const list = byTopic.get(candidate.category.l1) ?? [];
    list.push(candidate);
    byTopic.set(candidate.category.l1, list);
  }

  const queues = [...byTopic.values()];
  const out: VectorCandidate[] = [];
  let index = 0;
  while (out.length < candidates.length && queues.some((q) => q.length > 0)) {
    const queue = queues[index % queues.length] as VectorCandidate[];
    const next = queue.shift();
    if (next) out.push(next);
    index += 1;
  }
  return out;
}

/** Exposed for the refresh endpoint, which discards the buffer and re-ranks. */
export async function discardBuffer(cache: KeyValueCache, userId: string): Promise<void> {
  for (const key of cacheKeys.rankedBufferPrefixes(userId)) {
    await cache.del(key);
  }
}
