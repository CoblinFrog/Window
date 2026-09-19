import { DEFAULT_RANKING_CONFIG, type RankingConfig } from '@window/shared';
import { createCache, type KeyValueCache } from '../cache/index.js';
import { CartService } from '../cart/service.js';
import { CheckoutOrchestrator } from '../checkout/orchestrator.js';
import { CouponStore } from '../checkout/coupons.js';
import { MongoCheckoutRepository } from '../checkout/repository.mongo.js';
import type { CheckoutRepository } from '../checkout/repository.js';
import { connectDatabase, type DatabaseHandle } from '../db/client.js';
import { ensureIndexes } from '../db/indexes.js';
import { localEmbeddingProvider } from '../embedding/local.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { EventCollector } from '../events/collector.js';
import { FeedService } from '../feed/service.js';
import { CategoryClassifier } from '../ingestion/classify.js';
import { logger } from '../lib/logger.js';
import { mediaPipeline, type MediaPipeline } from '../media/pipeline.js';
import { RankingService } from '../ranking/service.js';
import { createVectorSearch } from '../vector/index.js';
import type { VectorSearch } from '../vector/types.js';
import { createMailer, createOidcVerifier, type Mailer, type OidcVerifier } from './claims.js';

export interface AppContext {
  db: DatabaseHandle;
  cache: KeyValueCache;
  vectors: VectorSearch;
  embedder: EmbeddingProvider;
  classifier: CategoryClassifier;
  media: MediaPipeline;
  ranking: RankingService;
  feed: FeedService;
  cart: CartService;
  /** The checkout data boundary; swapping it swaps the backing store. */
  repository: CheckoutRepository;
  checkout: CheckoutOrchestrator;
  events: EventCollector;
  coupons: CouponStore;
  /** Out-of-band delivery for email ownership challenges. */
  mailer: Mailer;
  /** ID-token verification for Apple and Google claims. */
  oidc: OidcVerifier;
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
  const repository = new MongoCheckoutRepository(db.collections);
  const cart = new CartService({ repository });
  const coupons = new CouponStore(repository);
  const checkout = new CheckoutOrchestrator({ repository, cache, coupons });
  const events = new EventCollector({ collections: db.collections, cache, config });
  const mailer = createMailer();
  const oidc = createOidcVerifier();

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
    cart,
    repository,
    checkout,
    events,
    coupons,
    mailer,
    oidc,
    config,
    async close() {
      await cache.close();
      await db.close();
    },
  };
}
