import { Router } from 'express';
import { z } from 'zod';
import { ApiError, INTERACTION_TYPES, UPVOTE_REASONS } from '@window/shared';
import type { AppContext } from '../context.js';
import { rateLimit } from '../middleware.js';

const eventSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  type: z.enum(INTERACTION_TYPES),
  productId: z.string(),
  position: z.number().int().min(0),
  mode: z.enum(['single', 'window']),
  clientTs: z.string(),
  dwellMs: z.number().int().min(0).max(3_600_000).optional(),
  reason: z.enum(UPVOTE_REASONS).optional(),
  isExploration: z.boolean().optional(),
  viewportFraction: z.number().min(0).max(1).optional(),
  foreground: z.boolean().optional(),
});

const batchSchema = z.object({
  sessionId: z.string().min(1).max(64),
  events: z.array(eventSchema).min(1).max(200),
});

export function eventRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * Batched interaction events, fire-and-forget.
   *
   * Events batch client-side and flush every five seconds, on backgrounding,
   * and immediately for anything at or above weight 0.45 so the next page
   * reflects it. The response is a 202 because the client must never wait on
   * telemetry: this endpoint is not allowed to be the reason a scroll stutters.
   */
  router.post('/', rateLimit(ctx.cache, 'events'), async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.validation('Invalid event batch.', {
          issues: parsed.error.issues.slice(0, 5).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      const result = await ctx.events.collect(user, parsed.data.sessionId, parsed.data.events);
      res.status(202).json({
        accepted: result.accepted,
        rejected: result.rejected,
        invalidatedBuffer: result.invalidatedBuffer,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
