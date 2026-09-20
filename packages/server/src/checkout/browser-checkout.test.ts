import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryCache } from '../cache/index.js';
import type { User } from '../db/supabase-collections.js';
import { CheckoutOrchestrator } from './orchestrator.js';
import { MemoryCheckoutRepository } from './repository.memory.js';
import { fixtureProduct, fixtureSource } from './repository.conformance.js';
import { PlaywrightCheckoutBrowser } from './browser.js';
import { startMockMerchant, type MockMerchant } from './mock-merchant.js';
import { BrowserCheckoutAgent, type FieldMap } from './agent.js';
import { SimulatedPaymentRail } from './payments.js';
import { VaultHandle } from './vault.js';
import type { Cart } from './repository.js';

/**
 * The checkout button, end to end, with a real browser doing the work.
 *
 * This is the path `POST /v1/checkout/quote` takes: the orchestrator decomposes
 * the cart, hands the job to the browser agent, the agent drives the merchant's
 * own checkout and stops, and nothing is placed until `authorize` arrives
 * carrying the hash of the quote the user was shown.
 *
 * The suite asserts the two halves separately, because the gap between them is
 * the entire safety argument: after quoting, the merchant has no order; after
 * authorizing, it has exactly one.
 */

const USER_ID = 'd290f1ee-6c54-4b01-90e6-d701748f0851';
const user = { id: USER_ID, settings: { currency: 'USD' } } as unknown as User;

const FAKE = {
  name: 'Dale Cooper',
  line1: '1 Great Northern Road',
  line2: 'Room 315',
  city: 'Twin Peaks',
  region: 'WA',
  postal: '98170',
  country: 'US',
  phone: '555-0142',
  email: 'dale.cooper@example.test',
};

/** The selector map for our stand-in merchant. Configuration, not inference. */
const NORTHWIND: FieldMap = {
  checkoutPath: '/checkout',
  fields: {
    'ship.name': '#f-recipient',
    'ship.line1': '#f-street',
    'ship.line2': '#f-street2',
    'ship.city': '#f-town',
    'ship.region': '#f-state',
    'ship.postal': '#f-zip',
    'ship.phone': '#f-phone',
    'contact.email': '#f-email',
  },
  shipping: { selector: '#f-ship', value: 'standard' },
  totals: {
    subtotal: '#t-subtotal',
    shipping: '#t-shipping',
    tax: '#t-tax',
    discount: '#t-discount',
    total: '#t-total',
  },
  placeOrder: '#place-order',
};

describe('checkout button → browser agent', () => {
  let merchant: MockMerchant;
  let browser: PlaywrightCheckoutBrowser;
  let repo: MemoryCheckoutRepository;
  let orchestrator: CheckoutOrchestrator;
  let vault: VaultHandle;
  let cartId: string;

  before(async () => {
    merchant = await startMockMerchant();
    browser = new PlaywrightCheckoutBrowser({ headless: true, allowUncheckedHosts: true });
    vault = new VaultHandle(FAKE);

    repo = new MemoryCheckoutRepository();
    repo.seed({
      products: [fixtureProduct({ id: 'prod_1', title: 'Field Notebook' })],
      sources: [fixtureSource({ id: 'northwind.test' })],
    });

    const cart = await repo.createCart(USER_ID, new Date());
    cartId = cart.id;
    await repo.saveCartItems(
      cart.id,
      [
        {
          id: 'line_1',
          productId: 'prod_1',
          clusterId: null,
          sellerId: 'seller_1',
          merchantDomain: 'northwind.test',
          variant: {},
          quantity: 1,
          priceAtAdd: { amount: 6400, currency: 'USD' },
          priceNow: { amount: 6400, currency: 'USD' },
          priceChanged: false,
          available: true,
          softHold: false,
          addedAt: new Date(),
        } as unknown as Cart['items'][number],
      ],
      new Date(),
    );

    orchestrator = new CheckoutOrchestrator({
      repository: repo,
      cache: new MemoryCache(),
      payments: new SimulatedPaymentRail(),
      // Exactly what `CHECKOUT_AGENT=browser` builds, minus the env read.
      agentFor: async () =>
        new BrowserCheckoutAgent(browser, {
          fieldMapFor: (domain) => (domain === 'northwind.test' ? NORTHWIND : null),
          vault,
          originFor: () => merchant.origin,
        }),
    });
  });

  after(async () => {
    vault.dispose();
    await browser.close();
    await merchant.close();
  });

  it('quotes by driving the merchant, reading its totals, and stopping', async () => {
    const [order] = await orchestrator.createJobs(user, cartId);
    const quoted = await orchestrator.runQuote(order!, user);

    assert.equal(quoted.status, 'awaiting_auth', quoted.failure?.message ?? '');
    // Every number comes off the merchant's own page, not from our arithmetic.
    assert.equal(quoted.quote?.subtotal, 6400);
    assert.equal(quoted.quote?.tax, 544);
    assert.equal(quoted.quote?.discount, 640);
    assert.equal(quoted.quote?.total, 6304);

    // The merchant has no order. This is the gap the authorization sits in.
    assert.equal(merchant.orderPlaced(), false, 'quoting must place nothing');
    assert.equal(quoted.submissionSeq, 0);
  });

  it('places the order only once an authorization echoes that exact quote', async () => {
    const [order] = await orchestrator.createJobs(user, cartId);
    const quoted = await orchestrator.runQuote(order!, user);
    assert.equal(quoted.status, 'awaiting_auth');
    assert.equal(merchant.orderPlaced(), false);

    const placed = await orchestrator.authorize(quoted.id, user, {
      quoteHash: quoted.quote!.hash,
      passkeyAssertion: 'tap_1',
      userAgent: 'test',
    });

    assert.ok(['placed', 'uncertain'].includes(placed.status), placed.failure?.message ?? '');
    assert.equal(placed.submissionSeq, 1);
    // Now — and only now — the merchant has the order.
    assert.equal(merchant.orderPlaced(), true);
    assert.equal(placed.merchantOrderNumber, 'NW-4417-2290');
  });

  it('refuses a mismatched hash and leaves the merchant untouched', async () => {
    const local = await startMockMerchant();
    try {
      const isolated = new CheckoutOrchestrator({
        repository: repo,
        cache: new MemoryCache(),
        payments: new SimulatedPaymentRail(),
        agentFor: async () =>
          new BrowserCheckoutAgent(browser, {
            fieldMapFor: () => NORTHWIND,
            vault,
            originFor: () => local.origin,
          }),
      });

      const [order] = await isolated.createJobs(user, cartId);
      const quoted = await isolated.runQuote(order!, user);

      await assert.rejects(() =>
        isolated.authorize(quoted.id, user, {
          quoteHash: 'f'.repeat(64),
          passkeyAssertion: 'tap_1',
          userAgent: 'test',
        }),
      );
      assert.equal(local.orderPlaced(), false, 'a refused authorization must place nothing');
    } finally {
      await local.close();
    }
  });

  it('hands off rather than guessing when it has no field map', async () => {
    const local = await startMockMerchant();
    try {
      const unmapped = new CheckoutOrchestrator({
        repository: repo,
        cache: new MemoryCache(),
        payments: new SimulatedPaymentRail(),
        agentFor: async () =>
          // No map for this merchant. Guessing selectors on a live checkout is
          // how an agent fills the wrong field and buys the wrong thing.
          new BrowserCheckoutAgent(browser, {
            fieldMapFor: () => null,
            vault,
            originFor: () => local.origin,
          }),
      });

      const [order] = await unmapped.createJobs(user, cartId);
      const failed = await unmapped.runQuote(order!, user);

      assert.equal(failed.status, 'failed');
      assert.equal(failed.failure?.code, 'blocked');
      assert.equal(failed.quote, null, 'a failed quote leaves nothing to authorize');
      assert.equal(local.orderPlaced(), false);
    } finally {
      await local.close();
    }
  });
});
