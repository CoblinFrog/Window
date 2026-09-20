/**
 * Supabase implementation of the checkout repository.
 *
 * This implementation follows the contract defined in repository.ts:
 * - Ids are opaque strings (UUIDs)
 * - Missing rows return null, never throw
 * - claimForSubmission is a single atomic compare-and-set operation
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CheckoutRepository,
  User,
  Cart,
  Order,
  Source,
  Coupon,
  MerchantLink,
  Product,
} from './repository.js';

/**
 * Helper to convert snake_case database columns to camelCase application fields
 */
function toCamelCase<T>(obj: Record<string, any>): T {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  return result as T;
}

/**
 * Helper to convert camelCase application fields to snake_case database columns
 */
function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    result[snakeKey] = value;
  }
  return result;
}

/**
 * Helper to parse timestamptz to Date objects
 */
function parseDates<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  const result: Record<string, any> = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj as Record<string, any>)) {
    if (value instanceof Date) {
      (result as Record<string, any>)[key] = value;
    } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      (result as Record<string, any>)[key] = new Date(value);
    } else if (typeof value === 'object' && value !== null) {
      (result as Record<string, any>)[key] = parseDates(value);
    } else {
      (result as Record<string, any>)[key] = value;
    }
  }
  return Array.isArray(obj) ? (result as T) : (result as T);
}

export class SupabaseCheckoutRepository implements CheckoutRepository {
  constructor(private readonly client: SupabaseClient) {}

  async truncate(): Promise<void> {
    const tables = [
      'merchant_links',
      'orders',
      'carts',
      'coupons',
      'users',
      'sources',
      'products',
    ];

    for (const table of tables) {
      await this.client.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    }
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async findUserByDeviceUserId(deviceUserId: string): Promise<User | null> {
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('device_user_id', deviceUserId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<User>(data));
  }

  async findUserById(id: string): Promise<User | null> {
    const { data, error } = await this.client.from('users').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<User>(data));
  }

  async createUser(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const now = new Date();
    const doc = {
      ...toSnakeCase(user),
      // Provide defaults for required fields from existing schema
      onboarding: null,
      interest_vector: null,
      interest_set: [],
      exploration_state: {
        counter: 0,
        last_topic: null,
        rejected: [],
        pending: [],
      },
      price_prior: {
        center: 0,
        currency: 'USD',
        confidence: 0.1,
      },
      affinities: {
        brands: {},
        sellers: {},
      },
      suppressions: {
        products: [],
        brands: [],
        sellers: [],
      },
      seen_filter: {
        bits: '',
        k: 7,
        m: 200000,
        n: 0,
        rebuilt_at: now.toISOString(),
      },
      counters: {
        interaction_count: 0,
        session_count: 0,
        last_active_at: now.toISOString(),
        last_decayed_on: null,
      },
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    const { data, error } = await this.client.from('users').insert(doc).select().single();

    if (error) throw error;

    return parseDates(toCamelCase<User>(data));
  }

  async createUserMinimal(deviceUserId: string, deviceSecretHash: string | null): Promise<User> {
    return this.createUser({
      deviceUserId,
      deviceSecretHash,
      sessionEpoch: 1,
      auth: null,
      settings: {},
      onboarding: null,
      interestVector: null,
      interestSet: [],
      explorationState: {
        counter: 0,
        lastTopic: null,
        rejected: [],
        pending: [],
      },
      pricePrior: {
        center: 0,
        currency: 'USD',
        confidence: 0.1,
      },
      affinities: {
        brands: {},
        sellers: {},
      },
      suppressions: {
        products: [],
        brands: [],
        sellers: [],
      },
      seenFilter: {
        bits: '',
        k: 7,
        m: 200000,
        n: 0,
        rebuiltAt: new Date(),
      },
      counters: {
        interactionCount: 0,
        sessionCount: 0,
        lastActiveAt: new Date(),
        lastDecayedOn: null,
      },
    });
  }

  async updateUser(id: string, updates: Partial<Omit<User, 'id' | 'createdAt'>>): Promise<User | null> {
    const doc = {
      ...toSnakeCase(updates),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.client.from('users').update(doc).eq('id', id).select().single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<User>(data));
  }

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  async findCartById(id: string): Promise<Cart | null> {
    const { data, error } = await this.client.from('carts').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Cart>(data));
  }

  async findOpenCartByUserId(userId: string): Promise<Cart | null> {
    const { data, error } = await this.client
      .from('carts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'open')
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Cart>(data));
  }

  async createCart(cart: Omit<Cart, 'id' | 'updatedAt'>): Promise<Cart> {
    const doc = {
      ...toSnakeCase(cart),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.client.from('carts').insert(doc).select().single();

    if (error) throw error;

    return parseDates(toCamelCase<Cart>(data));
  }

  async updateCart(id: string, updates: Partial<Omit<Cart, 'id'>>): Promise<Cart | null> {
    const doc = {
      ...toSnakeCase(updates),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.client.from('carts').update(doc).eq('id', id).select().single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Cart>(data));
  }

  async reopenCart(id: string): Promise<Cart | null> {
    const { data, error } = await this.client
      .from('carts')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'checking_out')
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Cart>(data));
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async findOrderById(id: string): Promise<Order | null> {
    const { data, error } = await this.client.from('orders').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Order>(data));
  }

  async findOrdersByUserId(userId: string): Promise<Order[]> {
    const { data, error } = await this.client
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return (data ?? []).map((row) => parseDates(toCamelCase<Order>(row)));
  }

  async createOrder(order: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Promise<Order> {
    const now = new Date();
    const doc = {
      ...toSnakeCase(order),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    const { data, error } = await this.client.from('orders').insert(doc).select().single();

    if (error) throw error;

    return parseDates(toCamelCase<Order>(data));
  }

  async updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Promise<Order | null> {
    const doc = {
      ...toSnakeCase(updates),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.client.from('orders').update(doc).eq('id', id).select().single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Order>(data));
  }

  async claimForSubmission(
    id: string,
    authorization: Order['authorization'],
    payment: Order['payment']
  ): Promise<Order | null> {
    const { data, error } = await this.client
      .from('orders')
      .update({
        status: 'placing',
        submission_seq: 1,
        authorization: authorization ? toSnakeCase(authorization) : null,
        payment: payment ? toSnakeCase(payment) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'awaiting_auth')
      .eq('submission_seq', 0)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Order>(data));
  }

  async cancelOrder(id: string): Promise<Order | null> {
    const { data, error } = await this.client
      .from('orders')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .not('status', 'in', '("placed","placing","uncertain")')
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Order>(data));
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async findSourceByDomain(domain: string): Promise<Source | null> {
    const { data, error } = await this.client.from('sources').select('*').eq('id', domain).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Source>(data));
  }

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  async findCouponsByMerchantDomain(merchantDomain: string): Promise<Coupon[]> {
    const { data, error } = await this.client
      .from('coupons')
      .select('*')
      .eq('merchant_domain', merchantDomain);

    if (error) throw error;

    return (data ?? []).map((row) => parseDates(toCamelCase<Coupon>(row)));
  }

  async createCoupon(coupon: Omit<Coupon, 'id'>): Promise<Coupon> {
    const doc = toSnakeCase(coupon);

    const { data, error } = await this.client.from('coupons').insert(doc).select().single();

    if (error) throw error;

    return parseDates(toCamelCase<Coupon>(data));
  }

  async updateCoupon(id: string, updates: Partial<Omit<Coupon, 'id'>>): Promise<Coupon | null> {
    const doc = toSnakeCase(updates);

    const { data, error } = await this.client.from('coupons').update(doc).eq('id', id).select().single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Coupon>(data));
  }

  // -------------------------------------------------------------------------
  // Merchant Links
  // -------------------------------------------------------------------------

  async findMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null> {
    const { data, error } = await this.client
      .from('merchant_links')
      .select('*')
      .eq('user_id', userId)
      .eq('merchant_domain', merchantDomain)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<MerchantLink>(data));
  }

  async createMerchantLink(link: Omit<MerchantLink, 'id'>): Promise<MerchantLink> {
    const doc = toSnakeCase(link);

    const { data, error } = await this.client.from('merchant_links').insert(doc).select().single();

    if (error) throw error;

    return parseDates(toCamelCase<MerchantLink>(data));
  }

  async updateMerchantLink(id: string, updates: Partial<Omit<MerchantLink, 'id'>>): Promise<MerchantLink | null> {
    const doc = toSnakeCase(updates);

    const { data, error } = await this.client
      .from('merchant_links')
      .update(doc)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<MerchantLink>(data));
  }

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  async findProductsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];

    const { data, error } = await this.client
      .from('products')
      .select('id,title,price,stock,risk,status,source_type,source')
      .in('id', ids);

    if (error) throw error;

    return (data ?? []).map((row) => parseDates(toCamelCase<Product>(row)));
  }

  async findProductById(id: string): Promise<Product | null> {
    const { data, error } = await this.client
      .from('products')
      .select('id,title,price,stock,risk,status,source_type,source')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return parseDates(toCamelCase<Product>(data));
  }
}
