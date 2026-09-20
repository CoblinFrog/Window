import { EMBEDDING_DIM, quantizeScalar } from '@window/shared';
import { logger } from '../lib/logger.js';
import { reviveDates } from '../db/supabase-helpers.js';
import type { Product } from '../db/supabase-collections.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CANDIDATE_PROJECTION,
  type VectorCandidate,
  type VectorQuery,
  type VectorSearch,
} from './types.js';

const log = logger.child('vector.local');

/**
 * An in-process vector index, used when cloud vector search is unavailable.
 *
 * It implements the same contract and the same pre-filter semantics as the
 * Atlas stage, including the index's scalar quantization, so recall behaviour
 * is comparable rather than silently better. It differs in one way worth being
 * explicit about: the scan is exhaustive over the filtered set rather than
 * approximate, which makes `numCandidates` an upper bound it never needs and
 * makes its recall an upper bound on what Atlas would return. That is the right
 * trade for a development catalog and the wrong one above a few million
 * products, which is the point at which Atlas earns its place.
 */
export class LocalVectorIndex implements VectorSearch {
  readonly kind = 'local' as const;

  private capacity = 0;
  private count = 0;

  /** Row-major quantized vectors, `count` rows of `EMBEDDING_DIM` int8s. */
  private matrix = new Int8Array(0);
  private ids: string[] = [];
  private live = new Uint8Array(0);
  private l1: string[] = [];
  private l3: string[] = [];
  private status: string[] = [];
  private sourceType: string[] = [];
  private brand: Array<string | null> = [];
  private sellerId: string[] = [];
  private domain: string[] = [];
  private inStock = new Uint8Array(0);
  private price = new Float64Array(0);
  private lastCrawledAt = new Float64Array(0);
  private readonly rowOf = new Map<string, number>();

  constructor(private readonly products: ReturnType<SupabaseClient['from']>) {}

  private grow(minimum: number): void {
    if (minimum <= this.capacity) return;
    const next = Math.max(minimum, this.capacity === 0 ? 4096 : this.capacity * 2);
    const oldMatrix = this.matrix;
    const oldIds = this.ids;
    const oldLive = this.live;
    const oldL1 = this.l1;
    const oldL3 = this.l3;
    const oldStatus = this.status;
    const oldSourceType = this.sourceType;
    const oldBrand = this.brand;
    const oldSellerId = this.sellerId;
    const oldDomain = this.domain;
    const oldInStock = this.inStock;
    const oldPrice = this.price;
    const oldLastCrawledAt = this.lastCrawledAt;

    this.matrix = new Int8Array(next * EMBEDDING_DIM);
    this.ids = new Array(next);
    this.live = new Uint8Array(next);
    this.l1 = new Array(next);
    this.l3 = new Array(next);
    this.status = new Array(next);
    this.sourceType = new Array(next);
    this.brand = new Array(next);
    this.sellerId = new Array(next);
    this.domain = new Array(next);
    this.inStock = new Uint8Array(next);
    this.price = new Float64Array(next);
    this.lastCrawledAt = new Float64Array(next);

    this.matrix.set(oldMatrix.subarray(0, this.capacity * EMBEDDING_DIM));
    for (let i = 0; i < oldIds.length; i++) this.ids[i] = oldIds[i];
    for (let i = 0; i < oldLive.length; i++) this.live[i] = oldLive[i];
    for (let i = 0; i < oldL1.length; i++) this.l1[i] = oldL1[i];
    for (let i = 0; i < oldL3.length; i++) this.l3[i] = oldL3[i];
    for (let i = 0; i < oldStatus.length; i++) this.status[i] = oldStatus[i];
    for (let i = 0; i < oldSourceType.length; i++) this.sourceType[i] = oldSourceType[i];
    for (let i = 0; i < oldBrand.length; i++) this.brand[i] = oldBrand[i];
    for (let i = 0; i < oldSellerId.length; i++) this.sellerId[i] = oldSellerId[i];
    for (let i = 0; i < oldDomain.length; i++) this.domain[i] = oldDomain[i];
    for (let i = 0; i < oldInStock.length; i++) this.inStock[i] = oldInStock[i];
    for (let i = 0; i < oldPrice.length; i++) this.price[i] = oldPrice[i];
    for (let i = 0; i < oldLastCrawledAt.length; i++) this.lastCrawledAt[i] = oldLastCrawledAt[i];

    this.capacity = next;
  }

  async build(): Promise<void> {
    const started = Date.now();
    this.rowOf.clear();

    // For Supabase, we need to get the count first
    const total = 10000; // Default for now, could be fetched from Supabase
    this.grow(Math.max(4096, total));

    const { data: docs, error } = await this.products
      .select('id,embedding,category,stock,price,status,source_type,brand,seller_id,source,crawl')
      .not('embedding', 'is', null);
    if (error) throw error;

    for (const doc of docs || []) {
      this.insert({
        ...(doc as unknown as Product),
        sourceType: (doc as { source_type?: string }).source_type,
        sellerId: (doc as { seller_id?: string }).seller_id,
      } as Product);
    }

    log.info('local vector index built', {
      vectors: this.count,
      ms: Date.now() - started,
      dims: EMBEDDING_DIM,
    });
  }

  async search(query: VectorQuery): Promise<VectorCandidate[]> {
    // Filter by L1 topic if provided
    let startRow = 0;
    if (query.filter.categoryL1In && query.filter.categoryL1In.length > 0) {
      startRow = this.rowOf.get(`l1:${query.filter.categoryL1In[0]}`) ?? 0;
    }

    const top: { row: number; score: number }[] = [];
    let worst = -Infinity;
    const quantizedQuery = quantizeScalar(query.vector);

    for (let row = startRow; row < this.count; row++) {
      if (this.live[row] === 0) continue;
      if (query.filter.categoryL1In && !query.filter.categoryL1In.includes(this.l1[row])) continue;
      if (query.filter.categoryL3In && !query.filter.categoryL3In.includes(this.l3[row] ?? '')) continue;
      if (query.filter.statusIn && !query.filter.statusIn.includes(this.status[row] ?? '')) continue;
      if (query.filter.sourceTypeIn && !query.filter.sourceTypeIn.includes(this.sourceType[row] ?? '')) continue;
      if (query.filter.inStock && this.inStock[row] === 0) continue;
      if (query.filter.priceMax && this.price[row] > query.filter.priceMax) continue;
      if (query.filter.priceMin && this.price[row] < query.filter.priceMin) continue;
      if (query.filter.excludeBrands && this.brand[row] && query.filter.excludeBrands.includes(this.brand[row].toLowerCase())) continue;
      if (query.filter.excludeSellerIds && this.sellerId[row] && query.filter.excludeSellerIds.includes(this.sellerId[row])) continue;

      let dot = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        dot += quantizedQuery[i] * this.matrix[row * EMBEDDING_DIM + i];
      }
      const score = dot / 127;

      if (top.length < query.limit) {
        top.push({ row, score });
        if (top.length === query.limit) {
          top.sort((a, b) => b.score - a.score);
          worst = top[top.length - 1]!.score;
        }
        continue;
      }
      if (score <= worst) continue;

      // Replace the current worst, then re-place it by a single insertion step.
      top[top.length - 1] = { row, score };
      for (let i = top.length - 1; i > 0 && (top[i - 1] as { score: number }).score < score; i--) {
        const tmp = top[i - 1]!;
        top[i - 1] = top[i]!;
        top[i] = tmp;
      }
      worst = top[top.length - 1]!.score;
    }

    if (top.length < query.limit) top.sort((a, b) => b.score - a.score);
    if (top.length === 0) return [];

    const ids = top.map((hit) => this.ids[hit.row]);
    const { data: docs, error } = await this.products
      .select('id,cluster_id,title,brand,price,original_price,shipping,condition,stock,auction,media,seller_id,source,source_type,embedding,embedding_version,quality,risk,engagement,crawl,status,reject_reason,category')
      .in('id', ids);
    if (error) throw error;

    const byId = new Map(
      (docs || []).map((raw) => {
        const doc = raw as Record<string, unknown>;
        return [
          doc.id,
          {
            // This path fetches rows straight from PostgREST rather than
            // through the db helpers, so it has to revive its own dates; the
            // ranker calls `.getTime()` on `crawl.firstSeenAt`.
            ...reviveDates(doc),
            clusterId: doc.cluster_id,
            originalPrice: doc.original_price,
            sellerId: doc.seller_id,
            sourceType: doc.source_type,
            embeddingVersion: doc.embedding_version,
            rejectReason: doc.reject_reason,
          },
        ];
      }),
    );
    const out: VectorCandidate[] = [];
    for (const hit of top) {
      const doc = byId.get(this.ids[hit.row]);
      if (!doc) continue; // Deleted between the scan and the fetch.
      out.push({
        ...(doc as unknown as VectorCandidate),
        // Atlas reports cosine similarity rescaled into [0,1]; match that so
        // downstream scoring weights mean the same thing on both back ends.
        vectorScore: (hit.score + 1) / 2,
      });
    }
    return out;
  }

  private insert(product: Product): void {
    const key = product.id;
    const existing = this.rowOf.get(key);
    const row = existing ?? this.count;

    if (existing === undefined) {
      this.grow(this.count + 1);
      this.ids[row] = product.id;
      this.count += 1;
      this.rowOf.set(key, row);
    }

    const quantized = quantizeScalar(product.embedding ?? []);
    this.matrix.set(quantized.subarray(0, EMBEDDING_DIM), row * EMBEDDING_DIM);
    this.live[row] = 1;
    this.l1[row] = product.category?.l1 ?? '';
    this.l3[row] = product.category?.l3 ?? '';
    this.status[row] = product.status ?? 'active';
    this.sourceType[row] = product.sourceType ?? 'new';
    this.brand[row] = product.brand ?? null;
    this.sellerId[row] = product.sellerId ?? '';
    this.domain[row] = product.source?.domain ?? '';
    this.inStock[row] = product.stock?.inStock ? 1 : 0;
    this.price[row] = product.price?.amount ?? 0;
    const crawledAt = product.crawl?.lastCrawledAt;
    this.lastCrawledAt[row] = crawledAt
      ? crawledAt instanceof Date
        ? crawledAt.getTime()
        : Date.parse(String(crawledAt)) || 0
      : 0;
  }

  onProductUpserted(product: Product): void {
    if (!product.embedding || product.embedding.length === 0) return;
    this.insert(product);
  }

  onProductRemoved(id: string): void {
    const row = this.rowOf.get(id);
    if (row !== undefined) this.live[row] = 0;
  }

  async size(): Promise<number> {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.live[i] === 1) n += 1;
    return n;
  }
}