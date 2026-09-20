/**
 * In-memory implementation of the checkout repository for testing.
 *
 * This implementation stores all data in memory and is used for testing
 * the conformance suite without requiring a real database connection.
 */

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

export class MemoryCheckoutRepository implements CheckoutRepository {
  private users = new Map<string, User>();
  private carts = new Map<string, Cart>();
  private orders = new Map<string, Order>();
  private sources = new Map<string, Source>();
  private coupons = new Map<string, Coupon>();
  private merchantLinks = new Map<string, MerchantLink>();
  private products = new Map<string, Product>();

  async truncate(): Promise<void> {
    this.users.clear();
    this.carts.clear();
    this.orders.clear();
    this.sources.clear();
    this.coupons.clear();
    this.merchantLinks.clear();
    this.products.clear();
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async findUserByDeviceUserId(deviceUserId: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.deviceUserId === deviceUserId) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async createUser(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const id = crypto.randomUUID();
    const now = new Date();
    const newUser: User = { ...user, id, createdAt: now, updatedAt: now };
    this.users.set(id, newUser);
    return newUser;
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
    const user = this.users.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates, updatedAt: new Date() };
    this.users.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  async findCartById(id: string): Promise<Cart | null> {
    return this.carts.get(id) || null;
  }

  async findOpenCartByUserId(userId: string): Promise<Cart | null> {
    for (const cart of this.carts.values()) {
      if (cart.userId === userId && cart.status === 'open') return cart;
    }
    return null;
  }

  async createCart(cart: Omit<Cart, 'id' | 'updatedAt'>): Promise<Cart> {
    const id = crypto.randomUUID();
    const now = new Date();
    const newCart: Cart = { ...cart, id, updatedAt: now };
    this.carts.set(id, newCart);
    return newCart;
  }

  async updateCart(id: string, updates: Partial<Omit<Cart, 'id'>>): Promise<Cart | null> {
    const cart = this.carts.get(id);
    if (!cart) return null;
    const updated = { ...cart, ...updates, updatedAt: new Date() };
    this.carts.set(id, updated);
    return updated;
  }

  async reopenCart(id: string): Promise<Cart | null> {
    const cart = this.carts.get(id);
    if (!cart || cart.status !== 'checking_out') return null;
    const updated = { ...cart, status: 'open' as const, updatedAt: new Date() };
    this.carts.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async findOrderById(id: string): Promise<Order | null> {
    return this.orders.get(id) || null;
  }

  async findOrdersByUserId(userId: string): Promise<Order[]> {
    const result: Order[] = [];
    for (const order of this.orders.values()) {
      if (order.userId === userId) result.push(order);
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async createOrder(order: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Promise<Order> {
    const id = crypto.randomUUID();
    const now = new Date();
    const newOrder: Order = { ...order, id, createdAt: now, updatedAt: now };
    this.orders.set(id, newOrder);
    return newOrder;
  }

  async updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Promise<Order | null> {
    const order = this.orders.get(id);
    if (!order) return null;
    const updated = { ...order, ...updates, updatedAt: new Date() };
    this.orders.set(id, updated);
    return updated;
  }

  async claimForSubmission(
    id: string,
    authorization: Order['authorization'],
    payment: Order['payment']
  ): Promise<Order | null> {
    const order = this.orders.get(id);
    if (!order || order.status !== 'awaiting_auth' || order.submissionSeq !== 0) return null;
    const updated = {
      ...order,
      status: 'placing' as const,
      submissionSeq: 1,
      authorization,
      payment,
      updatedAt: new Date(),
    };
    this.orders.set(id, updated);
    return updated;
  }

  async cancelOrder(id: string): Promise<Order | null> {
    const order = this.orders.get(id);
    if (!order || order.status === 'placed' || order.status === 'placing' || order.status === 'uncertain') {
      return null;
    }
    const updated = { ...order, status: 'cancelled' as const, updatedAt: new Date() };
    this.orders.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async findSourceByDomain(domain: string): Promise<Source | null> {
    return this.sources.get(domain) || null;
  }

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  async findCouponsByMerchantDomain(merchantDomain: string): Promise<Coupon[]> {
    const result: Coupon[] = [];
    for (const coupon of this.coupons.values()) {
      if (coupon.merchantDomain === merchantDomain) result.push(coupon);
    }
    return result;
  }

  async createCoupon(coupon: Omit<Coupon, 'id'>): Promise<Coupon> {
    const id = crypto.randomUUID();
    const newCoupon: Coupon = { ...coupon, id };
    this.coupons.set(id, newCoupon);
    return newCoupon;
  }

  async updateCoupon(id: string, updates: Partial<Omit<Coupon, 'id'>>): Promise<Coupon | null> {
    const coupon = this.coupons.get(id);
    if (!coupon) return null;
    const updated = { ...coupon, ...updates };
    this.coupons.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Merchant Links
  // -------------------------------------------------------------------------

  async findMerchantLink(userId: string, merchantDomain: string): Promise<MerchantLink | null> {
    for (const link of this.merchantLinks.values()) {
      if (link.userId === userId && link.merchantDomain === merchantDomain) return link;
    }
    return null;
  }

  async createMerchantLink(link: Omit<MerchantLink, 'id'>): Promise<MerchantLink> {
    const id = crypto.randomUUID();
    const newLink: MerchantLink = { ...link, id };
    this.merchantLinks.set(id, newLink);
    return newLink;
  }

  async updateMerchantLink(id: string, updates: Partial<Omit<MerchantLink, 'id'>>): Promise<MerchantLink | null> {
    const link = this.merchantLinks.get(id);
    if (!link) return null;
    const updated = { ...link, ...updates };
    this.merchantLinks.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  async findProductsByIds(ids: string[]): Promise<Product[]> {
    const result: Product[] = [];
    for (const id of ids) {
      const product = this.products.get(id);
      if (product) result.push(product);
    }
    return result;
  }

  async findProductById(id: string): Promise<Product | null> {
    return this.products.get(id) || null;
  }
}
