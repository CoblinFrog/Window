/**
 * Checkout repository interface.
 *
 * This interface defines the contract for checkout data access. Implementations
 * must follow two rules:
 * 1. Ids are opaque strings - the store issues them, callers only echo them back
 * 2. Missing rows return null, never an exception
 */

import type { Quote, OrderStatus } from '@window/shared';

export interface User {
  id: string;
  deviceUserId: string;
  deviceSecretHash: string | null;
  sessionEpoch: number;
  auth: {
    email: string | null;
    providers: string[];
    claimedAt: Date | null;
    emailVerifiedAt: Date | null;
  } | null;
  settings: Record<string, unknown>;
  // Additional fields from existing schema
  onboarding: {
    topics: string[];
    priceBand: string | null;
    completedAt: Date;
  } | null;
  interestVector: number[] | null;
  interestSet: Array<{
    topic: string;
    weight: number;
    source: string;
    addedAt: Date;
    lastPositiveAt: Date | null;
  }>;
  explorationState: {
    counter: number;
    lastTopic: string | null;
    rejected: Array<{ topic: string; strikes: number; until: Date }>;
    pending: Array<{
      topic: string;
      sessions: string[];
      positiveDwells: number;
      bestDwellMs: number;
      railInteraction: boolean;
      cartAdd: boolean;
    }>;
  };
  pricePrior: {
    center: number;
    currency: string;
    confidence: number;
  };
  affinities: {
    brands: Record<string, number>;
    sellers: Record<string, number>;
  };
  suppressions: {
    products: string[];
    brands: string[];
    sellers: string[];
  };
  seenFilter: {
    bits: string;
    k: number;
    m: number;
    n: number;
    rebuiltAt: Date;
  };
  counters: {
    interactionCount: number;
    sessionCount: number;
    lastActiveAt: Date;
    lastDecayedOn: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface Cart {
  id: string;
  userId: string;
  status: 'open' | 'checking_out' | 'closed';
  items: Array<{
    id: string;
    productId: string;
    clusterId: string | null;
    sellerId: string;
    merchantDomain: string;
    variant: Record<string, string>;
    quantity: number;
    priceAtAdd: { amount: number; currency: string };
    priceNow: { amount: number; currency: string };
    priceChanged: boolean;
    available: boolean;
    softHold: boolean;
    addedAt: Date;
  }>;
  updatedAt: Date;
}

export interface Order {
  id: string;
  userId: string;
  cartId: string | null;
  merchantDomain: string;
  items: Array<{
    productId: string;
    title: string;
    quantity: number;
    unitPrice: number;
    variant: Record<string, string>;
  }>;
  quote: Quote | null;
  coupon: { code: string; discount: number; attempts: number } | null;
  authorization: {
    authorizedAt: Date;
    userAgentHash: string;
    quoteHash: string;
  } | null;
  payment: {
    rail: 'reap';
    intentId: string;
    tokenRef: string;
    cap: number;
    protocol: 'acp' | 'mpp' | 'tap' | 'browser';
  } | null;
  agentRun: {
    jobId: string;
    startedAt: Date;
    endedAt: Date | null;
    toolCallCount: number;
    screenshots: string[];
    transcriptRef: string;
  } | null;
  status: OrderStatus;
  merchantOrderNumber: string | null;
  failure: { code: string; message: string; recoverable: boolean } | null;
  submissionSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Source {
  id: string; // The domain is stored as id
  displayName: string;
  sourceType: string;
  checkout: {
    protocol: string;
    blocksAgents: boolean;
    stackableCoupons: boolean;
  };
}

export interface Coupon {
  id: string;
  merchantDomain: string;
  code: string;
  discovered: Record<string, unknown>;
  constraints: Record<string, unknown>;
  performance: Record<string, unknown>;
  stackable: boolean;
  status: string;
}

export interface MerchantLink {
  id: string;
  userId: string;
  merchantDomain: string;
  status: string;
  encryptedSession: Record<string, unknown> | null;
  createdAt: Date;
  linkedAt: Date | null;
  expiresAt: Date;
}

export interface Product {
  id: string;
  title: string;
  price: { amount: number; currency: string };
  stock: { inStock: boolean; quantity: number | null; singleUnit: boolean };
  risk: {
    score: number;
    tier: string;
  };
  status: string;
  sourceType: string;
  source: {
    domain: string;
    url: string;
  };
}

/**
 * Checkout repository interface.
 *
 * Touches seven tables: users, carts, orders, sources, coupons, merchant_links, products.
 * All ids are opaque strings. Missing rows return null, never throw.
 */
export interface CheckoutRepository {
  /**
   * Truncate all checkout tables for testing.
   * This is a test-only method and should never be used in production.
   */
  truncate(): Promise<void>;

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * Find a user by device user id.
   */
  findUserByDeviceUserId(deviceUserId: string): Promise<User | null>;

  /**
   * Find a user by id.
   */
  findUserById(id: string): Promise<User | null>;

  /**
   * Create a user.
   */
  createUser(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User>;

  /**
   * Create a user with minimal fields (provides defaults for required schema fields).
   */
  createUserMinimal(deviceUserId: string, deviceSecretHash: string | null): Promise<User>;

  /**
   * Update a user.
   */
  updateUser(id: string, updates: Partial<Omit<User, 'id' | 'createdAt'>>): Promise<User | null>;

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  /**
   * Find a cart by id.
   */
  findCartById(id: string): Promise<Cart | null>;

  /**
   * Find the open cart for a user.
   */
  findOpenCartByUserId(userId: string): Promise<Cart | null>;

  /**
   * Create a cart.
   */
  createCart(cart: Omit<Cart, 'id' | 'updatedAt'>): Promise<Cart>;

  /**
   * Update a cart.
   */
  updateCart(id: string, updates: Partial<Omit<Cart, 'id'>>): Promise<Cart | null>;

  /**
   * Reopen a cart (set status from 'checking_out' to 'open').
   * Must be conditional: only update if status is 'checking_out'.
   */
  reopenCart(id: string): Promise<Cart | null>;

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Find an order by id.
   */
  findOrderById(id: string): Promise<Order | null>;

  /**
   * Find orders by user id.
   */
  findOrdersByUserId(userId: string): Promise<Order[]>;

  /**
   * Create an order.
   */
  createOrder(order: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Promise<Order>;

  /**
   * Update an order.
   */
  updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Promise<Order | null>;

  /**
   * Claim an order for submission.
   * This must be a single atomic compare-and-set operation.
   * Updates status from 'awaiting_auth' to 'placing' and increments submission_seq.
   * Returns null if the order is not in 'awaiting_auth' or submission_seq is not 0.
   */
  claimForSubmission(
    id: string,
    authorization: Order['authorization'],
    payment: Order['payment']
  ): Promise<Order | null>;

  /**
   * Cancel an order.
   * Must be conditional: only update if status is not 'placed', 'placing', or 'uncertain'.
   */
  cancelOrder(id: string): Promise<Order | null>;

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /**
   * Find a source by domain (stored as id).
   */
  findSourceByDomain(domain: string): Promise<Source | null>;

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  /**
   * Find coupons by merchant domain.
   */
  findCouponsByMerchantDomain(merchantDomain: string): Promise<Coupon[]>;

  /**
   * Create a coupon.
   */
  createCoupon(coupon: Omit<Coupon, 'id'>): Promise<Coupon>;

  /**
   * Update a coupon.
   */
  updateCoupon(id: string, updates: Partial<Omit<Coupon, 'id'>>): Promise<Coupon | null>;

  // -------------------------------------------------------------------------
  // Merchant Links
  // -------------------------------------------------------------------------

  /**
   * Find a merchant link by user id and merchant domain.
   */
  findMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null>;

  /**
   * Create a merchant link.
   */
  createMerchantLink(link: Omit<MerchantLink, 'id'>): Promise<MerchantLink>;

  /**
   * Update a merchant link.
   */
  updateMerchantLink(id: string, updates: Partial<Omit<MerchantLink, 'id'>>): Promise<MerchantLink | null>;

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  /**
   * Find products by ids.
   */
  findProductsByIds(ids: string[]): Promise<Product[]>;

  /**
   * Find a product by id.
   */
  findProductById(id: string): Promise<Product | null>;
}
