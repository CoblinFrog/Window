import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { collectionsFor, type CollectionSet } from './supabase-collections.js';

export interface DatabaseHandle {
  client: SupabaseClient;
  collections: CollectionSet;
  close(): Promise<void>;
}

let handle: DatabaseHandle | null = null;

export async function connectDatabase(
  url: string = env.supabaseUrl,
  key: string = env.supabaseKey,
): Promise<DatabaseHandle> {
  if (handle) return handle;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment');
  }

  const client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  handle = {
    client,
    collections: collectionsFor(client),
    async close() {
      handle = null;
      // Supabase client doesn't need explicit closing
    },
  };

  logger.info('connected to supabase', { url });
  return handle;
}

export function database(): DatabaseHandle {
  if (!handle) throw new Error('Database not connected. Call connectDatabase() first.');
  return handle;
}

export async function closeDatabase(): Promise<void> {
  if (handle) await handle.close();
}