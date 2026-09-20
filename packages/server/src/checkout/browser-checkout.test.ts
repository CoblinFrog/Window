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
import { fieldMapFor } from './field-maps.js';
import { referenceFor } from './vault.js';
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

/**
 * The Shopify field map, against a Shopify-shaped page.
 *
 * This proves the map is well-formed and that the driver can drive that shape:
 * split names, `<select>` country and state, Shopify's totals attributes and
 * its pay-button id. It proves nothing about Shopify's live DOM — only a real
 * store can do that, and this is what makes the difference between the two
 * clear rather than assumed.
 */
describe('shopify field map', () => {
  let merchant: MockMerchant;
  let browser: PlaywrightCheckoutBrowser;
  let vault: VaultHandle;

  before(async () => {
    merchant = await startMockMerchant(0, { shopifyShaped: true });
    browser = new PlaywrightCheckoutBrowser({ headless: true, allowUncheckedHosts: true });
    vault = new VaultHandle(FAKE);
  });

  after(async () => {
    vault.dispose();
    await browser.close();
    await merchant.close();
  });

  it('fills a Shopify-shaped checkout and reads its totals', async () => {
    const map = fieldMapFor('shopify.checkout');
    assert.ok(map, 'the shared Shopify map must exist');

    const agent = new BrowserCheckoutAgent(browser, {
      fieldMapFor: () => map,
      vault,
      originFor: () => merchant.origin,
    });

    const quote = await agent.quote({
      session: { jobId: 'job_shopify', merchantDomain: 'shopify.checkout', toolCalls: [], screenshots: [] },
      merchantDomain: 'shopify.checkout',
      items: [
        {
          productId: 'p1',
          title: 'Field Notebook',
          url: merchant.origin,
          variant: {},
          quantity: 1,
          expectedUnitPrice: 6400,
          currency: 'USD',
        },
      ],
      coupons: [],
      allowStacking: false,
    });

    // Read off the fixture's own totals, in minor units.
    assert.equal(quote.subtotal, 6400);
    assert.equal(quote.tax, 544);
    assert.equal(quote.discount, 640);
    assert.equal(quote.total, 6304);
    assert.equal(merchant.orderPlaced(), false, 'quoting must place nothing');
  });

  it('splits a single display name across first and last name fields', async () => {
    const page = await browser.newContext({
      merchantDomain: 'shopify.checkout',
      sessionHandle: null,
      vault,
    });
    try {
      await page.navigate(`${merchant.origin}/checkouts`);
      await page.type('input[name="firstName"]', referenceFor('ship.firstName'));
      await page.type('input[name="lastName"]', referenceFor('ship.lastName'));

      assert.ok(await page.isFilledWith('input[name="firstName"]', referenceFor('ship.firstName')));
      assert.ok(await page.isFilledWith('input[name="lastName"]', referenceFor('ship.lastName')));
    } finally {
      await page.close();
    }
  });

  it('chooses country and state from their dropdowns', async () => {
    const page = await browser.newContext({
      merchantDomain: 'shopify.checkout',
      sessionHandle: null,
      vault,
    });
    try {
      await page.navigate(`${merchant.origin}/checkouts`);
      // Typing into a <select> silently does nothing and the parcel goes to the
      // default country, so these must go through selectOption.
      await page.select('select[name="countryCode"]', referenceFor('ship.country'));
      await page.select('select[name="zone"]', referenceFor('ship.region'));

      assert.ok(await page.isFilledWith('select[name="countryCode"]', referenceFor('ship.country')));
      assert.ok(await page.isFilledWith('select[name="zone"]', referenceFor('ship.region')));
    } finally {
      await page.close();
    }
  });
});

/**
 * A storefront behind a password gate.
 *
 * Shopify development stores are always password-protected, so a staging store
 * is unreachable until the agent signs in with the store's own password. This
 * is the demo path: a private store, dummy products, a real checkout.
 */
describe('storefront password gate', () => {
  const PASSWORD = 'let-me-in-please';
  let merchant: MockMerchant;
  let browser: PlaywrightCheckoutBrowser;
  let vault: VaultHandle;

  before(async () => {
    merchant = await startMockMerchant(0, { shopifyShaped: true, storefrontPassword: PASSWORD });
    browser = new PlaywrightCheckoutBrowser({ headless: true, allowUncheckedHosts: true });
    vault = new VaultHandle(FAKE);
  });

  after(async () => {
    delete process.env.DEMO_STOREFRONT_PASSWORD;
    vault.dispose();
    await browser.close();
    await merchant.close();
  });

  function agentFor(): BrowserCheckoutAgent {
    const base = fieldMapFor('shopify.checkout')!;
    return new BrowserCheckoutAgent(browser, {
      fieldMapFor: () => ({
        ...base,
        storefront: {
          path: '/password',
          passwordField: 'input[name="password"]',
          submit: 'button[type="submit"]',
          secretEnv: 'DEMO_STOREFRONT_PASSWORD',
        },
      }),
      vault,
      originFor: () => merchant.origin,
    });
  }

  const quoteInput = () => ({
    session: { jobId: 'job_gate', merchantDomain: 'shopify.checkout', toolCalls: [], screenshots: [] },
    merchantDomain: 'shopify.checkout',
    items: [
      {
        productId: 'p1',
        title: 'Field Notebook',
        url: merchant.origin,
        variant: {},
        quantity: 1,
        expectedUnitPrice: 6400,
        currency: 'USD',
      },
    ],
    coupons: [],
    allowStacking: false,
  });

  it('refuses to run when the gate password is not configured', async () => {
    delete process.env.DEMO_STOREFRONT_PASSWORD;
    // Better to abort than to drive blindly into a password page and report
    // whatever totals it fails to find there.
    await assert.rejects(
      () => agentFor().quote(quoteInput()),
      (error: unknown) => (error as Error).message.includes('DEMO_STOREFRONT_PASSWORD'),
    );
  });

  it('signs in past the gate and quotes the checkout behind it', async () => {
    process.env.DEMO_STOREFRONT_PASSWORD = PASSWORD;
    const steps: string[] = [];

    const quote = await agentFor().quote({ ...quoteInput(), onStep: (s) => steps.push(s) });

    assert.equal(quote.subtotal, 6400);
    assert.equal(quote.total, 6304);
    assert.ok(steps.includes('storefront gate passed'));
    // The password is a credential: it may appear in no step, anywhere.
    assert.ok(!steps.join(' ').includes(PASSWORD), 'the password must never reach the step log');
    assert.equal(merchant.orderPlaced(), false);
  });
});
