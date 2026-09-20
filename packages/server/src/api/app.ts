import express, { type Express } from 'express';
import { ApiError, DEFAULT_RANKING_CONFIG, type RankingConfig } from '@window/shared';
import type { AppContext } from './context.js';
import { authenticate, internalOnly, notFound, problemDetails, requestLogging, tracing } from './middleware.js';
import { catalogRoutes } from './routes/catalog.js';
import { commerceRoutes } from './routes/commerce.js';
import { eventRoutes } from './routes/events.js';
import { feedRoutes } from './routes/feed.js';
import { mediaRoutes } from './routes/media.js';
import { authRoutes, profileRoutes } from './routes/profile.js';
import { findOne } from '../db/supabase-helpers.js';

/**
 * The API gateway.
 *
 * REST rather than GraphQL: the feed is a small number of very hot, very
 * cacheable shapes, and the flexibility GraphQL buys is not worth the
 * query-cost management it demands on the critical path.
 */
export function createApp(ctx: AppContext): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // A feed page is budgeted at 60 KB gzipped; nothing legitimate posts a megabyte.
  app.use(express.json({ limit: '256kb' }));
  app.use(tracing());
  app.use(requestLogging());

  app.use((_req, res, next) => {
    // The web client is served from a different origin in development.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-internal-token');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-trace-id,retry-after,x-ratelimit-remaining');
    next();
  });
  app.options(/.*/, (_req, res) => res.status(204).end());

  // ---- Unauthenticated -----------------------------------------------------
  app.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      vectorBackend: ctx.vectors.kind,
      vectors: await ctx.vectors.size(),
      cacheBackend: ctx.cache.kind,
      rankingConfigVersion: ctx.ranking.getConfig().version,
    });
  });

  app.use('/media', mediaRoutes(ctx));
  app.use('/v1/auth', authRoutes(ctx));

  // ---- Authenticated -------------------------------------------------------
  const guarded = express.Router();
  guarded.use(authenticate(ctx.db.collections));
  guarded.use('/feed', feedRoutes(ctx));
  guarded.use('/events', eventRoutes(ctx));
  guarded.use(catalogRoutes(ctx));
  guarded.use(profileRoutes(ctx));
  guarded.use(commerceRoutes(ctx));
  app.use('/v1', guarded);

  // ---- Internal ------------------------------------------------------------
  app.use('/internal', internalRoutes(ctx));

  app.use(notFound());
  app.use(problemDetails());

  return app;
}

/**
 * Internal-only endpoints.
 *
 * The ranking debug endpoint returns per-candidate score components for a given
 * user and page. Without it, ranking regressions are undiagnosable — a feed
 * that "feels worse" is not a bug report, and this is what turns it into one.
 */
function internalRoutes(ctx: AppContext): express.Router {
  const router = express.Router();
  router.use(internalOnly());

  router.post('/ranking/debug', async (req, res, next) => {
    try {
      const { userId, mode = 'single', limit = 20 } = req.body as {
        userId?: string;
        mode?: 'single' | 'window';
        limit?: number;
      };
      if (!userId) {
        throw ApiError.validation('userId must be a valid id.');
      }
      const user = await findOne(ctx.db.collections.users, { id: userId });
      if (!user) throw ApiError.notFound('That user');

      const result = await ctx.ranking.rank({
        user,
        mode,
        limit,
        sessionId: `debug_${Date.now()}`,
        seenIds: [],
        debug: true,
      });
      res.json(result.debug);
    } catch (error) {
      next(error);
    }
  });

  /** Hot-reloads the ranking config without a deploy. */
  router.post('/ranking/config', async (req, res, next) => {
    try {
      const config = req.body as RankingConfig;
      if (!config?.version || !config.weights) {
        throw ApiError.validation('A ranking config needs at least a version and weights.');
      }
      // TODO: Implement config persistence for Supabase
      // For now, just update the in-memory config
      ctx.ranking.setConfig(config);
      res.json({ version: config.version });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ranking/config', (_req, res) => {
    res.json(ctx.ranking.getConfig());
  });

  router.post('/ranking/config/reset', async (_req, res) => {
    ctx.ranking.setConfig(DEFAULT_RANKING_CONFIG);
    res.json({ version: DEFAULT_RANKING_CONFIG.version });
  });

  return router;
}
