import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * The hot-path cache.
 *
 * Redis in production: ranked buffer, rate-limit counters, checkout job locks.
 * The in-process implementation below has the same semantics and is what runs
 * when `REDIS_URL` is unset, so nothing on the feed path branches on which one
 * it got.
 */
export interface KeyValueCache {
  readonly kind: 'redis' | 'memory';
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment with expiry on first write. Backs the rate limiter. */
  incr(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  /** Single-holder lock. Backs the checkout job's single-submission invariant. */
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryCache implements KeyValueCache {
  readonly kind = 'memory' as const;
  private readonly store = new Map<string, Entry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepIntervalMs = 30_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // A cache sweep must never be the reason the process stays alive.
    this.sweeper.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private read(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.read(key);
    return entry ? (entry.value as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const existing = this.read(key);
    if (!existing) {
      const resetAt = Date.now() + windowMs;
      this.store.set(key, { value: 1, expiresAt: resetAt });
      return { count: 1, resetAt };
    }
    const count = (existing.value as number) + 1;
    existing.value = count;
    return { count, resetAt: existing.expiresAt };
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (this.read(key)) return false;
    this.store.set(key, { value: 1, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.store.delete(key);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.store.clear();
  }
}

/** Key namespaces, kept in one place so invalidation never misses a shape. */
export const cacheKeys = {
  rankedBuffer: (userId: string, mode: string) => `feed:buffer:${userId}:${mode}`,
  rankedBufferPrefixes: (userId: string) => [
    `feed:buffer:${userId}:single`,
    `feed:buffer:${userId}:window`,
  ],
  rateLimit: (principal: string, bucket: string) => `rl:${bucket}:${principal}`,
  checkoutJobLock: (jobId: string) => `lock:checkout:${jobId}`,
  /** Single-use SSE ticket. Deleted on redemption. */
  streamTicket: (ticket: string) => `sse:ticket:${ticket}`,
  /** Pending email-ownership challenge, keyed by the user it would claim. */
  emailChallenge: (userId: string) => `claim:email:${userId}`,
  clusterDoc: (clusterId: string) => `cluster:${clusterId}`,
  session: (sessionId: string) => `session:${sessionId}`,
};

let shared: KeyValueCache | null = null;

export async function createCache(): Promise<KeyValueCache> {
  if (shared) return shared;

  if (env.redisUrl) {
    try {
      const { RedisCache } = await import('./redis.js');
      shared = await RedisCache.connect(env.redisUrl);
      logger.info('using redis cache');
      return shared;
    } catch (error) {
      logger.warn('redis unavailable; using the in-process cache', {
        error: (error as Error).message,
      });
    }
  }

  shared = new MemoryCache();
  logger.info('using in-process cache');
  return shared;
}

export function cache(): KeyValueCache {
  if (!shared) throw new Error('Cache not created. Call createCache() first.');
  return shared;
}

export async function closeCache(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = null;
  }
}
