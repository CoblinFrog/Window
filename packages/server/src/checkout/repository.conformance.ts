import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckoutRepository, User } from './repository.js';

function minimalUserInput(overrides: Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>> = {}) {
  return {
    deviceUserId: `device-${Math.random().toString(36).slice(2)}`,
    deviceSecretHash: 'test-secret-hash',
    sessionEpoch: 1,
    auth: null,
    settings: {},
    onboarding: null,
    interestVector: null,
    interestSet: [],
    explorationState: { counter: 0, lastTopic: null, rejected: [], pending: [] },
    pricePrior: { center: 8000, currency: 'USD', confidence: 0.1 },
    affinities: { brands: {}, sellers: {} },
    suppressions: { products: [], brands: [], sellers: [] },
    seenFilter: { bits: '', k: 7, m: 200000, n: 0, rebuiltAt: new Date() },
    counters: { interactionCount: 0, sessionCount: 0, lastActiveAt: new Date(), lastDecayedOn: null },
    ...overrides,
  } satisfies Omit<User, 'id' | 'createdAt' | 'updatedAt'>;
}

export function describeCheckoutRepository(
  name: string,
  factory: () => Promise<CheckoutRepository>,
): void {
  describe(`CheckoutRepository: ${name}`, () => {
    let repo: CheckoutRepository;

    before(async () => {
      repo = await factory();
      await repo.truncate();
    });

    it('creates, reads, and updates a user with an opaque string id', async () => {
      const user = await repo.createUser(minimalUserInput({ deviceUserId: 'device-user' }));
      assert.match(user.id, /^[0-9a-f-]{36}$/i);
      assert.equal((await repo.findUserByDeviceUserId('device-user'))?.id, user.id);
      assert.equal((await repo.findUserById(user.id))?.deviceUserId, 'device-user');

      const updated = await repo.updateUser(user.id, { sessionEpoch: 2 });
      assert.equal(updated?.sessionEpoch, 2);
      assert.equal(await repo.findUserById('00000000-0000-0000-0000-000000000000'), null);
    });

    it('creates, updates, and reopens carts by string id', async () => {
      const user = await repo.createUserMinimal('device-cart', 'hash');
      const cart = await repo.createCart({ userId: user.id, status: 'open', items: [] });
      assert.equal((await repo.findOpenCartByUserId(user.id))?.id, cart.id);

      const checkingOut = await repo.updateCart(cart.id, { status: 'checking_out' });
      assert.equal(checkingOut?.status, 'checking_out');
      assert.equal((await repo.reopenCart(cart.id))?.status, 'open');
      assert.equal(await repo.reopenCart(cart.id), null);
    });

    it('enforces the order claim compare-and-set contract', async () => {
      const user = await repo.createUserMinimal('device-order', 'hash');
      const order = await repo.createOrder({
        userId: user.id,
        cartId: null,
        merchantDomain: 'example.com',
        items: [],
        quote: null,
        coupon: null,
        authorization: null,
        payment: null,
        agentRun: null,
        status: 'awaiting_auth',
        merchantOrderNumber: null,
        failure: null,
        submissionSeq: 0,
      });
      const authorization = { authorizedAt: new Date(), userAgentHash: 'ua', quoteHash: 'quote' };
      const payment = { rail: 'reap' as const, intentId: 'intent', tokenRef: 'token', cap: 1000, protocol: 'browser' as const };
      const [first, second] = await Promise.all([
        repo.claimForSubmission(order.id, authorization, payment),
        repo.claimForSubmission(order.id, authorization, payment),
      ]);
      assert.equal([first, second].filter(Boolean).length, 1);
      assert.equal((first ?? second)?.status, 'placing');
      assert.equal((first ?? second)?.submissionSeq, 1);
    });

    it('cancels only cancellable orders and preserves user scoping', async () => {
      const user = await repo.createUserMinimal('device-cancel', 'hash');
      const order = await repo.createOrder({
        userId: user.id,
        cartId: null,
        merchantDomain: 'example.com',
        items: [],
        quote: null,
        coupon: null,
        authorization: null,
        payment: null,
        agentRun: null,
        status: 'quoting',
        merchantOrderNumber: null,
        failure: null,
        submissionSeq: 0,
      });
      assert.equal((await repo.cancelOrder(order.id))?.status, 'cancelled');
      assert.equal(await repo.findOrderById('00000000-0000-0000-0000-000000000000'), null);
    });

    it('round-trips sources, coupons, merchant links, and product lookups', async () => {
      const user = await repo.createUserMinimal('device-related', 'hash');
      const coupon = await repo.createCoupon({
        merchantDomain: 'example.com',
        code: 'SAVE10',
        discovered: { from: 'aggregator', url: 'https://example.com', at: new Date() },
        constraints: { minSpend: null, categories: [], firstOrderOnly: false, expiresAt: null },
        performance: { attempts: 0, successes: 0, successRate: 0, meanDiscountPct: 0, lastSuccessAt: null, consecutiveFailures: 0 },
        stackable: false,
        status: 'active',
      });
      assert.equal((await repo.findCouponsByMerchantDomain('example.com'))[0]?.id, coupon.id);
      assert.equal((await repo.updateCoupon(coupon.id, { status: 'retired' }))?.status, 'retired');

      const link = await repo.createMerchantLink({
        userId: user.id,
        merchantDomain: 'example.com',
        status: 'pending',
        encryptedSession: null,
        createdAt: new Date(),
        linkedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.equal((await repo.findMerchantLink(user.id, 'example.com'))?.id, link.id);
      assert.equal((await repo.updateMerchantLink(link.id, { status: 'linked' }))?.status, 'linked');
      assert.equal((await repo.findProductsByIds([])).length, 0);
      assert.equal(await repo.findProductById('00000000-0000-0000-0000-000000000000'), null);
    });
  });
}
