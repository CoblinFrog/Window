import { Router } from 'express';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  ApiError,
  BUFFER_CONFIG,
  bucketFor,
  type FeedPageResponse,
  type FeedSessionResponse,
} from '@window/shared';
import type { AppContext } from '../context.js';
import { bloomAdd, deserializeBloom, serializeBloom } from '../../lib/bloom.js';
import { discardBuffer } from '../../feed/service.js';
import { rateLimit } from '../middleware.js';

const pageSchema = z.object({
  mode: z.enum(['single', 'window']),
  limit: z.number().int().min(1).max(40).default(20),
  cursor: z.number().int().min(0).default(0),
  sessionId: z.string().min(1).max(64),
  seenIds: z.array(z.string()).max(BUFFER_CONFIG.seenIdsInRequest).default([]),
  context: z
    .object({
      region: z.string().default('US'),
      currency: z.string().default('USD'),
      connection: z.enum(['wifi', 'cellular', 'offline', 'unknown']).default('unknown'),
      dataSaver: z.boolean().optional(),
    })
    .default({ region: 'US', currency: 'USD', connection: 'unknown' }),
});

export function feedRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * The hot path. Everything about this handler is shaped by a 400 ms p95
   * budget: one ranking call, one projection, and the seen-set write deferred
   * until after the response has been handed to the client.
   */
  router.post('/page', rateLimit(ctx.cache, 'feed'), async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const parsed = pageSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.validation('Invalid feed page request.', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const result = await ctx.feed.page(user, parsed.data);

      const response: FeedPageResponse = {
        items: result.items,
        quads: result.quads,
        explorationIndexes: result.explorationIndexes,
        rankingConfigVersion: result.rankingConfigVersion,
        nextCursorHint: result.nextCursorHint,
        ttlMs: result.ttlMs,
        degraded: result.degraded,
      };
      res.json(response);

      // The seen-set is updated after the response is sent. A served card is
      // not yet an impression — the client reports those — but the server must
      // not hand the same product to the very next page request either.
      void recordServed(ctx, user._id, result.servedProductIds);
    } catch (error) {
      next(error);
    }
  });

  /** Discards the server-side buffer and re-ranks from scratch. */
  router.post('/refresh', rateLimit(ctx.cache, 'feed'), async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      await discardBuffer(ctx.cache, user._id.toHexString());
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  /** Session bootstrap: config, flags, exploration counter. */
  router.get('/session', async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();

      const sessionId = `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const counter = ctx.feed.explorationCounterFor(user);

      await ctx.db.collections.users.updateOne(
        { _id: user._id },
        {
          $set: { 'explorationState.counter': counter, 'counters.lastActiveAt': new Date() },
          $inc: { 'counters.sessionCount': 1 },
        },
      );

      const response: FeedSessionResponse = {
        sessionId,
        user: {
          id: user._id.toHexString(),
          isAnonymous: principal.isAnonymous,
          onboarded: user.onboarding !== null,
          interactionCount: user.counters.interactionCount,
          settings: user.settings,
        },
        explorationCounter: counter,
        rankingConfigVersion: ctx.ranking.getConfig().version,
        // Deterministic bucketing on user id, so any metric can be sliced by
        // arm without instrumenting each change separately.
        experiments: {
          feedComposition: bucketFor(user._id.toHexString(), 'feedComposition', ['A', 'B']),
          explorationInterval: bucketFor(user._id.toHexString(), 'explorationInterval', [
            'fixed',
            'adaptive',
          ]),
        },
        flags: {
          windowMode: true,
          agenticCheckout: true,
          reviewsSheet: true,
        },
        buffer: {
          size: BUFFER_CONFIG.size,
          behind: BUFFER_CONFIG.behind,
          ahead: BUFFER_CONFIG.ahead,
          refillThreshold: BUFFER_CONFIG.refillThreshold,
          pageSize: BUFFER_CONFIG.pageSize,
        },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Records served products into the user's Bloom filter.
 *
 * Deliberately fire-and-forget: the event collector is never on the critical
 * path, and neither is this. A lost write costs one repeated card.
 */
async function recordServed(
  ctx: AppContext,
  userId: ObjectId,
  productIds: readonly string[],
): Promise<void> {
  if (productIds.length === 0) return;
  try {
    const user = await ctx.db.collections.users.findOne(
      { _id: userId },
      { projection: { seenFilter: 1 } },
    );
    if (!user) return;
    const bloom = deserializeBloom(user.seenFilter);
    for (const id of productIds) bloomAdd(bloom, id);
    await ctx.db.collections.users.updateOne(
      { _id: userId },
      { $set: { seenFilter: serializeBloom(bloom, user.seenFilter.rebuiltAt) } },
    );
  } catch {
    // Intentionally swallowed. See the comment above.
  }
}
