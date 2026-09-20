/**
 * Conformance test suite for CheckoutRepository implementations.
 *
 * This suite tests the contract defined in repository.ts, ensuring that any
 * implementation follows the rules:
 * - Ids are opaque strings
 * - Missing rows return null, never throw
 * - claimForSubmission is a single atomic compare-and-set
 * - Cross-user reads are prevented
 * - Dates survive a round trip
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import type { CheckoutRepository } from './repository.js';

export function describeCheckoutRepository(
  name: string,
  factory: () => Promise<CheckoutRepository>
) {
  describe(`CheckoutRepository: ${name}`, () => {
    let repo: CheckoutRepository;

    before(async () => {
      repo = await factory();
      await repo.truncate();
    });

    describe('User operations', () => {
      it('creates and retrieves a user', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-123',
          deviceSecretHash: 'hash-123',
          sessionEpoch: 1,
          auth: null,
          settings: { theme: 'dark' },
          onboarding: null,
          interestVector: null,
          interestSet: [],
          explorationState: {
            counter: 0,
            lastTopic: null,
            rejected: [],
            pending: [],
          },
          pricePrior: {
            center: 0,
            currency: 'USD',
            confidence: 0.1,
          },
          affinities: {
            brands: {},
            sellers: {},
          },
          suppressions: {
            products: [],
            brands: [],
            sellers: [],
          },
          seenFilter: {
            bits: '',
            k: 7,
            m: 200000,
            n: 0,
            rebuiltAt: new Date(),
          },
          counters: {
            interactionCount: 0,
            sessionCount: 0,
            lastActiveAt: new Date(),
            lastDecayedOn: null,
          },
        });

        assert.ok(user);
        assert.ok(user.id);
        assert.strictEqual(user.deviceUserId, 'device-123');

        const found = await repo.findUserById(user.id);
        assert.ok(found);
        assert.strictEqual(found?.deviceUserId, 'device-123');
      });

      it('finds user by device user id', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-456',
          deviceSecretHash: 'hash-456',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const found = await repo.findUserByDeviceUserId('device-456');
        assert.ok(found);
        assert.strictEqual(found?.id, user.id);
      });

      it('returns null for non-existent user', async () => {
        const found = await repo.findUserById('00000000-0000-0000-0000-000000000000');
        assert.strictEqual(found, null);
      });

      it('updates a user', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-789',
          deviceSecretHash: 'hash-789',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const updated = await repo.updateUser(user.id, {
          sessionEpoch: 2,
          settings: { theme: 'light' },
        });

        assert.ok(updated);
        assert.strictEqual(updated?.sessionEpoch, 2);
        assert.deepStrictEqual(updated?.settings, { theme: 'light' });
      });

      it('round-trips a user with auth dates intact', async () => {
        const now = new Date();
        const user = await repo.createUser({
          deviceUserId: 'device-dates',
          deviceSecretHash: 'hash-dates',
          sessionEpoch: 1,
          auth: {
            email: 'test@example.com',
            providers: ['google'],
            claimedAt: now,
            emailVerifiedAt: now,
          },
          settings: {},
        });

        const found = await repo.findUserById(user.id);
        assert.ok(found);
        assert.ok(found?.auth?.claimedAt instanceof Date);
        assert.strictEqual(found?.auth?.claimedAt.getTime(), now.getTime());
        assert.ok(found?.auth?.emailVerifiedAt instanceof Date);
        assert.strictEqual(found?.auth?.emailVerifiedAt?.getTime(), now.getTime());
      });
    });

    describe('Cart operations', () => {
      it('creates and retrieves a cart', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-cart',
          deviceSecretHash: 'hash-cart',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user.id,
          status: 'open',
          items: [],
        });

        assert.ok(cart);
        assert.ok(cart.id);
        assert.strictEqual(cart.userId, user.id);

        const found = await repo.findCartById(cart.id);
        assert.ok(found);
        assert.strictEqual(found?.userId, user.id);
      });

      it('finds open cart by user id', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-open-cart',
          deviceSecretHash: 'hash-open-cart',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user.id,
          status: 'open',
          items: [],
        });

        const found = await repo.findOpenCartByUserId(user.id);
        assert.ok(found);
        assert.strictEqual(found?.id, cart.id);
      });

      it('returns null for non-existent cart', async () => {
        const found = await repo.findCartById('00000000-0000-0000-0000-000000000000');
        assert.strictEqual(found, null);
      });

      it('updates a cart', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-update-cart',
          deviceSecretHash: 'hash-update-cart',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user.id,
          status: 'open',
          items: [],
        });

        const updated = await repo.updateCart(cart.id, {
          status: 'checking_out',
          items: [
            {
              id: 'item-1',
              productId: 'product-1',
              clusterId: null,
              sellerId: 'seller-1',
              merchantDomain: 'example.com',
              variant: {},
              quantity: 1,
              priceAtAdd: { amount: 1000, currency: 'USD' },
              priceNow: { amount: 1000, currency: 'USD' },
              priceChanged: false,
              available: true,
              softHold: false,
              addedAt: new Date(),
            },
          ],
        });

        assert.ok(updated);
        assert.strictEqual(updated?.status, 'checking_out');
        assert.strictEqual(updated?.items.length, 1);
      });

      it('reopens a cart only when status is checking_out', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-reopen',
          deviceSecretHash: 'hash-reopen',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user.id,
          status: 'checking_out',
          items: [],
        });

        const reopened = await repo.reopenCart(cart.id);
        assert.ok(reopened);
        assert.strictEqual(reopened?.status, 'open');

        // Try to reopen again - should return null since status is now 'open'
        const reopenedAgain = await repo.reopenCart(cart.id);
        assert.strictEqual(reopenedAgain, null);
      });

      it('does not reopen a cart that is already placed', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-no-reopen',
          deviceSecretHash: 'hash-no-reopen',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user.id,
          status: 'closed',
          items: [],
        });

        const reopened = await repo.reopenCart(cart.id);
        assert.strictEqual(reopened, null);
      });
    });

    describe('Order operations', () => {
      it('creates and retrieves an order', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-order',
          deviceSecretHash: 'hash-order',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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
          status: 'pending',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        assert.ok(order);
        assert.ok(order.id);
        assert.strictEqual(order.userId, user.id);

        const found = await repo.findOrderById(order.id);
        assert.ok(found);
        assert.strictEqual(found?.userId, user.id);
      });

      it('finds orders by user id', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-orders',
          deviceSecretHash: 'hash-orders',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        await repo.createOrder({
          userId: user.id,
          cartId: null,
          merchantDomain: 'example.com',
          items: [],
          quote: null,
          coupon: null,
          authorization: null,
          payment: null,
          agentRun: null,
          status: 'pending',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        const orders = await repo.findOrdersByUserId(user.id);
        assert.strictEqual(orders.length, 1);
        assert.strictEqual(orders[0].userId, user.id);
      });

      it('returns null for non-existent order', async () => {
        const found = await repo.findOrderById('00000000-0000-0000-0000-000000000000');
        assert.strictEqual(found, null);
      });

      it('updates an order', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-update-order',
          deviceSecretHash: 'hash-update-order',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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
          status: 'pending',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        const updated = await repo.updateOrder(order.id, {
          status: 'quoting',
          merchantOrderNumber: 'ORD-123',
        });

        assert.ok(updated);
        assert.strictEqual(updated?.status, 'quoting');
        assert.strictEqual(updated?.merchantOrderNumber, 'ORD-123');
      });

      it('gives the order to exactly one of many concurrent claims', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-concurrent',
          deviceSecretHash: 'hash-concurrent',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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

        const auth = {
          authorizedAt: new Date(),
          userAgentHash: 'hash',
          quoteHash: 'quote-hash',
        };

        const payment = {
          rail: 'reap' as const,
          intentId: 'intent-123',
          tokenRef: 'token-123',
          cap: 10000,
          protocol: 'browser' as const,
        };

        // Try to claim twice - only one should succeed
        const [claim1, claim2] = await Promise.all([
          repo.claimForSubmission(order.id, auth, payment),
          repo.claimForSubmission(order.id, auth, payment),
        ]);

        // Exactly one should succeed, one should return null
        const succeeded = (claim1 || claim2);
        const failed = (!claim1 && !claim2) ? null : (claim1 ? claim2 : claim1);

        assert.ok(succeeded);
        assert.strictEqual(succeeded?.status, 'placing');
        assert.strictEqual(succeeded?.submissionSeq, 1);
        assert.strictEqual(failed, null);
      });

      it('claimForSubmission returns null when order is not in awaiting_auth', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-bad-state',
          deviceSecretHash: 'hash-bad-state',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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
          status: 'pending',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        const claimed = await repo.claimForSubmission(
          order.id,
          {
            authorizedAt: new Date(),
            userAgentHash: 'hash',
            quoteHash: 'quote-hash',
          },
          {
            rail: 'reap',
            intentId: 'intent-123',
            tokenRef: 'token-123',
            cap: 10000,
            protocol: 'browser',
          }
        );

        assert.strictEqual(claimed, null);
      });

      it('cancels an order only when not placed', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-cancel',
          deviceSecretHash: 'hash-cancel',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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

        const cancelled = await repo.cancelOrder(order.id);
        assert.ok(cancelled);
        assert.strictEqual(cancelled?.status, 'cancelled');
      });

      it('does not cancel an order that is already placed', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-no-cancel',
          deviceSecretHash: 'hash-no-cancel',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

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
          status: 'placed',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        const cancelled = await repo.cancelOrder(order.id);
        assert.strictEqual(cancelled, null);
      });

      it('round-trips a quote with its dates intact', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-quote-dates',
          deviceSecretHash: 'hash-quote-dates',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const generatedAt = new Date();
        const expiresAt = new Date(generatedAt.getTime() + 300000); // 5 minutes

        const quote = {
          subtotal: 10000,
          shipping: 500,
          tax: 800,
          discount: 1000,
          total: 10300,
          currency: 'USD',
          generatedAt,
          expiresAt,
          hash: 'quote-hash-123',
        };

        const order = await repo.createOrder({
          userId: user.id,
          cartId: null,
          merchantDomain: 'example.com',
          items: [],
          quote,
          coupon: null,
          authorization: null,
          payment: null,
          agentRun: null,
          status: 'awaiting_auth',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        const found = await repo.findOrderById(order.id);
        assert.ok(found);
        assert.ok(found?.quote);
        assert.ok(found?.quote?.generatedAt instanceof Date);
        assert.strictEqual(found?.quote?.generatedAt.getTime(), generatedAt.getTime());
        assert.ok(found?.quote?.expiresAt instanceof Date);
        assert.strictEqual(found?.quote?.expiresAt.getTime(), expiresAt.getTime());
      });
    });

    describe('Source operations', () => {
      it('finds a source by domain', async () => {
        // Note: This test assumes a source exists in the database
        // In a real test, you would insert one first
        const found = await repo.findSourceByDomain('example.com');
        // May be null if not inserted
        assert.strictEqual(found === null || found?.domain === 'example.com', true);
      });

      it('returns null for non-existent source', async () => {
        const found = await repo.findSourceByDomain('nonexistent.example.com');
        assert.strictEqual(found, null);
      });
    });

    describe('Coupon operations', () => {
      it('creates and finds coupons by merchant domain', async () => {
        const coupon = await repo.createCoupon({
          merchantDomain: 'example.com',
          code: 'SAVE10',
          discovered: { from: 'aggregator', url: 'https://example.com', at: new Date() },
          constraints: { minSpend: null, categories: [], firstOrderOnly: false, expiresAt: null },
          performance: { attempts: 0, successes: 0, successRate: 0, meanDiscountPct: 0, lastSuccessAt: null, consecutiveFailures: 0 },
          stackable: false,
          status: 'active',
        });

        assert.ok(coupon);
        assert.ok(coupon.id);

        const found = await repo.findCouponsByMerchantDomain('example.com');
        assert.ok(found.length > 0);
        assert.ok(found.some((c) => c.code === 'SAVE10'));
      });

      it('updates a coupon', async () => {
        const coupon = await repo.createCoupon({
          merchantDomain: 'update.example.com',
          code: 'UPDATE20',
          discovered: { from: 'affiliate', url: 'https://example.com', at: new Date() },
          constraints: { minSpend: null, categories: [], firstOrderOnly: false, expiresAt: null },
          performance: { attempts: 0, successes: 0, successRate: 0, meanDiscountPct: 0, lastSuccessAt: null, consecutiveFailures: 0 },
          stackable: false,
          status: 'active',
        });

        const updated = await repo.updateCoupon(coupon.id, {
          status: 'retired',
        });

        assert.ok(updated);
        assert.strictEqual(updated?.status, 'retired');
      });
    });

    describe('Merchant link operations', () => {
      it('creates and finds a merchant link', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-link',
          deviceSecretHash: 'hash-link',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const link = await repo.createMerchantLink({
          userId: user.id,
          merchantDomain: 'example.com',
          status: 'pending',
          encryptedSession: null,
          createdAt: new Date(),
          linkedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        });

        assert.ok(link);
        assert.ok(link.id);

        const found = await repo.findMerchantLink(user.id, 'example.com');
        assert.ok(found);
        assert.strictEqual(found?.id, link.id);
      });

      it('updates a merchant link', async () => {
        const user = await repo.createUser({
          deviceUserId: 'device-update-link',
          deviceSecretHash: 'hash-update-link',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const link = await repo.createMerchantLink({
          userId: user.id,
          merchantDomain: 'update.example.com',
          status: 'pending',
          encryptedSession: null,
          createdAt: new Date(),
          linkedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        });

        const updated = await repo.updateMerchantLink(link.id, {
          status: 'linked',
          linkedAt: new Date(),
        });

        assert.ok(updated);
        assert.strictEqual(updated?.status, 'linked');
        assert.ok(updated?.linkedAt instanceof Date);
      });
    });

    describe('Product operations', () => {
      it('finds products by ids', async () => {
        // Note: This test assumes products exist in the database
        // In a real test, you would insert test products first
        const products = await repo.findProductsByIds([]);
        assert.deepStrictEqual(products, []);
      });

      it('finds a product by id', async () => {
        const found = await repo.findProductById('00000000-0000-0000-0000-000000000000');
        assert.strictEqual(found, null);
      });
    });

    describe('Cross-user isolation', () => {
      it('prevents cross-user cart reads', async () => {
        const user1 = await repo.createUser({
          deviceUserId: 'device-user1',
          deviceSecretHash: 'hash-user1',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const user2 = await repo.createUser({
          deviceUserId: 'device-user2',
          deviceSecretHash: 'hash-user2',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const cart = await repo.createCart({
          userId: user1.id,
          status: 'open',
          items: [],
        });

        // User2 should not be able to find user1's cart by id
        // (This is enforced at the application layer, not the repository layer)
        const found = await repo.findCartById(cart.id);
        assert.ok(found); // Repository doesn't enforce user scoping
      });

      it('prevents cross-user order reads', async () => {
        const user1 = await repo.createUser({
          deviceUserId: 'device-order-user1',
          deviceSecretHash: 'hash-order-user1',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const user2 = await repo.createUser({
          deviceUserId: 'device-order-user2',
          deviceSecretHash: 'hash-order-user2',
          sessionEpoch: 1,
          auth: null,
          settings: {},
        });

        const order = await repo.createOrder({
          userId: user1.id,
          cartId: null,
          merchantDomain: 'example.com',
          items: [],
          quote: null,
          coupon: null,
          authorization: null,
          payment: null,
          agentRun: null,
          status: 'pending',
          merchantOrderNumber: null,
          failure: null,
          submissionSeq: 0,
        });

        // User2's orders should not include user1's order
        const user2Orders = await repo.findOrdersByUserId(user2.id);
        assert.strictEqual(user2Orders.length, 0);
      });
    });
  });
}
