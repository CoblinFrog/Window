import { Router } from 'express';
import { z } from 'zod';
import {
  ApiError,
  INTERACTION_TYPES,
  L1_TOPICS,
  ONBOARDING_TOPIC_COUNT,
  UPVOTE_REASONS,
  getCategory,
  imageUri,
  type ClientEvent,
  type MeResponse,
  type OnboardingTopicsResponse,
} from '@window/shared';
import { env } from '../../config/env.js';
import { localEmbeddingProvider } from '../../embedding/local.js';
import type { AppContext } from '../context.js';
import type { Product } from '../../db/supabase-collections.js';
import { bootstrapDevice, rateLimit } from '../middleware.js';
import { mintToken, requireAuthenticated } from '../auth.js';
import { seedInterestSet, seedPricePrior, seedUserVector } from '../../ranking/user-vector.js';
import { find, findOne, updateOne, updateMany, deleteMany, deleteOne, count, insert } from '../../db/supabase-helpers.js';

export function profileRoutes(ctx: AppContext): Router {
  const router = Router();
  const { collections } = ctx.db;

  const onboardingSchema = z.object({
    topics: z
      .array(z.string())
      .length(
        ONBOARDING_TOPIC_COUNT,
        `Exactly ${ONBOARDING_TOPIC_COUNT} topics are required; the picker hard-caps there.`,
      ),
    priceBand: z.enum(['budget', 'mid', 'premium']).nullable().default(null),
  });

  /** The 18 L1 tiles with imagery. */
  /**
   * One real photograph per topic, taken from the catalog.
   *
   * The tile used to be a generated collage: deterministic, identical on every
   * device, and an abstract smear of colour that told nobody what "Home and
   * kitchen" contains. A picker whose job is to ask what someone likes has to
   * show them the thing.
   *
   * The choice is deterministic rather than random — sorted by id and the first
   * one taken — so a topic keeps the same face between requests and reloads.
   * Picking freshly each time would make the grid flicker into a different set
   * of products on every visit, which reads as a bug.
   *
   * A topic the catalog cannot cover keeps the generated tile. That is a real
   * state, not a transitional one: the taxonomy has eighteen L1 topics and a
   * young catalog will not stock all of them, so the grid has to stay complete
   * with holes in it rather than render gaps.
   */
  async function topicImages(): Promise<Map<string, string>> {
    const products = await find<Product>(
      collections.products,
      { status: 'active' },
      { select: 'id,category,media', limit: 2000 },
    );
    products.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const images = new Map<string, string>();
    for (const product of products) {
      const l1 = product.category?.l1;
      if (!l1 || images.has(l1)) continue;
      const uri = product.media?.hero ? imageUri(product.media.hero) : undefined;
      if (uri) images.set(l1, uri);
    }
    return images;
  }

  router.get('/onboarding/topics', async (_req, res, next) => {
    try {
      // `tile.order` is a JSONB property, not a SQL column. Fetch the L1
      // rows normally and sort the JSON metadata in application code; this
      // also works when the category table has not been seeded yet.
      const docs = await find(collections.categories, { level: 1 });
      docs.sort((a, b) => (a.tile?.order ?? 0) - (b.tile?.order ?? 0));

      const photos = await topicImages();
      // A seeded `tile.image` points at the generated collage, so the catalog
      // photograph is preferred over it rather than the other way round.
      const tileFor = (slug: string, seeded?: string | undefined): string =>
        photos.get(slug) ?? seeded ?? `${env.publicUrl}/media/topic/${slug}`;

      const topics = docs.map((doc) => ({
        id: doc.slug,
        displayName: doc.displayName,
        image: tileFor(doc.slug, doc.tile?.image),
        order: doc.tile?.order ?? 0,
      }));

      // The taxonomy is authoritative in code, so an unseeded database still
      // renders a usable picker rather than an empty grid.
      const fallback = L1_TOPICS.map((node, index) => ({
        id: node.id,
        displayName: node.displayName,
        image: tileFor(node.id),
        order: node.tileOrder ?? index,
      }));

      const response: OnboardingTopicsResponse = {
        topics: topics.length === L1_TOPICS.length ? topics : fallback,
        requiredSelections: ONBOARDING_TOPIC_COUNT,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Seeds the user vector from the three chosen L1 centroids.
   *
   * Forcing exactly three, rather than "three or more", keeps the seed vector
   * sharp — the average of seven centroids is close to the catalog mean, which
   * is the one thing a cold-start vector must not be.
   */
  router.post('/onboarding/complete', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const parsed = onboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.validation(parsed.error.issues[0]?.message ?? 'Invalid onboarding request.');
      }
      const { topics, priceBand } = parsed.data;

      const unknown = topics.filter((topic) => getCategory(topic)?.level !== 1);
      if (unknown.length > 0) {
        throw ApiError.validation(`Unknown L1 topics: ${unknown.join(', ')}`);
      }
      if (new Set(topics).size !== topics.length) {
        throw ApiError.validation('Topics must be distinct.');
      }

      const categories = await find(collections.categories, { slug: { $in: topics }, level: 1 });
      const embedder = localEmbeddingProvider();
      // A fresh development database may not have products or computed
      // centroids yet. Keep onboarding usable by using the deterministic local
      // name embedding for only the missing topics; populated databases still
      // use their data-derived centroids.
      const centroids = await Promise.all(
        topics.map(async (topic) => {
          const stored = categories.find((category) => category.slug === topic)?.centroid;
          if (Array.isArray(stored) && stored.length > 0) return stored;
          return embedder.embedText(getCategory(topic)?.displayName ?? topic);
        }),
      );

      const now = new Date();
      const interestVector = seedUserVector(centroids);
      const interestSet = seedInterestSet(topics, now);
      const pricePrior = seedPricePrior(priceBand, user.settings.currency);

      // The exploration counter starts at a random integer in [10, 20] so that
      // first sessions do not all surface an exploration card at the same index.
      const counter = ctx.feed.explorationCounterFor({
        ...user,
        explorationState: { ...user.explorationState, counter: 0 },
      });

      await updateOne(
        collections.users,
        { id: user.id },
        {
          onboarding: { topics, priceBand, completedAt: now },
          interestVector,
          interestSet,
          pricePrior,
          explorationState: { ...user.explorationState, counter },
          updatedAt: now,
        },
      );

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();

      const response: MeResponse = {
        id: user.id,
        deviceUserId: user.deviceUserId,
        isAnonymous: principal.isAnonymous,
        email: user.auth?.email ?? null,
        onboarding: user.onboarding
          ? {
              topics: user.onboarding.topics,
              priceBand: user.onboarding.priceBand,
              completedAt: user.onboarding.completedAt.toISOString(),
            }
          : null,
        interestSet: user.interestSet.map((entry) => ({
          topic: entry.topic,
          displayName: getCategory(entry.topic)?.displayName ?? entry.topic,
          weight: Math.round(entry.weight * 100) / 100,
          source: entry.source,
          addedAt: entry.addedAt.toISOString(),
        })),
        pricePrior: user.pricePrior,
        settings: user.settings,
        counters: {
          interactionCount: user.counters.interactionCount,
          sessionCount: user.counters.sessionCount,
        },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  const settingsSchema = z.object({
    reducedMotion: z.boolean().optional(),
    autoplayVideo: z.boolean().optional(),
    dataSaver: z.boolean().optional(),
    region: z.string().length(2).optional(),
    currency: z.string().length(3).optional(),
  });

  router.patch('/me/settings', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid settings patch.');

      const settingsPatch = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(settingsPatch).length === 0) throw ApiError.validation('No settings supplied.');

      await updateOne(
        collections.users,
        { id: user.id },
        { settings: { ...user.settings, ...settingsPatch }, updatedAt: new Date() },
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const suppressionSchema = z.object({
    kind: z.enum(['product', 'brand', 'seller']),
    value: z.string().min(1),
    productId: z.string().optional(),
  });

  /**
   * Hide product, hide brand, mute seller.
   *
   * Each writes both a suppression and a strongly negative ranking signal: the
   * user is telling us two things at once — never show me this again, and I
   * dislike things like it.
   */
  router.post('/me/suppressions', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = suppressionSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid suppression request.');
      const { kind, value, productId } = parsed.data;

      // Get current user to check existing suppressions
      const currentUser = await findOne(collections.users, { id: user.id });
      if (!currentUser) throw ApiError.notFound('User not found');

      let newSuppressions = { ...currentUser.suppressions };
      
      if (kind === 'brand') {
        newSuppressions.brands = [...new Set([...newSuppressions.brands, value])];
      } else if (kind === 'seller') {
        newSuppressions.sellers = [...new Set([...newSuppressions.sellers, value])];
      } else {
        newSuppressions.products = [...new Set([...newSuppressions.products, value])];
      }

      await updateOne(
        collections.users,
        { id: user.id },
        { suppressions: newSuppressions, updatedAt: new Date() },
      );

      const signalProductId = productId ?? (kind === 'product' ? value : null);
      if (signalProductId) {
        const type =
          kind === 'brand' ? 'hide_brand' : kind === 'seller' ? 'mute_seller' : 'hide_product';
        const event: ClientEvent = {
          idempotencyKey: `suppress_${kind}_${value}_${Date.now()}`,
          type,
          productId: signalProductId,
          position: 0,
          mode: 'single',
          clientTs: new Date().toISOString(),
        };
        await ctx.events.collect(user, `suppression_${Date.now()}`, [event]);
      }

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const claimSchema = z.object({
    provider: z.enum(['email', 'apple', 'google']),
    email: z.string().email().optional(),
    token: z.string().min(1),
  });

  /**
   * Attaches an anonymous profile to an identity.
   *
   * The device identity is kept, not replaced, so a visitor who browsed
   * anonymously for a week keeps the interest model they built — losing it at
   * sign-in is the fastest way to make an account feel like a downgrade.
   */
  router.post('/me/claim', async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();

      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid claim request.');
      const { provider, email } = parsed.data;

      if (provider === 'email' && !email) {
        throw ApiError.validation('An email address is required for an email claim.');
      }

      // The provider token is not verified here. A real deployment validates it
      // against Apple/Google/the email-link service before this point; leaving
      // that as an obvious hole rather than a fake check is deliberate.
      if (process.env.AUTH_PROVIDER_VERIFICATION !== 'disabled' && provider !== 'email') {
        throw ApiError.validation(
          `OAuth claims need provider token verification, which is not configured. ` +
            `Set AUTH_PROVIDER_VERIFICATION=disabled to accept unverified tokens in development.`,
        );
      }

      const now = new Date();
      await updateOne(
        collections.users,
        { id: user.id },
        {
          auth: {
            email: email ?? null,
            providers: [provider],
            claimedAt: now,
          },
          updatedAt: now,
        },
      );

      res.json({
        token: mintToken({ ...principal, isAnonymous: false }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Account deletion, required by both app stores.
   *
   * Removes the user document, interactions, cart and merchant links. The
   * 30-day window in the privacy commitment covers backups and the analytics
   * warehouse; the operational stores are cleared synchronously here.
   */
  router.delete('/me', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      await Promise.all([
        deleteMany(collections.interactions, { userId: user.id }),
        deleteMany(collections.carts, { userId: user.id }),
        deleteMany(collections.merchantLinks, { userId: user.id }),
        deleteMany(collections.reports, { userId: user.id }),
      ]);
      // Orders are retained: they are transaction records with their own legal
      // retention, so they are unlinked from the identity rather than deleted.
      await updateMany(
        collections.orders,
        { userId: user.id },
        { userId: '00000000-0000-0000-0000-000000000000' },
      );
      await deleteOne(collections.users, { id: user.id });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const reportSchema = z.object({
    productId: z.string(),
    reason: z.enum([
      'counterfeit',
      'not_as_described',
      'seller_unresponsive',
      'price_manipulation',
      'stolen_photos',
    ]),
    note: z.string().max(500).optional(),
  });

  /**
   * The report control in the card menu.
   *
   * Three independent reports auto-promote a listing to the High tier pending
   * review, and two upheld reports against a seller suppress every listing they
   * have. Automated suppression with no appeal path removes honest sellers and
   * nobody notices, which is why the High tier goes to a human queue rather
   * than straight to deletion.
   */
  router.post('/reports', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid report.');

      const productId = parsed.data.productId;
      const product = await findOne(collections.products, { id: productId });
      if (!product) throw ApiError.notFound('That product');

      // Check if report already exists
      const existingReport = await findOne(collections.reports, { productId, userId: user.id });
      
      if (existingReport) {
        // Update existing report
        await updateOne(
          collections.reports,
          { productId, userId: user.id },
          {
            sellerId: product.sellerId,
            reason: parsed.data.reason,
            note: parsed.data.note ?? null,
            status: 'open' as const,
            createdAt: new Date(),
            resolvedAt: null,
          },
        );
      } else {
        // Insert new report
        await insert(collections.reports, {
          productId,
          userId: user.id,
          sellerId: product.sellerId,
          reason: parsed.data.reason,
          note: parsed.data.note ?? null,
          status: 'open' as const,
          createdAt: new Date(),
          resolvedAt: null,
        });
      }

      const reportCount = await count(collections.reports, { productId, status: 'open' });
      
      // Update product risk reports count
      const updatedProduct = { ...product, risk: { ...product.risk, reports: { count: reportCount, upheld: product.risk.reports.upheld } } };
      await updateOne(
        collections.products,
        { id: productId },
        { risk: updatedProduct.risk },
      );

      if (reportCount >= 3 && product.risk.tier !== 'high' && product.risk.tier !== 'blocked') {
        await updateOne(
          collections.products,
          { id: productId },
          { risk: { ...updatedProduct.risk, tier: 'high', score: Math.max(product.risk.score, 0.75) } },
        );
      }

      res.status(202).json({ reports: reportCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** Device bootstrap. Mints the anonymous principal the whole app runs on. */
export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const schema = z.object({ deviceUserId: z.string().min(8).max(128) });

  router.post('/device', rateLimit(ctx.cache, 'events'), async (req, res, next) => {
    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.validation('deviceUserId must be between 8 and 128 characters.');
      }
      const { user, principal } = await bootstrapDevice(
        ctx.db.collections,
        parsed.data.deviceUserId,
      );
      res.json({
        token: mintToken(principal),
        userId: user.id,
        isAnonymous: principal.isAnonymous,
        onboarded: user.onboarding !== null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export { INTERACTION_TYPES, UPVOTE_REASONS, requireAuthenticated };
