import type { FieldMap } from './agent.js';

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
  // The local stand-in used by the demo and the tests.
  'northwind.test': {
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
};

export function fieldMapFor(merchantDomain: string): FieldMap | null {
  return MAPS[merchantDomain] ?? null;
}

export function mappedMerchants(): string[] {
  return Object.keys(MAPS);
}
