import { EMBEDDING_VERSION } from '@window/shared';
import { requireSecret } from './secrets.js';
import { SUPABASE_CONFIG } from './supabase.js';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

function list(name: string, fallback: readonly string[]): readonly string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  /**
   * Public origin, used to build media and deep-link URLs. It defaults to the
   * loopback address rather than to `host`: 0.0.0.0 is a bind address, and a
   * browser handed it as the origin of a hero image may refuse the request. Set
   * `PUBLIC_URL` to the address clients actually reach this server on.
   */
  publicUrl: str('PUBLIC_URL', `http://127.0.0.1:${int('PORT', 4000)}`),

  supabaseUrl: str('SUPABASE_URL', SUPABASE_CONFIG.url),
  supabaseKey: str('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_CONFIG.serviceRoleKey),

  // Legacy MongoDB config (kept for migration fallback)
  mongoUrl: str('MONGO_URL', 'mongodb://127.0.0.1:27017'),
  mongoDb: str('MONGO_DB', 'window'),

  /**
   * Atlas Vector Search is used when available. A local MongoDB has no
   * `$vectorSearch` stage, so the ranking service falls back to the in-process
   * index, which implements the same contract and the same filter semantics.
   */
  atlasVectorSearch: bool('ATLAS_VECTOR_SEARCH', false),
  vectorIndexName: str('VECTOR_INDEX_NAME', 'product_embedding_v2'),
  clusterVectorIndexName: str('CLUSTER_VECTOR_INDEX_NAME', 'cluster_embedding_v2'),

  redisUrl: str('REDIS_URL', ''),

  embeddingVersion: str('EMBEDDING_VERSION', EMBEDDING_VERSION),

  /** Object storage root. Transcoded media is written here and served by the CDN route. */
  mediaDir: str('MEDIA_DIR', new URL('../../../../.data/media', import.meta.url).pathname),
  /** Checkout audit screenshots and transcripts. */
  auditDir: str('AUDIT_DIR', new URL('../../../../.data/audit', import.meta.url).pathname),

  /**
   * Internal-only endpoints (ranking debug) require this header value. It is a
   * real secret rather than a fixed default, because the endpoint behind it
   * dumps per-user ranking state for any user id and rewrites the scoring
   * weights for everybody. Production refuses to boot without one.
   */
  internalToken: requireSecret('INTERNAL_TOKEN'),

  /**
   * Origins permitted to call the API from a browser. A development web client
   * runs on a different origin, so the two Expo defaults are allowed outside
   * production; a deployment names its own.
   */
  corsOrigins: list(
    'CORS_ORIGINS',
    str('NODE_ENV', 'development') === 'production'
      ? []
      : ['http://localhost:8081', 'http://127.0.0.1:8081'],
  ),

  /**
   * Number of reverse-proxy hops to trust when reading `X-Forwarded-For`.
   *
   * Express's `true` means "trust the whole chain", and the chain is written by
   * the client. That makes `req.ip` attacker-chosen, and `req.ip` is the rate
   * limit key on exactly the unauthenticated routes that mint credentials. A
   * hop count trusts only the proxies actually in front of this process: 0 in
   * development, 1 behind a single load balancer.
   */
  trustProxyHops: int('TRUST_PROXY_HOPS', 0),

  /**
   * Which checkout agent runs.
   *
   * `simulated` is the default and is named as a simulator so nobody mistakes a
   * green checkout for a real one. `browser` drives the merchant's own checkout
   * with Playwright — only meaningful where a field map exists for the merchant
   * and its robots.txt permits the path.
   */
  checkoutAgent: str('CHECKOUT_AGENT', 'simulated') as 'simulated' | 'browser',
  /** Headful, for watching a checkout run during development. */
  checkoutHeadful: bool('CHECKOUT_HEADFUL', false),

  /** Simulated merchant latency for the checkout agent, in milliseconds. */
  agentStepDelayMs: int('AGENT_STEP_DELAY_MS', 120),

  logLevel: str('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
} as const;

export type Env = typeof env;
