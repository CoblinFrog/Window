import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, RATE_LIMITS, SESSION_CONFIG } from '@window/shared';
import { env } from '../config/env.js';
import { secretsMatch } from '../config/secrets.js';
import { logger } from '../lib/logger.js';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import type { CollectionSet, User } from '../db/supabase-collections.js';
import { findOne } from '../db/supabase-helpers.js';
import { isAnonymousUser, verifyToken, type Principal } from './auth.js';
import { hasPollutedKey, opaqueSecretSchema } from './validation.js';

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
    // An inbound trace id is echoed into every response header and every log
    // line, so it is constrained rather than trusted: a header that can carry
    // newlines into a log is how a log becomes unreadable as evidence.
    req.traceId =
      incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-trace-id', req.traceId);
    next();
  };
}

/**
 * Baseline response headers.
 *
 * None of these defend the API against a determined attacker; they defend the
 * *browser* against the API. Each one closes a class of attack that needs the
 * user's own browser as the confused deputy.
 */
export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Never let a browser guess a content type. The media origin serves bytes
    // fetched from third parties; a sniffed `text/html` there is stored XSS on
    // our own origin, with our own cookies and our own CORS posture.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // The API and the media origin have no legitimate use for any of these.
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');

    // Media is a public, content-addressed CDN origin and the client is served
    // from a different origin — `localhost:8081` against `127.0.0.1:4000` in
    // development, an app origin against a CDN in production. `same-site` there
    // blocks every product image with ERR_BLOCKED_BY_RESPONSE.NotSameSite and
    // the feed renders as black cards. Everything else stays locked down:
    // nothing under /v1 is a subresource another origin has cause to embed.
    res.setHeader(
      'cross-origin-resource-policy',
      req.path.startsWith('/media/') ? 'cross-origin' : 'same-site',
    );
    // A JSON API that renders nothing still benefits: if a response is ever
    // coerced into an HTML context, there is nothing it is permitted to load.
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
    );

    // HSTS is only meaningful, and only safe, once the connection is already
    // secure. Asserting it over plaintext teaches a browser nothing and pins a
    // development host to a scheme it does not serve.
    if (req.secure || req.header('x-forwarded-proto') === 'https') {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/**
 * CORS against an explicit allowlist.
 *
 * `Access-Control-Allow-Origin: *` was survivable here only because auth is a
 * bearer header rather than a cookie — one missing design decision away from
 * being every origin's API. An allowlist costs one environment variable and
 * removes the dependency on that accident.
 */
export function cors(allowed: readonly string[]) {
  const allowAll = allowed.includes('*');

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');

    if (origin && (allowAll || allowed.includes(origin))) {
      res.setHeader('access-control-allow-origin', origin);
      // The response varies by Origin, so a cache must not serve one origin's
      // response to another.
      res.setHeader('vary', 'Origin');
    } else if (!origin && allowAll) {
      res.setHeader('access-control-allow-origin', '*');
    }

    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-internal-token,idempotency-key');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-trace-id,retry-after,x-ratelimit-remaining');
    res.setHeader('access-control-max-age', '600');
    next();
  };
}

/** Refuses a body carrying a prototype-poisoning key before any handler sees it. */
export function rejectPollutedBodies() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.body && hasPollutedKey(req.body)) {
      next(ApiError.validation('Request body contains a reserved property name.'));
      return;
    }
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
        // `req.path` only; never the query string, which is where the one
        // credential-bearing parameter in the whole API lives.
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

/**
 * Resolves the caller.
 *
 * Three things are settled here and nowhere else: the token is genuine and
 * unexpired, the session generation it was minted under is still current, and
 * the privilege level comes from the user document rather than from the token's
 * own claim about itself. The last is the important one — `isAnonymous` decides
 * whether money may move, and the holder of a token is the last party who
 * should get to assert it.
 */
export function authenticate(collections: CollectionSet, cache: KeyValueCache) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.header('authorization');
      const raw = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

      // `EventSource` cannot set headers, so the SSE stream — and only the SSE
      // stream — also accepts a ticket as a query parameter. A ticket is not the
      // session token: it is single-use, expires in a minute, and is scoped to
      // one job, so the copy of it that lands in an access log is worthless.
      const ticket = req.path.endsWith('/stream') ? req.query.ticket : undefined;

      const principal = raw
        ? await principalFromToken(collections, raw)
        : typeof ticket === 'string'
          ? await principalFromTicket(collections, cache, ticket, requestPath(req))
          : null;

      if (!principal) {
        throw ApiError.unauthorized('Expected "Authorization: Bearer <token>".');
      }

      req.principal = principal.principal;
      req.currentUser = principal.user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function principalFromToken(
  collections: CollectionSet,
  raw: string,
): Promise<{ principal: Principal; user: User }> {
  const claims = verifyToken(raw);
  const user = await findOne<User>(collections.users, { id: claims.userId });
  if (!user) {
    // The token is well-formed but its user is gone: an account deleted while a
    // client still holds a token. Treated as unauthenticated rather than as an
    // error, so the client mints a fresh device identity.
    throw ApiError.unauthorized('This identity no longer exists.');
  }
  if ((user.sessionEpoch ?? 1) !== claims.epoch) {
    throw ApiError.unauthorized('This session was revoked; re-authenticate.');
  }

  return {
    user,
    principal: {
      userId: user.id,
      deviceUserId: user.deviceUserId,
      // From the document, never from the token.
      isAnonymous: isAnonymousUser(user),
      epoch: user.sessionEpoch ?? 1,
    },
  };
}

/**
 * The request path as the client asked for it.
 *
 * This middleware runs inside a router mounted at `/v1`, so `req.path` has the
 * mount point stripped — it is `/checkout/...` where the client asked for
 * `/v1/checkout/...`. A ticket is bound to the path it was minted for, and
 * minting happens in a route handler that knows the full path, so comparing
 * against the stripped one rejects every ticket that was ever issued.
 */
function requestPath(req: Request): string {
  return (req.originalUrl ?? req.url).split('?')[0] ?? '';
}

export interface StreamTicket {
  userId: string;
  /** The one path this ticket may be spent on. */
  path: string;
  epoch: number;
}

/**
 * Mints a single-use ticket for one SSE path.
 *
 * The client asks for this over an authenticated POST and puts it in the
 * EventSource URL. It is burned on redemption, so a ticket recovered from a
 * proxy log, a `Referer` or a screenshot has already been spent.
 */
export async function mintStreamTicket(
  cache: KeyValueCache,
  principal: Principal,
  path: string,
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const value: StreamTicket = {
    userId: principal.userId,
    path,
    epoch: principal.epoch,
  };
  await cache.set(cacheKeys.streamTicket(ticket), value, SESSION_CONFIG.streamTicketTtlMs);
  return { ticket, expiresAt: new Date(Date.now() + SESSION_CONFIG.streamTicketTtlMs) };
}

async function principalFromTicket(
  collections: CollectionSet,
  cache: KeyValueCache,
  ticket: string,
  path: string,
): Promise<{ principal: Principal; user: User }> {
  if (!opaqueSecretSchema.safeParse(ticket).success) {
    throw ApiError.unauthorized('Malformed stream ticket.');
  }

  const key = cacheKeys.streamTicket(ticket);
  const stored = await cache.get<StreamTicket>(key);
  // Burned on read, whether or not it turns out to be valid for this path.
  await cache.del(key);

  if (!stored) throw ApiError.unauthorized('This stream ticket has expired or was already used.');
  if (stored.path !== path) throw ApiError.unauthorized('This ticket was issued for another stream.');

  const user = await findOne<User>(collections.users, { id: stored.userId });
  if (!user) throw ApiError.unauthorized('This identity no longer exists.');
  if ((user.sessionEpoch ?? 1) !== stored.epoch) {
    throw ApiError.unauthorized('This session was revoked; re-authenticate.');
  }

  return {
    user,
    principal: {
      userId: user.id,
      deviceUserId: user.deviceUserId,
      isAnonymous: isAnonymousUser(user),
      epoch: user.sessionEpoch ?? 1,
    },
  };
}

export type RateLimitBucket =
  | 'feed'
  | 'events'
  | 'quotes'
  | 'merchantLinks'
  | 'bootstrap'
  | 'claim'
  | 'authorize';

const BUCKETS: Record<RateLimitBucket, { limit: number; windowMs: number }> = {
  feed: { limit: RATE_LIMITS.feedPagesPerMinute, windowMs: 60_000 },
  events: { limit: RATE_LIMITS.eventBatchesPerMinute, windowMs: 60_000 },
  quotes: { limit: RATE_LIMITS.checkoutQuotesPerHour, windowMs: 3_600_000 },
  merchantLinks: { limit: RATE_LIMITS.merchantLinksPerDay, windowMs: 86_400_000 },
  bootstrap: { limit: RATE_LIMITS.deviceBootstrapsPerHour, windowMs: 3_600_000 },
  claim: { limit: RATE_LIMITS.claimAttemptsPerHour, windowMs: 3_600_000 },
  authorize: { limit: RATE_LIMITS.authorizationsPerHour, windowMs: 3_600_000 },
};

/**
 * Per-principal rate limits. A 429 carries `Retry-After`, and the client backs
 * off and serves from its local buffer rather than showing an error — the feed
 * never surfaces a network problem, it just stops advancing.
 *
 * The fallback key is the peer address, which is only meaningful because
 * `trust proxy` is now an explicit hop count. With it set to `true`, any client
 * could write its own `X-Forwarded-For` and mint a fresh limit bucket per
 * request — which is to say, no limit at all on precisely the unauthenticated
 * credential routes that most need one.
 */
export function rateLimit(cache: KeyValueCache, bucket: RateLimitBucket) {
  const { limit, windowMs } = BUCKETS[bucket];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = req.principal?.userId ?? `ip:${req.ip ?? 'unknown'}`;
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

/**
 * Guards the internal-only endpoints.
 *
 * The comparison is timing-safe because the alternative is a byte oracle: `!==`
 * on strings returns at the first differing character, and a few thousand timed
 * requests recover the token one character at a time. The endpoint behind it
 * dumps per-user ranking state for an arbitrary user id and hot-reloads scoring
 * weights, so it is worth the microsecond.
 */
export function internalOnly() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!secretsMatch(req.header('x-internal-token'), env.internalToken)) {
      log.warn('rejected internal request', { path: req.path, traceId: req.traceId });
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

    // The stack stays in the log and never reaches the client: an unhandled
    // error is the one response most likely to describe the inside of the
    // process, and the trace id is enough to find it in the log.
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
