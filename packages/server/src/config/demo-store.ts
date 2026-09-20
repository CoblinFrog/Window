import { createHash } from 'node:crypto';

/**
 * The demo storefront.
 *
 * One real store, seeded into the catalog and pinned to the scroll, so the
 * checkout path can be shown end to end against a live merchant rather than
 * against the mock. Everything here is configuration: unset `DEMO_STORE_ORIGIN`
 * and the module goes inert — nothing is pinned, no field map is registered,
 * and the feed behaves exactly as it does without it.
 *
 * `domain` and `origin` are deliberately separate, and the split is the whole
 * point of this file. `domain` is the merchant identity a card carries — what
 * the shopper reads, what the checkout field map is keyed by, what the order
 * is grouped under. `origin` is where that merchant is actually reached. They
 * differ only while the store is still on its platform-issued hostname, and
 * they converge the moment a custom domain is attached to it. That convergence
 * is the end state this is shaped for: one name that is both what the shopper
 * reads and where the bytes come from. Until then `domain` is a label the
 * deployment asserts, so it must be a domain you actually control — a label
 * naming someone else's business is the one way to misuse this.
 *
 * The same shape already exists for `northwind.test`, whose hostname does not
 * resolve and which therefore carries the origin it is really served from.
 * This is that mechanism pointed at a real store.
 */

export interface DemoStoreProduct {
  /** The product's handle on the store; the last path segment of its URL. */
  handle: string;
  /** L3 taxonomy id. Fixed here rather than guessed at seed time. */
  l3: string;
  /**
   * Stand-in photograph, used instead of the one on the store.
   *
   * The catalog will not show an image below 800px on the short edge, and the
   * gate reads the bytes rather than the claim, so a store whose own shot is
   * smaller than that has no way to appear with it. Pointing at a larger image
   * here is the escape hatch. It is a demo affordance and it is honest only
   * while the demo is a demo: the image is not the store's own, so anything
   * shown outside a dev catalog wants the real photograph uploaded instead.
   */
  image?: string;
}

export interface DemoStore {
  /** The merchant identity the card shows. */
  domain: string;
  /** Where that merchant is actually reached, scheme included, no trailing slash. */
  origin: string;
  displayName: string;
  products: DemoStoreProduct[];
  /** Catalog ids for `products`, in the same order. */
  productIds: string[];
  /**
   * Where in the page the pinned products sit.
   *
   * Not zero, deliberately. A product held at the top of every page reads as
   * an advertisement — it is the one slot a shopper learns to skip, and it
   * announces that the placement is editorial rather than earned. Far enough
   * down that it arrives mid-scroll, the same listing reads as something the
   * feed found. A page shorter than this places them at its end instead.
   */
  pinOffset: number;
}

/**
 * Defaults describe the store this was built against, so the seeder and the
 * pin both work with no configuration. Every one of them is overridable, and a
 * different deployment is expected to override all of them.
 */
const DEFAULT_ORIGIN = 'https://mr17uc-64.myshopify.com';
const DEFAULT_DOMAIN = 'kaungsupply.com';
const DEFAULT_NAME = 'Kaung Supply Co.';
const DEFAULT_PRODUCTS: DemoStoreProduct[] = [
  {
    handle: 'kaung-short-sleeve-t-shirt',
    l3: 't-shirts',
    // The store's own shot is 768px on the short edge, below the catalog's
    // floor. See `image` above.
    //
    // Asked for at 1400px as JPEG rather than at source size: the media
    // pipeline has no codec, so `resolve` hands back the stored original for
    // every requested width, and whatever is ingested here is what a 480px
    // feed tile downloads. The 4500px PNG is 8.2MB and made the grid crawl;
    // this is 96KB, still covers the widest derivative, and is the same order
    // as the other product's photograph.
    image:
      'https://www.tuffwraps.com/cdn/shop/files/tuff-basic-tee-s-midnight-navy-tuffwraps-1154449040.png?v=1743852291&width=1400&format=jpg',
  },
  { handle: 'kaung-composition-book', l3: 'softcover-notebooks' },
];

const DEFAULT_PIN_OFFSET = 15;

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

/**
 * A stable uuid per (domain, handle).
 *
 * Derived rather than stored so the seeder and the pin agree on an id without
 * one having to read it back from the other, and so re-seeding updates a row
 * instead of growing a second copy of it.
 */
export function demoProductId(domain: string, handle: string): string {
  const h = createHash('sha256').update(`${domain}:${handle}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/** A stable uuid for the store's single seller row. */
export function demoSellerId(domain: string): string {
  return demoProductId(domain, '__seller__');
}

let cached: DemoStore | null | undefined;

/** The configured demo store, or null when the deployment has not set one. */
export function demoStore(): DemoStore | null {
  if (cached !== undefined) return cached;

  // An explicit empty origin is how a deployment turns this off outright.
  const origin = str('DEMO_STORE_ORIGIN', DEFAULT_ORIGIN).replace(/\/+$/, '');
  if (origin === '') {
    cached = null;
    return cached;
  }

  const handles = str('DEMO_STORE_HANDLES', '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Handles configured without an L3 fall back to the notebook shelf rather
  // than to an empty category: a product with no taxonomy path is invisible to
  // topic-scoped retrieval and to every quad, which reads as "the pin is
  // broken" rather than as "the category was not stated".
  const products: DemoStoreProduct[] =
    handles.length > 0
      ? handles.map((handle) => {
          const known = DEFAULT_PRODUCTS.find((p) => p.handle === handle);
          return {
            handle,
            l3: known?.l3 ?? 'softcover-notebooks',
            ...(known?.image ? { image: known.image } : {}),
          };
        })
      : DEFAULT_PRODUCTS;

  const domain = str('DEMO_STORE_DOMAIN', DEFAULT_DOMAIN).toLowerCase();

  cached = {
    domain,
    origin,
    displayName: str('DEMO_STORE_NAME', DEFAULT_NAME),
    products,
    productIds: products.map((product) => demoProductId(domain, product.handle)),
    pinOffset: int('DEMO_STORE_PIN_OFFSET', DEFAULT_PIN_OFFSET),
  };
  return cached;
}

/** Test seam: forgets the memoized read so a changed environment is picked up. */
export function resetDemoStore(): void {
  cached = undefined;
}
