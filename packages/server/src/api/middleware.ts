import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, RATE_LIMITS } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import type { CollectionSet, User } from '../db/supabase-collections.js';
import { resolveDeviceUser, verifyToken, type Principal } from './auth.js';
import { findOne } from '../db/supabase-helpers.js';

const log = logger.child('api');

declare module 'express-serve-static-core' {
  interface Request {
    traceId: string;
    principal?: Principal;
    currentUser?: User;
  }
}

/**
 * Distributed tracing, with the trace id returned in every response header.
 * Without it, a slow feed page is a mystery spread across five services.
 */
export function tracing() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('traceparent') ?? req.header('x-trace-id');
    req.traceId = incoming ?? randomUUID();
    res.setHeader('x-trace-id', req.traceId);
    next();
  };
}

export function requestLogging() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        traceId: req.traceId,
      };
      // The feed page has a 400 ms p95 budget; anything over it is worth a
      // warning on its own, before any alert threshold is reached.
      if (req.path === '/v1/feed/page' && durationMs > 400) {
        log.warn('feed page over budget', fields);
      } else {
        log.debug('request', fields);
      }
    });
    next();
  };
}

export function authenticate(collections: CollectionSet) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.header('authorization');
      // `EventSource` cannot set headers, so the SSE stream — and only the SSE
      // stream — also accepts the token as a query parameter. It is scoped to
      // that one path deliberately: a token in a URL lands in access logs and
      // referrers, which is an acceptable trade for one long-lived GET and not
      // for anything else.
      const isStream = req.path.endsWith('/stream');
      const queryToken = isStream ? req.query.access_token : undefined;

      const raw = header?.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : typeof queryToken === 'string'
          ? queryToken
          : null;

      if (!raw) {
        throw ApiError.unauthorized('Expected "Authorization: Bearer <token>".');
      }
      const principal = verifyToken(raw);
      const user = await findOne(collections.users, { id: principal.userId });
      if (!user) {
        // The token is well-formed but its user is gone: an account deleted
        // while a client still holds a token. Treated as unauthenticated rather
        // than as an error, so the client mints a fresh device identity.
        throw ApiError.unauthorized('This identity no longer exists.');
      }
      req.principal = principal;
      req.currentUser = user as User;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Anonymous device identities are created on demand by the bootstrap route. */
export async function bootstrapDevice(
  collections: CollectionSet,
  deviceUserId: string,
): Promise<{ user: User; principal: Principal }> {
  const user = await resolveDeviceUser(collections, deviceUserId);
  return {
    user,
    principal: {
      userId: user.id,
      deviceUserId,
      isAnonymous: user.auth === null,
    },
  };
}

export type RateLimitBucket = 'feed' | 'events' | 'quotes' | 'merchantLinks';

const BUCKETS: Record<RateLimitBucket, { limit: number; windowMs: number }> = {
  feed: { limit: RATE_LIMITS.feedPagesPerMinute, windowMs: 60_000 },
  events: { limit: RATE_LIMITS.eventBatchesPerMinute, windowMs: 60_000 },
  quotes: { limit: RATE_LIMITS.checkoutQuotesPerHour, windowMs: 3_600_000 },
  merchantLinks: { limit: RATE_LIMITS.merchantLinksPerDay, windowMs: 86_400_000 },
};

/**
 * Per-principal rate limits. A 429 carries `Retry-After`, and the client backs
 * off and serves from its local buffer rather than showing an error — the feed
 * never surfaces a network problem, it just stops advancing.
 */
export function rateLimit(cache: KeyValueCache, bucket: RateLimitBucket) {
  const { limit, windowMs } = BUCKETS[bucket];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = req.principal?.userId ?? req.ip ?? 'anonymous';
      const key = cacheKeys.rateLimit(principal, bucket);
      const { count, resetAt } = await cache.incr(key, windowMs);

      res.setHeader('x-ratelimit-limit', String(limit));
      res.setHeader('x-ratelimit-remaining', String(Math.max(0, limit - count)));
      res.setHeader('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));

      if (count > limit) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        res.setHeader('retry-after', String(retryAfter));
        throw ApiError.rateLimited(retryAfter);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Guards the internal-only ranking debug endpoint. */
export function internalOnly() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.header('x-internal-token') !== env.internalToken) {
      next(ApiError.forbidden('This endpoint is internal only.'));
      return;
    }
    next();
  };
}

/** Errors follow RFC 9457 problem details with a stable `type` URI. */
export function problemDetails() {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ApiError) {
      const problem = error.toProblem(req.traceId, req.originalUrl);
      if (error.status === 429 && typeof error.extra.retryAfter === 'number') {
        res.setHeader('retry-after', String(error.extra.retryAfter));
      }
      res.status(error.status).type('application/problem+json').json(problem);
      return;
    }

    log.error('unhandled error', {
      traceId: req.traceId,
      path: req.path,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    const fallback = ApiError.internal();
    res
      .status(500)
      .type('application/problem+json')
      .json(fallback.toProblem(req.traceId, req.originalUrl));
  };
}

export function notFound() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(ApiError.notFound(`${req.method} ${req.path}`));
  };
}
