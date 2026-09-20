import { EMBEDDING_DIM } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Product } from '../db/supabase-collections.js';
import { LocalVectorIndex } from './local.js';
import type { VectorSearch } from './types.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export * from './types.js';
export { LocalVectorIndex } from './local.js';

/**
 * Picks the retrieval back end. For Supabase, we use the in-process index.
 * Both satisfy the same contract, so nothing downstream of retrieval knows which one it got.
 */
export async function createVectorSearch(
  products: ReturnType<SupabaseClient['from']>,
): Promise<VectorSearch> {
  const local = new LocalVectorIndex(products);
  await local.build();
  return local;
}
