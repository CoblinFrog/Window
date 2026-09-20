import type {
  CartDoc,
  CouponDoc,
  MerchantLinkRecord,
  OrderDoc,
  OrderStatus,
  ProductDoc,
  SourceDoc,
} from '@window/shared';

/**
 * The checkout data boundary.
 *
 * Checkout needs seven tables and nothing else — no vector index, no ranking
 * state, no clusters or reviews. Naming that subset as an interface is what
 * lets the checkout system be built and tested against one implementation while
 * a different one is written behind it, which is the same pattern `PaymentRail`,
 * `CheckoutAgent`, `StockVerifier` and `VectorSearch` already follow here.
 *
 * Two rules keep it portable:
 *
 * **Ids are opaque strings.** Not `ObjectId`, not `uuid` — a string the store
 * issued and the caller only ever echoes back. A Mongo implementation hands out
 * hex, a Postgres one hands out uuids, and no code above this line can tell.
 *
 * **No query language crosses it.** Every method is a named operation with a
 * meaning, not a filter document. `claimForSubmission` is the clearest case: as
 * a raw update it is four conditions an implementation could get subtly wrong,
 * and as a method it is one guarantee that can be tested once and relied on.
 */

/** Documents at this boundary are the generic shapes with string ids. */
export type Cart = CartDoc<string>;
export type Order = OrderDoc<string>;
export type Product = ProductDoc<string>;
export type Source = SourceDoc<string>;
export type Coupon = CouponDoc<string>;
export type MerchantLink = MerchantLinkRecord<string>;

/** The fields a new order is created with. The store assigns `id`. */
export type NewOrder = Omit<Order, 'id'>;

/**
 * A partial update to an order.
 *
 * Deliberately a shallow patch of whole fields rather than a path-based update:
 * `quote` and `payment` are written as complete values, which is what makes
 * them a `jsonb` column in Postgres and a subdocument in Mongo without either
 * implementation needing to understand the other's update syntax.
 */
export type OrderPatch = Partial<
  Pick<
    Order,
    | 'items'
    | 'quote'
    | 'coupon'
    | 'status'
    | 'authorization'
    | 'payment'
    | 'agentRun'
    | 'merchantOrderNumber'
    | 'failure'
    | 'updatedAt'
  >
>;

export interface CheckoutRepository {
  /** Names the backing store, for logs and the health endpoint. */
  readonly kind: string;

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  /** The user's open cart, or null. Scoped by user: there is no unscoped read. */
  getOpenCart(userId: string): Promise<Cart | null>;

  /** A cart by id, scoped to its owner. */
  getCart(cartId: string, userId: string): Promise<Cart | null>;

  createCart(userId: string, now: Date): Promise<Cart>;

  /** Replaces the line array wholesale, which is how the cart service mutates it. */
  saveCartItems(cartId: string, items: Cart['items'], now: Date): Promise<void>;

  setCartStatus(cartId: string, status: Cart['status'], now: Date): Promise<void>;

  /**
   * Returns a cancelled job's cart to `open`.
   *
   * Conditional on the current status so that a cancellation arriving after the
   * user already started a new checkout cannot reopen the cart underneath it.
   */
  reopenCart(cartId: string, expected: Cart['status'], now: Date): Promise<void>;

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /** Scoped by user. Every order read in a request path goes through this. */
  getOrder(orderId: string, userId: string): Promise<Order | null>;

  createOrder(order: NewOrder): Promise<Order>;

  /** Applies a patch and returns the updated document. */
  updateOrder(orderId: string, patch: OrderPatch): Promise<Order | null>;

  listOrders(userId: string, limit: number): Promise<Order[]>;

  countOrders(userId: string, filter: { status: OrderStatus; since?: Date }): Promise<number>;

  /**
   * Atomically claims an order for submission. **The replay guard.**
   *
   * Moves `awaiting_auth` → `placing` and `submissionSeq` 0 → 1, and returns
   * the updated order, or null if either condition already failed. The whole
   * point is that two concurrent authorizations cannot both receive an order:
   * exactly one gets the document and the other gets null.
   *
   * This must be a single atomic compare-and-set in the store — a read followed
   * by a write is not an implementation of it, however carefully it is written.
   * In Postgres that is one statement:
   *
   * ```sql
   * UPDATE orders SET status = 'placing', submission_seq = 1, ...
   *  WHERE id = $1 AND status = 'awaiting_auth' AND submission_seq = 0
   *  RETURNING *;
   * ```
   *
   * A zero-row result is the contention case and must return null, not throw.
   */
  claimForSubmission(orderId: string, patch: OrderPatch): Promise<Order | null>;

  /**
   * Cancels an order unless it has reached a point of no return.
   *
   * `placed`, `placing` and `uncertain` cannot be cancelled: the merchant may
   * already hold the order, and a cancel that silently does nothing is worse
   * than a refusal. Conditional in the store for the same reason as above.
   */
  cancelOrder(orderId: string, userId: string, now: Date): Promise<Order | null>;

  // -------------------------------------------------------------------------
  // Catalog, read-only from checkout's point of view
  // -------------------------------------------------------------------------

  getProduct(productId: string): Promise<Product | null>;

  /** Batch read. Order is not guaranteed; callers index by id. */
  getProducts(productIds: readonly string[]): Promise<Product[]>;

  /** A merchant's source record, keyed by domain. */
  getSource(merchantDomain: string): Promise<Source | null>;

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  listCoupons(merchantDomain: string): Promise<Coupon[]>;

  /** Upserts the learning-loop counters for one code on one merchant. */
  recordCouponOutcome(
    merchantDomain: string,
    code: string,
    outcome: { applied: boolean; observedDiscount: number; subtotal: number; reason: string | null },
    now: Date,
  ): Promise<void>;

  // -------------------------------------------------------------------------
  // Merchant links
  // -------------------------------------------------------------------------

  upsertMerchantLink(link: Omit<MerchantLink, 'id'>): Promise<void>;

  getMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null>;
}
