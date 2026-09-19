import type { KeyValueCache } from './index.js';

/**
 * The Redis-backed cache.
 *
 * The `redis` package is resolved at runtime through a non-literal specifier so
 * this file compiles and ships whether or not the dependency is installed. With
 * `REDIS_URL` set and the client present this is what serves the ranked buffer,
 * rate-limit counters and checkout job locks; without it, `createCache` falls
 * back to the in-process implementation, which has the same semantics on a
 * single node but does not survive a restart or span replicas.
 */

interface RedisLike {
  connect(): Promise<void>;
  quit(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
  pTTL(key: string): Promise<number>;
  on(event: string, handler: (err: unknown) => void): unknown;
}

export class RedisCache implements KeyValueCache {
  readonly kind = 'redis' as const;

  private constructor(private readonly client: RedisLike) {}

  static async connect(url: string): Promise<RedisCache> {
    const specifier = 'redis';
    const mod = (await import(specifier)) as { createClient(opts: { url: string }): RedisLike };
    const client = mod.createClient({ url });
    // An unhandled 'error' event would take the process down; the cache is not
    // allowed to be the reason the feed stops serving.
    client.on('error', () => {});
    await client.connect();
    return new RedisCache(client);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { PX: ttlMs });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.pExpire(key, windowMs);
      return { count, resetAt: Date.now() + windowMs };
    }
    const ttl = await this.client.pTTL(key);
    return { count, resetAt: Date.now() + (ttl > 0 ? ttl : windowMs) };
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, '1', { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
