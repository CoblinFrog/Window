import { Router } from 'express';
import { z } from 'zod';
import {
  ApiError,
  INTERACTION_TYPES,
  L1_TOPICS,
  ONBOARDING_TOPIC_COUNT,
  UPVOTE_REASONS,
  getCategory,
  type ClientEvent,
  type MeResponse,
  type OnboardingTopicsResponse,
} from '@window/shared';
import { env } from '../../config/env.js';
import type { AppContext } from '../context.js';
import { rateLimit } from '../middleware.js';
import {
  createDeviceUser,
  isAnonymousUser,
  mintToken,
  requireAuthenticated,
  resumeDeviceUser,
  revokeSessions,
} from '../auth.js';
import { issueEmailChallenge, normalizeEmail, verifyEmailChallenge } from '../claims.js';
import { objectIdSchema, opaqueSecretSchema } from '../validation.js';
import {
  count as countRows,
  deleteMany,
  deleteOne,
  find,
  findOne,
  insert,
  updateMany,
  updateOne,
} from '../../db/supabase-helpers.js';
import type { Category, Product, ReportDoc, User } from '../../db/supabase-collections.js';
import { seedInterestSet, seedPricePrior, seedUserVector } from '../../ranking/user-vector.js';

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
  router.get('/onboarding/topics', async (_req, res, next) => {
    try {
      const docs = await find<Category>(
        collections.categories,
        { level: 1 },
        { orderBy: { column: 'tile.order', ascending: true } },
      );

      const topics = (docs.length > 0 ? docs : []).map((doc) => ({
        id: doc.id,
        displayName: doc.displayName,
        image: doc.tile?.image ?? `${env.publicUrl}/media/topic/${doc.id}`,
        order: doc.tile?.order ?? 0,
      }));

      // The taxonomy is authoritative in code, so an unseeded database still
      // renders a usable picker rather than an empty grid.
      const fallback = L1_TOPICS.map((node, index) => ({
        id: node.id,
        displayName: node.displayName,
        image: `${env.publicUrl}/media/topic/${node.id}`,
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

      const categories = await find<Category>(collections.categories, {
        id: { in: topics },
        level: 1,
      });
      const centroids = categories
        .map((c) => c.centroid)
        .filter((c): c is number[] => Array.isArray(c) && c.length > 0);

      if (centroids.length === 0) {
        throw ApiError.internal(
          'Category centroids have not been computed. Run the seeder or the nightly centroid job.',
        );
      }

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

      await updateOne<User>(collections.users, { id: user.id }, {
        onboarding: { topics, priceBand, completedAt: now },
        interestVector,
        interestSet,
        pricePrior,
        explorationState: { ...user.explorationState, counter },
        updatedAt: now,
      } as Partial<User>);

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

      if (Object.keys(parsed.data).length === 0) {
        throw ApiError.validation('No settings supplied.');
      }

      await updateOne<User>(collections.users, { id: user.id }, {
        settings: { ...user.settings, ...parsed.data },
        updatedAt: new Date(),
      } as Partial<User>);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const suppressionSchema = z.object({
    kind: z.enum(['product', 'brand', 'seller']),
    value: z.string().min(1).max(128),
    productId: objectIdSchema.optional(),
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

      // Validated before use, not after. Under Mongo this prevented a BSONError
      // rendered as a 500; under Postgres a malformed uuid is a 22P02 with the
      // same effect — a bad request reported as a server fault.
      if (kind !== 'brand' && !objectIdSchema.safeParse(value).success) {
        throw ApiError.validation(`${kind} suppressions require a valid id.`);
      }

      // Get current user to check existing suppressions
      const currentUser = await findOne<User>(collections.users, { id: user.id });
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
    email: z.string().email().max(254).optional(),
    /** The emailed code for `email`, or the provider ID token for the rest. */
    token: z.string().min(1).max(4096),
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
      const { provider, email, token } = parsed.data;

      // Every branch below ends in a *verified* address or an exception. This
      // is the only route that raises a principal's privilege — it is what lets
      // an identity spend money — so there is no path through it that takes the
      // caller's word for who they are.
      let verifiedEmail: string;

      if (provider === 'email') {
        if (!email) throw ApiError.validation('An email address is required for an email claim.');

        const result = await verifyEmailChallenge(
          ctx.cache,
          user.id,
          email,
          token,
        );
        if (!result.ok) {
          throw result.reason === 'too_many_attempts'
            ? ApiError.validation('Too many incorrect codes. Request a new one.')
            : ApiError.validation('That code is not valid. Request a new one if it has expired.');
        }
        verifiedEmail = result.email;
      } else {
        // Refuses until a JWKS verifier is configured. See `claims.ts`: a
        // verification step that pretends to work is worse than an absent one.
        const identity = await ctx.oidc.verify(provider, token);
        if (!identity.emailVerified || !identity.email) {
          throw ApiError.validation('That provider account has no verified email address.');
        }
        verifiedEmail = normalizeEmail(identity.email);
      }

      const now = new Date();

      // One account per address. Without this, claiming an address that already
      // belongs to someone else silently produces two accounts answering to one
      // identity — and a merge request nobody can safely honour. The unique
      // index on `auth.email` is the actual enforcement; this is the message.
      const taken = await findOne<User>(collections.users, { 'auth->>email': verifiedEmail });
      if (taken && taken.id !== user.id) {
        throw ApiError.validation(
          'That address is already attached to another Window account. Sign in on that account instead.',
        );
      }

      try {
        await updateOne<User>(collections.users, { id: user.id }, {
          auth: {
            email: verifiedEmail,
            providers: [provider],
            claimedAt: now,
            emailVerifiedAt: now,
          },
          updatedAt: now,
        } as Partial<User>);
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          throw ApiError.validation('That address is already attached to another Window account.');
        }
        throw error;
      }

      // The session is regenerated at the privilege change. A token minted
      // before the claim described an anonymous principal; leaving it valid
      // means the old, lower-trust credential still opens the higher-trust
      // account for the rest of its lifetime.
      const epoch = await revokeSessions(collections, user.id);

      res.json({
        token: mintToken({ ...principal, isAnonymous: false, epoch }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Sign out everywhere.
   *
   * Bumping the session epoch invalidates every token already issued for this
   * identity. Without it, "sign out" only clears local storage and a token
   * copied off the device stays valid for its full lifetime — a button that
   * describes an intention rather than an effect.
   */
  router.post('/me/sessions/revoke', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      await revokeSessions(collections, user.id);
      res.status(204).end();
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
    productId: objectIdSchema,
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
      const product = await findOne<Product>(collections.products, { id: productId });
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

      const count = await countRows(collections.reports, { productId, status: 'open' });
      
      // Update product risk reports count
      const updatedProduct = { ...product, risk: { ...product.risk, reports: { count, upheld: product.risk.reports.upheld } } };
      await updateOne(
        collections.products,
        { id: productId },
        { risk: updatedProduct.risk },
      );

      if (count >= 3 && product.risk.tier !== 'high' && product.risk.tier !== 'blocked') {
        await updateOne(
          collections.products,
          { id: productId },
          { risk: { ...updatedProduct.risk, tier: 'high', score: Math.max(product.risk.score, 0.75) } },
        );
      }

      res.status(202).json({ reports: count });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Device bootstrap. Mints the anonymous principal the whole app runs on.
 *
 * The rule that makes this safe: a presented secret may only ever *resume* an
 * identity, never claim one. Previously the client chose its own
 * `deviceUserId`, the server adopted whatever it was handed, and the client
 * minted it with `Math.random()` — so a device identifier that nobody treated
 * as a credential was in fact the only credential, and a guessable one. Now the
 * server mints 256 bits from the CSPRNG, stores only the hash, and a secret it
 * does not recognise gets a brand-new empty profile rather than someone else's.
 */
export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const schema = z.object({ deviceSecret: opaqueSecretSchema.optional() });

  router.post('/device', rateLimit(ctx.cache, 'bootstrap'), async (req, res, next) => {
    try {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw ApiError.validation('deviceSecret must be a base64url secret issued by this API.');
      }

      const existing = parsed.data.deviceSecret
        ? await resumeDeviceUser(ctx.db.collections, parsed.data.deviceSecret)
        : null;

      // A miss is not an error. An unrecognised secret means a new device, a
      // deleted account, or somebody guessing — and all three get the same
      // answer, which is why guessing reveals nothing.
      const minted = existing ? null : await createDeviceUser(ctx.db.collections);
      const user = existing ?? minted!.user;

      const principal = {
        userId: user.id,
        deviceUserId: user.deviceUserId,
        isAnonymous: isAnonymousUser(user),
        epoch: user.sessionEpoch ?? 1,
      };

      res.json({
        token: mintToken(principal),
        // Returned exactly once, at mint time. The client stores it in secure
        // storage and presents it to resume; the server keeps only its hash.
        ...(minted ? { deviceSecret: minted.deviceSecret } : {}),
        deviceUserId: user.deviceUserId,
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
