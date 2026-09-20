import { DEFAULT_RANKING_CONFIG, type RankingConfig } from '@window/shared';
import { createCache, type KeyValueCache } from '../cache/index.js';
import { CartService } from '../cart/service.js';
import { CheckoutOrchestrator } from '../checkout/orchestrator.js';
import { CouponStore } from '../checkout/coupons.js';
import { connectDatabase, type DatabaseHandle } from '../db/client.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { EventCollector } from '../events/collector.js';
import { FeedService } from '../feed/service.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { AdapterVerifier, refreshProduct, type RefreshOutcome } from '../ingestion/live.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import { logger } from '../lib/logger.js';
import { mediaPipeline, type MediaPipeline } from '../media/pipeline.js';
import { RankingService } from '../ranking/service.js';
import { createVectorSearch } from '../vector/index.js';
import type { VectorSearch } from '../vector/types.js';

export interface AppContext {
  db: DatabaseHandle;
  cache: KeyValueCache;
  vectors: VectorSearch;
  embedder: EmbeddingProvider;
  classifier: CategoryClassifier;
  media: MediaPipeline;
  ranking: RankingService;
  feed: FeedService;
  ingest: IngestionPipeline;
  /** Re-fetch a product's listing from its source URL and upsert the result. */
  refreshProduct(product: import('../db/collections.js').Product): Promise<RefreshOutcome>;
  cart: CartService;
  checkout: CheckoutOrchestrator;
  events: EventCollector;
  coupons: CouponStore;
  config: RankingConfig;
  close(): Promise<void>;
}

/**
 * Wires the services together.
 *
 * The composition happens once, here, so that every route handler receives
 * fully constructed collaborators and no module reaches for a global. That is
 * also what makes the whole stack constructible in a test with a different
 * database name and a memory cache.
 */
export async function createContext(options: { ensureIndexes?: boolean } = {}): Promise<AppContext> {
  const db = await connectDatabase();
  if (options.ensureIndexes !== false) await ensureIndexes(db.db);

  const cache = await createCache();
  const vectors = await createVectorSearch(db.collections.products);
  const embedder = localEmbeddingProvider();

  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  // Ranking weights live in a config document and are hot-reloadable; the
  // built-in defaults are the bootstrap value when none has been written yet.
  const stored = await db.db
    .collection<{ _id: string; config: RankingConfig }>('config')
    .findOne({ _id: 'ranking' });
  const config = stored?.config ?? DEFAULT_RANKING_CONFIG;

  const ranking = new RankingService({ collections: db.collections, vectors, config });
  const feed = new FeedService({ collections: db.collections, ranking, vectors, cache });

  const brandDictionary = (await db.collections.products.distinct('brand')).filter(
    (brand): brand is string => typeof brand === 'string' && brand !== '',
  );
  const ingest = new IngestionPipeline({
    collections: db.collections,
    embedder,
    classifier,
    media: mediaPipeline(),
    brandDictionary,
    onProductUpserted: (product) => vectors.onProductUpserted?.(product),
  });
  const refreshDeps = { collections: db.collections, pipeline: ingest };
  const cart = new CartService({
    collections: db.collections,
    verifier: new AdapterVerifier(refreshDeps),
  });
  const coupons = new CouponStore(db.collections.coupons);
  const checkout = new CheckoutOrchestrator({ collections: db.collections, cache, coupons });
  const events = new EventCollector({ collections: db.collections, cache, config });

  logger.info('application context ready', {
    vectorBackend: vectors.kind,
    cacheBackend: cache.kind,
    rankingConfig: config.version,
  });

  return {
    db,
    cache,
    vectors,
    embedder,
    classifier,
    media: mediaPipeline(),
    ranking,
    feed,
    ingest,
    refreshProduct: (product) => refreshProduct(refreshDeps, product),
    cart,
    checkout,
    events,
    coupons,
    config,
    async close() {
      await cache.close();
      await db.close();
    },
  };
}
