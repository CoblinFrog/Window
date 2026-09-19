import { randomUUID } from 'node:crypto';
import { CHECKOUT_CONFIG, type OrderStatus } from '@window/shared';
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

const COUPON_RETIREMENT_FAILURES = CHECKOUT_CONFIG.couponRetirementFailures;

/**
 * An in-process implementation of the checkout boundary.
 *
 * Its purpose is to let checkout be built and tested without a database at all.
 * That is not a compromise: the invariants checkout has to hold — one
 * submission per authorization, no cross-user read, a cancel that refuses after
 * the point of no return — are logic, and logic is better tested against a
 * store that starts empty and deterministic every run than against a seeded
 * server somebody has to remember to start.
 *
 * Every document is structurally cloned on the way in and on the way out. A
 * real store cannot hand a caller a live reference into its own state, and a
 * fake that does will hide aliasing bugs that only appear in production.
 */
export class MemoryCheckoutRepository implements CheckoutRepository {
  readonly kind = 'memory';

  private readonly carts = new Map<string, Cart>();
  private readonly orders = new Map<string, Order>();
  private readonly products = new Map<string, Product>();
  private readonly sources = new Map<string, Source>();
  private readonly coupons = new Map<string, Coupon>();
  private readonly links = new Map<string, MerchantLink>();

  // -------------------------------------------------------------------------
  // Test fixtures
  // -------------------------------------------------------------------------

  /** Seeds the read-only catalog a checkout run needs. */
  seed(fixtures: {
    products?: readonly Product[];
    sources?: readonly Source[];
    coupons?: readonly Coupon[];
  }): this {
    for (const product of fixtures.products ?? []) this.products.set(product._id, clone(product));
    for (const source of fixtures.sources ?? []) this.sources.set(source._id, clone(source));
    for (const coupon of fixtures.coupons ?? []) this.coupons.set(coupon._id, clone(coupon));
    return this;
  }

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  async getOpenCart(userId: string): Promise<Cart | null> {
    for (const cart of this.carts.values()) {
      if (cart.userId === userId && cart.status === 'open') return clone(cart);
    }
    return null;
  }

  async getCart(cartId: string, userId: string): Promise<Cart | null> {
    const cart = this.carts.get(cartId);
    // Scoped, exactly as the real store is. A fake that ignores the user id
    // lets a cross-user read pass its tests and fail in production.
    return cart && cart.userId === userId ? clone(cart) : null;
  }

  async createCart(userId: string, now: Date): Promise<Cart> {
    const cart: Cart = { _id: newId(), userId, status: 'open', items: [], updatedAt: now };
    this.carts.set(cart._id, cart);
    return clone(cart);
  }

  async saveCartItems(cartId: string, items: Cart['items'], now: Date): Promise<void> {
    const cart = this.carts.get(cartId);
    if (!cart) return;
    cart.items = clone(items) as Cart['items'];
    cart.updatedAt = now;
  }

  async setCartStatus(cartId: string, status: Cart['status'], now: Date): Promise<void> {
    const cart = this.carts.get(cartId);
    if (!cart) return;
    cart.status = status;
    cart.updatedAt = now;
  }

  async reopenCart(cartId: string, expected: Cart['status'], now: Date): Promise<void> {
    const cart = this.carts.get(cartId);
    if (!cart || cart.status !== expected) return;
    cart.status = 'open';
    cart.updatedAt = now;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async getOrder(orderId: string, userId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    return order && order.userId === userId ? clone(order) : null;
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const stored: Order = { ...clone(order), _id: newId() };
    this.orders.set(stored._id, stored);
    return clone(stored);
  }

  async updateOrder(orderId: string, patch: OrderPatch): Promise<Order | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    Object.assign(order, clone(patch));
    return clone(order);
  }

  async listOrders(userId: string, limit: number): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((order) => order.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async countOrders(
    userId: string,
    filter: { status: OrderStatus; since?: Date },
  ): Promise<number> {
    return [...this.orders.values()].filter(
      (order) =>
        order.userId === userId &&
        order.status === filter.status &&
        (!filter.since || order.createdAt.getTime() >= filter.since.getTime()),
    ).length;
  }

  /**
   * The replay guard.
   *
   * JavaScript's single-threaded execution makes this atomic here for free,
   * which is exactly why the conformance suite matters: the guarantee this
   * method provides is trivial to hold in memory and easy to get wrong in SQL.
   */
  async claimForSubmission(orderId: string, patch: OrderPatch): Promise<Order | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status !== 'awaiting_auth' || order.submissionSeq !== 0) return null;

    Object.assign(order, clone(patch));
    order.submissionSeq = 1;
    return clone(order);
  }

  async cancelOrder(orderId: string, userId: string, now: Date): Promise<Order | null> {
    const order = this.orders.get(orderId);
    if (!order || order.userId !== userId) return null;
    // Past these three states the merchant may already hold the order.
    if (order.status === 'placed' || order.status === 'placing' || order.status === 'uncertain') {
      return null;
    }

    order.status = 'cancelled';
    order.updatedAt = now;
    return clone(order);
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async getProduct(productId: string): Promise<Product | null> {
    const product = this.products.get(productId);
    return product ? clone(product) : null;
  }

  async getProducts(productIds: readonly string[]): Promise<Product[]> {
    const found: Product[] = [];
    for (const id of new Set(productIds)) {
      const product = this.products.get(id);
      if (product) found.push(clone(product));
    }
    return found;
  }

  async getSource(merchantDomain: string): Promise<Source | null> {
    const source = this.sources.get(merchantDomain);
    return source ? clone(source) : null;
  }

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  async listCoupons(merchantDomain: string): Promise<Coupon[]> {
    return [...this.coupons.values()]
      .filter((coupon) => coupon.merchantDomain === merchantDomain)
      .map(clone);
  }

  /**
   * The coupon learning loop, mirroring `CouponStore.recordAttempt`.
   *
   * An unknown code is ignored rather than created: codes enter the store
   * through discovery, and a failed attempt against one we never had is not
   * evidence of anything worth recording.
   */
  async recordCouponOutcome(
    merchantDomain: string,
    code: string,
    outcome: { applied: boolean; observedDiscount: number; subtotal: number; reason: string | null },
    now: Date,
  ): Promise<void> {
    const coupon = [...this.coupons.values()].find(
      (candidate) => candidate.merchantDomain === merchantDomain && candidate.code === code,
    );
    if (!coupon) return;

    const attempts = coupon.performance.attempts + 1;
    const successes = coupon.performance.successes + (outcome.applied ? 1 : 0);
    const consecutiveFailures = outcome.applied ? 0 : coupon.performance.consecutiveFailures + 1;

    const discountPct =
      outcome.applied && outcome.subtotal > 0
        ? (outcome.observedDiscount / outcome.subtotal) * 100
        : 0;
    const meanDiscountPct = outcome.applied
      ? (coupon.performance.meanDiscountPct * coupon.performance.successes + discountPct) /
        Math.max(1, successes)
      : coupon.performance.meanDiscountPct;

    coupon.performance = {
      attempts,
      successes,
      successRate: successes / attempts,
      meanDiscountPct: Math.round(meanDiscountPct * 10) / 10,
      consecutiveFailures,
      lastSuccessAt: outcome.applied ? now : coupon.performance.lastSuccessAt,
    };
    if (consecutiveFailures >= COUPON_RETIREMENT_FAILURES) coupon.status = 'retired';
  }

  // -------------------------------------------------------------------------
  // Merchant links
  // -------------------------------------------------------------------------

  async upsertMerchantLink(link: Omit<MerchantLink, '_id'>): Promise<void> {
    const key = `${link.userId}:${link.merchantDomain}`;
    const existing = this.links.get(key);
    this.links.set(key, { ...clone(link), _id: existing?._id ?? newId() });
  }

  async getMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null> {
    const link = this.links.get(`${userId}:${merchantDomain}`);
    return link ? clone(link) : null;
  }
}

/** Ids are opaque to every caller, so a uuid is as good as anything else. */
function newId(): string {
  return randomUUID();
}

/**
 * Deep clone preserving `Date`.
 *
 * `structuredClone` handles dates correctly, where a JSON round trip would turn
 * every one of them into a string — and `expiresAt` being a string rather than
 * a Date is precisely the bug that would make an expired quote look valid.
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}
