import type { Product } from '../db/supabase-collections.js';

/**
 * Pre-filters applied inside the retrieval stage. Every field here is declared
 * as a `filter` path on the vector index, so Atlas applies them during ANN
 * traversal rather than after it — which is what keeps `limit: 400` meaningful.
 */
export interface VectorFilter {
  categoryL1In?: string[];
  categoryL3In?: string[];
  inStock?: boolean;
  statusIn?: string[];
  sourceTypeIn?: string[];
  priceMin?: number;
  priceMax?: number;
  /** Excluded ids: suppressed products and the seen-set's exact tail. */
  excludeIds?: string[];
  /**
   * High-cardinality exclusions. These are not declared filter paths on the
   * vector index — indexing a per-user suppression list is not a thing — so
   * they are applied immediately after ANN traversal and still inside the
   * database rather than in application code.
   */
  excludeBrands?: string[];
  excludeSellerIds?: string[];
  excludeDomains?: string[];
  /** Drops listings past their source's staleness ceiling. */
  crawledSince?: Date;
}

export interface VectorQuery {
  vector: number[];
  numCandidates: number;
  limit: number;
  filter: VectorFilter;
}

/**
 * The candidate projection the scoring stage needs. Deliberately not the whole
 * document: specs and the gallery are not scored, and at 400 candidates a page
 * their bytes are the difference between hitting the latency budget and not.
 */
export type VectorCandidate = Pick<
  Product,
  | 'id'
  | 'clusterId'
  | 'title'
  | 'brand'
  | 'category'
  | 'price'
  | 'originalPrice'
  | 'shipping'
  | 'sourceType'
  | 'condition'
  | 'stock'
  | 'auction'
  | 'sellerId'
  | 'source'
  | 'embedding'
  | 'quality'
  | 'risk'
  | 'engagement'
  | 'crawl'
  | 'status'
  | 'media'
> & {
  /** Cosine similarity from the retrieval stage, in [0, 1] after rescaling. */
  vectorScore: number;
};

export const CANDIDATE_PROJECTION = {
  id: 1,
  clusterId: 1,
  title: 1,
  brand: 1,
  category: 1,
  price: 1,
  originalPrice: 1,
  shipping: 1,
  sourceType: 1,
  condition: 1,
  stock: 1,
  auction: 1,
  sellerId: 1,
  source: 1,
  embedding: 1,
  quality: 1,
  risk: 1,
  engagement: 1,
  crawl: 1,
  status: 1,
  media: 1,
} as const;

export interface VectorSearch {
  readonly kind: 'atlas' | 'local';
  search(query: VectorQuery): Promise<VectorCandidate[]>;
  /** Local indexes need to be told about writes; Atlas keeps itself in sync. */
  onProductUpserted?(product: Product): void;
  onProductRemoved?(id: string): void;
  /** Number of vectors currently searchable. */
  size(): Promise<number>;
}
