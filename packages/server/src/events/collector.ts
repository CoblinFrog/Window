import { ObjectId } from 'mongodb';
import {
  DWELL_THRESHOLDS,
  SIGNAL_QUALITY_RULES,
  SIGNAL_WEIGHTS,
  STRONG_SIGNAL_THRESHOLD,
  type ClientEvent,
  type EventsResponse,
  type InteractionType,
  type RankingConfig,
} from '@window/shared';
import type { CollectionSet, Interaction, User } from '../db/collections.js';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import { bloomAdd, deserializeBloom, serializeBloom } from '../lib/bloom.js';
import { logger } from '../lib/logger.js';
import {
  adoptTopic,
  applyAdoptionEvidence,
  demoteStaleTopics,
} from '../ranking/exploration.js';
import { applyInteraction, updatePricePrior } from '../ranking/user-vector.js';

const log = logger.child('events');

/**
 * The event collector.
 *
 * Write-heavy, append-only, and never on the critical path: if it is down,
 * events drop and the feed serves unchanged. That is a deliberate trade — a
 * ranking signal lost is a small regression, while a feed that stalls because
 * telemetry is slow is the product failing.
 */

export interface CollectorDeps {
  collections: CollectionSet;
  cache: KeyValueCache;
  config: RankingConfig;
}

export interface CollectResult extends EventsResponse {
  /** Topics that graduated into the interest set while processing this batch. */
  graduatedTopics: string[];
}

export class EventCollector {
  constructor(private readonly deps: CollectorDeps) {}

  /**
   * Two rules protect signal quality, and they are enforced here rather than on
   * the client: a dwell only counts when the app is foregrounded and the card
   * occupies at least 60% of the viewport, and a negative skip is suppressed
   * for the first three cards of a session, because those are scrolled past
   * reflexively while the user settles in.
   */
  private rejectionReason(event: ClientEvent): string | null {
    if (!(event.type in SIGNAL_WEIGHTS)) return 'unknown_event_type';
    if (!ObjectId.isValid(event.productId)) return 'invalid_product_id';

    const isDwell =
      event.type === 'dwell_short' || event.type === 'dwell_long' || event.type === 'skip_fast';

    if (isDwell) {
      if (SIGNAL_QUALITY_RULES.requireForeground && event.foreground === false) {
        return 'backgrounded';
      }
      if (
        event.viewportFraction !== undefined &&
        event.viewportFraction < SIGNAL_QUALITY_RULES.minViewportFraction
      ) {
        return 'below_viewport_threshold';
      }
    }

    if (
      event.type === 'skip_fast' &&
      event.position < SIGNAL_QUALITY_RULES.suppressSkipForFirstNCards
    ) {
      return 'settling_in';
    }

    return null;
  }

  /**
   * Classifies a raw dwell duration. The client reports milliseconds; the
   * boundaries live here so retuning them does not require an app release.
   */
  static classifyDwell(dwellMs: number): InteractionType | null {
    if (dwellMs < DWELL_THRESHOLDS.skipFastMaxMs) return 'skip_fast';
    if (dwellMs >= DWELL_THRESHOLDS.longMinMs) return 'dwell_long';
    if (dwellMs >= DWELL_THRESHOLDS.shortMinMs && dwellMs < DWELL_THRESHOLDS.shortMaxMs) {
      return 'dwell_short';
    }
    // Between 4 s and 8 s is deliberately unclassified: it is neither a skip
    // nor evidence of interest, and inventing a bucket for it would add noise.
    return null;
  }

  async collect(
    user: User,
    sessionId: string,
    events: readonly ClientEvent[],
    now = new Date(),
  ): Promise<CollectResult> {
    const { collections } = this.deps;
    const rejected: EventsResponse['rejected'] = [];
    const accepted: ClientEvent[] = [];

    for (const event of events) {
      const reason = this.rejectionReason(event);
      if (reason) rejected.push({ idempotencyKey: event.idempotencyKey, reason });
      else accepted.push(event);
    }

    if (accepted.length === 0) {
      return { accepted: 0, rejected, invalidatedBuffer: false, graduatedTopics: [] };
    }

    const productIds = [...new Set(accepted.map((e) => new ObjectId(e.productId)))];
    const products = await collections.products.find({ _id: { $in: productIds } }).toArray();
    const productById = new Map(products.map((p) => [p._id.toHexString(), p]));

    // ---- Persist ----------------------------------------------------------
    const documents: Interaction[] = [];
    for (const event of accepted) {
      const product = productById.get(event.productId);
      if (!product) {
        rejected.push({ idempotencyKey: event.idempotencyKey, reason: 'unknown_product' });
        continue;
      }
      documents.push({
        _id: new ObjectId(),
        userId: user._id,
        productId: product._id,
        clusterId: product.clusterId,
        sessionId,
        type: event.type,
        // The weight is resolved from config at write time so a later config
        // change cannot retroactively rewrite what a past event meant.
        weight: SIGNAL_WEIGHTS[event.type],
        mode: event.mode,
        position: event.position,
        dwellMs: event.dwellMs ?? null,
        isExploration: event.isExploration ?? false,
        category: product.category,
        reason: event.reason ?? null,
        rankingConfigVersion: this.deps.config.version,
        experiments: {},
        idempotencyKey: event.idempotencyKey,
        clientTs: new Date(event.clientTs),
        serverTs: now,
      });
    }

    if (documents.length > 0) {
      try {
        // Unordered so one duplicate key does not discard the rest of the batch.
        await collections.interactions.insertMany(documents, { ordered: false });
      } catch (error) {
        // Duplicate idempotency keys are the expected failure here: the client
        // retried a batch it had already delivered. Everything novel still landed.
        const code = (error as { code?: number }).code;
        if (code !== 11000) throw error;
      }
    }

    // ---- Update the user model -------------------------------------------
    let interestVector = user.interestVector;
    let interestSet = user.interestSet;
    let affinities = user.affinities;
    let pricePrior = user.pricePrior;
    let explorationState = user.explorationState;
    const graduatedTopics: string[] = [];
    let strongSignal = false;
    let cardsRendered = 0;

    const seen = deserializeBloom(user.seenFilter);

    for (const event of accepted) {
      const product = productById.get(event.productId);
      if (!product) continue;

      const weight = SIGNAL_WEIGHTS[event.type];
      if (Math.abs(weight) >= STRONG_SIGNAL_THRESHOLD) strongSignal = true;

      if (event.type === 'impression') {
        // The seen-set is fed by impressions only: a product the user scrolled
        // past has been seen, but one that merely sat in the prefetch buffer
        // has not, and re-showing it is correct.
        bloomAdd(seen, event.productId);
        cardsRendered += 1;
      }

      const update = applyInteraction(
        { interestVector, interestSet, affinities, pricePrior },
        {
          type: event.type,
          productVector: product.embedding,
          categoryL1: product.category.l1,
          brand: product.brand,
          sellerId: product.sellerId.toHexString(),
          isExploration: event.isExploration ?? false,
        },
        this.deps.config,
        now,
      );
      interestVector = update.interestVector;
      interestSet = update.interestSet;
      affinities = update.affinities;
      pricePrior = updatePricePrior(pricePrior, product.price.amount, weight);

      // Exploration cards are the only place topic adoption can start.
      if (event.isExploration) {
        const outcome = applyAdoptionEvidence(
          explorationState,
          {
            topic: product.category.l1,
            sessionId,
            type: event.type,
            dwellMs: event.dwellMs ?? null,
          },
          interestSet,
        );
        explorationState = outcome.explorationState;
        if (outcome.graduated) {
          interestSet = adoptTopic(
            interestSet,
            outcome.graduated.topic,
            outcome.graduated.weight,
            now,
          );
          graduatedTopics.push(outcome.graduated.topic);
          log.info('exploration topic graduated', {
            userId: user._id.toHexString(),
            topic: outcome.graduated.topic,
            weight: outcome.graduated.weight,
          });
        }
      }
    }

    // A graduated topic that never earns a signal is demoted back out.
    const { kept, demoted } = demoteStaleTopics(interestSet);
    interestSet = kept;

    // The exploration counter is deliberately NOT touched here.
    //
    // It is decremented per card rendered, and the feed service already knows
    // exactly how many cards it served and where the slot landed. Decrementing
    // from both sides means whichever write lands second overwrites the other
    // with a value computed from a stale read — and the observable symptom is
    // the counter pinned at zero and an exploration card on every page.
    void cardsRendered;

    await collections.users.updateOne(
      { _id: user._id },
      {
        $set: {
          interestVector,
          interestSet,
          affinities,
          pricePrior,
          explorationState,
          seenFilter: serializeBloom(seen, user.seenFilter.rebuiltAt),
          'counters.lastActiveAt': now,
          updatedAt: now,
        },
        $inc: { 'counters.interactionCount': documents.length },
      },
    );

    if (demoted.length > 0) {
      log.info('exploration topics demoted', { userId: user._id.toHexString(), demoted });
    }

    // The cache is invalidated immediately on any interaction at or above 0.45,
    // so a strong signal changes the very next page.
    if (strongSignal) {
      for (const key of cacheKeys.rankedBufferPrefixes(user._id.toHexString())) {
        await this.deps.cache.del(key);
      }
    }

    return {
      accepted: documents.length,
      rejected,
      invalidatedBuffer: strongSignal,
      graduatedTopics,
    };
  }
}
