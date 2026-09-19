import { EMBEDDING_DIM } from '@window/shared';

/**
 * What the embedding model sees. The PRD's product embedding is multimodal over
 * title, brand, L3 path, key specs and the hero image, all in one joint space,
 * so the interface carries all of those rather than a flattened string.
 */
export interface EmbeddingInput {
  title: string;
  brand: string | null;
  category: { l1: string; l2: string; l3: string };
  specs?: Array<{ key: string; value: string }>;
  priceAmount?: number;
  /**
   * Stands in for the hero image. A real multimodal provider is handed the
   * image bytes; the local provider is handed a stable descriptor of them.
   */
  imageDescriptor?: string;
}

export interface EmbeddingProvider {
  /** Pinned in `product.embeddingVersion`; a change triggers a background re-embed. */
  readonly version: string;
  readonly dimensions: number;
  embed(input: EmbeddingInput): Promise<number[]>;
  embedBatch(inputs: EmbeddingInput[]): Promise<number[][]>;
  /** Free text, for the keyword-fallback search path. */
  embedText(text: string): Promise<number[]>;
}

export const EMBEDDING_DIMENSIONS = EMBEDDING_DIM;
