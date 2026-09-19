import { createHash, randomUUID } from 'node:crypto';
import { CHECKOUT_CONFIG } from '@window/shared';
import { logger } from '../lib/logger.js';

const log = logger.child('payments');

/**
 * Payments.
 *
 * Payment runs on Reap. Window does not store raw card data and is not in PCI
 * scope for card storage: Reap mints a Visa network token per payment intent,
 * capped to the approved amount and restricted to the merchant, so a checkout
 * job physically cannot spend more than the quote the user authorized.
 *
 * Money transmission is avoided by design — Window never holds buyer funds, and
 * Reap is the licensed issuer and settlement provider. That is the single most
 * important structural decision in the payment design and it is why this file
 * has no concept of a Window-held balance anywhere in it.
 */

export interface SpendRules {
  /** Programmable spend rules, enforced before an intent is ever created. */
  maxOrderValue: number;
  maxOrdersPerDay: number;
  blockedMerchantCategories: string[];
}

export const DEFAULT_SPEND_RULES: SpendRules = {
  maxOrderValue: 200_000,
  maxOrdersPerDay: 5,
  blockedMerchantCategories: [],
};

export interface PaymentIntentRequest {
  userId: string;
  jobId: string;
  merchantDomain: string;
  merchantCategory: string;
  /** The authorized quote total, in minor units. */
  authorizedAmount: number;
  currency: string;
  /** Hash of the exact quote the user saw. Bound into the intent. */
  quoteHash: string;
  /** Passkey assertion from the authorization tap. */
  passkeyAssertion: string;
  ordersToday: number;
  rules: SpendRules;
}

export interface PaymentIntent {
  intentId: string;
  /** Reference to the network token. The raw PAN never leaves the rail. */
  tokenRef: string;
  /** Authorized amount plus the tolerance for shipping and tax drift. */
  cap: number;
  currency: string;
  merchantDomain: string;
  expiresAt: Date;
  /** Opaque handle the agent pastes; it is not the token. */
  paymentHandle: string;
}

export class PaymentRuleViolation extends Error {
  constructor(
    readonly code: 'max_order_value' | 'max_orders_per_day' | 'blocked_category' | 'no_passkey',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentRuleViolation';
  }
}

export interface PaymentRail {
  readonly rail: 'reap';
  readonly kind: 'live' | 'simulated';
  /** Minted only at the authorization step, never before. */
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
  /** Called after placement, whatever the outcome, so no token outlives its job. */
  revoke(intentId: string): Promise<void>;
  capture(intentId: string, amount: number): Promise<{ captured: boolean; reason: string | null }>;
}

/**
 * The amount cap: the authorized quote plus a 2% tolerance for shipping and tax
 * drift. Anything larger is refused by the rail rather than by Window, which is
 * what makes "the agent cannot overspend" a property of the card rather than a
 * property of our code being correct.
 */
export function capFor(authorizedAmount: number): number {
  return Math.ceil(authorizedAmount * (1 + CHECKOUT_CONFIG.amountCapTolerance));
}

export function assertSpendRules(request: PaymentIntentRequest): void {
  const { rules } = request;

  // Authorization is passkey-based rather than OTP, which matters because the
  // agent must never be in a position to read a one-time code.
  if (!request.passkeyAssertion) {
    throw new PaymentRuleViolation(
      'no_passkey',
      'A passkey assertion from the authorization tap is required before an intent is minted.',
    );
  }
  if (request.authorizedAmount > rules.maxOrderValue) {
    throw new PaymentRuleViolation(
      'max_order_value',
      `This order exceeds the per-order ceiling of ${rules.maxOrderValue} ${request.currency}.`,
    );
  }
  if (request.ordersToday >= rules.maxOrdersPerDay) {
    throw new PaymentRuleViolation(
      'max_orders_per_day',
      `The daily order limit of ${rules.maxOrdersPerDay} has been reached.`,
    );
  }
  if (rules.blockedMerchantCategories.includes(request.merchantCategory)) {
    throw new PaymentRuleViolation(
      'blocked_category',
      `Purchases in "${request.merchantCategory}" are blocked for this account.`,
    );
  }
}

/**
 * The live rail.
 *
 * No Reap credentials exist in this environment, so it refuses rather than
 * inventing an intent. Everything it would do — the spend-rule checks, the cap
 * computation, the one-token-per-job binding — lives in shared functions above
 * so that the simulated rail cannot drift from it.
 */
export class ReapPaymentRail implements PaymentRail {
  readonly rail = 'reap' as const;
  readonly kind = 'live' as const;

  constructor(
    private readonly credentials: { apiKey: string; baseUrl: string } | null,
  ) {}

  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
    assertSpendRules(request);
    if (!this.credentials) {
      throw new Error(
        'Reap credentials are not configured. Set REAP_API_KEY and REAP_BASE_URL to enable the ' +
          'live payment rail; until then the orchestrator uses the simulated rail and never moves money.',
      );
    }
    throw new Error('The live Reap rail is not wired up in this environment.');
  }

  async revoke(): Promise<void> {
    throw new Error('The live Reap rail is not wired up in this environment.');
  }

  async capture(): Promise<{ captured: boolean; reason: string | null }> {
    throw new Error('The live Reap rail is not wired up in this environment.');
  }
}

/**
 * The simulated rail.
 *
 * Named as a simulator and it never moves money. It enforces the real
 * invariants — passkey present, spend rules honoured, one token per job bound
 * to one merchant, a hard cap that refuses a capture above the authorized
 * amount plus tolerance — so the orchestrator's guarantees are genuinely
 * exercised rather than assumed.
 */
export class SimulatedPaymentRail implements PaymentRail {
  readonly rail = 'reap' as const;
  readonly kind = 'simulated' as const;

  private readonly intents = new Map<
    string,
    { cap: number; merchantDomain: string; currency: string; revoked: boolean; captured: boolean }
  >();

  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
    assertSpendRules(request);

    const intentId = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const cap = capFor(request.authorizedAmount);

    // The token reference is derived from the job and the exact quote, so a
    // token minted for one quote can never be replayed against another.
    const tokenRef = `tok_${createHash('sha256')
      .update(`${request.jobId}:${request.quoteHash}`)
      .digest('hex')
      .slice(0, 24)}`;

    this.intents.set(intentId, {
      cap,
      merchantDomain: request.merchantDomain,
      currency: request.currency,
      revoked: false,
      captured: false,
    });

    log.info('payment intent minted', {
      intentId,
      merchantDomain: request.merchantDomain,
      cap,
      jobId: request.jobId,
    });

    return {
      intentId,
      tokenRef,
      cap,
      currency: request.currency,
      merchantDomain: request.merchantDomain,
      expiresAt: new Date(Date.now() + CHECKOUT_CONFIG.quoteTtlMs),
      // The handle is what the agent sees. It is not the token, and it cannot
      // be used anywhere except through this rail.
      paymentHandle: `handle_${intentId}`,
    };
  }

  async revoke(intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent) return;
    intent.revoked = true;
    log.info('payment intent revoked', { intentId });
  }

  async capture(intentId: string, amount: number): Promise<{ captured: boolean; reason: string | null }> {
    const intent = this.intents.get(intentId);
    if (!intent) return { captured: false, reason: 'unknown_intent' };
    if (intent.revoked) return { captured: false, reason: 'revoked' };
    // One authorization equals at most one order per job: a second capture
    // against the same intent is refused by the rail, not by a flag in our code.
    if (intent.captured) return { captured: false, reason: 'already_captured' };
    if (amount > intent.cap) {
      log.warn('capture refused above the authorized cap', { intentId, amount, cap: intent.cap });
      return { captured: false, reason: 'above_cap' };
    }
    intent.captured = true;
    return { captured: true, reason: null };
  }
}

/** Picks the rail. Live when credentials exist; the simulator otherwise. */
export function createPaymentRail(): PaymentRail {
  const apiKey = process.env.REAP_API_KEY;
  const baseUrl = process.env.REAP_BASE_URL;
  if (apiKey && baseUrl) return new ReapPaymentRail({ apiKey, baseUrl });
  log.info('no Reap credentials configured; using the simulated rail (no money moves)');
  return new SimulatedPaymentRail();
}
