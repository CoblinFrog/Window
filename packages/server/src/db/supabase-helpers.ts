/**
 * Helper functions to adapt MongoDB-style operations to Supabase/PostgreSQL
 * These provide compatibility layers for common MongoDB operations
 */

import type { SupabaseTable } from './supabase-collections.js';

/** Supabase exposes SQL columns in snake_case while the application contract
 * intentionally keeps the original Mongo-style camelCase names. */
function toColumnName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toDatabaseObject<T extends Record<string, any>>(value: T): Record<string, any> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [toColumnName(key), entry]));
}

function toJsonColumn(key: string): string {
  if (key.includes('->>')) return key;
  if (key.includes('.')) {
    const [column, ...path] = key.split('.');
    return `${toColumnName(column as string)}->>${path.join('->>')}`;
  }
  return toColumnName(key);
}

function toOrderColumn(key: string): string {
  // Mongo-style dotted paths refer to JSONB properties in Supabase. Preserve
  // JSON property casing and use PostgREST's JSON traversal syntax.
  return toJsonColumn(key);
}

/** A full ISO-8601 instant, which is the only shape `timestamptz` and the
 * dates nested inside our JSONB columns are ever written in. Date-only strings
 * are deliberately excluded: nothing in the model stores one, and reviving them
 * would silently rewrite ordinary text that happens to look like a date. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Turns the ISO strings Postgres hands back into the `Date` objects the domain
 * types declare.
 *
 * The document types are shared with the ranking and ingestion code, which
 * calls `.getTime()` on `crawl.firstSeenAt`, `counters.lastActiveAt` and their
 * peers. Those fields live inside JSONB columns, so they arrive as strings and
 * every such call throws — which the feed catches as a ranking failure and
 * silently answers with a degraded page. Reviving here, at the one point every
 * read passes through, keeps that contract honest for all callers at once.
 */
export function reviveDates<T>(value: T): T {
  if (typeof value === 'string') {
    return (ISO_INSTANT.test(value) ? new Date(value) : value) as T;
  }
  if (Array.isArray(value)) {
    // Embeddings are long number arrays; skip the walk when there is no string
    // anywhere in the array to find.
    return value.map((entry) => reviveDates(entry)) as T;
  }
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        reviveDates(entry),
      ]),
    ) as T;
  }
  return value;
}

function fromDatabaseRow<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      reviveDates(entry),
    ]),
  ) as T;
}

function fromDatabaseRows<T>(value: unknown[] | null): T[] {
  return (value ?? []).map((row) => fromDatabaseRow<T>(row));
}

function applyFilters(query: any, filters: Record<string, any>): any {
  for (const [rawKey, value] of Object.entries(filters)) {
    const key = toJsonColumn(rawKey);
    if (value === null || value === undefined) query = query.is(key, null);
    else if (typeof value === 'object' && '$ne' in value) query = query.neq(key, value.$ne);
    else if (typeof value === 'object' && '$in' in value) query = query.in(key, value.$in);
    else if (typeof value === 'object' && '$nin' in value) query = query.not(key, 'in', `(${value.$nin.join(',')})`);
    else if (typeof value === 'object' && '$gt' in value) query = query.gt(key, value.$gt);
    else if (typeof value === 'object' && '$gte' in value) query = query.gte(key, value.$gte);
    else if (typeof value === 'object' && '$lt' in value) query = query.lt(key, value.$lt);
    else if (typeof value === 'object' && '$lte' in value) query = query.lte(key, value.$lte);
    else query = query.eq(key, value);
  }
  return query;
}

/**
 * MongoDB findOne equivalent
 */
export async function findOne<T = any>(
  table: SupabaseTable,
  filters: Record<string, any> = {},
  options: { select?: string; orderBy?: { column: string; ascending?: boolean } } = {}
): Promise<T | null> {
  let query = table.select(options.select || '*');

  query = applyFilters(query, filters);

  // Apply ordering
  if (options.orderBy) {
    query = query.order(toOrderColumn(options.orderBy.column), { ascending: options.orderBy.ascending ?? true });
  }

  const { data, error } = await query.limit(1).single();
  
  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      return null;
    }
    throw error;
  }
  
  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB find equivalent
 */
export async function find<T = any>(
  table: SupabaseTable,
  filters: Record<string, any> = {},
  options: { 
    select?: string; 
    limit?: number; 
    skip?: number;
    orderBy?: { column: string; ascending?: boolean } | Array<{ column: string; ascending?: boolean }>;
  } = {}
): Promise<T[]> {
  let query = table.select(options.select || '*');

  query = applyFilters(query, filters);

  // Apply ordering
  if (options.orderBy) {
    if (Array.isArray(options.orderBy)) {
      options.orderBy.forEach(order => {
        query = query.order(toOrderColumn(order.column), { ascending: order.ascending ?? true });
      });
    } else {
      query = query.order(toOrderColumn(options.orderBy.column), { ascending: options.orderBy.ascending ?? true });
    }
  }

  // Apply pagination
  if (options.skip) {
    query = query.range(options.skip, (options.skip + (options.limit || 10)) - 1);
  } else if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  
  if (error) throw error;
  
  return fromDatabaseRows<T>(data);
}

/**
 * MongoDB insertOne equivalent
 */
export async function insertOne<T = any>(
  table: SupabaseTable,
  document: Record<string, any>
): Promise<T> {
  const { data, error } = await table.insert(toDatabaseObject(document)).select().single();
  
  if (error) throw error;
  
  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB insert equivalent (for cases where we use .insert() directly)
 */
export async function insert<T = any>(
  table: SupabaseTable,
  document: Record<string, any>
): Promise<T> {
  const { data, error } = await table.insert(toDatabaseObject(document)).select().single();
  
  if (error) throw error;
  
  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB insertMany equivalent
 */
export async function insertMany<T = any>(
  table: SupabaseTable,
  documents: Record<string, any>[]
): Promise<T[]> {
  const { data, error } = await table.insert(documents.map(toDatabaseObject)).select();
  
  if (error) throw error;
  
  return fromDatabaseRows<T>(data);
}

/**
 * MongoDB updateOne equivalent
 */
export async function updateOne<T = any>(
  table: SupabaseTable,
  filters: Record<string, any>,
  update: Record<string, any>
): Promise<T> {
  let query = table.update(toDatabaseObject(update));

  query = applyFilters(query, filters);

  const { data, error } = await query.select().single();
  
  if (error) throw error;
  
  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB updateMany equivalent
 */
export async function updateMany<T = any>(
  table: SupabaseTable,
  filters: Record<string, any>,
  update: Record<string, any>
): Promise<T[]> {
  let query = table.update(toDatabaseObject(update));

  query = applyFilters(query, filters);

  const { data, error } = await query.select();
  
  if (error) throw error;
  
  return fromDatabaseRows<T>(data);
}

/**
 * MongoDB deleteOne equivalent
 */
export async function deleteOne<T = any>(
  table: SupabaseTable,
  filters: Record<string, any>
): Promise<T> {
  let query = table.delete();

  query = applyFilters(query, filters);

  const { data, error } = await query.select().single();
  
  if (error) throw error;
  
  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB deleteMany equivalent
 */
export async function deleteMany<T = any>(
  table: SupabaseTable,
  filters: Record<string, any>
): Promise<T[]> {
  let query = table.delete();

  query = applyFilters(query, filters);

  const { data, error } = await query.select();
  
  if (error) throw error;
  
  return fromDatabaseRows<T>(data);
}

/**
 * MongoDB count equivalent
 */
export async function count(
  table: SupabaseTable,
  filters: Record<string, any> = {}
): Promise<number> {
  let query = table.select('*', { count: 'exact', head: true });

  query = applyFilters(query, filters);

  const { count, error } = await query;
  
  if (error) throw error;
  
  return count || 0;
}