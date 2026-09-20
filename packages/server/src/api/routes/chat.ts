import { Router } from 'express';
import { z } from 'zod';
import { ApiError, type ChatResponse } from '@window/shared';
import type { AppContext } from '../context.js';
import { chat, type ChatPick } from '../../agent/shop-chat.js';
import { rateLimit } from '../middleware.js';

/**
 * The shopping assistant, over HTTP.
 *
 * One turn per request and no server-side session state: the client carries
 * the transcript and hands it back, so a follow-up resolves without anything
 * being stored here. The answer lands in a few seconds, which is why there is
 * no streaming — it would buy nothing the client would use.
 *
 * Note what is not passed in: the catalog. The assistant reads Amazon and eBay
 * and nothing else. `ctx.vectors` scores on a different scale from a storefront
 * card, so blending the two let catalog rows outrank every live search hit —
 * see the header of `shop-chat.ts`.
 */

const askSchema = z.object({
  // Long enough for a real request, short enough that the prompt stays a
  // prompt. Anything past this is not a shopping ask.
  message: z.string().min(1).max(400),
  sessionId: z.string().min(1).max(64),
  // The transcript is the client's, so it is bounded here rather than trusted:
  // an unbounded history is an unbounded prompt, billed per turn.
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2_000) }))
    .max(20)
    .default([]),
  standing: z
    .object({
      item: z.string().min(1).max(200),
      budgetMinor: z.number().int().positive().max(100_000_000).nullable(),
      requirements: z.array(z.string().max(80)).max(12),
    })
    .nullish(),
});

/** Picks without a price can't be rendered as cards, so they never ship. */
function toResponsePick(pick: ChatPick): ChatResponse['picks'][number] | null {
  if (pick.url === null || pick.price === null) return null;
  return {
    productId: pick.productId,
    title: pick.title,
    priceMinor: pick.price,
    currency: pick.currency ?? 'USD',
    url: pick.url,
    imageUrl: pick.imageUrl,
    sourceDomain: pick.sourceDomain,
    rating: pick.rating,
    reviewCount: pick.reviewCount,
    reviewNote: pick.reviewNote,
    sources: pick.sources,
  };
}

export function chatRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', rateLimit(ctx.cache, 'chat'), async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const parsed = askSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.validation('Invalid ask request.', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const reply = await chat(
        parsed.data.message,
        // A user who has not finished onboarding has no interest vector yet.
        // The agent treats an empty preference vector as "steer by the request
        // alone", which is the right behaviour rather than an error.
        {
          preferences: user.interestVector ?? [],
          history: parsed.data.history,
          standing: parsed.data.standing ?? null,
        },
        {
          llm: ctx.llm,
          embedder: ctx.embedder,
          // The request's own deadline governs: a shopper who navigated away
          // should not leave two storefront fetches running behind them.
          storefront: { signal: AbortSignal.timeout(20_000) },
          ...(ctx.askSearch !== undefined ? { search: ctx.askSearch } : {}),
        },
      );

      const response: ChatResponse = {
        kind: reply.kind,
        message: reply.message,
        picks: reply.picks
          .map(toResponsePick)
          .filter((pick): pick is ChatResponse['picks'][number] => pick !== null),
        budgetMinor: reply.budgetMinor,
        requirements: reply.requirements,
        standing: reply.standing,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
