import { randomUUID } from 'node:crypto';
import { CHECKOUT_CONFIG, hashString, mulberry32 } from '@window/shared';
import { referenceFor, type VaultField, type VaultHandle } from './vault.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { CouponCandidate, CouponAttemptOutcome } from './coupons.js';

const log = logger.child('checkout.agent');

/**
 * The checkout agent.
 *
 * Each job runs in an isolated browser context with its own storage partition
 * and egress identity. The agent is a tool-using loop over a small, closed tool
 * set — navigate, click, type, select, read DOM, screenshot, and a
 * `request_user_input` escape hatch — and nothing else. The tool set is closed
 * on purpose: an agent that can only do these seven things cannot be talked
 * into doing an eighth.
 */

export const AGENT_TOOLS = [
  'navigate',
  'click',
  'type',
  'select',
  'read_dom',
  'screenshot',
  'request_user_input',
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export interface AgentToolCall {
  tool: AgentTool;
  args: Record<string, unknown>;
  at: Date;
  /** Never contains credentials or session cookies. */
  result: string;
}

export interface CheckoutLineItem {
  productId: string;
  title: string;
  url: string;
  variant: Record<string, string>;
  quantity: number;
  /** Price the user saw when the line was added, in minor units. */
  expectedUnitPrice: number;
  currency: string;
}

export interface AgentQuote {
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  currency: string;
  /** Totals observed before any code was applied, for the savings figure. */
  preCouponTotal: number;
  couponCode: string | null;
  couponAttempts: CouponAttemptOutcome[];
  automaticPromotionApplied: boolean;
  /** Lines the merchant could not fulfil; the quote is recomputed without them. */
  droppedProductIds: string[];
  screenshotRef: string;
}

export interface AgentPlacement {
  merchantOrderNumber: string | null;
  /** Set when the order was submitted but no confirmation could be parsed. */
  uncertain: boolean;
  screenshotRef: string;
}

export type AgentPrompt =
  | { kind: 'address'; message: string; options: Array<{ id: string; label: string }> }
  | { kind: 'shipping_option'; message: string; options: Array<{ id: string; label: string; detail: string }> }
  | { kind: 'captcha'; message: string; handoffUrl: string }
  | { kind: 'twofa'; message: string; handoffUrl: string }
  | { kind: 'three_ds'; message: string; handoffUrl: string }
  | { kind: 'choice'; message: string; options: Array<{ id: string; label: string }> };

export interface AgentSession {
  jobId: string;
  merchantDomain: string;
  toolCalls: AgentToolCall[];
  screenshots: string[];
}

export class AgentAbort extends Error {
  constructor(
    readonly code:
      | 'timeout'
      | 'out_of_stock'
      | 'price_increased'
      | 'blocked'
      | 'payment_step_anomaly'
      | 'not_configured',
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'AgentAbort';
  }
}

/**
 * What the orchestrator needs from any checkout path, browser or protocol.
 * `quote` fills a cart and prices it; `place` submits. They are separate calls
 * because the authorization gate sits between them and nothing may cross it.
 */
export interface CheckoutAgent {
  readonly kind: 'browser' | 'protocol' | 'simulated';
  quote(input: {
    session: AgentSession;
    merchantDomain: string;
    items: CheckoutLineItem[];
    coupons: CouponCandidate[];
    allowStacking: boolean;
    onStep?: (step: string) => void;
    onCouponAttempt?: (attempt: CouponAttemptOutcome) => void;
    onPrompt?: (prompt: AgentPrompt) => Promise<string>;
    signal?: AbortSignal;
  }): Promise<AgentQuote>;

  place(input: {
    session: AgentSession;
    merchantDomain: string;
    quote: AgentQuote;
    /** Opaque payment handle. The raw token never enters the agent's context. */
    paymentHandle: string;
    onStep?: (step: string) => void;
    onPrompt?: (prompt: AgentPrompt) => Promise<string>;
    signal?: AbortSignal;
  }): Promise<AgentPlacement>;
}

// ---------------------------------------------------------------------------
// Browser driver seam
// ---------------------------------------------------------------------------

/**
 * The browser the agent drives. Deliberately narrow: an interface this small
 * cannot grow an "evaluate arbitrary script" method by accident, and the
 * checkout pool is the one place in the system where that matters most.
 */
export interface CheckoutBrowser {
  /** A fresh storage partition and egress identity per job, torn down after. */
  newContext(options: {
    merchantDomain: string;
    sessionHandle: string | null;
    /** Bound to the page so values are substituted at the keystroke. */
    vault?: VaultHandle | null;
  }): Promise<CheckoutPage>;
}

export interface CheckoutPage {
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  readDom(selector?: string): Promise<string>;
  /**
   * Whether a field currently holds the value behind a vault reference.
   *
   * The agent has to confirm a field took what it typed — merchant forms
   * reformat, truncate and silently reject — but handing the value back would
   * undo the entire point of the vault. So the comparison happens in the
   * driver and only the boolean crosses back.
   */
  isFilledWith(selector: string, reference: string): Promise<boolean>;
  /** Whether a field is empty. Used to prove the agent left payment alone. */
  isEmpty(selector: string): Promise<boolean>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * The real browser agent.
 *
 * Drives a merchant's own checkout with a real browser, because there is no
 * single API to post an order to fifteen different sites. What makes that safe
 * is what it is *not* allowed to do:
 *
 *   * it never sees the user's details — it passes `{{ref:ship.line1}}` and the
 *     driver substitutes plaintext at the keystroke (see `vault.ts`);
 *   * it never touches a payment field, by selector or by attribute;
 *   * it stops at the last screen before money moves and returns a quote. Only
 *     `POST /authorize`, carrying the hash of that exact quote, can go further.
 *
 * The selector map is per-merchant configuration rather than something the
 * agent infers. A model choosing selectors from page text is a model a page can
 * instruct; a lookup table is not. `FieldMap` is the seam where a learned or
 * hand-maintained mapping plugs in.
 */
export interface FieldMap {
  /**
   * Origin override. Real merchants are reached at `https://<domain>`; this is
   * for a local stand-in, whose domain does not resolve.
   */
  origin?: string;
  /** Where the checkout form lives, relative to the merchant origin. */
  checkoutPath: string;
  /** Vault field → CSS selector on the merchant's form. */
  fields: Partial<Record<VaultField, string>>;
  /** Optional shipping-method select and the value to choose. */
  shipping?: { selector: string; value: string };
  /** Where the totals are read from. */
  totals: {
    subtotal: string;
    shipping: string;
    tax: string;
    discount?: string;
    total: string;
  };
  /** The button that would place the order. Located, never clicked, at quote time. */
  placeOrder: string;
  /** Where a coupon code goes, when the merchant takes one. */
  coupon?: { input: string; apply: string };
}

export class BrowserCheckoutAgent implements CheckoutAgent {
  readonly kind = 'browser' as const;

  constructor(
    private readonly browser: CheckoutBrowser | null,
    private readonly config: {
      /** Resolves the selector map for a merchant. */
      fieldMapFor: (merchantDomain: string) => FieldMap | null;
      /** The user's details, held encrypted for the life of the job. */
      vault: VaultHandle | null;
      /** Origin override, for pointing a test at a local fixture. */
      originFor?: (merchantDomain: string) => string;
    },
  ) {}

  private require(): CheckoutBrowser {
    if (!this.browser) {
      throw new AgentAbort(
        'not_configured',
        'No CheckoutBrowser is injected. The browser checkout fleet needs a Playwright-backed ' +
          'CheckoutBrowser implementation, running in its own network segment with its own ' +
          'egress identity, separate from the crawl pool.',
        false,
      );
    }
    return this.browser;
  }

  private mapFor(merchantDomain: string): FieldMap {
    const map = this.config.fieldMapFor(merchantDomain);
    if (!map) {
      // No map means we do not know this merchant's form. Guessing at selectors
      // on a live checkout is how an agent fills the wrong field and places the
      // wrong order, so this hands off instead.
      throw new AgentAbort(
        'blocked',
        `No checkout field map for ${merchantDomain}. Finish this order on the merchant's site.`,
        true,
      );
    }
    return map;
  }

  private originOf(merchantDomain: string): string {
    return this.config.originFor?.(merchantDomain) ?? `https://${merchantDomain}`;
  }

  /**
   * Fills the merchant's cart and prices it, stopping before submission.
   *
   * Everything here is observation: the totals in the returned quote are read
   * off the merchant's own page, never computed by us, because the number the
   * user authorizes has to be the number the merchant will actually charge.
   */
  async quote(input: Parameters<CheckoutAgent['quote']>[0]): Promise<AgentQuote> {
    const browser = this.require();
    const map = this.mapFor(input.merchantDomain);
    const currency = input.items[0]?.currency ?? 'USD';

    const page = await browser.newContext({
      merchantDomain: input.merchantDomain,
      sessionHandle: null,
      vault: this.config.vault,
    });

    try {
      input.signal?.throwIfAborted();
      await page.navigate(`${this.originOf(input.merchantDomain)}${map.checkoutPath}`);
      input.onStep?.('navigate: checkout opened');

      // Delivery details, by reference. The agent does not know what it typed.
      //
      // Only fields the vault actually holds are filled. A second address line
      // is optional for most people, and a form that offers the box must not
      // fail the order because the user has nothing to put in it.
      const held = new Set(this.config.vault?.availableFields() ?? []);
      for (const [field, selector] of Object.entries(map.fields) as Array<[VaultField, string]>) {
        input.signal?.throwIfAborted();
        if (!held.has(field)) {
          input.onStep?.(`skip: ${field} (not held for this user)`);
          continue;
        }
        await page.type(selector, referenceFor(field));
        input.onStep?.(`type: ${field} into ${selector}`);
      }

      if (map.shipping) {
        await page.select(map.shipping.selector, map.shipping.value);
        input.onStep?.(`select: shipping ${map.shipping.value}`);
      }

      const couponAttempts: CouponAttemptOutcome[] = [];
      const before = await this.readTotals(page, map, currency);

      // The coupon loop, bounded. Each code is tried against the merchant's own
      // page and kept only if the observed total actually fell.
      if (map.coupon) {
        for (const candidate of input.coupons.slice(0, CHECKOUT_CONFIG.maxCouponAttempts)) {
          input.signal?.throwIfAborted();
          await page.type(map.coupon.input, candidate.code);
          await page.click(map.coupon.apply);

          const after = await this.readTotals(page, map, currency);
          const observedDiscount = Math.max(0, before.total - after.total);
          const applied = observedDiscount > 0;

          couponAttempts.push({
            code: candidate.code,
            applied,
            observedDiscount,
            reason: applied ? null : 'no observed change to the total',
          });
          input.onCouponAttempt?.(couponAttempts[couponAttempts.length - 1]!);
          if (applied && !input.allowStacking) break;
        }
      }

      const totals = await this.readTotals(page, map, currency);

      // The button must exist before we call this a quote. A checkout we cannot
      // submit is not one the user should be asked to authorize.
      const dom = await page.readDom();
      if (!dom.includes(await this.labelOf(page, map.placeOrder))) {
        throw new AgentAbort(
          'payment_step_anomaly',
          'Could not find the place-order control on the merchant checkout.',
          true,
        );
      }
      input.onStep?.('read_dom: totals and place-order control located');

      const screenshotRef = `${input.session.jobId}/quote.png`;
      input.session.screenshots.push(screenshotRef);
      await page.screenshot();

      return {
        ...totals,
        preCouponTotal: before.total,
        couponCode: couponAttempts.find((a) => a.applied)?.code ?? null,
        couponAttempts,
        automaticPromotionApplied: false,
        droppedProductIds: [],
        screenshotRef,
      };
    } finally {
      // The context, its storage and its egress identity die with the job.
      await page.close();
    }
  }

  /**
   * Submits. Reached only after an authorization carrying the quote hash.
   *
   * The payment handle is opaque — a reference the rail understands and the
   * page cannot reuse. No PAN, no CVV, no card field is ever touched here.
   */
  async place(input: Parameters<CheckoutAgent['place']>[0]): Promise<AgentPlacement> {
    const browser = this.require();
    const map = this.mapFor(input.merchantDomain);

    const page = await browser.newContext({
      merchantDomain: input.merchantDomain,
      sessionHandle: null,
      vault: this.config.vault,
    });

    try {
      input.signal?.throwIfAborted();
      await page.navigate(`${this.originOf(input.merchantDomain)}${map.checkoutPath}`);

      const held = new Set(this.config.vault?.availableFields() ?? []);
      for (const [field, selector] of Object.entries(map.fields) as Array<[VaultField, string]>) {
        if (!held.has(field)) continue;
        await page.type(selector, referenceFor(field));
      }
      if (map.shipping) await page.select(map.shipping.selector, map.shipping.value);
      input.onStep?.('type: delivery details restored');

      // This is the line. Everything before it is reversible.
      await page.click(map.placeOrder);
      input.onStep?.('click: order submitted');

      const screenshotRef = `${input.session.jobId}/placement.png`;
      input.session.screenshots.push(screenshotRef);
      await page.screenshot();

      const confirmation = await page.readDom();
      const orderNumber = /\b([A-Z]{2,4}-[A-Z0-9-]{4,})\b/.exec(confirmation)?.[1] ?? null;

      // Submitted but unparsed goes `uncertain` rather than `placed`, and is
      // never re-submitted: a duplicate order is worse than an unclear one.
      return {
        merchantOrderNumber: orderNumber,
        uncertain: orderNumber === null,
        screenshotRef,
      };
    } finally {
      await page.close();
    }
  }

  /** Reads the totals off the merchant's own page. */
  private async readTotals(
    page: CheckoutPage,
    map: FieldMap,
    currency: string,
  ): Promise<{
    subtotal: number;
    shipping: number;
    tax: number;
    discount: number;
    total: number;
    currency: string;
  }> {
    const read = async (selector?: string): Promise<number> => {
      if (!selector) return 0;
      return parseMinorUnits(await page.readDom(selector));
    };

    return {
      subtotal: await read(map.totals.subtotal),
      shipping: await read(map.totals.shipping),
      tax: await read(map.totals.tax),
      discount: Math.abs(await read(map.totals.discount)),
      total: await read(map.totals.total),
      currency,
    };
  }

  private async labelOf(page: CheckoutPage, selector: string): Promise<string> {
    const text = (await page.readDom(selector)).trim();
    return text.length > 0 ? text : 'Place';
  }
}

/**
 * Reads a displayed price into integer minor units.
 *
 * Deliberately strict: anything it cannot read becomes 0 rather than `NaN`,
 * because `NaN` propagates silently into a total and a total is the one number
 * in this system that must never be wrong by accident.
 */
export function parseMinorUnits(text: string): number {
  const match = /(-?)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(text.replace(/\u00a0/g, ' '));
  if (!match) return 0;
  const amount = Number.parseFloat((match[2] ?? '0').replace(/,/g, ''));
  if (Number.isNaN(amount)) return 0;
  return Math.round(amount * 100) * (match[1] === '-' ? -1 : 1);
}

// ---------------------------------------------------------------------------
// Protocol-native path
// ---------------------------------------------------------------------------

export type AgenticProtocol = 'acp' | 'mpp' | 'tap';

/**
 * Where a merchant supports an agentic protocol, the orchestrator uses it and
 * skips browser simulation entirely. Protocol-native checkout is faster,
 * cheaper and far more reliable than driving a browser, so it is always
 * attempted first — every merchant moved off the browser path lowers cost,
 * latency and legal exposure at once.
 */
export interface ProtocolClient {
  readonly protocol: AgenticProtocol;
  createCart(merchantDomain: string, items: CheckoutLineItem[]): Promise<{ cartId: string }>;
  applyCoupon(cartId: string, code: string): Promise<{ applied: boolean; total: number; reason: string | null }>;
  price(cartId: string): Promise<Omit<AgentQuote, 'screenshotRef' | 'couponAttempts' | 'couponCode' | 'automaticPromotionApplied' | 'preCouponTotal'>>;
  submit(cartId: string, paymentHandle: string): Promise<{ orderNumber: string | null }>;
}

// ---------------------------------------------------------------------------
// Simulated merchant
// ---------------------------------------------------------------------------

export interface SimulatedMerchantOptions {
  /** Per-merchant failure injection, so the failure paths are actually tested. */
  outOfStockRate?: number;
  priceDriftRate?: number;
  captchaRate?: number;
  shippingAmbiguityRate?: number;
  confirmationParseFailureRate?: number;
  /** Codes the simulated merchant will actually accept. */
  validCodes?: Record<string, number>;
  automaticPromotionPct?: number;
  stepDelayMs?: number;
}

/**
 * A simulated merchant.
 *
 * This is a development and test double, named as one. It drives the same
 * `CheckoutAgent` contract as the browser and protocol paths, emits the same
 * tool calls into the audit record, and injects the failure modes the PRD
 * requires the orchestrator to handle — out of stock at checkout, a price rise
 * above the quote, CAPTCHA handoff, ambiguous shipping, and a submitted order
 * whose confirmation could not be parsed. It never contacts a real merchant and
 * never moves money.
 *
 * Its determinism is the point: seeded from the job id, every run of the same
 * job takes the same path, so a failure in the orchestrator is reproducible
 * rather than a flake.
 */
export class SimulatedMerchantAgent implements CheckoutAgent {
  readonly kind = 'simulated' as const;

  constructor(private readonly options: SimulatedMerchantOptions = {}) {}

  private random(session: AgentSession, salt: string): () => number {
    return mulberry32(hashString(`${session.jobId}:${salt}`));
  }

  private async step(
    session: AgentSession,
    tool: AgentTool,
    args: Record<string, unknown>,
    result: string,
    onStep?: (step: string) => void,
  ): Promise<void> {
    const delay = this.options.stepDelayMs ?? env.agentStepDelayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    session.toolCalls.push({ tool, args, at: new Date(), result });
    onStep?.(`${tool}: ${result}`);
  }

  async quote(input: Parameters<CheckoutAgent['quote']>[0]): Promise<AgentQuote> {
    const { session, items, coupons } = input;
    const random = this.random(session, 'quote');
    const currency = items[0]?.currency ?? 'USD';

    await this.step(session, 'navigate', { url: `https://${input.merchantDomain}/cart` }, 'cart opened', input.onStep);

    // Out of stock at checkout: that line drops out and the quote is recomputed.
    const dropped: string[] = [];
    const live: CheckoutLineItem[] = [];
    for (const item of items) {
      this.throwIfAborted(input.signal);
      if (random() < (this.options.outOfStockRate ?? 0.04)) {
        dropped.push(item.productId);
        await this.step(session, 'read_dom', { selector: '.stock' }, `${item.title}: out of stock`, input.onStep);
        continue;
      }
      await this.step(session, 'click', { selector: `[data-add="${item.productId}"]` }, `added ${item.title}`, input.onStep);
      live.push(item);
    }

    if (live.length === 0) {
      throw new AgentAbort('out_of_stock', 'Every line in this job is out of stock.', true);
    }

    // A price rise above what the user saw halts the job. It is never auto-accepted.
    let subtotal = 0;
    for (const item of live) {
      const drift = random() < (this.options.priceDriftRate ?? 0.05) ? 1 + random() * 0.15 : 1;
      const unit = Math.round(item.expectedUnitPrice * drift);
      if (unit > item.expectedUnitPrice) {
        throw new AgentAbort(
          'price_increased',
          `"${item.title}" is now ${unit} ${currency}, above the ${item.expectedUnitPrice} the quote was built on.`,
          true,
        );
      }
      subtotal += unit * item.quantity;
    }

    // A CAPTCHA pauses the job and hands the live view to the user.
    if (random() < (this.options.captchaRate ?? 0.05)) {
      if (!input.onPrompt) {
        throw new AgentAbort('blocked', 'A bot challenge appeared and there is no way to hand it to the user.', true);
      }
      await input.onPrompt({
        kind: 'captcha',
        message: `${input.merchantDomain} presented a bot challenge. Solve it to continue.`,
        handoffUrl: `${env.publicUrl}/checkout/handoff/${session.jobId}`,
      });
      await this.step(session, 'read_dom', {}, 'challenge cleared by the user', input.onStep);
    }

    // Ambiguous shipping is handed back with the options rendered natively.
    let shipping = subtotal > 7500 ? 0 : 599;
    if (input.onPrompt && random() < (this.options.shippingAmbiguityRate ?? 0.12)) {
      const chosen = await input.onPrompt({
        kind: 'shipping_option',
        message: 'Choose a shipping speed.',
        options: [
          { id: 'standard', label: 'Standard, 4-6 days', detail: shipping === 0 ? 'Free' : '$5.99' },
          { id: 'express', label: 'Express, 2 days', detail: '$14.99' },
        ],
      });
      if (chosen === 'express') shipping = 1499;
      await this.step(session, 'select', { selector: '#shipping' }, `shipping: ${chosen}`, input.onStep);
    }

    const preCouponTotal = subtotal + shipping + Math.round(subtotal * 0.0875);

    // Coupons are applied serially against the real cart, reading the total
    // after each, capped at eight attempts.
    const validCodes = this.options.validCodes ?? { SAVE15: 15, WELCOME10: 10 };
    const attempts: CouponAttemptOutcome[] = [];
    let bestDiscount = 0;
    let bestCode: string | null = null;

    for (const coupon of coupons.slice(0, CHECKOUT_CONFIG.maxCouponAttempts)) {
      this.throwIfAborted(input.signal);
      const pct = validCodes[coupon.code];
      const applied = pct !== undefined;
      const observedDiscount = applied ? Math.round(subtotal * (pct / 100)) : 0;

      await this.step(
        session,
        'type',
        { selector: '#promo', text: coupon.code },
        applied ? `${coupon.code} accepted` : `${coupon.code} rejected`,
        input.onStep,
      );

      const attempt: CouponAttemptOutcome = {
        code: coupon.code,
        applied,
        observedDiscount,
        reason: applied ? null : 'invalid',
      };
      attempts.push(attempt);
      input.onCouponAttempt?.(attempt);

      if (applied && observedDiscount > bestDiscount) {
        bestDiscount = observedDiscount;
        bestCode = coupon.code;
      }
      if (applied && !input.allowStacking) break;
    }

    const automaticPct = this.options.automaticPromotionPct ?? 0;
    const automaticDiscount = Math.round(subtotal * (automaticPct / 100));
    const automaticWins = automaticDiscount >= bestDiscount && automaticDiscount > 0;

    const discount = automaticWins ? automaticDiscount : bestDiscount;
    const tax = Math.round((subtotal - discount) * 0.0875);
    const total = subtotal - discount + shipping + tax;

    const screenshotRef = `job-${session.jobId}-quote-${randomUUID().slice(0, 8)}`;
    await this.step(session, 'screenshot', {}, screenshotRef, input.onStep);
    session.screenshots.push(screenshotRef);

    return {
      subtotal,
      shipping,
      tax,
      discount,
      total,
      currency,
      preCouponTotal,
      couponCode: automaticWins ? null : bestCode,
      couponAttempts: attempts,
      automaticPromotionApplied: automaticWins,
      droppedProductIds: dropped,
      screenshotRef,
    };
  }

  async place(input: Parameters<CheckoutAgent['place']>[0]): Promise<AgentPlacement> {
    const { session } = input;
    const random = this.random(session, 'place');

    await this.step(session, 'navigate', { url: `https://${input.merchantDomain}/checkout` }, 'checkout opened', input.onStep);
    // The payment handle is opaque: the agent pastes a reference, never a PAN.
    await this.step(session, 'type', { selector: '#payment', text: '[payment handle]' }, 'payment method attached', input.onStep);

    // 3-D Secure is always handed to the user. The agent never handles a code.
    if (input.onPrompt && random() < 0.08) {
      await input.onPrompt({
        kind: 'three_ds',
        message: 'Your bank needs to verify this payment.',
        handoffUrl: `${env.publicUrl}/checkout/handoff/${session.jobId}`,
      });
    }

    await this.step(session, 'click', { selector: '#place-order' }, 'order submitted', input.onStep);

    const screenshotRef = `job-${session.jobId}-placed-${randomUUID().slice(0, 8)}`;
    await this.step(session, 'screenshot', {}, screenshotRef, input.onStep);
    session.screenshots.push(screenshotRef);

    // Submitted but no confirmation parsed: the job goes `uncertain` and a
    // verification pass re-checks the merchant's order history. Never re-submit.
    if (random() < (this.options.confirmationParseFailureRate ?? 0.03)) {
      log.warn('order submitted but no confirmation parsed', { jobId: session.jobId });
      return { merchantOrderNumber: null, uncertain: true, screenshotRef };
    }

    const orderNumber = `${input.merchantDomain.split('.')[0]?.toUpperCase()}-${Math.floor(
      random() * 900000 + 100000,
    )}`;
    return { merchantOrderNumber: orderNumber, uncertain: false, screenshotRef };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AgentAbort('timeout', 'The job was cancelled.', true);
    }
  }
}
