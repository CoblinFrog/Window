import {
  DEFAULT_RANKING_CONFIG,
  L1_IDS,
  seededRandom,
  type CategoryDoc,
  type FeedMode,
  type RankingConfig,
  type RankingDebugCandidate,
  type RankingDebugResponse,
} from '@window/shared';
import type { CollectionSet, User } from '../db/supabase-collections.js';
import { find, findOne } from '../db/supabase-helpers.js';
import { bloomHas, deserializeBloom } from '../lib/bloom.js';
import { logger } from '../lib/logger.js';
import type { VectorCandidate, VectorSearch } from '../vector/types.js';
import { selectPage } from './diversify.js';
import { chooseExplorationTopic, explorationSlotsForPage } from './exploration.js';
import type { ScoringContext } from './scoring.js';
import { priceBounds } from './user-vector.js';

const log = logger.child('ranking');

export interface RankRequest {
  user: User;
  mode: FeedMode;
  limit: number;
  sessionId: string;
  /** The last 200 seen ids the client carries; the server holds the rest. */
  seenIds: string[];
  /** Explicit topic scope, used by the cold-start composer. */
  restrictToTopics?: string[] | null;
  /** Restrict to specific L3s, used for quad seeds and L2 diversification. */
  restrictToL3?: string[] | null;
  /** Overrides the user's price band, used by the price-band spread block. */
  priceOverride?: { min: number; max: number } | null;
  /** Suppresses the exploration slot; the cold-start composer places its own. */
  injectExploration?: boolean;
  debug?: boolean;
}

export interface RankResult {
  items: VectorCandidate[];
  explorationIndexes: number[];
  explorationTopic: string | null;
  /** The interval left over for the next page, already charged for this one. */
  nextExplorationCounter: number;
  rankingConfigVersion: string;
  timings: Record<string, number>;
  debug: RankingDebugResponse | null;
  /** How many candidates each filter removed, for the crawl and ranking dashboards. */
  filteredBy: Record<string, number>;
}

export interface RankingDeps {
  collections: CollectionSet;
  vectors: VectorSearch;
  config?: RankingConfig;
}

/**
 * The ranking service.
 *
 * Four stages over the vector index: retrieve a candidate pool by similarity,
 * filter it, score it with business signals, then diversify and inject
 * exploration. The whole pipeline must return 20 products in under 250 ms at
 * p95, which is why the expensive parts — the Bloom check, the near-duplicate
 * cosines — are deliberately placed where they operate on hundreds of items
 * rather than on the whole catalog.
 */
export class RankingService {
  private config: RankingConfig;
  private categoryCache: Map<string, CategoryDoc<string>> | null = null;
  private categoryCacheAt = 0;

  constructor(private readonly deps: RankingDeps) {
    this.config = deps.config ?? DEFAULT_RANKING_CONFIG;
  }

  /** Ranking weights live in a config document and are hot-reloadable. */
  setConfig(config: RankingConfig): void {
    this.config = config;
    log.info('ranking config reloaded', { version: config.version });
  }

  getConfig(): RankingConfig {
    return this.config;
  }

  private async categories(): Promise<Map<string, CategoryDoc<string>>> {
    // The taxonomy changes nightly at most; re-reading 1,638 documents on every
    // feed page would be the single largest cost in the pipeline.
    const ttlMs = 60_000;
    if (this.categoryCache && Date.now() - this.categoryCacheAt < ttlMs) {
      return this.categoryCache;
    }
    const docs = await find(this.deps.collections.categories, {});
    this.categoryCache = new Map(docs.map((d) => [d.id, d]));
    this.categoryCacheAt = Date.now();
    return this.categoryCache;
  }

  async rank(request: RankRequest, now = new Date()): Promise<RankResult> {
    const timings: Record<string, number> = {};
    const startedAt = Date.now();
    const config = this.config;
    const user = request.user;

    const categories = await this.categories();
    timings.categories = Date.now() - startedAt;

    // ---- Exploration slots ------------------------------------------------
    // The counter is decremented per card rendered, so the slots for this page
    // are every position where the interval expires *inside* it. A 20-card page
    // against a 10-to-20 interval earns one or two, and only computing the
    // first would silently pin every gap to a full page — the sparse end of the
    // range, every single time.
    //
    // Seeded per session so a retry of the same page is stable, which matters
    // because the client may re-request after a 429.
    const explorationRandom = seededRandom(
      `${user.id}:${request.sessionId}:${request.seenIds.length}:explore`,
    );

    const injects = request.injectExploration !== false;
    const slots = injects
      ? explorationSlotsForPage(
          user.explorationState.counter,
          request.limit,
          config,
          explorationRandom,
        )
      : {
          positions: [],
          // A page that suppresses injection still consumes the interval.
          nextCounter: Math.max(0, user.explorationState.counter - request.limit),
        };
    const slotPositions = slots.positions;
    const nextExplorationCounter = slots.nextCounter;

    const explorationTopic =
      slotPositions.length > 0
        ? chooseExplorationTopic(
            user,
            categories as unknown as ReadonlyMap<string, CategoryDoc>,
            config,
            explorationRandom,
            now,
          )
        : null;

    // ---- Stage 1: retrieval ----------------------------------------------
    const retrievalStart = Date.now();
    const topicScope = this.topicScope(request, explorationTopic);
    const bounds = request.priceOverride ?? priceBounds(user.pricePrior, config);

    const suppressed = user.suppressions;
    const candidates = await this.deps.vectors.search({
      vector: user.interestVector ?? [],
      numCandidates: config.retrieval.numCandidates,
      limit: config.retrieval.limit,
      filter: {
        // `inStock: true` and the topic scope are declared filter paths, so
        // Atlas applies them during ANN traversal rather than after it.
        inStock: true,
        statusIn: ['active'],
        categoryL1In: topicScope ?? undefined,
        categoryL3In: request.restrictToL3 ?? undefined,
        priceMin: bounds.min,
        priceMax: bounds.max,
        excludeIds: [
          ...suppressed.products,
          ...request.seenIds,
        ],
        excludeBrands: suppressed.brands,
        excludeSellerIds: suppressed.sellers,
      },
    });
    timings.retrieval = Date.now() - retrievalStart;

    // ---- Stage 2: the filters that cannot live in the index ---------------
    const filterStart = Date.now();
    const filteredBy: Record<string, number> = {
      seen_bloom: 0,
      risk_tier: 0,
      auction_ended: 0,
    };

    // The seen-set is a Bloom filter on the user document, so membership cannot
    // be expressed as an aggregation predicate. It is applied here, over the
    // 400 retrieved candidates rather than over the catalog, which is the only
    // place the check is cheap.
    const seen = deserializeBloom(user.seenFilter);
    const eligible: VectorCandidate[] = [];
    for (const candidate of candidates) {
      if (bloomHas(seen, candidate.id)) {
        filteredBy.seen_bloom = (filteredBy.seen_bloom as number) + 1;
        continue;
      }
      // High-tier listings are excluded from the feed entirely and reachable
      // only by direct link; blocked ones are never shown at all.
      if (candidate.risk.tier === 'high' || candidate.risk.tier === 'blocked') {
        filteredBy.risk_tier = (filteredBy.risk_tier as number) + 1;
        continue;
      }
      if (candidate.auction && candidate.auction.endsAt.getTime() <= now.getTime()) {
        filteredBy.auction_ended = (filteredBy.auction_ended as number) + 1;
        continue;
      }
      eligible.push(candidate);
    }
    timings.filters = Date.now() - filterStart;

    // ---- Stages 3 and 4: scoring, then MMR --------------------------------
    const scoreStart = Date.now();
    const context: ScoringContext = {
      config,
      userVector: user.interestVector,
      brandAffinities: user.affinities.brands,
      sellerAffinities: user.affinities.sellers,
      categoryMeanCtr: new Map(
        [...categories.values()]
          .filter((c) => c.level === 2)
          .map((c) => [c.id, c.engagement.medianCtr]),
      ),
      now,
    };

    // Caution-tier listings are ranked down 40%; they are still shown, with a
    // plain-language flag, because suppressing honest sellers outright destroys
    // the secondhand supply that differentiates the product.
    const adjusted = eligible.map((candidate) =>
      candidate.risk.tier === 'caution'
        ? { ...candidate, quality: { ...candidate.quality, score: candidate.quality.score * 0.6 } }
        : candidate,
    );

    const selection = selectPage(
      adjusted,
      context,
      request.limit,
      24 * 60 * 60 * 1000,
    );
    timings.scoring = Date.now() - scoreStart;

    // ---- Exploration injection -------------------------------------------
    const injectStart = Date.now();
    const explorationIndexes: number[] = [];
    let items = selection.selected;

    if (explorationTopic && slotPositions.length > 0) {
      // Each slot gets its own card, and the excluded set grows as they are
      // placed so one page never shows the same exploration product twice.
      const placed = new Set<string>();

      // Inserted back-to-front: inserting at an earlier index would shift every
      // later position by one and land the second slot in the wrong place.
      for (const position of [...slotPositions].reverse()) {
        const card = await this.explorationCard(explorationTopic, user, now, placed);
        if (!card) continue;
        placed.add(card.id);

        const index = Math.min(position, items.length);
        items = [...items.slice(0, index), card, ...items.slice(index)];
        explorationIndexes.push(index);
      }

      items = items.slice(0, request.limit);
      explorationIndexes.sort((a, b) => a - b);
    }
    timings.exploration = Date.now() - injectStart;
    timings.total = Date.now() - startedAt;

    return {
      items,
      explorationIndexes,
      explorationTopic,
      nextExplorationCounter,
      rankingConfigVersion: config.version,
      timings,
      filteredBy,
      debug: request.debug
        ? this.buildDebug(request, selection, candidates, eligible, explorationTopic, timings, filteredBy)
        : null,
    };
  }

  /**
   * Retrieval is scoped to the interest set plus the exploration topic. With no
   * interest set — a user who has not onboarded — the scope is the whole
   * taxonomy, which is what makes the shared-link entry point work.
   */
  private topicScope(request: RankRequest, explorationTopic: string | null): string[] | null {
    if (request.restrictToTopics) return request.restrictToTopics;
    const interests = request.user.interestSet.map((entry) => entry.topic);
    if (interests.length === 0) return null;
    const scope = new Set(interests);
    if (explorationTopic) scope.add(explorationTopic);
    return [...scope].filter((topic) => L1_IDS.includes(topic));
  }

  /**
   * The exploration card is the single highest-quality, highest-engagement
   * product in the topic, not a vector-similar one. The point is to present the
   * topic at its best — a mediocre example of an unfamiliar category teaches
   * the user that exploration cards are noise.
   */
  private async explorationCard(
    topic: string,
    user: User,
    now: Date,
    exclude: ReadonlySet<string> = new Set(),
  ): Promise<VectorCandidate | null> {
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
      {
        limit: 120,
        orderBy: [{ column: 'quality.score', ascending: false }, { column: 'engagement.ctrSmoothed', ascending: false }],
      },
    );

    for (const doc of docs) {
      if (exclude.has(doc.id)) continue;
      if (bloomHas(seen, doc.id)) continue;
      if (doc.auction && doc.auction.endsAt.getTime() <= now.getTime()) continue;
      return { ...(doc as unknown as VectorCandidate), vectorScore: 0.5 };
    }
    return null;
  }

  private buildDebug(
    request: RankRequest,
    selection: ReturnType<typeof selectPage>,
    retrieved: readonly VectorCandidate[],
    eligible: readonly VectorCandidate[],
    explorationTopic: string | null,
    timings: Record<string, number>,
    filteredBy: Record<string, number>,
  ): RankingDebugResponse {
    const selectedIds = new Set(selection.selected.map((c) => c.id));
    const candidates: RankingDebugCandidate[] = eligible.slice(0, 200).map((candidate) => {
      const key = candidate.id;
      const breakdown = selection.breakdowns.get(key);
      return {
        productId: key,
        title: candidate.title,
        category: candidate.category,
        sim: breakdown?.sim ?? candidate.vectorScore,
        quality: breakdown?.quality ?? candidate.quality.score,
        ctr: breakdown?.ctr ?? 0,
        freshness: breakdown?.freshness ?? 0,
        affinity: breakdown?.affinity ?? 0,
        penalty: breakdown?.penalty ?? 0,
        score: breakdown?.score ?? 0,
        mmrScore: breakdown?.mmrScore ?? null,
        selected: selectedIds.has(key),
        selectionReason: breakdown?.reason ?? 'not_selected',
      };
    });

    return {
      userId: request.user.id,
      mode: request.mode,
      rankingConfigVersion: this.config.version,
      stages: {
        retrieved: retrieved.length,
        afterFilters: eligible.length,
        filteredBy,
        scored: eligible.length,
        selected: selection.selected.length,
      },
      explorationTopic,
      candidates,
      timingsMs: timings,
    };
  }
}
