import type { Collection } from 'mongodb';
import { EMBEDDING_DIM } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Product } from '../db/collections.js';
import { AtlasVectorSearch } from './atlas.js';
import { LocalVectorIndex } from './local.js';
import type { VectorSearch } from './types.js';

export * from './types.js';
export { AtlasVectorSearch } from './atlas.js';
export { LocalVectorIndex } from './local.js';

/**
 * Picks the retrieval back end. Atlas is used when configured and reachable;
 * otherwise the in-process index is built from the catalog. Both satisfy the
 * same contract, so nothing downstream of retrieval knows which one it got.
 */
export async function createVectorSearch(
  products: Collection<Product>,
): Promise<VectorSearch> {
  if (env.atlasVectorSearch) {
    const atlas = new AtlasVectorSearch(products);
    try {
      // A probe with a correctly-dimensioned unit vector: if `$vectorSearch` is
      // not available the stage errors immediately, and finding that out at boot
      // beats finding it out on the first feed page.
      const probe = new Array<number>(EMBEDDING_DIM).fill(0);
      probe[0] = 1;
      await products
        .aggregate([
          {
            $vectorSearch: {
              index: env.vectorIndexName,
              path: 'embedding',
              queryVector: probe,
              numCandidates: 1,
              limit: 1,
            },
          },
          { $limit: 1 },
        ])
        .toArray();
      logger.info('using atlas vector search', { index: env.vectorIndexName });
      return atlas;
    } catch (error) {
      logger.warn('atlas vector search unavailable; building the in-process index', {
        error: (error as Error).message,
      });
    }
  }

  const local = new LocalVectorIndex(products);
  await local.build();
  return local;
}
