import { Router } from 'express';
import { L1_TOPICS, hashString } from '@window/shared';
import { encodeBlurhash } from '../../media/blurhash.js';
import { renderProductImage } from '../../media/generator.js';
import { encodePng } from '../../media/png.js';
import type { AppContext } from '../context.js';

/**
 * The media origin.
 *
 * Source images are never hotlinked: every URL a client sees belongs to us, is
 * served with immutable far-future cache headers, and is backed by object
 * storage behind a CDN. In this environment the derivatives are generated on
 * first request and materialised to disk, which is the same shape as a CDN
 * origin with a cold cache.
 */
export function mediaRoutes(ctx: AppContext): Router {
  const router = Router();

  // Registered before the generic `/:key/:width` route below: Express
  // matches in declaration order, and `/media/topic/tech` would otherwise
  // bind `width` to "tech" and 404 before ever reaching this handler.
  /**
   * Onboarding tiles. Each L1 topic gets a deterministic photo-collage stand-in
   * so the picker renders identically on every device and every run.
   */
  router.get('/topic/:id', async (req, res, next) => {
    try {
      const topic = L1_TOPICS.find((node) => node.id === req.params.id);
      if (!topic) {
        res.status(404).end();
        return;
      }
      const key = hashString(`topic:${topic.id}`).toString(16).padStart(8, '0').repeat(3);
      const image = renderProductImage(key, 512, 512);
      res.setHeader('cache-control', 'public, max-age=86400');
      res.setHeader('content-type', 'image/png');
      res.setHeader('x-blurhash', encodeBlurhash(
        renderProductImage(key, 32, 32).pixels,
        32,
        32,
        4,
        3,
      ));
      res.send(encodePng(image));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:key/:width', async (req, res, next) => {
    try {
      const width = Number.parseInt(req.params.width, 10);
      const resolved = await ctx.media.resolve(req.params.key, width);
      if (!resolved) {
        res.status(404).end();
        return;
      }
      // Derivatives are content-addressed by key, so they can never change
      // under a URL and are safe to cache for a year.
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.setHeader('content-type', resolved.contentType);
      res.send(resolved.body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
