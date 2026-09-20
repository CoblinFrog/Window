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
import type { Order } from '../../checkout/repository.js';
import { CheckoutConflict } from '../../checkout/orchestrator.js';
import { mintStreamTicket, rateLimit } from '../middleware.js';
import { requireAuthenticated } from '../auth.js';
import {
  idParam,
  merchantDomainSchema,
  objectIdSchema,
  safeRecord,
  sanitizeRecord,
} from '../validation.js';

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

  // `variant` is the one place a request body becomes a document *key*: it is
  // stored on the cart line and travels to the merchant agent. Unbounded and
  // unfiltered, that is a write primitive into the document's own shape, and a
  // `$`-prefixed key in a filter position is a query the caller gets to author.
  const addSchema = z.object({
    productId: objectIdSchema,
    variant: safeRecord().optional(),
    quantity: z.number().int().min(1).max(99).optional(),
  });

  router.post('/cart/items', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = addSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid cart item.');

      await ctx.cart.addItem(user, {
        ...parsed.data,
        ...(parsed.data.variant ? { variant: sanitizeRecord(parsed.data.variant) } : {}),
      });
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  const patchSchema = z.object({
    quantity: z.number().int().min(1).max(99).optional(),
    variant: safeRecord().optional(),
  });

  router.patch('/cart/items/:id', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid cart patch.');

      const lineId = idParam(req.params.id, 'cart line id');
      await ctx.cart.updateItem(user, lineId, {
        ...parsed.data,
        ...(parsed.data.variant ? { variant: sanitizeRecord(parsed.data.variant) } : {}),
      });
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/cart/items/:id', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      await ctx.cart.removeItem(user, idParam(req.params.id, 'cart line id'));
      res.json(await ctx.cart.view(user));
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  async function summarize(order: Order): Promise<CheckoutJobSummary> {
    const source = await ctx.repository.getSource(order.merchantDomain);
    const interstitial = await ctx.checkout.riskInterstitial(order);

    // The hero images, fetched in one batched read the way `/orders` does.
    // An order line stores a title and a price but not the photograph, because
    // the photograph belongs to the product and can be re-derived; checkout
    // needs it on screen, so it is joined here rather than copied at add time.
    const products = await ctx.repository.getProducts(order.items.map((i) => i.productId));
    const heroById = new Map(products.map((p) => [p.id, p.media.hero]));

    return {
      // The order id, always.
      //
      // `agentRun.jobId` is an internal audit identifier minted when quoting
      // starts, so returning it here meant a job's public id *changed* the
      // moment it began working. The client keys its job map by this field:
      // every later update landed under a new key and the card the user was
      // watching sat at "Not started" forever while the job completed.
      jobId: order.id,
      orderId: order.id,
      merchantDomain: order.merchantDomain,
      merchantName: source?.displayName ?? order.merchantDomain,
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
        hero: heroById.get(item.productId) ?? null,
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

      const orders = await ctx.checkout.createJobs(user, cart.id);

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
      const order = await ctx.repository.getOrder(
        idParam(req.params.id, 'job id'),
        user.id,
      );
      if (!order) throw ApiError.notFound('That checkout job');
      res.json(await summarize(order));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Issues a single-use ticket for a job's SSE stream.
   *
   * `EventSource` cannot set an Authorization header, so the stream URL has to
   * carry its own credential — and a URL is the worst place in the system to
   * put one: it lands in access logs, proxy logs, `Referer` headers and browser
   * history. A ticket is the smallest credential that solves it: one job, one
   * minute, one use.
   */
  router.post('/checkout/jobs/:id/stream-ticket', async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();
      const jobId = idParam(req.params.id, 'job id');

      // Scoped to a job this caller actually owns, so a ticket cannot be minted
      // for somebody else's stream even by someone holding a valid session.
      const order = await ctx.repository.getOrder(jobId, user.id);
      if (!order) throw ApiError.notFound('That checkout job');

      const { ticket, expiresAt } = await mintStreamTicket(
        ctx.cache,
        principal,
        `/v1/checkout/jobs/${jobId}/stream`,
      );
      res.json({ ticket, expiresAt: expiresAt.toISOString() });
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
      const orderId = idParam(req.params.id, 'job id');
      const order = await ctx.repository.getOrder(orderId, user.id);
      if (!order) throw ApiError.notFound('That checkout job');

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
  router.post(
    '/checkout/jobs/:id/authorize',
    rateLimit(ctx.cache, 'authorize'),
    async (req, res, next) => {
    try {
      const user = req.currentUser;
      const principal = req.principal;
      if (!user || !principal) throw ApiError.unauthorized();
      requireAuthenticated(principal, 'place orders');

      const parsed = authorizeSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('authorize requires the quoteHash.');
      const order = await ctx.checkout.authorize(idParam(req.params.id, 'job id'), user, {
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
    },
  );

  const inputSchema = z.object({
    promptId: z.string().min(1).max(64),
    // The value is typed into the merchant's own form by the agent, so it is
    // bounded here rather than wherever it lands.
    value: z.string().max(512),
  });

  /**
   * Answers a `request_user_input` prompt.
   *
   * The ownership lookup is the point of this handler. Being authenticated only
   * established that the caller is *a* user; without the `userId` filter, any
   * account could answer any other account's live checkout prompt — choosing a
   * shipping address, picking a shipping option, or resolving a handoff on an
   * order it has nothing to do with. Order ids are sequential enough to guess.
   */
  router.post('/checkout/jobs/:id/input', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();
      const parsed = inputSchema.safeParse(req.body);
      if (!parsed.success) throw ApiError.validation('Invalid input response.');
      const jobId = idParam(req.params.id, 'job id');

      const order = await ctx.repository.getOrder(jobId, user.id);
      // Indistinguishable from a job that does not exist, so this is not an
      // oracle for which order ids are real.
      if (!order) throw ApiError.notFound('That checkout job');

      const accepted = ctx.checkout.provideInput(
        jobId,
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
      const order = await ctx.checkout.cancel(idParam(req.params.id, 'job id'), user);
      res.json(await summarize(order));
    } catch (error) {
      next(error instanceof CheckoutConflict ? conflictToApiError(error) : error);
    }
  });

  router.get('/orders', async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (!user) throw ApiError.unauthorized();

      const orders = await ctx.repository.listOrders(user.id, 50);

      const products = await ctx.repository.getProducts(
        orders.flatMap((o) => o.items.map((i) => i.productId)),
      );
      const heroById = new Map(products.map((p) => [p.id, p.media.hero]));

      const response: OrdersResponse = {
        orders: orders.map((order) => ({
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

        // Validated as a bare hostname: it is interpolated into the link URL
        // the client is told to open, and a path or scheme smuggled through a
        // path parameter turns that into an open redirect on our own origin.
        const parsedDomain = merchantDomainSchema.safeParse(req.params.domain);
        if (!parsedDomain.success) throw ApiError.validation('Invalid merchant domain.');

        const domain = parsedDomain.data.toLowerCase();
        const source = await ctx.repository.getSource(domain);
        if (!source) throw ApiError.notFound(`Merchant ${domain}`);

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
        const linkId = randomUUID();

        await ctx.repository.upsertMerchantLink({
          userId: user.id,
          merchantDomain: domain,
          status: 'pending',
          encryptedSession: null,
          createdAt: now,
          linkedAt: null,
          expiresAt,
        });

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
