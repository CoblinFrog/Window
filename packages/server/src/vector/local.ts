import type { Collection } from 'mongodb';
import { ObjectId } from 'mongodb';
import { EMBEDDING_DIM, quantizeScalar } from '@window/shared';
import { logger } from '../lib/logger.js';
import type { Product } from '../db/collections.js';
import {
  CANDIDATE_PROJECTION,
  type VectorCandidate,
  type VectorQuery,
  type VectorSearch,
} from './types.js';

const log = logger.child('vector.local');

/**
 * An in-process vector index, used whenever Atlas Vector Search is unavailable.
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
  private ids: ObjectId[] = [];
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

  constructor(private readonly products: Collection<Product>) {}

  private grow(minimum: number): void {
    if (minimum <= this.capacity) return;
    const next = Math.max(minimum, this.capacity === 0 ? 4096 : this.capacity * 2);

    const matrix = new Int8Array(next * EMBEDDING_DIM);
    matrix.set(this.matrix);
    this.matrix = matrix;

    const live = new Uint8Array(next);
    live.set(this.live);
    this.live = live;

    const inStock = new Uint8Array(next);
    inStock.set(this.inStock);
    this.inStock = inStock;

    const price = new Float64Array(next);
    price.set(this.price);
    this.price = price;

    const lastCrawledAt = new Float64Array(next);
    lastCrawledAt.set(this.lastCrawledAt);
    this.lastCrawledAt = lastCrawledAt;

    this.capacity = next;
  }

  /** Streams every product's vector into memory. Called at boot and on rebuild. */
  async build(): Promise<void> {
    const started = Date.now();
    this.capacity = 0;
    this.count = 0;
    this.matrix = new Int8Array(0);
    this.ids = [];
    this.live = new Uint8Array(0);
    this.l1 = [];
    this.l3 = [];
    this.status = [];
    this.sourceType = [];
    this.brand = [];
    this.sellerId = [];
    this.domain = [];
    this.inStock = new Uint8Array(0);
    this.price = new Float64Array(0);
    this.lastCrawledAt = new Float64Array(0);
    this.rowOf.clear();

    const total = await this.products.estimatedDocumentCount();
    this.grow(Math.max(4096, total));

    const cursor = this.products.find(
      { embedding: { $exists: true, $ne: [] } },
      {
        projection: {
          _id: 1,
          embedding: 1,
          'category.l1': 1,
          'category.l3': 1,
          'stock.inStock': 1,
          'price.amount': 1,
          status: 1,
          sourceType: 1,
          brand: 1,
          sellerId: 1,
          'source.domain': 1,
          'crawl.lastCrawledAt': 1,
        },
      },
    );

    for await (const doc of cursor) {
      this.insert(doc as unknown as Product);
    }

    log.info('local vector index built', {
      vectors: this.count,
      ms: Date.now() - started,
      dims: EMBEDDING_DIM,
    });
  }

  private insert(product: Product): void {
    const key = product._id.toHexString();
    const existing = this.rowOf.get(key);
    const row = existing ?? this.count;

    if (existing === undefined) {
      this.grow(this.count + 1);
      this.ids[row] = product._id;
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
    this.sellerId[row] = product.sellerId?.toHexString() ?? '';
    this.domain[row] = product.source?.domain ?? '';
    this.inStock[row] = product.stock?.inStock ? 1 : 0;
    this.price[row] = product.price?.amount ?? 0;
    this.lastCrawledAt[row] = product.crawl?.lastCrawledAt?.getTime() ?? 0;
  }

  onProductUpserted(product: Product): void {
    if (!product.embedding || product.embedding.length === 0) return;
    this.insert(product);
  }

  onProductRemoved(id: ObjectId): void {
    const row = this.rowOf.get(id.toHexString());
    if (row !== undefined) this.live[row] = 0;
  }

  async size(): Promise<number> {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.live[i] === 1) n += 1;
    return n;
  }

  private passesFilter(
    row: number,
    query: VectorQuery,
    exclusions: {
      ids: Set<string> | null;
      brands: Set<string> | null;
      sellers: Set<string> | null;
      domains: Set<string> | null;
    },
  ): boolean {
    if (this.live[row] !== 1) return false;
    const f = query.filter;

    if (f.inStock !== undefined && this.inStock[row] !== (f.inStock ? 1 : 0)) return false;
    if (f.statusIn && !f.statusIn.includes(this.status[row] as string)) return false;
    if (f.sourceTypeIn && !f.sourceTypeIn.includes(this.sourceType[row] as string)) return false;
    if (f.categoryL1In && !f.categoryL1In.includes(this.l1[row] as string)) return false;
    if (f.categoryL3In && !f.categoryL3In.includes(this.l3[row] as string)) return false;

    const amount = this.price[row] as number;
    if (f.priceMin !== undefined && amount < f.priceMin) return false;
    if (f.priceMax !== undefined && amount > f.priceMax) return false;

    if (f.crawledSince && (this.lastCrawledAt[row] as number) < f.crawledSince.getTime()) {
      return false;
    }

    if (exclusions.ids?.has((this.ids[row] as ObjectId).toHexString())) return false;
    const brand = this.brand[row];
    if (brand && exclusions.brands?.has(brand.toLowerCase())) return false;
    if (exclusions.sellers?.has(this.sellerId[row] as string)) return false;
    if (exclusions.domains?.has(this.domain[row] as string)) return false;

    return true;
  }

  async search(query: VectorQuery): Promise<VectorCandidate[]> {
    if (query.limit <= 0) return [];
    const f = query.filter;
    const exclusions = {
      ids: f.excludeIds?.length ? new Set(f.excludeIds.map((id) => id.toHexString())) : null,
      brands: f.excludeBrands?.length
        ? new Set(f.excludeBrands.map((b) => b.toLowerCase()))
        : null,
      sellers: f.excludeSellerIds?.length
        ? new Set(f.excludeSellerIds.map((id) => id.toHexString()))
        : null,
      domains: f.excludeDomains?.length ? new Set(f.excludeDomains) : null,
    };

    // The query vector is unit-normalized, and stored vectors were unit-normalized
    // before quantization, so the dot product is cosine similarity to within the
    // int8 rounding error the Atlas index would also incur.
    const q = query.vector;
    const dim = Math.min(q.length, EMBEDDING_DIM);

    // A bounded min-heap would beat a sorted insert at large `limit`; at 400 out
    // of a few hundred thousand the linear insert never shows up in a profile.
    const top: Array<{ row: number; score: number }> = [];
    let worst = -Infinity;

    for (let row = 0; row < this.count; row++) {
      if (!this.passesFilter(row, query, exclusions)) continue;

      const base = row * EMBEDDING_DIM;
      let dot = 0;
      for (let i = 0; i < dim; i++) {
        dot += (this.matrix[base + i] as number) * (q[i] as number);
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

    const ids = top.map((hit) => this.ids[hit.row] as ObjectId);
    const docs = await this.products
      .find({ _id: { $in: ids } }, { projection: CANDIDATE_PROJECTION })
      .toArray();

    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const out: VectorCandidate[] = [];
    for (const hit of top) {
      const doc = byId.get((this.ids[hit.row] as ObjectId).toHexString());
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
}
