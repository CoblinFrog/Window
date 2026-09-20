import type { SupabaseClient } from '@supabase/supabase-js';
import { CHECKOUT_CONFIG, type OrderStatus } from '@window/shared';
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
 * The Supabase implementation of the checkout boundary.
 *
 * Two conventions, both load-bearing:
 *
 * **Column names are snake_case; everything inside a `jsonb` column is not.**
 * The row-level mapping is shallow on purpose. A `quote`, an `authorization` or
 * a cart's `items` is stored exactly as the application holds it, so the round
 * trip is symmetric. Snake-casing on the way in while reading shallowly on the
 * way out is the asymmetry that silently turns `authorizedAt` into `undefined`.
 *
 * **Every read that can reach a user's data takes a `userId`.** Not because the
 * caller might forget — because at this layer forgetting is impossible. The
 * scoping is in the signature, so there is no version of `getOrder` that
 * returns somebody else's order.
 */
export class SupabaseCheckoutRepository implements CheckoutRepository {
  readonly kind = 'supabase';

  constructor(private readonly client: SupabaseClient) {}

  /** Test-only. Empties the checkout tables so each case starts from nothing. */
  async truncate(): Promise<void> {
    for (const table of ['orders', 'carts', 'merchant_links', 'coupons']) {
      await this.client.from(table).delete().neq('id', ZERO_UUID);
    }
  }

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  async getOpenCart(userId: string): Promise<Cart | null> {
    return this.oneCart(
      this.client.from('carts').select('*').eq('user_id', userId).eq('status', 'open').limit(1),
    );
  }

  async getCart(cartId: string, userId: string): Promise<Cart | null> {
    return this.oneCart(
      this.client.from('carts').select('*').eq('id', cartId).eq('user_id', userId).limit(1),
    );
  }

  async createCart(userId: string, now: Date): Promise<Cart> {
    const { data, error } = await this.client
      .from('carts')
      .insert({ user_id: userId, status: 'open', items: [], updated_at: now.toISOString() })
      .select()
      .single();
    if (error) throw error;
    return rowToCart(data);
  }

  async saveCartItems(cartId: string, items: Cart['items'], now: Date): Promise<void> {
    const { error } = await this.client
      .from('carts')
      .update({ items, updated_at: now.toISOString() })
      .eq('id', cartId);
    if (error) throw error;
  }

  async setCartStatus(cartId: string, status: Cart['status'], now: Date): Promise<void> {
    const { error } = await this.client
      .from('carts')
      .update({ status, updated_at: now.toISOString() })
      .eq('id', cartId);
    if (error) throw error;
  }

  async reopenCart(cartId: string, expected: Cart['status'], now: Date): Promise<void> {
    // Conditional in the statement, so a cancellation arriving after the user
    // started a new checkout cannot reopen the cart underneath it.
    const { error } = await this.client
      .from('carts')
      .update({ status: 'open', updated_at: now.toISOString() })
      .eq('id', cartId)
      .eq('status', expected);
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async getOrder(orderId: string, userId: string): Promise<Order | null> {
    return this.oneOrder(
      this.client.from('orders').select('*').eq('id', orderId).eq('user_id', userId).limit(1),
    );
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const { data, error } = await this.client
      .from('orders')
      .insert(orderToRow(order))
      .select()
      .single();
    if (error) throw error;
    return rowToOrder(data);
  }

  async updateOrder(orderId: string, patch: OrderPatch): Promise<Order | null> {
    return this.oneOrder(
      this.client.from('orders').update(patchToRow(patch)).eq('id', orderId).select() as Thenable,
    );
  }

  async listOrders(userId: string, limit: number): Promise<Order[]> {
    const { data, error } = await this.client
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(rowToOrder);
  }

  async countOrders(
    userId: string,
    filter: { status: OrderStatus; since?: Date },
  ): Promise<number> {
    let query = this.client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', filter.status);
    if (filter.since) query = query.gte('created_at', filter.since.toISOString());

    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  }

  /**
   * The replay guard: one statement, three conditions, `RETURNING`.
   *
   * Postgres applies the predicate and the write atomically to the row, so two
   * concurrent callers cannot both match `submission_seq = 0`. The loser
   * updates zero rows and gets `null` — which is the contention case, not an
   * error, and must never throw.
   */
  async claimForSubmission(orderId: string, patch: OrderPatch): Promise<Order | null> {
    return this.oneOrder(
      this.client
        .from('orders')
        .update({ ...patchToRow(patch), submission_seq: 1 })
        .eq('id', orderId)
        .eq('status', 'awaiting_auth')
        .eq('submission_seq', 0)
        .select() as Thenable,
    );
  }

  async cancelOrder(orderId: string, userId: string, now: Date): Promise<Order | null> {
    return this.oneOrder(
      this.client
        .from('orders')
        .update({ status: 'cancelled', updated_at: now.toISOString() })
        .eq('id', orderId)
        .eq('user_id', userId)
        // Past these three the merchant may already hold the order.
        .not('status', 'in', '("placed","placing","uncertain")')
        .select() as Thenable,
    );
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async getProduct(productId: string): Promise<Product | null> {
    const { data, error } = await this.client
      .from('products')
      .select('*')
      .eq('id', productId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? (rowToDoc(data) as unknown as Product) : null;
  }

  async getProducts(productIds: readonly string[]): Promise<Product[]> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return [];

    const { data, error } = await this.client.from('products').select('*').in('id', ids);
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => rowToDoc(row) as unknown as Product);
  }

  async getSource(merchantDomain: string): Promise<Source | null> {
    const { data, error } = await this.client
      .from('sources')
      .select('*')
      .eq('id', merchantDomain)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? (rowToDoc(data) as unknown as Source) : null;
  }

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  async listCoupons(merchantDomain: string): Promise<Coupon[]> {
    const { data, error } = await this.client
      .from('coupons')
      .select('*')
      .eq('merchant_domain', merchantDomain);
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => rowToDoc(row) as unknown as Coupon);
  }

  async recordCouponOutcome(
    merchantDomain: string,
    code: string,
    outcome: { applied: boolean; observedDiscount: number; subtotal: number; reason: string | null },
    now: Date,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('coupons')
      .select('*')
      .eq('merchant_domain', merchantDomain)
      .eq('code', code)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    // An unknown code is ignored rather than created: codes enter through
    // discovery, and a failure against one we never had is not evidence.
    if (!data) return;

    const coupon = rowToDoc(data) as unknown as Coupon;
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

    const retired = consecutiveFailures >= CHECKOUT_CONFIG.couponRetirementFailures;

    const { error: updateError } = await this.client
      .from('coupons')
      .update({
        performance: {
          attempts,
          successes,
          successRate: successes / attempts,
          meanDiscountPct: Math.round(meanDiscountPct * 10) / 10,
          consecutiveFailures,
          lastSuccessAt: outcome.applied ? now.toISOString() : coupon.performance.lastSuccessAt,
        },
        ...(retired ? { status: 'retired' } : {}),
      })
      .eq('id', coupon.id);
    if (updateError) throw updateError;

    if (retired) log.info('coupon retired after consecutive failures', { merchantDomain, code });
  }

  // -------------------------------------------------------------------------
  // Merchant links
  // -------------------------------------------------------------------------

  async upsertMerchantLink(link: Omit<MerchantLink, 'id'>): Promise<void> {
    const { error } = await this.client.from('merchant_links').upsert(
      {
        user_id: link.userId,
        merchant_domain: link.merchantDomain,
        status: link.status,
        encrypted_session: link.encryptedSession,
        created_at: link.createdAt.toISOString(),
        linked_at: link.linkedAt?.toISOString() ?? null,
        expires_at: link.expiresAt.toISOString(),
      },
      { onConflict: 'user_id,merchant_domain' },
    );
    if (error) throw error;
  }

  async getMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null> {
    const { data, error } = await this.client
      .from('merchant_links')
      .select('*')
      .eq('user_id', userId)
      .eq('merchant_domain', merchantDomain)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? (rowToDoc(data) as unknown as MerchantLink) : null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Zero or one order, with no-rows treated as absence rather than failure. */
  private async oneOrder(query: Thenable): Promise<Order | null> {
    const { data, error } = await query;
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? rowToOrder(row) : null;
  }

  private async oneCart(query: Thenable): Promise<Cart | null> {
    const { data, error } = await query;
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? rowToCart(row) : null;
  }
}

/**
 * What a PostgREST builder resolves to.
 *
 * The client's own generic types describe the builder, not the awaited value,
 * and they differ per verb. This is the shape every one of them settles into.
 */
type Thenable = PromiseLike<{
  data: Record<string, unknown> | Record<string, unknown>[] | null;
  error: { code?: string; message: string } | null;
}>;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Row translation
// ---------------------------------------------------------------------------

/**
 * Column names only, one level deep.
 *
 * Deliberately shallow: a `jsonb` column holds the application's own shape and
 * must come back exactly as it went in. Recursing here would rename keys inside
 * `quote` and `items`, and the write path does not rename them — the two would
 * disagree, and `quote.expiresAt` would arrive as `undefined`.
 */
function rowToDoc(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

/** Revives ISO strings into `Date`, including inside `jsonb` payloads. */
function reviveDates<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return (ISO_DATE.test(value) ? new Date(value) : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(reviveDates) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = reviveDates(entry);
    }
    return out as unknown as T;
  }
  return value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function rowToOrder(row: Record<string, unknown>): Order {
  return reviveDates(rowToDoc(row)) as unknown as Order;
}

function rowToCart(row: Record<string, unknown>): Cart {
  return reviveDates(rowToDoc(row)) as unknown as Cart;
}

function orderToRow(order: NewOrder): Record<string, unknown> {
  return {
    user_id: order.userId,
    cart_id: order.cartId,
    merchant_domain: order.merchantDomain,
    // jsonb, stored as the application holds it.
    items: order.items,
    quote: order.quote,
    coupon: order.coupon,
    authorization: order.authorization,
    payment: order.payment,
    agent_run: order.agentRun,
    status: order.status,
    merchant_order_number: order.merchantOrderNumber,
    failure: order.failure,
    submission_seq: order.submissionSeq,
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
  };
}

function patchToRow(patch: OrderPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.items !== undefined) row.items = patch.items;
  if (patch.quote !== undefined) row.quote = patch.quote;
  if (patch.coupon !== undefined) row.coupon = patch.coupon;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.authorization !== undefined) row.authorization = patch.authorization;
  if (patch.payment !== undefined) row.payment = patch.payment;
  if (patch.agentRun !== undefined) row.agent_run = patch.agentRun;
  if (patch.merchantOrderNumber !== undefined) row.merchant_order_number = patch.merchantOrderNumber;
  if (patch.failure !== undefined) row.failure = patch.failure;
  row.updated_at = (patch.updatedAt ?? new Date()).toISOString();
  return row;
}
