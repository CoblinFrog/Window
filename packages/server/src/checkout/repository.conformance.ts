import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderStatus, ProductDoc, SourceDoc } from '@window/shared';
import type { CheckoutRepository, NewOrder, Product, Source } from './repository.js';

/**
 * The contract every `CheckoutRepository` must satisfy.
 *
 * This is the deliverable that makes a second implementation cheap. A new
 * backing store is finished when this suite is green against it — not when it
 * compiles, and not when it looks right. Run it like this:
 *
 * ```ts
 * // repository.supabase.test.ts
 * import { describeCheckoutRepository } from './repository.conformance.js';
 *
 * describeCheckoutRepository('supabase', async () => {
 *   const repo = new SupabaseCheckoutRepository(client);
 *   await repo.truncate();          // each case starts from empty
 *   return repo;
 * });
 * ```
 *
 * The cases are written as the things that must not happen. A suite that only
 * proved the happy path would pass against a store with no scoping and no
 * compare-and-set — which is to say, against the two bugs that matter most.
 */
export function describeCheckoutRepository(
  name: string,
  freshRepository: () => Promise<CheckoutRepository>,
): void {
  describe(`CheckoutRepository conformance: ${name}`, () => {
    // -----------------------------------------------------------------------
    // Scoping. Every read is scoped to a user; none of them is a filter the
    // caller supplies and can forget.
    // -----------------------------------------------------------------------

    it('never returns one user\'s cart to another', async () => {
      const repo = await freshRepository();
      const mine = await repo.createCart('user_a', new Date());

      assert.notEqual(await repo.getCart(mine._id, 'user_a'), null);
      assert.equal(await repo.getCart(mine._id, 'user_b'), null);
    });

    it('never returns one user\'s order to another', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ userId: 'user_a' }));

      assert.notEqual(await repo.getOrder(order._id, 'user_a'), null);
      // This is the IDOR the checkout routes depend on being impossible.
      assert.equal(await repo.getOrder(order._id, 'user_b'), null);
    });

    it('lists only the caller\'s own orders', async () => {
      const repo = await freshRepository();
      await repo.createOrder(newOrder({ userId: 'user_a' }));
      await repo.createOrder(newOrder({ userId: 'user_b' }));

      const mine = await repo.listOrders('user_a', 50);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.userId, 'user_a');
    });

    it('refuses to cancel another user\'s order', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ userId: 'user_a' }));

      assert.equal(await repo.cancelOrder(order._id, 'user_b', new Date()), null);
      const still = await repo.getOrder(order._id, 'user_a');
      assert.equal(still?.status, 'awaiting_auth');
    });

    // -----------------------------------------------------------------------
    // The replay guard. One authorization, at most one order.
    // -----------------------------------------------------------------------

    it('claims an order for submission exactly once', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ status: 'awaiting_auth' }));

      const first = await repo.claimForSubmission(order._id, { status: 'placing' });
      assert.notEqual(first, null);
      assert.equal(first?.status, 'placing');
      assert.equal(first?.submissionSeq, 1);

      // The second caller must get null, not a second claim on the same order.
      assert.equal(await repo.claimForSubmission(order._id, { status: 'placing' }), null);
    });

    it('gives the order to exactly one of many concurrent claims', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ status: 'awaiting_auth' }));

      // The real contention case: a double-tap, a retried request, two tabs.
      // If a store implements this as read-then-write, this is where it fails.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.claimForSubmission(order._id, { status: 'placing' })),
      );

      assert.equal(results.filter((r) => r !== null).length, 1);
    });

    it('refuses to claim an order that is not awaiting authorization', async () => {
      const repo = await freshRepository();
      for (const status of ['pending', 'quoting', 'placing', 'placed', 'cancelled', 'failed'] as const) {
        const order = await repo.createOrder(newOrder({ status }));
        assert.equal(
          await repo.claimForSubmission(order._id, { status: 'placing' }),
          null,
          `status ${status} must not be claimable`,
        );
      }
    });

    it('returns null rather than throwing when the claim is lost', async () => {
      // Contention is ordinary, not exceptional: the caller turns it into a
      // 409. A store that throws here turns a normal double-tap into a 500.
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ status: 'awaiting_auth' }));
      await repo.claimForSubmission(order._id, { status: 'placing' });

      await assert.doesNotReject(() => repo.claimForSubmission(order._id, { status: 'placing' }));
    });

    // -----------------------------------------------------------------------
    // Cancellation. Refusing is required; silently doing nothing is not.
    // -----------------------------------------------------------------------

    it('refuses to cancel past the point of no return', async () => {
      const repo = await freshRepository();
      for (const status of ['placing', 'placed', 'uncertain'] as const) {
        const order = await repo.createOrder(newOrder({ status }));
        assert.equal(
          await repo.cancelOrder(order._id, 'user_a', new Date()),
          null,
          `${status} must not be cancellable`,
        );
      }
    });

    it('cancels an order that has not been submitted', async () => {
      const repo = await freshRepository();
      for (const status of ['pending', 'quoting', 'awaiting_auth'] as const) {
        const order = await repo.createOrder(newOrder({ status }));
        const cancelled = await repo.cancelOrder(order._id, 'user_a', new Date());
        assert.equal(cancelled?.status, 'cancelled', `${status} must be cancellable`);
      }
    });

    // -----------------------------------------------------------------------
    // Round-tripping. Types have to survive storage.
    // -----------------------------------------------------------------------

    it('round-trips a quote with its dates intact', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({}));
      const expiresAt = new Date('2026-06-01T12:00:00.000Z');

      await repo.updateOrder(order._id, {
        quote: {
          subtotal: 1000,
          shipping: 500,
          tax: 90,
          discount: 100,
          total: 1490,
          currency: 'USD',
          generatedAt: new Date('2026-06-01T11:50:00.000Z'),
          expiresAt,
          hash: 'a'.repeat(64),
        },
      });

      const stored = await repo.getOrder(order._id, 'user_a');
      // A Date that came back as a string would make every expired quote look
      // valid, because a string is never less than Date.now().
      assert.ok(stored?.quote?.expiresAt instanceof Date, 'expiresAt must be a Date');
      assert.equal(stored?.quote?.expiresAt.toISOString(), expiresAt.toISOString());
      assert.equal(stored?.quote?.total, 1490);
    });

    it('round-trips money as integer minor units', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(
        newOrder({ items: [{ productId: 'p1', title: 'Thing', quantity: 3, unitPrice: 1999, variant: {} }] }),
      );

      const stored = await repo.getOrder(order._id, 'user_a');
      // 1999 must not come back as 19.99, "1999.00", or a float.
      assert.equal(stored?.items[0]?.unitPrice, 1999);
      assert.equal(Number.isInteger(stored?.items[0]?.unitPrice), true);
    });

    it('round-trips an empty variant map without turning it into null', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(
        newOrder({ items: [{ productId: 'p1', title: 'Thing', quantity: 1, unitPrice: 100, variant: {} }] }),
      );

      const stored = await repo.getOrder(order._id, 'user_a');
      assert.deepEqual(stored?.items[0]?.variant, {});
    });

    it('does not hand out a live reference into its own state', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({}));

      const first = await repo.getOrder(order._id, 'user_a');
      first!.status = 'placed' as OrderStatus;

      const second = await repo.getOrder(order._id, 'user_a');
      // Mutating a returned document must not mutate the store. A real database
      // gets this for free; an in-process one has to be deliberate about it.
      assert.equal(second?.status, 'awaiting_auth');
    });

    it('applies a patch without dropping unmentioned fields', async () => {
      const repo = await freshRepository();
      const order = await repo.createOrder(newOrder({ merchantDomain: 'shop.test' }));

      await repo.updateOrder(order._id, { status: 'quoting' });
      const stored = await repo.getOrder(order._id, 'user_a');

      assert.equal(stored?.status, 'quoting');
      assert.equal(stored?.merchantDomain, 'shop.test', 'a patch must not clear other fields');
    });

    // -----------------------------------------------------------------------
    // Carts
    // -----------------------------------------------------------------------

    it('finds the open cart and ignores closed ones', async () => {
      const repo = await freshRepository();
      const first = await repo.createCart('user_a', new Date());
      await repo.setCartStatus(first._id, 'closed', new Date());

      assert.equal(await repo.getOpenCart('user_a'), null);

      const second = await repo.createCart('user_a', new Date());
      assert.equal((await repo.getOpenCart('user_a'))?._id, second._id);
    });

    it('reopens a cart only from the expected status', async () => {
      const repo = await freshRepository();
      const cart = await repo.createCart('user_a', new Date());
      await repo.setCartStatus(cart._id, 'closed', new Date());

      // A cancellation arriving late must not reopen a cart the user has since
      // moved on from.
      await repo.reopenCart(cart._id, 'checking_out', new Date());
      assert.equal((await repo.getCart(cart._id, 'user_a'))?.status, 'closed');

      await repo.setCartStatus(cart._id, 'checking_out', new Date());
      await repo.reopenCart(cart._id, 'checking_out', new Date());
      assert.equal((await repo.getCart(cart._id, 'user_a'))?.status, 'open');
    });

    // -----------------------------------------------------------------------
    // Counting, which feeds the daily spend rule
    // -----------------------------------------------------------------------

    it('counts placed orders within a window', async () => {
      const repo = await freshRepository();
      const now = new Date('2026-06-02T00:00:00.000Z');
      const old = new Date('2026-05-01T00:00:00.000Z');

      await repo.createOrder(newOrder({ status: 'placed', createdAt: now }));
      await repo.createOrder(newOrder({ status: 'placed', createdAt: old }));
      await repo.createOrder(newOrder({ status: 'failed', createdAt: now }));

      assert.equal(await repo.countOrders('user_a', { status: 'placed' }), 2);
      assert.equal(
        await repo.countOrders('user_a', {
          status: 'placed',
          since: new Date('2026-06-01T00:00:00.000Z'),
        }),
        1,
      );
    });

    // -----------------------------------------------------------------------
    // Missing rows are null, never an exception
    // -----------------------------------------------------------------------

    it('returns null for absent rows rather than throwing', async () => {
      const repo = await freshRepository();
      const absent = '00000000-0000-4000-8000-000000000000';

      assert.equal(await repo.getOrder(absent, 'user_a'), null);
      assert.equal(await repo.getCart(absent, 'user_a'), null);
      assert.equal(await repo.getProduct(absent), null);
      assert.equal(await repo.getSource('nobody.test'), null);
      assert.equal(await repo.getMerchantLink('user_a', 'nobody.test'), null);
      assert.deepEqual(await repo.getProducts([absent]), []);
    });
  });
}

/** A minimal order, overridable per case. Defaults to the interesting state. */
export function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    userId: 'user_a',
    cartId: 'cart_a',
    merchantDomain: 'shop.test',
    items: [{ productId: 'p1', title: 'Thing', quantity: 1, unitPrice: 1000, variant: {} }],
    quote: null,
    coupon: null,
    authorization: null,
    payment: null,
    agentRun: null,
    status: 'awaiting_auth',
    merchantOrderNumber: null,
    failure: null,
    submissionSeq: 0,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A product with only the fields checkout actually reads. */
export function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    _id: 'p1',
    title: 'Thing',
    price: { amount: 1000, currency: 'USD' },
    stock: { inStock: true, quantity: 5, singleUnit: false },
    risk: { tier: 'low', score: 0.1 },
    status: 'active',
    sourceType: 'new',
    source: { domain: 'shop.test', url: 'https://shop.test/p/1' },
    ...overrides,
  } as unknown as ProductDoc<string> as Product;
}

/** A merchant source with only the fields checkout actually reads. */
export function fixtureSource(overrides: Partial<Source> = {}): Source {
  return {
    _id: 'shop.test',
    displayName: 'Shop',
    sourceType: 'new',
    checkout: { protocol: 'browser', blocksAgents: false, stackableCoupons: false },
    ...overrides,
  } as unknown as SourceDoc<string> as Source;
}
