import type { Collection, Db, ObjectId } from 'mongodb';
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

/** Document shapes as they sit in MongoDB, with `ObjectId` ids. */
export type Product = ProductDoc<ObjectId>;
export type Cluster = ClusterDoc<ObjectId>;
export type User = UserDoc<ObjectId>;
export type Interaction = InteractionDoc<ObjectId>;
export type Category = CategoryDoc<ObjectId>;
export type Seller = SellerDoc<ObjectId>;
export type Review = ReviewDoc<ObjectId>;
export type Cart = CartDoc<ObjectId>;
export type Order = OrderDoc<ObjectId>;
export type Coupon = CouponDoc<ObjectId>;
export type Source = SourceDoc<ObjectId>;

/**
 * Operational collections beyond the ten in the data model: a listing report
 * queue (the risk section's reporting loop needs somewhere to land) and
 * merchant account links (checkout stores encrypted session cookies per user).
 */
export interface ReportDoc {
  _id: ObjectId;
  productId: ObjectId;
  sellerId: ObjectId;
  userId: ObjectId;
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
  _id: ObjectId;
  userId: ObjectId;
  merchantDomain: string;
  status: 'pending' | 'linked' | 'expired' | 'revoked';
  /**
   * Session cookies encrypted at rest with a per-user key. This value is never
   * placed in a model context; the agent receives an opaque handle instead.
   */
  encryptedSession: { ciphertext: string; iv: string; keyVersion: number } | null;
  createdAt: Date;
  linkedAt: Date | null;
  expiresAt: Date;
}

export interface CollectionSet {
  products: Collection<Product>;
  clusters: Collection<Cluster>;
  users: Collection<User>;
  interactions: Collection<Interaction>;
  categories: Collection<Category>;
  sellers: Collection<Seller>;
  reviews: Collection<Review>;
  carts: Collection<Cart>;
  orders: Collection<Order>;
  coupons: Collection<Coupon>;
  sources: Collection<Source>;
  reports: Collection<ReportDoc>;
  merchantLinks: Collection<MerchantLinkDoc>;
}

export const COLLECTION_NAMES = {
  products: 'products',
  clusters: 'productClusters',
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
  merchantLinks: 'merchantLinks',
} as const;

export function collectionsFor(db: Db): CollectionSet {
  return {
    products: db.collection<Product>(COLLECTION_NAMES.products),
    clusters: db.collection<Cluster>(COLLECTION_NAMES.clusters),
    users: db.collection<User>(COLLECTION_NAMES.users),
    interactions: db.collection<Interaction>(COLLECTION_NAMES.interactions),
    categories: db.collection<Category>(COLLECTION_NAMES.categories),
    sellers: db.collection<Seller>(COLLECTION_NAMES.sellers),
    reviews: db.collection<Review>(COLLECTION_NAMES.reviews),
    carts: db.collection<Cart>(COLLECTION_NAMES.carts),
    orders: db.collection<Order>(COLLECTION_NAMES.orders),
    coupons: db.collection<Coupon>(COLLECTION_NAMES.coupons),
    sources: db.collection<Source>(COLLECTION_NAMES.sources),
    reports: db.collection<ReportDoc>(COLLECTION_NAMES.reports),
    merchantLinks: db.collection<MerchantLinkDoc>(COLLECTION_NAMES.merchantLinks),
  };
}
