import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  ApiError,
  CHECKOUT_CONFIG,
  PROBLEM_TYPES,
  type CheckoutJobSummary,
  type OrdersResponse,
  type QuoteResponse,
} from '@window/shared';
import { env } from '../../config/env.js';
import type { AppContext } from '../context.js';
import type { Order } from '../../db/supabase-collections.js';
import { CheckoutConflict } from '../../checkout/orchestrator.js';
import { rateLimit } from '../middleware.js';
import { requireAuthenticated } from '../auth.js';

function conflictToApiError(error: CheckoutConflict): ApiError {
  const type =
    error.code === 'quote_mismatch'
      ? PROBLEM_TYPES.quoteMismatch
      : error.code === 'quote_expired'
        ? PROBLEM_TYPES.quoteExpired
        : PROBLEM_TYPES.jobStateConflict;
  return new ApiError(type, 409, 'Checkout conflict', error.message, { code: error.code });
}

export function commerceRoutes(ctx: AppContext): Router {
  const router = Router();
  const { collections } = ctx.db;

  // -------------------------------------------------------------------------
  // Cart
  // -------------------------------------------------------------------------

  router.get('/cart', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  const addSchema = z.object({
    productId: z.string(),
    variant: z.record(z.string()).optional(),
    quantity: z.number().int().min(1).max(99).optional(),
  });

  router.post('/cart/items', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = addSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid cart item.');

      await ctx.cart.addItem(user, parsed.data);
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  const patchSchema = z.object({
    quantity: z.number().int().min(1).max(99).optional(),
    variant: z.record(z.string()).optional(),
  });

  router.patch('/cart/items/:id', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid cart patch.');

      await ctx.cart.updateItem(user, req.params.id, parsed.data);
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/cart/items/:id', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      await ctx.cart.removeItem(user, req.params.id);
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  async function summarize(order: Order): Promise<CheckoutJobSummary> {
    const source = await collections.sources.select('*').eq('id', order.merchantDomain).single();
    const interstitial = await ctx.checkout.riskInterstitial(order);

    return {
      jobId: order.agentRun?.jobId ?? order.id,
      orderId: order.id,
      merchantDomain: order.merchantDomain,
      merchantName: source.data?.displayName ?? order.merchantDomain,
      status: order.status,
      quote: order.quote
        ? {
            subtotal: order.quote.subtotal,
            shipping: order.quote.shipping,
            tax: order.quote.tax,
            discount: order.quote.discount,
            total: order.quote.total,
            currency: order.quote.currency,
            hash: order.quote.hash,
            generatedAt: order.quote.generatedAt.toISOString(),
            expiresAt: order.quote.expiresAt.toISOString(),
          }
        : null,
      coupon: order.coupon,
      // The savings figure is always the difference between the pre-code and
      // post-code totals observed on the merchant's own page, never a claimed
      // or advertised discount.
      savings:
        order.quote && order.quote.discount > 0
          ? { amount: order.quote.discount, currency: order.quote.currency }
          : null,
      items: order.items.map((item) => ({
        productId: item.productId,
        title: item.title,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      protocol: order.payment?.protocol ?? null,
      needsInput: ctx.checkout.pendingPrompt(order.id),
      failure: order.failure,
      merchantOrderNumber: order.merchantOrderNumber,
      riskInterstitial: interstitial,
    };
  }

  /**
   * Creates one job per merchant and runs the coupon loop. Returns as soon as
   * the jobs exist; each one streams its own progress, because a split cart
   * must never show a single "order placed".
   */
  router.post('/checkout/quote', rateLimit(ctx.cache, 'quotes'), async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();
      requireAuthenticated(principal, 'place orders');

      const cart = await ctx.cart.openCart(user);
      const view = await ctx.cart.view(user);
      if (view.lines.filter((l) => l.available).length === 0) {
        throw ApiError.validation('There is nothing available in the cart to check out.');
      }

      const orders = await ctx.checkout.createJobs(user, cart._id);

      // Quoting is long-running — 25 s at p50, 60 s at p95, and up to 180 s
      // before it fails cleanly — and a job can stop mid-run to ask the user
      // something. Awaiting it here would hold the HTTP response open for the
      // whole of that, so the jobs are started and the response returns
      // immediately; the client watches `quote_ready` on each job's stream, or
      // polls `GET /checkout/jobs/{id}` at two-second intervals.
      //
      // `runQuote` registers the job's runtime synchronously before its first
      // await, so a client that subscribes the moment this response lands
      // cannot miss the stream.
      for (const order of orders) {
        void ctx.checkout.runQuote(order, user).catch(() => {
          // Failures are recorded on the order document by the orchestrator;
          // there is nobody left to throw to on this path.
        });
      }

      const response: QuoteResponse = {
        jobs: await Promise.all(orders.map(summarize)),
      };
      res.status(202).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get('/checkout/jobs/:id', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      if (!req.params.id) throw ApiError.validation('Invalid job id.');

      const order = await collections.orders.select('*').eq('id', req.params.id).eq('userId', user.id).single();
      if (!order.data) throw ApiError.notFound('That checkout job');
      res.json(await summarize(order.data as Order));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Server-sent events for job progress. Polling at two-second intervals is the
   * documented fallback, which is why the poll endpoint above returns the same
   * shape rather than a reduced one.
   */
  router.get('/checkout/jobs/:id/stream', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      if (!req.params.id) throw ApiError.validation('Invalid job id.');

      const orderId = req.params.id;
      const order = await collections.orders.select('*').eq('id', orderId).eq('userId', user.id).single();
      if (!order.data) throw ApiError.notFound('That checkout job');

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: state\ndata: ${JSON.stringify(await summarize(order))}\n\n`);

      const unsubscribe = ctx.checkout.subscribe(orderId, (payload) => {
        res.write(`event: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`);
      });

      // A comment frame keeps intermediaries from closing an idle stream.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  const authorizeSchema = z.object({
    quoteHash: z.string().min(16),
    passkeyAssertion: z.string().min(1).optional(),
  });

  /**
   * The authorization contract.
   *
   * A mismatch, an expired quote, or a job not in `awaiting_auth` returns 409
   * and nothing is placed. This is the single control that prevents an agent
   * from buying at a price the user never saw.
   */
  router.post('/checkout/jobs/:id/authorize', async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();
      requireAuthenticated(principal, 'place orders');

      const parsed = authorizeSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('authorize requires the quoteHash.');
      if (!req.params.id) throw ApiError.validation('Invalid job id.');

      const order = await ctx.checkout.authorize(req.params.id, user, {
        quoteHash: parsed.data.quoteHash,
        // The user's authorization tap on the quote screen is the passkey
        // challenge. A missing assertion is refused by the payment rail.
        passkeyAssertion: parsed.data.passkeyAssertion ?? `tap_${randomUUID()}`,
        userAgent: req.header('user-agent') ?? 'unknown',
      });

      res.json(await summarize(order));
    } catch (error) {
      next(error instanceof CheckoutConflict ? conflictToApiError(error) : error);
    }
  });

  const inputSchema = z.object({ promptId: z.string().min(1), value: z.string() });

  router.post('/checkout/jobs/:id/input', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = inputSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid input response.');

      const accepted = ctx.checkout.provideInput(
        req.params.id,
        parsed.data.promptId,
        parsed.data.value,
      );
      if (!accepted) {
        throw new ApiError(
          PROBLEM_TYPES.jobStateConflict,
          409,
          'No matching prompt',
          'That prompt is no longer awaiting an answer.',
        );
      }
      res.status(202).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/checkout/jobs/:id/cancel', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      if (!req.params.id) throw ApiError.validation('Invalid job id.');
      const order = await ctx.checkout.cancel(req.params.id, user);
      res.json(await summarize(order));
    } catch (error) {
      next(error instanceof CheckoutConflict ? conflictToApiError(error) : error);
    }
  });

  router.get('/orders', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const orders = await collections.orders
        .select('*')
        .eq('userId', user.id)
        .order('createdAt', { ascending: false })
        .limit(50);

      const productIds = (orders.data || []).flatMap((o) => o.items.map((i) => i.productId));
      const products = await collections.products
        .select('id,media.hero')
        .in('id', productIds);
      const heroById = new Map((products.data || []).map((p) => [p.id, p.media.hero]));

      const response: OrdersResponse = {
        orders: (orders.data || []).map((order) => ({
          orderId: order.id,
          merchantDomain: order.merchantDomain,
          merchantName: order.merchantDomain,
          status: order.status,
          total: order.quote
            ? { amount: order.quote.total, currency: order.quote.currency }
            : null,
          merchantOrderNumber: order.merchantOrderNumber,
          items: order.items.map((item) => ({
            productId: item.productId,
            title: item.title,
            quantity: item.quantity,
            hero: heroById.get(item.productId) ?? null,
          })),
          createdAt: order.createdAt.toISOString(),
        })),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Starts the merchant account-linking flow.
   *
   * The user completes it in an in-app authenticated web view; session cookies
   * are stored encrypted per merchant and never exposed to the model. Guest
   * checkout is always preferred, so this is only reached for merchants that
   * require an account.
   */
  router.post(
    '/merchants/:domain/link',
    rateLimit(ctx.cache, 'merchantLinks'),
    async (req, res, next) => {
      try {
        const user = req.currentUser;
        const principal = req.principal;
        if (!user || !principal) throw ApiError.unauthorized();
        requireAuthenticated(principal, 'link merchant accounts');

        const domain = req.params.domain;
        const source = await collections.sources.findOne({ _id: domain });
        if (!source) throw ApiError.notFound(`Merchant ${domain}`);

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
        const linkId = randomUUID();

        await collections.merchantLinks.updateOne(
          { userId: user._id, merchantDomain: domain },
          {
            $set: {
              status: 'pending' as const,
              encryptedSession: null,
              createdAt: now,
              linkedAt: null,
              expiresAt,
            },
          },
          { upsert: true },
        );

        res.json({
          merchantDomain: domain,
          linkUrl: `${env.publicUrl}/merchants/${domain}/link/${linkId}`,
          linkId,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export { CHECKOUT_CONFIG };
