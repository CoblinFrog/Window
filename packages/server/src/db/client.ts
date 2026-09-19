import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { collectionsFor, type CollectionSet } from './collections.js';

export interface DatabaseHandle {
  client: MongoClient;
  db: Db;
  collections: CollectionSet;
  close(): Promise<void>;
}

let handle: DatabaseHandle | null = null;

export async function connectDatabase(
  url: string = env.mongoUrl,
  dbName: string = env.mongoDb,
): Promise<DatabaseHandle> {
  if (handle) return handle;

  const client = new MongoClient(url, {
    // The feed path is latency-critical; a slow pool is worse than a fast error.
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);

  handle = {
    client,
    db,
    collections: collectionsFor(db),
    async close() {
      handle = null;
      await client.close();
    },
  };

  logger.info('connected to mongodb', { db: dbName });
  return handle;
}

export function database(): DatabaseHandle {
  if (!handle) throw new Error('Database not connected. Call connectDatabase() first.');
  return handle;
}

export async function closeDatabase(): Promise<void> {
  if (handle) await handle.close();
}
