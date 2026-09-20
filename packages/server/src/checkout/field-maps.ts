import { demoStore } from '../config/demo-store.js';
import type { CheckoutLineItem, FieldMap } from './agent.js';

/**
 * Per-merchant checkout selector maps.
 *
 * The agent does not infer selectors from page text. That is the difference
 * between an agent a merchant page can *inform* and one a merchant page can
 * *instruct*: a model reading "enter the card number in #f-street" from injected
 * content will do it, and a lookup table will not.
 *
 * A merchant with no entry here is not driven at all — `BrowserCheckoutAgent`
 * aborts to a deep-link handoff, because guessing at selectors on a live
 * checkout is how an agent fills the wrong field and buys the wrong thing.
 *
 * Amazon and eBay are deliberately absent and must stay absent: their
 * robots.txt disallows these paths, so they are reached through their official
 * APIs instead. The `robotsAllows` check in the driver enforces that
 * independently of this file.
 */
const MAPS: Record<string, FieldMap> = {
  // The local stand-in used by the demo and the tests. Its domain does not
  // resolve, so it carries the origin it is actually served from.
  'northwind.test': {
    origin: process.env.MOCK_MERCHANT_URL ?? 'http://127.0.0.1:4545',
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
  },

  /**
   * Shopify's one-page checkout.
   *
   * Written against the `name` attributes rather than ids or classes, because
   * Shopify generates ids per render (`TextField12`) and themes rewrite
   * classes, while the form field names are part of how the checkout submits
   * and are stable across themes and stores.
   *
   * A store must permit `/checkouts/` in its own robots.txt for the agent to
   * drive it. Shopify's default disallows it — see `robotsAllows` — so this map
   * only ever applies to a store whose owner has opted in, which in practice
   * means your own. That is the whole point: consent is a per-store fact, not
   * something the map can assume on the store's behalf.
   */
  'shopify.checkout': {
    // Singular. `/checkouts/` is the prefix Shopify puts the *session* under
    // once one exists (`/checkouts/c/<token>`); navigating to it directly is
    // a 404. `/checkout` is the entry point that turns the current cart into
    // a session and redirects there.
    checkoutPath: '/checkout',
    cartPath: shopifyCartPath,
    fields: {
      'contact.email': 'input[name="email"]',
      'ship.firstName': 'input[name="firstName"]',
      'ship.lastName': 'input[name="lastName"]',
      'ship.line1': 'input[name="address1"]',
      'ship.line2': 'input[name="address2"]',
      'ship.city': 'input[name="city"]',
      'ship.postal': 'input[name="postalCode"]',
      'ship.phone': 'input[name="phone"]',
    },
    // Country and state are dropdowns. `ship.country` holds an ISO code and
    // `ship.region` a state code, which is what Shopify's option values use.
    selectFields: {
      'ship.country': 'select[name="countryCode"]',
      'ship.region': 'select[name="zone"]',
    },
    totals: {
      subtotal: '[data-checkout-subtotal-price-target]',
      shipping: '[data-checkout-total-shipping-price-target]',
      tax: '[data-checkout-tax-price-target]',
      discount: '[data-checkout-discount-amount-target]',
      total: '[data-checkout-payment-due-target]',
    },
    placeOrder: '#checkout-pay-button',
  },
};

/**
 * Shopify's cart permalink: `/cart/<variantId>:<qty>,<variantId>:<qty>`.
 *
 * Shopify builds the cart server-side from this URL and redirects, which is
 * why the agent needs no product page and no add-to-cart button — the two
 * things on a storefront most likely to be themed into something a selector
 * map cannot find.
 *
 * The variant id is the numeric id of the *variant*, not the product; a
 * product with one option still has one. It rides on the cart line's
 * `variant` record, so a line added without it cannot be expressed as a link
 * and the whole permalink is abandoned rather than built with a hole in it —
 * a cart missing a line prices wrongly, and pricing wrongly is worse than
 * failing on the checkout page.
 */
function shopifyCartPath(items: readonly CheckoutLineItem[]): string | null {
  if (items.length === 0) return null;

  const parts: string[] = [];
  for (const item of items) {
    const variantId = item.variant['variantId'] ?? item.variant['variant_id'] ?? '';
    // Digits only: this is interpolated into a URL the agent then navigates.
    if (!/^\d+$/.test(variantId)) return null;
    const quantity = Math.max(1, Math.floor(item.quantity));
    parts.push(`${variantId}:${quantity}`);
  }
  return `/cart/${parts.join(',')}`;
}

/**
 * Stores that run Shopify's checkout, pointed at the shared map.
 *
 * Add a domain here once its robots.txt permits `/checkouts/`. Nothing else is
 * needed: the selectors are identical across Shopify stores, which is the
 * reason one map covers a million merchants and the reason this list is the
 * only thing that changes per store.
 */
const SHOPIFY_STORES = (process.env.SHOPIFY_CHECKOUT_DOMAINS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);

/**
 * The storefront gate, when one is configured.
 *
 * Development stores are always password-protected and the page cannot be
 * disabled; live stores have no gate at all. Rather than guess which a store
 * is, the gate exists exactly when a password has been supplied for it — so a
 * live store needs no configuration and a dev store needs one variable.
 */
function storefrontGate(): FieldMap['storefront'] {
  if (!process.env.SHOPIFY_STOREFRONT_PASSWORD) return undefined;
  return {
    path: '/password',
    passwordField: 'input[name="password"]',
    submit: 'form[action*="password"] button[type="submit"]',
    secretEnv: 'SHOPIFY_STOREFRONT_PASSWORD',
  };
}

/**
 * The demo storefront, when one is configured.
 *
 * It runs Shopify's checkout but is presented to shoppers under its own
 * domain, so it takes the shared Shopify selectors with an explicit `origin` —
 * the same shape `northwind.test` uses above, and the reason `origin` is on
 * the map at all. Registering it here rather than in `SHOPIFY_STORES` is what
 * lets the identity the card carries differ from the host the driver dials.
 *
 * Registration is not permission. `robotsAllows` is checked independently by
 * the driver against the real origin, and a store whose robots.txt disallows
 * `/checkouts/` is refused no matter what this map says — which is correct,
 * and which a Shopify store disallows by default until its owner changes it.
 */
function registerDemoStore(): void {
  const store = demoStore();
  if (!store) return;
  const base = MAPS['shopify.checkout'];
  if (!base) return;
  const gate = storefrontGate();
  MAPS[store.domain] = {
    ...base,
    origin: store.origin,
    ...(gate ? { storefront: gate } : {}),
  };
}
registerDemoStore();

export function fieldMapFor(merchantDomain: string): FieldMap | null {
  const direct = MAPS[merchantDomain];
  if (direct) return direct;

  if (SHOPIFY_STORES.includes(merchantDomain.toLowerCase())) {
    const base = MAPS['shopify.checkout'];
    if (!base) return null;
    const gate = storefrontGate();
    return gate ? { ...base, storefront: gate } : base;
  }
  return null;
}

/** Where a mapped merchant is actually reached. */
export function originFor(merchantDomain: string): string {
  return MAPS[merchantDomain]?.origin ?? `https://${merchantDomain}`;
}

export function mappedMerchants(): string[] {
  return Object.keys(MAPS);
}
