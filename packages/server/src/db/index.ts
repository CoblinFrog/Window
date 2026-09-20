/**
 * Database client for Supabase
 */

import { env } from '../config/env.js';

// Import Supabase client functions
import { connectDatabase as connectSupabase, database as getSupabaseDatabase, closeDatabase as closeSupabaseFunc, type DatabaseHandle as SupabaseHandle } from './supabase-client.js';

// Export Supabase client
export { connectDatabase as connectSupabaseDatabase, database as supabaseDatabase, closeDatabase as closeSupabaseDatabase } from './supabase-client.js';
export { collectionsFor as supabaseCollectionsFor } from './supabase-collections.js';

// Export common types
export type { 
  Product, 
  Cluster, 
  User, 
  Interaction, 
  Category, 
  Seller, 
  Review, 
  Cart, 
  Order, 
  Coupon, 
  Source,
  ReportDoc,
  MerchantLinkDoc
} from './supabase-collections.js';

// Database handle type
export type DatabaseHandle = SupabaseHandle;

// Connect function
export async function connectDatabase(): Promise<DatabaseHandle> {
  return await connectSupabase();
}

// Database accessor
export function database(): DatabaseHandle {
  return getSupabaseDatabase();
}

// Close function
export async function closeDatabase(): Promise<void> {
  await closeSupabaseFunc();
}