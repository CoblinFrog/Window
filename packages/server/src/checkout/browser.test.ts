import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PlaywrightCheckoutBrowser, RobotsDisallowed } from './browser.js';
import { startMockMerchant, type MockMerchant } from './mock-merchant.js';
import { VAULT_FIELDS, VaultHandle, VaultViolation, referenceFor, scrubValues } from './vault.js';
import type { CheckoutPage } from './agent.js';

/**
 * The browser agent, driven against a real browser and a real page.
 *
 * The invariant every case here defends: **the agent fills the form and stops.**
 * It reaches the last screen before money moves, and the only thing that can
 * cross that line is an explicit authorization carrying the quote hash — which
 * lives in the orchestrator, not here.
 */

/** Invented details. No real person, no real address, no real card anywhere. */
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

describe('browser checkout agent', () => {
  let merchant: MockMerchant;
  let browser: PlaywrightCheckoutBrowser;

  before(async () => {
    merchant = await startMockMerchant();
    // The fixture serves plain HTTP on a loopback port, which `robotsAllows`
    // cannot fetch over https — so it fails closed and refuses to navigate.
    // That is correct behaviour, proved by its own case below; here the check
    // is waived so the rest of the agent can be exercised.
    browser = new PlaywrightCheckoutBrowser({
      headless: true,
      timeoutMs: 10_000,
      allowUncheckedHosts: true,
    });
  });

  after(async () => {
    await browser.close();
    await merchant.close();
  });

  async function openCheckout(vault: VaultHandle | null): Promise<CheckoutPage> {
    const page = await browser.newContext({
      merchantDomain: '127.0.0.1',
      sessionHandle: null,
      vault,
    });
    await page.navigate(`${merchant.origin}/checkout`);
    return page;
  }

  /** Fills the delivery form the way the agent does: references, never values. */
  async function fillDelivery(page: CheckoutPage): Promise<void> {
    await page.type('#f-recipient', referenceFor('ship.name'));
    await page.type('#f-street', referenceFor('ship.line1'));
    await page.type('#f-street2', referenceFor('ship.line2'));
    await page.type('#f-town', referenceFor('ship.city'));
    await page.type('#f-state', referenceFor('ship.region'));
    await page.type('#f-zip', referenceFor('ship.postal'));
    await page.type('#f-phone', referenceFor('ship.phone'));
    await page.type('#f-email', referenceFor('contact.email'));
    await page.select('#f-ship', 'standard');
  }

  it('fills the whole delivery form from vault references', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);

    try {
      await fillDelivery(page);

      // Verified in the driver, which compares and discards: the assertion
      // proves the plaintext reached the page without the test ever holding it.
      for (const [selector, field] of [
        ['#f-recipient', 'ship.name'],
        ['#f-street', 'ship.line1'],
        ['#f-street2', 'ship.line2'],
        ['#f-town', 'ship.city'],
        ['#f-state', 'ship.region'],
        ['#f-zip', 'ship.postal'],
        ['#f-phone', 'ship.phone'],
        ['#f-email', 'contact.email'],
      ] as const) {
        assert.ok(
          await page.isFilledWith(selector, referenceFor(field)),
          `${selector} should hold ${field}`,
        );
      }
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('reaches the place-order button without pressing it', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);

    try {
      await fillDelivery(page);

      const dom = await page.readDom();
      assert.ok(dom.includes('Place your order'), 'the final button must be on screen');
      assert.ok(dom.includes('$63.04'), 'the total must be readable for the quote');

      // The whole point. The agent stops here; only an authorization carrying
      // the quote hash may cross this line, and that lives in the orchestrator.
      assert.equal(merchant.orderPlaced(), false, 'nothing may be ordered by quoting');
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('refuses to type into a card field however it is addressed', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);

    try {
      // By id, by name, and by autocomplete attribute — a page that renames its
      // fields does not get to talk the agent into filling them.
      for (const selector of ['#f-card', '#f-cvv', '[name="card_number"]', '[autocomplete="cc-number"]']) {
        await assert.rejects(
          () => page.type(selector, '4111111111111111'),
          (error: unknown) => error instanceof VaultViolation,
          `${selector} must be refused`,
        );
      }

      assert.ok(await page.isEmpty('#f-card'), 'no card field may be touched');
      assert.ok(await page.isEmpty('#f-cvv'));
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('refuses a reference the vault does not hold rather than typing it literally', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);

    try {
      await assert.rejects(
        () => page.type('#f-recipient', '{{ref:ship.nonexistent}}'),
        (error: unknown) => error instanceof VaultViolation,
      );
      assert.ok(await page.isEmpty('#f-recipient'), 'a bad reference must leave the field untouched');
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('never returns the user\'s own values in a DOM read', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);

    try {
      await fillDelivery(page);
      // Drive to the confirmation screen, which echoes nothing — but the
      // scrubber is what protects the general case where a merchant renders the
      // delivery address back onto the page.
      const dom = await page.readDom();

      assert.ok(!dom.includes(FAKE.line1), 'the street address must not reach the agent');
      assert.ok(!dom.includes(FAKE.phone), 'the phone number must not reach the agent');
      assert.ok(!dom.includes(FAKE.email), 'the email must not reach the agent');
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('bounds a DOM read so a merchant cannot flood the agent context', async () => {
    const vault = new VaultHandle(FAKE);
    const page = await openCheckout(vault);
    try {
      const dom = await page.readDom();
      assert.ok(dom.length <= 8_000);
    } finally {
      vault.dispose();
      await page.close();
    }
  });

  it('gives each job its own storage partition', async () => {
    const a = await openCheckout(null);
    const b = await openCheckout(null);

    try {
      await a.navigate(`${merchant.origin}/whoami`);
      await b.navigate(`${merchant.origin}/whoami`);

      // The merchant issues a session cookie per fresh context. Two jobs that
      // shared storage would come back with the same one — which is how one
      // user's checkout session leaks into another's.
      const sessionA = await a.readDom('#sid');
      const sessionB = await b.readDom('#sid');
      assert.notEqual(sessionA, sessionB, 'two jobs must not share a merchant session');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('refuses to navigate when robots.txt disallows the path', async () => {
    // A merchant that disallows its checkout path does not get driven, full
    // stop. This is the control that keeps the agent off Amazon and eBay, whose
    // robots.txt disallow exactly these paths — which is why both are reached
    // through their official APIs instead.
    const strict = await startMockMerchant(0, { disallowCheckout: true });
    const guarded = new PlaywrightCheckoutBrowser({ headless: true, timeoutMs: 10_000 });

    try {
      const page = await guarded.newContext({ merchantDomain: '127.0.0.1', sessionHandle: null });
      await assert.rejects(
        () => page.navigate(`${strict.origin}/checkout`),
        (error: unknown) => error instanceof RobotsDisallowed,
      );
      await page.close();
    } finally {
      await guarded.close();
      await strict.close();
    }
  });

  it('navigates when robots.txt permits the path', async () => {
    // The same gate, live, against a merchant that allows it — so the refusal
    // above is a decision about the rule rather than a network failure.
    const guarded = new PlaywrightCheckoutBrowser({ headless: true, timeoutMs: 10_000 });
    try {
      const page = await guarded.newContext({ merchantDomain: '127.0.0.1', sessionHandle: null });
      await page.navigate(`${merchant.origin}/checkout`);
      assert.ok((await page.readDom()).includes('Place your order'));
      await page.close();
    } finally {
      await guarded.close();
    }
  });

  it('places nothing across the entire suite', () => {
    // The button was never pressed by any case above.
    assert.equal(merchant.orderPlaced(), false);
  });
});

describe('vault', () => {
  it('scrubs values out of merchant-controlled text', () => {
    const vault = new VaultHandle(FAKE);
    const echoed = `Delivering to ${FAKE.name}, ${FAKE.line1}, ${FAKE.city}`;

    const scrubbed = scrubValues(echoed, vault);
    assert.ok(!scrubbed.includes(FAKE.line1));
    assert.ok(scrubbed.includes('[ship.line1]'));
    vault.dispose();
  });

  it('records which fields were used without recording their values', () => {
    const vault = new VaultHandle(FAKE);
    vault.resolve(referenceFor('ship.line1'));

    const trail = JSON.stringify(vault.auditTrail());
    assert.ok(trail.includes('ship.line1'), 'the field name is the audit record');
    assert.ok(!trail.includes(FAKE.line1), 'the value is not');
    vault.dispose();
  });

  it('is unusable after disposal', () => {
    const vault = new VaultHandle(FAKE);
    vault.dispose();
    // A job that has ended cannot have its details read back out of memory.
    assert.throws(() => vault.resolve(referenceFor('ship.line1')), /disposed/);
  });
});

describe('vault reference pattern', () => {
  it('resolves every field name the vault can hold', () => {
    // Field names contain digits (`line1`) and capitals (`firstName`). The
    // pattern has silently failed on both; an unmatched reference is typed
    // into the merchant's form verbatim, so this walks the whole set.
    const vault = new VaultHandle(FAKE);
    try {
      for (const field of VAULT_FIELDS) {
        const resolved = vault.resolve(referenceFor(field));
        assert.ok(
          !resolved.includes('{{ref:'),
          `${field} must resolve, not pass through as a literal`,
        );
      }
    } finally {
      vault.dispose();
    }
  });

  it('derives first and last name from a single display name', () => {
    const vault = new VaultHandle(FAKE);
    try {
      assert.equal(vault.resolve(referenceFor('ship.firstName')), 'Dale');
      assert.equal(vault.resolve(referenceFor('ship.lastName')), 'Cooper');
    } finally {
      vault.dispose();
    }
  });
});
