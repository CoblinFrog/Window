import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ObjectId } from 'mongodb';
import { CHECKOUT_CONFIG } from '@window/shared';
import { MemoryCache } from '../cache/index.js';
import type { User } from '../db/collections.js';
import { CheckoutOrchestrator, CheckoutConflict } from './orchestrator.js';
import { MemoryCheckoutRepository } from './repository.memory.js';
import { fixtureProduct, fixtureSource } from './repository.conformance.js';
import { SimulatedMerchantAgent } from './agent.js';
import { SimulatedPaymentRail, capFor } from './payments.js';
import type { Cart } from './repository.js';

/**
 * The checkout lifecycle, end to end, with no database and no server.
 *
 * This is the layer the individual unit tests could not reach. `hashQuote` is
 * tested, the payment cap is tested, the repository's atomicity is tested — but
 * a checkout system fails in the *transitions*, and until the orchestrator
 * depended on an interface rather than a live MongoDB, none of them could be
 * exercised at all.
 *
 * Every case below is a way the user could lose money or lose an order.
 */

const USER_ID = new ObjectId('507f1f77bcf86cd799439011');
const user = { _id: USER_ID, settings: { currency: 'USD' } } as unknown as User;

/** A merchant that always succeeds, so a failing test means a real regression. */
function reliableAgent() {
  return new SimulatedMerchantAgent({
    stepDelayMs: 0,
    outOfStockRate: 0,
    priceDriftRate: 0,
    captchaRate: 0,
    shippingAmbiguityRate: 0,
    confirmationParseFailureRate: 0,
  });
}

interface Harness {
  repo: MemoryCheckoutRepository;
  orchestrator: CheckoutOrchestrator;
  payments: SimulatedPaymentRail;
  cartId: string;
}

async function harness(
  options: { agent?: SimulatedMerchantAgent; payments?: SimulatedPaymentRail } = {},
): Promise<Harness> {
  const repo = new MemoryCheckoutRepository();
  repo.seed({
    products: [fixtureProduct({ _id: 'prod_1', title: 'Keyboard' })],
    sources: [fixtureSource({ _id: 'shop.test' })],
  });

  const cart = await repo.createCart(USER_ID.toHexString(), new Date());
  const items: Cart['items'] = [
    {
      _id: 'line_1',
      productId: 'prod_1',
      clusterId: null,
      sellerId: 'seller_1',
      merchantDomain: 'shop.test',
      variant: {},
      quantity: 1,
      priceAtAdd: { amount: 1000, currency: 'USD' },
      priceNow: { amount: 1000, currency: 'USD' },
      priceChanged: false,
      available: true,
      softHold: false,
      addedAt: new Date(),
    } as unknown as Cart['items'][number],
  ];
  await repo.saveCartItems(cart._id, items, new Date());

  const payments = options.payments ?? new SimulatedPaymentRail();
  const agent = options.agent ?? reliableAgent();

  const orchestrator = new CheckoutOrchestrator({
    repository: repo,
    cache: new MemoryCache(),
    payments,
    agentFor: async () => agent,
  });

  return { repo, orchestrator, payments, cartId: cart._id };
}

/** Drives a job to the point where it is waiting for the user's tap. */
async function quotedJob(h: Harness) {
  const [order] = await h.orchestrator.createJobs(user, h.cartId);
  return h.orchestrator.runQuote(order!, user);
}

describe('checkout lifecycle', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('decomposes the cart into one job per merchant and stops before money moves', async () => {
    const quoted = await quotedJob(h);

    assert.equal(quoted.status, 'awaiting_auth');
    assert.ok(quoted.quote, 'a quote must be attached before authorization');
    assert.ok(quoted.quote!.hash.length > 0);
    // Nothing may be placed by quoting alone.
    assert.equal(quoted.merchantOrderNumber, null);
    assert.equal(quoted.submissionSeq, 0);
  });

  it('places the order when the authorization echoes the exact quote', async () => {
    const quoted = await quotedJob(h);
    const placed = await h.orchestrator.authorize(quoted._id, user, {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    });

    assert.ok(['placed', 'uncertain'].includes(placed.status), `got ${placed.status}`);
    assert.equal(placed.submissionSeq, 1);
    assert.equal(placed.authorization?.quoteHash, quoted.quote!.hash);
    // The raw user agent is never stored, only a hash of it.
    assert.notEqual(placed.authorization?.userAgentHash, 'test');
  });

  // -------------------------------------------------------------------------
  // The authorization gate. Each of these is a way to buy at a price the user
  // never saw, and each must be a 409 that places nothing.
  // -------------------------------------------------------------------------

  it('refuses an authorization whose hash does not match', async () => {
    const quoted = await quotedJob(h);

    await assert.rejects(
      () =>
        h.orchestrator.authorize(quoted._id, user, {
          quoteHash: 'f'.repeat(64),
          passkeyAssertion: 'tap_1',
          userAgent: 'test',
        }),
      (error: unknown) =>
        error instanceof CheckoutConflict && error.code === 'quote_mismatch',
    );

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.status, 'awaiting_auth', 'a refused authorization must change nothing');
    assert.equal(after?.submissionSeq, 0);
  });

  it('refuses an authorization against an expired quote', async () => {
    const quoted = await quotedJob(h);
    const afterExpiry = new Date(Date.now() + CHECKOUT_CONFIG.quoteTtlMs + 1000);

    await assert.rejects(
      () =>
        h.orchestrator.authorize(
          quoted._id,
          user,
          { quoteHash: quoted.quote!.hash, passkeyAssertion: 'tap_1', userAgent: 'test' },
          afterExpiry,
        ),
      (error: unknown) => error instanceof CheckoutConflict && error.code === 'quote_expired',
    );

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.status, 'awaiting_auth');
  });

  it('refuses to authorize a job that is not awaiting authorization', async () => {
    const [order] = await h.orchestrator.createJobs(user, h.cartId);

    // Still `pending`: never quoted, so there is no quote to have been shown.
    await assert.rejects(
      () =>
        h.orchestrator.authorize(order!._id, user, {
          quoteHash: 'a'.repeat(64),
          passkeyAssertion: 'tap_1',
          userAgent: 'test',
        }),
      (error: unknown) => error instanceof CheckoutConflict && error.code === 'bad_state',
    );
  });

  it('refuses to authorize another user\'s job', async () => {
    const quoted = await quotedJob(h);
    const stranger = { _id: new ObjectId(), settings: { currency: 'USD' } } as unknown as User;

    await assert.rejects(
      () =>
        h.orchestrator.authorize(quoted._id, stranger, {
          quoteHash: quoted.quote!.hash,
          passkeyAssertion: 'tap_1',
          userAgent: 'test',
        }),
      (error: unknown) => error instanceof CheckoutConflict,
    );

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.status, 'awaiting_auth');
  });

  // -------------------------------------------------------------------------
  // One authorization, at most one order
  // -------------------------------------------------------------------------

  it('places exactly one order when the same authorization arrives twice', async () => {
    const quoted = await quotedJob(h);
    const input = {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    };

    await h.orchestrator.authorize(quoted._id, user, input);

    // The replay: same job, same hash, same everything.
    await assert.rejects(
      () => h.orchestrator.authorize(quoted._id, user, input),
      (error: unknown) => error instanceof CheckoutConflict,
    );

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.submissionSeq, 1, 'the submission counter must never exceed one');
  });

  it('survives two concurrent authorizations with one placement', async () => {
    const quoted = await quotedJob(h);
    const input = {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    };

    // A double-tap on a slow connection. Both requests are genuinely in flight.
    const results = await Promise.allSettled([
      h.orchestrator.authorize(quoted._id, user, input),
      h.orchestrator.authorize(quoted._id, user, input),
    ]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.submissionSeq, 1);
  });

  // -------------------------------------------------------------------------
  // The payment cap, exercised through the orchestrator rather than the rail
  // -------------------------------------------------------------------------

  it('aborts placement when the merchant charges above the authorized cap', async () => {
    // A rail that refuses every capture as over-cap: the merchant tried to take
    // more than the user approved. This is the case the cap exists for, and the
    // job must fail rather than complete.
    const refusing = new SimulatedPaymentRail();
    const original = refusing.capture.bind(refusing);
    refusing.capture = async () => ({ captured: false, reason: 'above_cap' as const });
    void original;

    const local = await harness({ payments: refusing });
    const quoted = await quotedJob(local);

    const result = await local.orchestrator.authorize(quoted._id, user, {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.code, 'price_increased');
    assert.equal(result.merchantOrderNumber, null, 'nothing may be recorded as ordered');
  });

  it('caps the payment intent at the authorized total plus tolerance', async () => {
    const quoted = await quotedJob(h);
    await h.orchestrator.authorize(quoted._id, user, {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    });

    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.payment?.cap, capFor(quoted.quote!.total));
    // The agent never receives the token itself, only a reference.
    assert.ok(after?.payment?.tokenRef.startsWith('tok_'));
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  it('cancels before submission and returns the cart to the user', async () => {
    const quoted = await quotedJob(h);

    const cancelled = await h.orchestrator.cancel(quoted._id, user);
    assert.equal(cancelled.status, 'cancelled');

    // Nothing may be stranded: the cart goes back to `open` so the user can
    // finish manually.
    const cart = await h.repo.getCart(h.cartId, USER_ID.toHexString());
    assert.equal(cart?.status, 'open');
  });

  it('refuses to cancel once the order has been placed', async () => {
    const quoted = await quotedJob(h);
    await h.orchestrator.authorize(quoted._id, user, {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    });

    // The merchant may already hold it. A cancel that silently does nothing is
    // worse than a refusal.
    await assert.rejects(
      () => h.orchestrator.cancel(quoted._id, user),
      (error: unknown) => error instanceof CheckoutConflict && error.code === 'bad_state',
    );
  });

  it('refuses to cancel another user\'s job', async () => {
    const quoted = await quotedJob(h);
    const stranger = { _id: new ObjectId(), settings: { currency: 'USD' } } as unknown as User;

    await assert.rejects(() => h.orchestrator.cancel(quoted._id, stranger));
    const after = await h.repo.getOrder(quoted._id, USER_ID.toHexString());
    assert.equal(after?.status, 'awaiting_auth');
  });

  // -------------------------------------------------------------------------
  // Merchant-driven failure
  // -------------------------------------------------------------------------

  it('fails cleanly when the merchant blocks agent traffic', async () => {
    const local = await harness();
    local.repo.seed({
      sources: [
        fixtureSource({
          _id: 'shop.test',
          checkout: { protocol: 'browser', blocksAgents: true, stackableCoupons: false },
        } as never),
      ],
    });

    const [order] = await local.orchestrator.createJobs(user, local.cartId);
    const failed = await local.orchestrator.runQuote(order!, user);

    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure?.code, 'blocked');
    // Recoverable, but by the user rather than by a retry: the client deep-links
    // out so the order can be finished on the merchant's own site. Re-running the
    // agent would only get us blocked harder.
    assert.equal(failed.failure?.recoverable, true);
    assert.equal(failed.quote, null, 'a failed quote must not leave a quote to authorize');
  });

  it('cannot authorize a job whose quote failed', async () => {
    const local = await harness();
    local.repo.seed({
      sources: [
        fixtureSource({
          _id: 'shop.test',
          checkout: { protocol: 'browser', blocksAgents: true, stackableCoupons: false },
        } as never),
      ],
    });

    const [order] = await local.orchestrator.createJobs(user, local.cartId);
    await local.orchestrator.runQuote(order!, user);

    await assert.rejects(
      () =>
        local.orchestrator.authorize(order!._id, user, {
          quoteHash: 'a'.repeat(64),
          passkeyAssertion: 'tap_1',
          userAgent: 'test',
        }),
      (error: unknown) => error instanceof CheckoutConflict,
    );
  });
});
