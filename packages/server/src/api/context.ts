import { DEFAULT_RANKING_CONFIG, type RankingConfig } from '@window/shared';
import { env } from '../config/env.js';
import { createCache, type KeyValueCache } from '../cache/index.js';
import { CartService } from '../cart/service.js';
import { CheckoutOrchestrator } from '../checkout/orchestrator.js';
import { CouponStore } from '../checkout/coupons.js';
import { SupabaseCheckoutRepository } from '../checkout/repository.supabase.js';
import { PlaywrightCheckoutBrowser } from '../checkout/browser.js';
import { fieldMapFor, originFor } from '../checkout/field-maps.js';
import { VaultHandle, type ShippingDetails } from '../checkout/vault.js';
import type { CheckoutRepository } from '../checkout/repository.js';
import { createMailer, createOidcVerifier, type Mailer, type OidcVerifier } from './claims.js';
import { connectDatabase, type DatabaseHandle } from '../db/index.js';
import type { AgentLlm } from '../agent/llm.js';
import { agentLlm } from '../agent/llm-api.js';
import type { ChatDeps } from '../agent/shop-chat.js';
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
  /** The shopping assistant's model. One cheap, fast call per ask. */
  llm: AgentLlm;
  /**
   * Retrieval seam for the assistant. Left unset in production, where the
   * agent goes to the live storefronts; tests substitute their own so an ask
   * costs no network.
   */
  askSearch?: ChatDeps['search'];
  classifier: CategoryClassifier;
  media: MediaPipeline;
  ranking: RankingService;
  feed: FeedService;
  ingest: IngestionPipeline;
  /** Re-fetch a product's listing from its source URL and upsert the result. */
  refreshProduct(product: import('../db/supabase-collections.js').Product): Promise<RefreshOutcome>;
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

  const cache = await createCache();
  const vectors = await createVectorSearch(db.collections.products);
  const embedder = localEmbeddingProvider();
  // Small and fast on purpose: the ask does retrieval in code and asks the
  // model only to judge titles and write two sentences. The API when a key is
  // configured, the `claude` CLI when not — the CLI spawns a subprocess per
  // call, which is the difference between a 3-second answer and a 30-second one.
  const llm = agentLlm({
    model: env.agentModel,
    timeoutMs: env.agentTimeoutMs,
    cli: { model: 'haiku', effort: 'low', timeoutMs: env.agentTimeoutMs },
  });

  const classifier = new CategoryClassifier(embedder);
  await classifier.init();

  // For now, use default ranking config. In Supabase, this could be stored in a config table
  const config = DEFAULT_RANKING_CONFIG;

  const ranking = new RankingService({ collections: db.collections, vectors, config });
  const feed = new FeedService({ collections: db.collections, ranking, vectors, cache });
  // Supabase has no `distinct`, so the brand dictionary is deduplicated here.
  // The pipeline only needs the set of known brands, not their counts.
  const { data: brandRows } = await db.collections.products.select('brand');
  const brandDictionary = [
    ...new Set(
      ((brandRows ?? []) as Array<{ brand?: unknown }>)
        .map((row) => row.brand)
        .filter((brand): brand is string => typeof brand === 'string' && brand !== ''),
    ),
  ];
  const ingest = new IngestionPipeline({
    collections: db.collections,
    embedder,
    classifier,
    media: mediaPipeline(),
    brandDictionary,
    onProductUpserted: (product) => vectors.onProductUpserted?.(product),
  });
  const refreshDeps = { collections: db.collections, pipeline: ingest };

  const repository = new SupabaseCheckoutRepository(db.client);
  // The live verifier re-checks price and stock against the merchant at the
  // moment the cart is opened, which is the freshness guarantee the cart
  // actually promises. It satisfies the same `StockVerifier` seam the stored
  // reader did, so the cart's own logic is unchanged.
  const cart = new CartService({ repository, verifier: new AdapterVerifier(refreshDeps) });
  const coupons = new CouponStore(repository);

  // The browser fleet is only constructed when it is actually going to run.
  // Launching Chromium for a deployment using the simulated rail would be a
  // hundred megabytes of process for nothing.
  const browser =
    env.checkoutAgent === 'browser'
      ? new PlaywrightCheckoutBrowser({ headless: !env.checkoutHeadful })
      : null;

  const checkout = new CheckoutOrchestrator({
    repository,
    cache,
    coupons,
    browser,
    fieldMapFor,
    originFor,
    // Delivery details, held encrypted for the life of the job.
    //
    // A real deployment loads these from the user's saved address at job
    // creation. That profile field does not exist yet, so development reads
    // them from DEMO_SHIPPING — which is why it is named for what it is. With
    // neither, there is no vault and the agent refuses rather than typing
    // unresolved references into a merchant's form.
    vaultFor: demoVaultFactory(),
  });
  const events = new EventCollector({ collections: db.collections, cache, config });
  const mailer = createMailer();
  const oidc = createOidcVerifier();

  logger.info('application context ready', {
    vectorBackend: vectors.kind,
    cacheBackend: cache.kind,
    rankingConfig: config.version,
    database: 'supabase',
  });

  return {
    db,
    cache,
    vectors,
    embedder,
    llm,
    classifier,
    media: mediaPipeline(),
    ranking,
    feed,
    ingest,
    refreshProduct: (product) => refreshProduct(refreshDeps, product),
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

/**
 * Development-only delivery details, from `DEMO_SHIPPING` as JSON.
 *
 * Deliberately not a fallback to invented values: an agent that types a made-up
 * address because none was configured would ship a real order to a real
 * stranger. No configuration means no vault means the job refuses.
 */
function demoVaultFactory(): () => VaultHandle | null {
  const raw = process.env.DEMO_SHIPPING;
  if (!raw) return () => null;

  let details: ShippingDetails;
  try {
    details = JSON.parse(raw) as ShippingDetails;
  } catch {
    logger.warn('DEMO_SHIPPING is not valid JSON; checkout will run without a vault');
    return () => null;
  }

  logger.warn('using DEMO_SHIPPING for checkout delivery details', {
    note: 'Development only. A deployment loads these from the user profile.',
  });
  // A fresh handle per job, so one job disposing it cannot blank another.
  return () => new VaultHandle(details);
}
