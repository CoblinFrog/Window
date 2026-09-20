import { randomUUID } from 'node:crypto';
import {
  ApiError,
  PROBLEM_TYPES,
  type AddCartItemRequest,
  type CartLine,
  type CartResponse,
} from '@window/shared';
import type { User } from '../db/supabase-collections.js';
import type { Cart, CheckoutRepository, Product } from '../checkout/repository.js';
import { logger } from '../lib/logger.js';
import { cautionText } from '../ingestion/quality.js';
import { riskFlagText } from '../ingestion/risk.js';

const log = logger.child('cart');

/**
 * The cart.
 *
 * One Window cart holds line items from any number of merchants, which no
 * merchant cart does. Internally it decomposes into one checkout job per
 * merchant, and that decomposition is why checkout has to be delegated to an
 * agent at all.
 *
 * Nothing is ever bought at a price the user has not seen: price and stock are
 * re-verified when the cart is opened and again at checkout, and any change is
 * surfaced as a diff the user must acknowledge.
 */

export interface VerificationResult {
  productId: string;
  inStock: boolean;
  priceAmount: number;
  currency: string;
}

/**
 * Just-in-time verification. A single tier-2 or tier-3 check runs the moment a
 * product is added to cart, and again immediately before checkout. This is the
 * only freshness guarantee the product actually promises.
 */
export interface StockVerifier {
  verify(products: readonly Product[]): Promise<VerificationResult[]>;
}

/**
 * The default verifier reads the stored listing rather than re-fetching the
 * merchant page, because no crawl fleet runs in this environment. It is
 * deliberately a separate object so that wiring in a real tier-2 check is an
 * injection rather than an edit to the cart's logic.
 */
export class StoredListingVerifier implements StockVerifier {
  async verify(products: readonly Product[]): Promise<VerificationResult[]> {
    return products.map((product) => ({
      productId: product.id,
      inStock: product.stock.inStock && product.status === 'active',
      priceAmount: product.price.amount,
      currency: product.price.currency,
    }));
  }
}

export interface CartDeps {
  repository: CheckoutRepository;
  verifier?: StockVerifier;
}

export class CartService {
  private readonly verifier: StockVerifier;

  constructor(private readonly deps: CartDeps) {
    this.verifier = deps.verifier ?? new StoredListingVerifier();
  }

  async openCart(user: User, now = new Date()): Promise<Cart> {
    const { repository } = this.deps;
    const existing = await repository.getOpenCart(user.id);
    return existing ?? (await repository.createCart(user.id, now));
  }

  /**
   * Adding to cart never navigates away, so this has to be fast and it has to
   * refuse clearly. Auction items cannot be added at all: the card's bag button
   * is replaced by "Open to bid", which deep-links out, and agentic bidding is
   * out of scope because it is a liability question rather than an engineering
   * one.
   */
  async addItem(
    user: User,
    request: AddCartItemRequest,
    now = new Date(),
  ): Promise<Cart> {
    const { repository } = this.deps;
    const product = await repository.getProduct(request.productId);
    if (!product) throw ApiError.notFound('That product');

    if (product.sourceType === 'auction') {
      throw new ApiError(
        PROBLEM_TYPES.auctionNotPurchasable,
        409,
        'Auction items cannot be added to cart',
        'Open this listing to bid on the source site. Window does not bid on your behalf.',
        { productId: request.productId, sourceUrl: product.source.url },
      );
    }
    if (product.risk.tier === 'high' || product.risk.tier === 'blocked') {
      throw new ApiError(
        PROBLEM_TYPES.checkoutBlocked,
        403,
        'Checkout blocked for this listing',
        riskFlagText(product.risk as never) ??
          'This listing was withheld from checkout for safety reasons.',
        { productId: request.productId },
      );
    }
    if (!product.stock.inStock) {
      throw ApiError.validation('That product is out of stock.');
    }

    const cart = await this.openCart(user, now);
    const quantity = Math.max(1, Math.min(request.quantity ?? 1, product.stock.quantity ?? 99));
    const variant = request.variant ?? {};

    // A repeat add of the same product and variant raises the quantity rather
    // than creating a second line, which is what a user expects from tapping
    // the same bag twice.
    const variantKey = JSON.stringify(variant);
    const existing = cart.items.find(
      (item) => item.productId === product.id && JSON.stringify(item.variant) === variantKey,
    );

    if (existing) {
      existing.quantity = Math.min(existing.quantity + quantity, product.stock.quantity ?? 99);
    } else {
      cart.items.push({
        id: randomUUID(),
        productId: product.id,
        clusterId: product.clusterId,
        sellerId: product.sellerId,
        merchantDomain: product.source.domain,
        variant,
        quantity,
        priceAtAdd: product.price,
        priceNow: product.price,
        priceChanged: false,
        available: true,
        // Window cannot reserve inventory it does not own, and the UI says so.
        softHold: product.stock.singleUnit,
        addedAt: now,
      });
    }

    await repository.saveCartItems(cart.id, cart.items, now);
    return cart;
  }

  async updateItem(
    user: User,
    lineId: string,
    patch: { quantity?: number; variant?: Record<string, string> },
    now = new Date(),
  ): Promise<Cart> {
    const cart = await this.openCart(user, now);
    const line = cart.items.find((item) => item.id === lineId);
    if (!line) throw ApiError.notFound('That cart line');

    if (patch.quantity !== undefined) {
      if (patch.quantity < 1) throw ApiError.validation('quantity must be at least 1.');
      line.quantity = patch.quantity;
    }
    if (patch.variant) line.variant = patch.variant;

    await this.deps.repository.saveCartItems(cart.id, cart.items, now);
    return cart;
  }

  async removeItem(user: User, lineId: string, now = new Date()): Promise<Cart> {
    const cart = await this.openCart(user, now);
    const next = cart.items.filter((item) => item.id !== lineId);
    if (next.length === cart.items.length) throw ApiError.notFound('That cart line');

    await this.deps.repository.saveCartItems(cart.id, next, now);
    return { ...cart, items: next };
  }

  /**
   * Re-verifies every line and returns the cart with a diff. A price that moved
   * or a line that went out of stock is surfaced, never silently applied — the
   * cart is the last place the user sees a number before an agent starts
   * spending against it.
   */
  async view(user: User, now = new Date()): Promise<CartResponse> {
    const { repository } = this.deps;
    const cart = await this.openCart(user, now);

    if (cart.items.length === 0) {
      return {
        cartId: cart.id,
        status: cart.status,
        lines: [],
        byMerchant: [],
        diffs: [],
        total: { amount: 0, currency: user.settings.currency },
        verifiedAt: now.toISOString(),
      };
    }

    const products = await repository.getProducts(cart.items.map((i) => i.productId));
    const productById = new Map(products.map((p) => [p.id, p]));

    const verified = await this.verifier.verify(products);
    const verifiedById = new Map(verified.map((v) => [v.productId, v]));

    const diffs: CartResponse['diffs'] = [];
    const lines: CartLine[] = [];

    for (const item of cart.items) {
      const key = item.productId;
      const product = productById.get(key);
      const check = verifiedById.get(key);
      if (!product || !check) {
        item.available = false;
        diffs.push({ lineId: item.id, kind: 'out_of_stock', from: item.priceNow, to: null });
        continue;
      }

      const previous = item.priceNow;
      const next = { amount: check.priceAmount, currency: check.currency };

      if (!check.inStock && item.available) {
        diffs.push({ lineId: item.id, kind: 'out_of_stock', from: previous, to: null });
      } else if (next.amount !== previous.amount) {
        diffs.push({
          lineId: item.id,
          kind: next.amount > previous.amount ? 'price_up' : 'price_down',
          from: previous,
          to: next,
        });
      }

      item.priceNow = next;
      item.priceChanged = next.amount !== item.priceAtAdd.amount;
      item.available = check.inStock;

      const caution = product.quality.cautions?.[0] ?? null;
      lines.push({
        id: item.id,
        productId: key,
        clusterId: item.clusterId,
        title: product.title,
        merchant: { domain: item.merchantDomain, displayName: item.merchantDomain },
        seller: { id: item.sellerId, handle: item.merchantDomain },
        hero: product.media.hero,
        variant: item.variant,
        quantity: item.quantity,
        priceAtAdd: item.priceAtAdd,
        priceNow: item.priceNow,
        priceChanged: item.priceChanged,
        available: item.available,
        softHold: item.softHold,
        badges: {
          source: product.sourceType,
          condition: product.sourceType === 'new' ? null : product.condition,
          priceContext: null,
          onlyOne: product.stock.singleUnit && product.sourceType !== 'new',
          endsAt: null,
          riskFlag: riskFlagText(product.risk as never),
          wellReviewed: false,
          caution: caution ? cautionText(caution) : null,
        },
      });
    }

    await repository.saveCartItems(cart.id, cart.items, now);

    if (diffs.length > 0) {
      log.info('cart diff surfaced', { cartId: cart.id, diffs: diffs.length });
    }

    const byMerchant = new Map<string, { lineIds: string[]; subtotal: number; currency: string }>();
    for (const line of lines) {
      if (!line.available) continue;
      const entry = byMerchant.get(line.merchant.domain) ?? {
        lineIds: [],
        subtotal: 0,
        currency: line.priceNow.currency,
      };
      entry.lineIds.push(line.id);
      entry.subtotal += line.priceNow.amount * line.quantity;
      byMerchant.set(line.merchant.domain, entry);
    }

    const currency = lines[0]?.priceNow.currency ?? user.settings.currency;
    return {
      cartId: cart.id,
      status: cart.status,
      lines,
      byMerchant: [...byMerchant.entries()].map(([domain, entry]) => ({
        domain,
        displayName: domain,
        lineIds: entry.lineIds,
        subtotal: { amount: entry.subtotal, currency: entry.currency },
      })),
      diffs,
      total: {
        amount: lines
          .filter((l) => l.available)
          .reduce((sum, l) => sum + l.priceNow.amount * l.quantity, 0),
        currency,
      },
      verifiedAt: now.toISOString(),
    };
  }

  /** Queued offline cart adds are replayed here when connectivity returns. */
  async replayQueued(
    user: User,
    requests: readonly AddCartItemRequest[],
    now = new Date(),
  ): Promise<{ added: number; failed: Array<{ productId: string; reason: string }> }> {
    let added = 0;
    const failed: Array<{ productId: string; reason: string }> = [];
    for (const request of requests) {
      try {
        await this.addItem(user, request, now);
        added += 1;
      } catch (error) {
        failed.push({ productId: request.productId, reason: (error as Error).message });
      }
    }
    return { added, failed };
  }
}
