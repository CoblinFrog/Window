import { ObjectId } from 'mongodb';
import { CHECKOUT_CONFIG, type OrderStatus } from '@window/shared';
import type { CollectionSet } from '../db/collections.js';
import { logger } from '../lib/logger.js';
import type {
  Cart,
  CheckoutRepository,
  Coupon,
  MerchantLink,
  NewOrder,
  Order,
  OrderPatch,
  Product,
  Source,
} from './repository.js';

const log = logger.child('checkout.repo');

/**
 * The MongoDB implementation of the checkout boundary.
 *
 * It exists so that introducing the interface changed no behaviour: the same
 * queries run against the same collections as before, and the only new thing
 * that happens is `ObjectId` being translated to and from an opaque string at
 * the edge.
 *
 * That translation is the entire job. Above this file ids are strings; below
 * it they are `ObjectId`s, and nothing on either side needs to know about the
 * other's representation.
 */
export class MongoCheckoutRepository implements CheckoutRepository {
  readonly kind = 'mongodb';

  constructor(private readonly collections: CollectionSet) {}

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  async getOpenCart(userId: string): Promise<Cart | null> {
    const cart = await this.collections.carts.findOne({
      userId: new ObjectId(userId),
      status: 'open',
    });
    return cart ? (toPlain(cart) as Cart) : null;
  }

  async getCart(cartId: string, userId: string): Promise<Cart | null> {
    const cart = await this.collections.carts.findOne({
      _id: new ObjectId(cartId),
      userId: new ObjectId(userId),
    });
    return cart ? (toPlain(cart) as Cart) : null;
  }

  async createCart(userId: string, now: Date): Promise<Cart> {
    const cart = {
      userId: new ObjectId(userId),
      status: 'open' as const,
      items: [],
      updatedAt: now,
    };
    const result = await this.collections.carts.insertOne(cart as never);
    return toPlain({ ...cart, _id: result.insertedId }) as Cart;
  }

  async saveCartItems(cartId: string, items: Cart['items'], now: Date): Promise<void> {
    await this.collections.carts.updateOne(
      { _id: new ObjectId(cartId) },
      { $set: { items: items.map(cartItemToMongo) as never, updatedAt: now } },
    );
  }

  async setCartStatus(cartId: string, status: Cart['status'], now: Date): Promise<void> {
    await this.collections.carts.updateOne(
      { _id: new ObjectId(cartId) },
      { $set: { status, updatedAt: now } },
    );
  }

  async reopenCart(cartId: string, expected: Cart['status'], now: Date): Promise<void> {
    // Conditional on the current status, so a late cancellation cannot reopen a
    // cart the user has already moved on from.
    await this.collections.carts.updateOne(
      { _id: new ObjectId(cartId), status: expected },
      { $set: { status: 'open', updatedAt: now } },
    );
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async getOrder(orderId: string, userId: string): Promise<Order | null> {
    const order = await this.collections.orders.findOne({
      _id: new ObjectId(orderId),
      userId: new ObjectId(userId),
    });
    return order ? (toPlain(order) as Order) : null;
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const doc = orderToMongo(order);
    const result = await this.collections.orders.insertOne(doc as never);
    return toPlain({ ...doc, _id: result.insertedId }) as Order;
  }

  async updateOrder(orderId: string, patch: OrderPatch): Promise<Order | null> {
    const updated = await this.collections.orders.findOneAndUpdate(
      { _id: new ObjectId(orderId) },
      { $set: patchToMongo(patch) as never },
      { returnDocument: 'after' },
    );
    return updated ? (toPlain(updated) as Order) : null;
  }

  async listOrders(userId: string, limit: number): Promise<Order[]> {
    const orders = await this.collections.orders
      .find({ userId: new ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return orders.map((order) => toPlain(order) as Order);
  }

  async countOrders(
    userId: string,
    filter: { status: OrderStatus; since?: Date },
  ): Promise<number> {
    return this.collections.orders.countDocuments({
      userId: new ObjectId(userId),
      status: filter.status,
      ...(filter.since ? { createdAt: { $gte: filter.since } } : {}),
    });
  }

  /**
   * The replay guard, as a single conditional update.
   *
   * Mongo applies the filter and the update atomically on one document, so two
   * concurrent callers cannot both match `submissionSeq: 0` — the loser matches
   * nothing and receives null. Read-then-write here would be a race with money
   * on the other side of it.
   */
  async claimForSubmission(orderId: string, patch: OrderPatch): Promise<Order | null> {
    const claimed = await this.collections.orders.findOneAndUpdate(
      { _id: new ObjectId(orderId), status: 'awaiting_auth', submissionSeq: 0 },
      { $set: { ...patchToMongo(patch), submissionSeq: 1 } as never },
      { returnDocument: 'after' },
    );
    return claimed ? (toPlain(claimed) as Order) : null;
  }

  async cancelOrder(orderId: string, userId: string, now: Date): Promise<Order | null> {
    const cancelled = await this.collections.orders.findOneAndUpdate(
      {
        _id: new ObjectId(orderId),
        userId: new ObjectId(userId),
        // Past these three the merchant may already hold the order.
        status: { $nin: ['placed', 'placing', 'uncertain'] },
      },
      { $set: { status: 'cancelled' as OrderStatus, updatedAt: now } },
      { returnDocument: 'after' },
    );
    return cancelled ? (toPlain(cancelled) as Order) : null;
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async getProduct(productId: string): Promise<Product | null> {
    const product = await this.collections.products.findOne({ _id: new ObjectId(productId) });
    return product ? (toPlain(product) as Product) : null;
  }

  async getProducts(productIds: readonly string[]): Promise<Product[]> {
    const ids = [...new Set(productIds)].map((id) => new ObjectId(id));
    const products = await this.collections.products.find({ _id: { $in: ids } }).toArray();
    return products.map((product) => toPlain(product) as Product);
  }

  async getSource(merchantDomain: string): Promise<Source | null> {
    // The domain is the id, so this one needs no translation.
    const source = await this.collections.sources.findOne({ _id: merchantDomain });
    return source ? (toPlain(source) as Source) : null;
  }

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  async listCoupons(merchantDomain: string): Promise<Coupon[]> {
    const coupons = await this.collections.coupons.find({ merchantDomain }).toArray();
    return coupons.map((coupon) => toPlain(coupon) as Coupon);
  }

  async recordCouponOutcome(
    merchantDomain: string,
    code: string,
    outcome: { applied: boolean; observedDiscount: number; subtotal: number; reason: string | null },
    now: Date,
  ): Promise<void> {
    const doc = await this.collections.coupons.findOne({ merchantDomain, code });
    // An unknown code is ignored rather than created: codes enter through
    // discovery, and a failure against one we never had is not evidence.
    if (!doc) return;

    const attempts = doc.performance.attempts + 1;
    const successes = doc.performance.successes + (outcome.applied ? 1 : 0);
    const consecutiveFailures = outcome.applied ? 0 : doc.performance.consecutiveFailures + 1;

    const discountPct =
      outcome.applied && outcome.subtotal > 0
        ? (outcome.observedDiscount / outcome.subtotal) * 100
        : 0;
    const meanDiscountPct = outcome.applied
      ? (doc.performance.meanDiscountPct * doc.performance.successes + discountPct) /
        Math.max(1, successes)
      : doc.performance.meanDiscountPct;

    const retired = consecutiveFailures >= CHECKOUT_CONFIG.couponRetirementFailures;

    await this.collections.coupons.updateOne(
      { _id: doc._id },
      {
        $set: {
          'performance.attempts': attempts,
          'performance.successes': successes,
          'performance.successRate': successes / attempts,
          'performance.meanDiscountPct': Math.round(meanDiscountPct * 10) / 10,
          'performance.consecutiveFailures': consecutiveFailures,
          ...(outcome.applied ? { 'performance.lastSuccessAt': now } : {}),
          ...(retired ? { status: 'retired' as const } : {}),
        },
      },
    );

    if (retired) log.info('coupon retired after consecutive failures', { merchantDomain, code });
  }

  // -------------------------------------------------------------------------
  // Merchant links
  // -------------------------------------------------------------------------

  async upsertMerchantLink(link: Omit<MerchantLink, '_id'>): Promise<void> {
    await this.collections.merchantLinks.updateOne(
      { userId: new ObjectId(link.userId), merchantDomain: link.merchantDomain },
      {
        $set: {
          status: link.status,
          encryptedSession: link.encryptedSession,
          createdAt: link.createdAt,
          linkedAt: link.linkedAt,
          expiresAt: link.expiresAt,
        },
      },
      { upsert: true },
    );
  }

  async getMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null> {
    const link = await this.collections.merchantLinks.findOne({
      userId: new ObjectId(userId),
      merchantDomain,
    });
    return link ? (toPlain(link) as MerchantLink) : null;
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Recursively replaces every `ObjectId` with its hex string.
 *
 * Structural rather than field-by-field because the alternative is a mapping
 * table that silently rots whenever a document grows a field — and the failure
 * mode of a missed field is an `ObjectId` leaking above the boundary, where it
 * compares unequal to the string everything else uses.
 *
 * `Date` is passed through untouched: a quote whose `expiresAt` became a string
 * would never appear expired, because a string is never less than `Date.now()`.
 */
function toPlain(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toPlain);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toPlain(entry);
  }
  return out;
}

/** Ids on the write path, which must be named because a string is ambiguous. */
function cartItemToMongo(item: Cart['items'][number]): unknown {
  return {
    ...item,
    _id: new ObjectId(item._id),
    productId: new ObjectId(item.productId),
    clusterId: item.clusterId ? new ObjectId(item.clusterId) : null,
    sellerId: new ObjectId(item.sellerId),
  };
}

function orderToMongo(order: NewOrder): Record<string, unknown> {
  return {
    ...order,
    userId: new ObjectId(order.userId),
    cartId: new ObjectId(order.cartId),
    items: order.items.map((item) => ({ ...item, productId: new ObjectId(item.productId) })),
  };
}

function patchToMongo(patch: OrderPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if (patch.items) {
    out.items = patch.items.map((item) => ({ ...item, productId: new ObjectId(item.productId) }));
  }
  return out;
}
