import type { 
  CartDoc,
  CategoryDoc,
  ClusterDoc,
  CouponDoc,
  InteractionDoc,
  OrderDoc,
  ProductDoc,
  ReviewDoc,
  SellerDoc,
  SourceDoc,
  UserDoc,
} from '@window/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Document shapes as they sit in Supabase, with UUID ids. */
export type Product = ProductDoc<string>;
export type Cluster = ClusterDoc<string>;
export type User = UserDoc<string>;
export type Interaction = InteractionDoc<string>;
export type Category = CategoryDoc<string>;
export type Seller = SellerDoc<string>;
export type Review = ReviewDoc<string>;
export type Cart = CartDoc<string>;
export type Order = OrderDoc<string>;
export type Coupon = CouponDoc<string>;
export type Source = SourceDoc<string>;

/**
 * Operational collections beyond the ten in the data model.
 */
export interface ReportDoc {
  id: string;
  productId: string;
  sellerId: string;
  userId: string;
  reason:
    | 'counterfeit'
    | 'not_as_described'
    | 'seller_unresponsive'
    | 'price_manipulation'
    | 'stolen_photos';
  note: string | null;
  status: 'open' | 'upheld' | 'dismissed';
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface MerchantLinkDoc {
  id: string;
  userId: string;
  merchantDomain: string;
  status: 'pending' | 'linked' | 'expired' | 'revoked';
  encryptedSession: { ciphertext: string; iv: string; keyVersion: number } | null;
  createdAt: Date;
  linkedAt: Date | null;
  expiresAt: Date;
}

/**
 * Supabase table interfaces - these map to the actual database tables
 * Each is a Supabase query builder for the respective table
 */
export interface CollectionSet {
  products: ReturnType<SupabaseClient['from']>;
  clusters: ReturnType<SupabaseClient['from']>;
  users: ReturnType<SupabaseClient['from']>;
  interactions: ReturnType<SupabaseClient['from']>;
  categories: ReturnType<SupabaseClient['from']>;
  sellers: ReturnType<SupabaseClient['from']>;
  reviews: ReturnType<SupabaseClient['from']>;
  carts: ReturnType<SupabaseClient['from']>;
  orders: ReturnType<SupabaseClient['from']>;
  coupons: ReturnType<SupabaseClient['from']>;
  sources: ReturnType<SupabaseClient['from']>;
  reports: ReturnType<SupabaseClient['from']>;
  merchantLinks: ReturnType<SupabaseClient['from']>;
}

export const TABLE_NAMES = {
  products: 'products',
  clusters: 'product_clusters',
  users: 'users',
  interactions: 'interactions',
  categories: 'categories',
  sellers: 'sellers',
  reviews: 'reviews',
  carts: 'carts',
  orders: 'orders',
  coupons: 'coupons',
  sources: 'sources',
  reports: 'reports',
  merchantLinks: 'merchant_links',
} as const;

export function collectionsFor(client: SupabaseClient): CollectionSet {
  return {
    products: client.from(TABLE_NAMES.products),
    clusters: client.from(TABLE_NAMES.clusters),
    users: client.from(TABLE_NAMES.users),
    interactions: client.from(TABLE_NAMES.interactions),
    categories: client.from(TABLE_NAMES.categories),
    sellers: client.from(TABLE_NAMES.sellers),
    reviews: client.from(TABLE_NAMES.reviews),
    carts: client.from(TABLE_NAMES.carts),
    orders: client.from(TABLE_NAMES.orders),
    coupons: client.from(TABLE_NAMES.coupons),
    sources: client.from(TABLE_NAMES.sources),
    reports: client.from(TABLE_NAMES.reports),
    merchantLinks: client.from(TABLE_NAMES.merchantLinks),
  };
}