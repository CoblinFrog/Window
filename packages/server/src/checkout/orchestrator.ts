import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CHECKOUT_CONFIG,
  type CheckoutInputPrompt,
  type CheckoutStreamPayload,
  type OrderStatus,
  type Quote,
} from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { User } from '../db/supabase-collections.js';
import type { CheckoutRepository, Order } from './repository.js';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import { checkoutInterstitial } from '../ingestion/risk.js';
import {
  AgentAbort,
  BrowserCheckoutAgent,
  SimulatedMerchantAgent,
  type AgentPrompt,
  type AgentSession,
  type AgentToolCall,
  type CheckoutAgent,
  type CheckoutBrowser,
  type CheckoutLineItem,
  type FieldMap,
} from './agent.js';
import type { VaultHandle } from './vault.js';
import { CouponStore, bestCouponOutcome, stackableSubset } from './coupons.js';
import {
  DEFAULT_SPEND_RULES,
  PaymentRuleViolation,
  createPaymentRail,
  type PaymentRail,
} from './payments.js';

const log = logger.child('checkout');

export interface OrchestratorDeps {
  /**
   * The checkout data boundary. Seven tables, named operations, opaque string
   * ids — so the orchestrator's invariants can be tested in-process against an
   * in-memory store, and run in production against whatever the deployment has.
   */
  repository: CheckoutRepository;
  cache: KeyValueCache;
  coupons?: CouponStore;
  payments?: PaymentRail;
  /**
   * Resolves the agent for a merchant. Protocol-native first, browser second;
   * the simulator is what runs when neither is configured.
   */
  agentFor?: (merchantDomain: string) => Promise<CheckoutAgent>;
  /** The browser fleet, when `CHECKOUT_AGENT=browser`. */
  browser?: CheckoutBrowser | null;
  /** Per-merchant selector maps. No map means hand off rather than guess. */
  fieldMapFor?: (merchantDomain: string) => FieldMap | null;
  /** The user's delivery details, encrypted for the life of the job. */
  vaultFor?: () => VaultHandle | null;
  /** Origin override, so a test can point a merchant at a local fixture. */
  originFor?: (merchantDomain: string) => string;
}

interface PendingPrompt {
  promptId: string;
  prompt: CheckoutInputPrompt;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface JobRuntime {
  orderId: string;
  emitter: EventEmitter;
  abort: AbortController;
  pending: PendingPrompt | null;
  session: AgentSession;
}

/**
 * Hashes the quote the user is shown.
 *
 * `POST /authorize` must echo this back. A mismatch, an expired quote, or a job
 * not in `awaiting_auth` returns 409 and nothing is placed. This is the single
 * control that prevents an agent from buying at a price the user never saw, so
 * the hash covers every number on the screen, not just the total.
 */
export function hashQuote(input: {
  jobId: string;
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  currency: string;
  productIds: string[];
}): string {
  const canonical = [
    input.jobId,
    input.subtotal,
    input.shipping,
    input.tax,
    input.discount,
    input.total,
    input.currency,
    [...input.productIds].sort().join(','),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Reduces a tool call to what an auditor needs and a breach cannot use.
 *
 * Selectors, URLs and the tool name are kept — they are the record of what the
 * agent did. Typed values become a type and a length, so "the agent entered a
 * 14-character value into #phone" survives and the phone number does not.
 */
export function redactToolCall(call: AgentToolCall): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(call.args)) {
    if (key === 'value' || key === 'text' || key === 'password') {
      args[key] = typeof value === 'string' ? `<redacted:${value.length}>` : '<redacted>';
    } else if (typeof value === 'string') {
      args[key] = value.slice(0, 256);
    } else {
      args[key] = value;
    }
  }

  return {
    tool: call.tool,
    args,
    at: call.at,
    // The result can echo page content back, which is merchant-controlled text.
    result: call.result.slice(0, 256),
  };
}

export class CheckoutConflict extends Error {
  constructor(
    readonly code: 'quote_mismatch' | 'quote_expired' | 'bad_state' | 'already_submitted',
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutConflict';
  }
}

/**
 * The checkout orchestrator.
 *
 * One durable job record per merchant per checkout. The lifecycle is
 * deliberately explicit — `quoting`, `awaiting_auth`, `placing`, then a
 * terminal state — because the authorization step sits between two of those
 * transitions and nothing is allowed to cross it implicitly.
 */
export class CheckoutOrchestrator {
  private readonly runtimes = new Map<string, JobRuntime>();
  private readonly coupons: CouponStore;
  private readonly payments: PaymentRail;

  constructor(private readonly deps: OrchestratorDeps) {
    this.coupons = deps.coupons ?? new CouponStore(deps.repository);
    this.payments = deps.payments ?? createPaymentRail();
  }

  // -------------------------------------------------------------------------
  // Job creation
  // -------------------------------------------------------------------------

  /**
   * Decomposes one Window cart into one checkout job per merchant. This is the
   * feature and the reason checkout is delegated to an agent at all: there is
   * no single API to post an order to fifteen different sites.
   */
  async createJobs(user: User, cartId: string, now = new Date()): Promise<Order[]> {
    const { repository } = this.deps;
    const userId = user.id;
    const cart = await repository.getCart(cartId, userId);
    if (!cart) throw new Error('Cart not found.');

    const byMerchant = new Map<string, typeof cart.items>();
    for (const item of cart.items) {
      if (!item.available) continue;
      const list = byMerchant.get(item.merchantDomain) ?? [];
      list.push(item);
      byMerchant.set(item.merchantDomain, list);
    }

    const products = await repository.getProducts(cart.items.map((i) => i.productId));
    const titles = new Map(products.map((p) => [p.id, p.title]));

    const orders: Order[] = [];
    for (const [merchantDomain, items] of byMerchant) {
      const order: Omit<Order, 'id'> = {
        userId,
        cartId,
        merchantDomain,
        items: items.map((item) => ({
          productId: item.productId,
          title: titles.get(item.productId) ?? 'Item',
          quantity: item.quantity,
          unitPrice: item.priceNow.amount,
          variant: item.variant,
        })),
        quote: null,
        coupon: null,
        authorization: null,
        payment: null,
        agentRun: null,
        status: 'pending',
        merchantOrderNumber: null,
        failure: null,
        submissionSeq: 0,
        createdAt: now,
        updatedAt: now,
      };
      orders.push(await repository.createOrder(order));
    }

    await repository.setCartStatus(cartId, 'checking_out', now);

    return orders;
  }

  // -------------------------------------------------------------------------
  // Quoting
  // -------------------------------------------------------------------------

  /**
   * Fills the merchant's cart, runs the coupon loop, and stops at the last
   * screen before money moves. The job does not proceed from here without an
   * explicit user tap against this exact quote.
   */
  async runQuote(order: Order, user: User): Promise<Order> {
    const { repository } = this.deps;
    const jobId = order.agentRun?.jobId ?? `job_${randomUUID().slice(0, 18)}`;
    const runtime = this.runtimeFor(order.id, jobId, order.merchantDomain);

    await repository.updateOrder(order.id, {
      status: 'quoting' as OrderStatus,
      agentRun: {
        jobId,
        startedAt: new Date(),
        endedAt: null,
        toolCallCount: 0,
        screenshots: [],
        transcriptRef: `${jobId}/quote.json`,
      },
      updatedAt: new Date(),
    });
    this.emit(runtime, { event: 'state', state: 'quoting' });

    const timeout = setTimeout(() => runtime.abort.abort(), CHECKOUT_CONFIG.jobTimeoutMs);

    try {
      const source = await repository.getSource(order.merchantDomain);
      // A merchant that blocks agent traffic switches permanently to
      // deep-link-out; running the agent again would just get us blocked harder.
      if (source?.checkout.blocksAgents) {
        throw new AgentAbort(
          'blocked',
          `${order.merchantDomain} blocks agent traffic. Finish this order on the merchant's site.`,
          true,
        );
      }

      const products = await repository.getProducts(order.items.map((i) => i.productId));
      const productById = new Map(products.map((p) => [p.id, p]));

      const items: CheckoutLineItem[] = order.items.map((item) => {
        const product = productById.get(item.productId);
        return {
          productId: item.productId,
          title: item.title,
          url: product?.source.url ?? `https://${order.merchantDomain}`,
          variant: item.variant,
          quantity: item.quantity,
          expectedUnitPrice: item.unitPrice,
          currency: product?.price.currency ?? 'USD',
        };
      });

      const subtotal = items.reduce((s, i) => s + i.expectedUnitPrice * i.quantity, 0);
      const orderCount = await repository.countOrders(user.id, {
        status: 'placed',
      });

      // Coupon discovery runs in parallel with cart building, so it adds no
      // wall-clock time to checkout.
      const couponsPromise = this.coupons.candidatesFor(order.merchantDomain, {
        subtotal,
        categories: products.map((p) => p.category.l1),
        isFirstOrder: orderCount === 0,
      });

      const agent = await this.resolveAgent(order.merchantDomain);
      const coupons = await couponsPromise;

      const quote = await agent.quote({
        session: runtime.session,
        merchantDomain: order.merchantDomain,
        items,
        coupons,
        allowStacking: source?.checkout.stackableCoupons ?? false,
        signal: runtime.abort.signal,
        onStep: (step) => this.emit(runtime, { event: 'step', step }),
        onCouponAttempt: (attempt) =>
          this.emit(runtime, {
            event: 'coupon_attempt',
            couponAttempt: {
              code: attempt.code,
              ok: attempt.applied,
              discount: attempt.observedDiscount,
              ...(attempt.reason ? { reason: attempt.reason } : {}),
            },
          }),
        onPrompt: (prompt) => this.ask(runtime, prompt),
      });

      for (const attempt of quote.couponAttempts) {
        await this.coupons.recordAttempt(order.merchantDomain, attempt.code, {
          applied: attempt.applied,
          observedDiscount: attempt.observedDiscount,
          subtotal: quote.subtotal,
          reason: attempt.reason,
        });
      }

      const best = bestCouponOutcome(quote.couponAttempts, quote.automaticPromotionApplied ? quote.discount : 0);
      void stackableSubset(coupons, source?.checkout.stackableCoupons ?? false);

      // A line that dropped out is removed from the order, and the quote the
      // user authorizes covers only what is actually being bought.
      const remainingItems = order.items.filter(
        (i) => !quote.droppedProductIds.includes(i.productId),
      );

      const generatedAt = new Date();
      const expiresAt = new Date(generatedAt.getTime() + CHECKOUT_CONFIG.quoteTtlMs);
      const hash = hashQuote({
        jobId,
        subtotal: quote.subtotal,
        shipping: quote.shipping,
        tax: quote.tax,
        discount: quote.discount,
        total: quote.total,
        currency: quote.currency,
        productIds: remainingItems.map((i) => i.productId),
      });

      const storedQuote: Quote = {
        subtotal: quote.subtotal,
        shipping: quote.shipping,
        tax: quote.tax,
        discount: quote.discount,
        total: quote.total,
        currency: quote.currency,
        generatedAt,
        expiresAt,
        hash,
      };

      const updated = await repository.updateOrder(order.id, {
        items: remainingItems,
        quote: storedQuote,
        coupon: best.code
          ? { code: best.code, discount: best.discount, attempts: best.attempts }
          : null,
        status: 'awaiting_auth' as OrderStatus,
        agentRun: {
          ...(order.agentRun ?? {
            jobId,
            startedAt: new Date(),
            endedAt: null,
            transcriptRef: `${jobId}/quote.json`,
          }),
          jobId,
          toolCallCount: runtime.session.toolCalls.length,
          screenshots: runtime.session.screenshots,
        },
        updatedAt: generatedAt,
      });

      await this.writeAudit(runtime, order, 'quote');
      this.emit(runtime, { event: 'quote_ready', state: 'awaiting_auth' });

      return updated as Order;
    } catch (error) {
      return this.fail(order, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Authorization and placement
  // -------------------------------------------------------------------------

  /**
   * The authorization step is non-negotiable. The agent may navigate, fill and
   * apply coupons freely, but it stops here and waits for an explicit tap
   * against a quote showing item price, shipping, tax, discount and final total.
   */
  async authorize(
    orderId: string,
    user: User,
    input: { quoteHash: string; passkeyAssertion: string; userAgent: string },
    now = new Date(),
  ): Promise<Order> {
    const { repository } = this.deps;
    const order = await repository.getOrder(orderId, user.id);
    if (!order) throw new CheckoutConflict('bad_state', 'Order not found.');

    if (order.status !== 'awaiting_auth') {
      throw new CheckoutConflict(
        'bad_state',
        `This job is ${order.status}, not awaiting authorization.`,
      );
    }
    if (!order.quote) {
      throw new CheckoutConflict('bad_state', 'This job has no quote to authorize.');
    }
    if (order.quote.hash !== input.quoteHash) {
      throw new CheckoutConflict(
        'quote_mismatch',
        'The authorization does not match the quote that was shown.',
      );
    }
    if (order.quote.expiresAt.getTime() <= now.getTime()) {
      throw new CheckoutConflict('quote_expired', 'This quote has expired and must be re-run.');
    }

    // One authorization equals at most one order per job. The lock is taken
    // before any state changes, so two concurrent taps cannot both proceed.
    const lockKey = cacheKeys.checkoutJobLock(orderId);
    const locked = await this.deps.cache.acquireLock(lockKey, CHECKOUT_CONFIG.jobTimeoutMs);
    if (!locked) {
      throw new CheckoutConflict('already_submitted', 'This job is already being placed.');
    }

    try {
      const ordersToday = await repository.countOrders(user.id, {
        status: 'placed',
        since: new Date(now.getTime() - 86_400_000),
      });

      const source = await repository.getSource(order.merchantDomain);
      const intent = await this.payments.createIntent({
        userId: user.id,
        jobId: order.agentRun?.jobId ?? orderId,
        merchantDomain: order.merchantDomain,
        merchantCategory: source?.sourceType ?? 'new',
        authorizedAmount: order.quote.total,
        currency: order.quote.currency,
        quoteHash: order.quote.hash,
        passkeyAssertion: input.passkeyAssertion,
        ordersToday,
        rules: DEFAULT_SPEND_RULES,
      });

      // The submission counter is incremented under the same guard that
      // authorised the job. If it is already non-zero, something placed this
      // order before us and we must not place it again.
      // One atomic compare-and-set. Two concurrent taps cannot both win it:
      // the loser gets null and its intent is revoked immediately below.
      const claimed = await repository.claimForSubmission(orderId, {
        status: 'placing' as OrderStatus,
        authorization: {
          authorizedAt: now,
          userAgentHash: createHash('sha256').update(input.userAgent).digest('hex').slice(0, 32),
          quoteHash: input.quoteHash,
        },
        payment: {
          rail: 'reap' as const,
          intentId: intent.intentId,
          tokenRef: intent.tokenRef,
          cap: intent.cap,
          protocol: (source?.checkout.protocol ?? 'browser') as 'acp' | 'mpp' | 'tap' | 'browser',
        },
        updatedAt: now,
      });

      if (!claimed) {
        await this.payments.revoke(intent.intentId);
        throw new CheckoutConflict('already_submitted', 'This job has already been submitted.');
      }

      return await this.place(claimed, intent.intentId, intent.paymentHandle);
    } catch (error) {
      if (error instanceof PaymentRuleViolation) {
        await this.fail(order, error);
      }
      throw error;
    } finally {
      await this.deps.cache.releaseLock(lockKey);
    }
  }

  private async place(order: Order, intentId: string, paymentHandle: string): Promise<Order> {
    const { repository } = this.deps;
    const jobId = order.agentRun?.jobId as string;
    const runtime = this.runtimeFor(order.id, jobId, order.merchantDomain);
    const now = new Date();

    try {
      const agent = await this.resolveAgent(order.merchantDomain);
      const placement = await agent.place({
        session: runtime.session,
        merchantDomain: order.merchantDomain,
        quote: {
          subtotal: order.quote?.subtotal ?? 0,
          shipping: order.quote?.shipping ?? 0,
          tax: order.quote?.tax ?? 0,
          discount: order.quote?.discount ?? 0,
          total: order.quote?.total ?? 0,
          currency: order.quote?.currency ?? 'USD',
          preCouponTotal: order.quote?.total ?? 0,
          couponCode: order.coupon?.code ?? null,
          couponAttempts: [],
          automaticPromotionApplied: false,
          droppedProductIds: [],
          screenshotRef: '',
        },
        paymentHandle,
        signal: runtime.abort.signal,
        onStep: (step) => this.emit(runtime, { event: 'step', step }),
        onPrompt: (prompt) => this.ask(runtime, prompt),
      });

      const capture = await this.payments.capture(intentId, order.quote?.total ?? 0);
      if (!capture.captured && capture.reason === 'above_cap') {
        // The rail refused; the merchant is trying to charge more than the user
        // authorized. This is exactly the case the cap exists for.
        throw new AgentAbort(
          'price_increased',
          'The merchant attempted to charge more than the authorized amount.',
          false,
        );
      }

      // Submitted but no confirmation parsed: the job goes `uncertain` and a
      // verification pass re-checks the merchant's order history before
      // anything is shown as complete. It is never re-submitted.
      const status: OrderStatus = placement.uncertain ? 'uncertain' : 'placed';

      const updated = await repository.updateOrder(order.id, {
        status,
        merchantOrderNumber: placement.merchantOrderNumber,
        agentRun: order.agentRun
          ? {
              ...order.agentRun,
              endedAt: now,
              toolCallCount: runtime.session.toolCalls.length,
              screenshots: runtime.session.screenshots,
            }
          : null,
        updatedAt: now,
      });

      await this.writeAudit(runtime, order, 'placement');
      this.emit(runtime, { event: 'state', state: status });
      await this.payments.revoke(intentId);
      this.runtimes.delete(order.id);

      return updated as Order;
    } catch (error) {
      await this.payments.revoke(intentId);
      return this.fail(order, error);
    }
  }

  // -------------------------------------------------------------------------
  // Cancellation, input, streaming
  // -------------------------------------------------------------------------

  /**
   * The user can cancel at any point before submission, and this path is tested
   * as a first-class flow rather than an afterthought. A job already in
   * `placing` cannot be cancelled: at that point the merchant may already have
   * the order, and a cancel that silently does nothing is worse than a refusal.
   */
  async cancel(orderId: string, user: User, now = new Date()): Promise<Order> {
    const { repository } = this.deps;
    const order = await repository.getOrder(orderId, user.id);
    if (!order) throw new CheckoutConflict('bad_state', 'Order not found.');
    if (order.status === 'placed' || order.status === 'placing' || order.status === 'uncertain') {
      throw new CheckoutConflict(
        'bad_state',
        `This job is ${order.status} and can no longer be cancelled.`,
      );
    }

    const runtime = this.runtimes.get(orderId);
    if (runtime) {
      runtime.abort.abort();
      runtime.pending?.reject(new AgentAbort('timeout', 'Cancelled by the user.', true));
      this.emit(runtime, { event: 'state', state: 'cancelled' });
      this.runtimes.delete(orderId);
    }

    const updated = await repository.cancelOrder(orderId, user.id, now);
    if (!updated) throw new CheckoutConflict('bad_state', 'This job could not be cancelled.');

    // The cart is restored to `open` so nothing is stranded by a cancellation.
    await repository.reopenCart(order.cartId, 'checking_out', now);

    return updated;
  }

  /** Answers a `request_user_input` prompt. */
  provideInput(orderId: string, promptId: string, value: string): boolean {
    const runtime = this.runtimes.get(orderId);
    if (!runtime?.pending || runtime.pending.promptId !== promptId) return false;
    const pending = runtime.pending;
    runtime.pending = null;
    pending.resolve(value);
    return true;
  }

  pendingPrompt(orderId: string): CheckoutInputPrompt | null {
    return this.runtimes.get(orderId)?.pending?.prompt ?? null;
  }

  /** Job progress is pushed over SSE; polling at 2 s is the documented fallback. */
  subscribe(orderId: string, listener: (payload: CheckoutStreamPayload) => void): () => void {
    const runtime = this.runtimes.get(orderId);
    if (!runtime) return () => {};
    runtime.emitter.on('event', listener);
    return () => runtime.emitter.off('event', listener);
  }

  /** Copy shown before authorization when a line carries a caution-tier flag. */
  async riskInterstitial(order: Order): Promise<string | null> {
    const products = await this.deps.repository.getProducts(
      order.items.map((i) => i.productId),
    );
    for (const product of products) {
      const text = checkoutInterstitial(product.risk as never, product.title);
      if (text) return text;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private runtimeFor(orderId: string, jobId: string, merchantDomain: string): JobRuntime {
    const existing = this.runtimes.get(orderId);
    if (existing) return existing;
    const runtime: JobRuntime = {
      orderId,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      pending: null,
      session: { jobId, merchantDomain, toolCalls: [], screenshots: [] },
    };
    this.runtimes.set(orderId, runtime);
    return runtime;
  }

  private emit(runtime: JobRuntime, payload: Partial<CheckoutStreamPayload>): void {
    runtime.emitter.emit('event', {
      jobId: runtime.session.jobId,
      at: new Date().toISOString(),
      event: 'state',
      ...payload,
    } as CheckoutStreamPayload);
  }

  /**
   * Hands a decision to the user. CAPTCHA, 2FA and 3-D Secure always come here:
   * the agent never requests, reads or handles a one-time code, which is the
   * reason authorization is passkey-based in the first place.
   */
  private ask(runtime: JobRuntime, prompt: AgentPrompt): Promise<string> {
    const promptId = `prompt_${randomUUID().slice(0, 12)}`;
    const wire: CheckoutInputPrompt = {
      promptId,
      kind: prompt.kind,
      message: prompt.message,
      ...('options' in prompt ? { options: prompt.options } : {}),
      ...('handoffUrl' in prompt ? { handoffUrl: prompt.handoffUrl } : {}),
    };

    return new Promise<string>((resolve, reject) => {
      runtime.pending = { promptId, prompt: wire, resolve, reject };
      this.emit(runtime, { event: 'needs_input', needsInput: wire });

      runtime.abort.signal.addEventListener(
        'abort',
        () => reject(new AgentAbort('timeout', 'The job was cancelled while awaiting input.', true)),
        { once: true },
      );
    });
  }

  private async resolveAgent(merchantDomain: string): Promise<CheckoutAgent> {
    if (this.deps.agentFor) return this.deps.agentFor(merchantDomain);

    // Protocol-native first, then browser, then the simulator. With neither a
    // protocol client nor a browser driver configured, the simulator is what
    // runs — and it is named a simulator precisely so that nobody mistakes a
    // green checkout here for a real one.
    const source = await this.deps.repository.getSource(merchantDomain);

    if (env.checkoutAgent === 'browser') {
      // A field map is required: without one we do not know this merchant's
      // form, and guessing selectors on a live checkout fills the wrong field.
      // `BrowserCheckoutAgent` aborts to a deep-link handoff in that case.
      return new BrowserCheckoutAgent(this.deps.browser ?? null, {
        fieldMapFor: (domain) => this.deps.fieldMapFor?.(domain) ?? null,
        vault: this.deps.vaultFor?.() ?? null,
        ...(this.deps.originFor ? { originFor: this.deps.originFor } : {}),
      });
    }

    return new SimulatedMerchantAgent({
      stepDelayMs: env.agentStepDelayMs,
      automaticPromotionPct: source?.checkout.stackableCoupons ? 5 : 0,
    });
  }

  private async fail(order: Order, error: unknown): Promise<Order> {
    const abort = error instanceof AgentAbort ? error : null;
    const violation = error instanceof PaymentRuleViolation ? error : null;
    const code = abort?.code ?? violation?.code ?? 'unknown';
    const message = (error as Error).message;
    const recoverable = abort?.recoverable ?? true;

    log.warn('checkout job failed', {
      orderId: order.id,
      merchantDomain: order.merchantDomain,
      code,
      message,
    });

    const updated = await this.deps.repository.updateOrder(order.id, {
      status: 'failed' as OrderStatus,
      failure: { code, message, recoverable },
      agentRun: order.agentRun ? { ...order.agentRun, endedAt: new Date() } : null,
      updatedAt: new Date(),
    });

    const runtime = this.runtimes.get(order.id);
    if (runtime) {
      this.emit(runtime, { event: 'state', state: 'failed' });
      this.runtimes.delete(order.id);
    }

    // The cart is preserved so the user can finish manually via a deep link.
    return (updated ?? order) as Order;
  }

  /**
   * Every job writes an immutable audit record: the tool calls made, the final
   * screenshot, the quote shown and the authorization timestamp. Retained 90
   * days for dispute resolution, then deleted.
   *
   * What it does *not* write is the content the agent typed. A checkout agent
   * fills in a name, a street address and a phone number; recording those
   * verbatim, next to a user id, for ninety days, builds a store of personal
   * data whose only purpose is to be breached. The dispute question an audit
   * log has to answer is "what did the agent do", and field names plus value
   * shapes answer it without keeping the values themselves.
   */
  private async writeAudit(runtime: JobRuntime, order: Order, phase: string): Promise<void> {
    const dir = join(env.auditDir, runtime.session.jobId);
    await mkdir(dir, { recursive: true });
    const record = {
      jobId: runtime.session.jobId,
      orderId: order.id,
      userId: order.userId,
      merchantDomain: order.merchantDomain,
      phase,
      writtenAt: new Date().toISOString(),
      quote: order.quote,
      authorization: order.authorization,
      toolCalls: runtime.session.toolCalls.map(redactToolCall),
      screenshots: runtime.session.screenshots,
    };
    // Append-only: one file per phase, never rewritten, so the record of what
    // the agent did at quote time survives whatever happens at placement.
    await writeFile(join(dir, `${phase}.json`), JSON.stringify(record, null, 2), {
      flag: 'wx',
    }).catch(() => {
      // A second write for the same phase means a retry; the first record is
      // the authoritative one and must not be overwritten.
    });
  }
}
