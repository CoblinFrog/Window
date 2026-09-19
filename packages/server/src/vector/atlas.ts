import type { Collection, Document } from 'mongodb';
import { env } from '../config/env.js';
import type { Product } from '../db/collections.js';
import { CANDIDATE_PROJECTION, type VectorCandidate, type VectorQuery, type VectorSearch } from './types.js';

/**
 * Retrieval stage 1 against Atlas Vector Search.
 *
 * The whole point of putting vectors next to the operational documents is that
 * filtering, scoring inputs and the ANN traversal are one round trip. The
 * filter is expressed with the index's declared filter paths so Atlas applies
 * it during traversal, and the candidate projection happens server-side so the
 * 400 embeddings that come back are the only large payload on the wire.
 */
export class AtlasVectorSearch implements VectorSearch {
  readonly kind = 'atlas' as const;

  constructor(
    private readonly products: Collection<Product>,
    private readonly indexName: string = env.vectorIndexName,
  ) {}

  private buildFilter(query: VectorQuery): Document | undefined {
    const clauses: Document[] = [];
    const f = query.filter;

    if (f.categoryL1In?.length) clauses.push({ 'category.l1': { $in: f.categoryL1In } });
    if (f.categoryL3In?.length) clauses.push({ 'category.l3': { $in: f.categoryL3In } });
    if (f.inStock !== undefined) clauses.push({ 'stock.inStock': f.inStock });
    if (f.statusIn?.length) clauses.push({ status: { $in: f.statusIn } });
    if (f.sourceTypeIn?.length) clauses.push({ sourceType: { $in: f.sourceTypeIn } });

    if (f.priceMin !== undefined || f.priceMax !== undefined) {
      const range: Document = {};
      if (f.priceMin !== undefined) range.$gte = f.priceMin;
      if (f.priceMax !== undefined) range.$lte = f.priceMax;
      clauses.push({ 'price.amount': range });
    }

    if (clauses.length === 0) return undefined;
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  async search(query: VectorQuery): Promise<VectorCandidate[]> {
    const filter = this.buildFilter(query);
    const stage: Document = {
      index: this.indexName,
      path: 'embedding',
      queryVector: query.vector,
      numCandidates: query.numCandidates,
      limit: query.limit,
    };
    if (filter) stage.filter = filter;

    const pipeline: Document[] = [{ $vectorSearch: stage }];

    // High-cardinality exclusions are not declared filter paths — a per-user
    // suppression list cannot be indexed — so they are dropped immediately
    // after traversal, still inside the aggregation rather than in application
    // code, which is what keeps the candidate pool server-side.
    const post: Document = {};
    const f = query.filter;
    if (f.excludeIds?.length) post._id = { $nin: f.excludeIds };
    if (f.excludeBrands?.length) post.brand = { $nin: f.excludeBrands };
    if (f.excludeSellerIds?.length) post.sellerId = { $nin: f.excludeSellerIds };
    if (f.excludeDomains?.length) post['source.domain'] = { $nin: f.excludeDomains };
    if (f.crawledSince) post['crawl.lastCrawledAt'] = { $gte: f.crawledSince };
    if (Object.keys(post).length > 0) pipeline.push({ $match: post });

    pipeline.push({
      $project: { ...CANDIDATE_PROJECTION, vectorScore: { $meta: 'vectorSearchScore' } },
    });

    const docs = await this.products.aggregate<VectorCandidate>(pipeline).toArray();
    return docs;
  }

  async size(): Promise<number> {
    return this.products.countDocuments({ status: 'active' });
  }
}
