/**
 * Helper functions to adapt MongoDB-style operations to Supabase/PostgreSQL
 * These provide compatibility layers for common MongoDB operations
 */

import type { SupabaseTable } from './supabase-collections.js';

/** Supabase exposes SQL columns in snake_case while the application contract
 * intentionally keeps the original Mongo-style camelCase names. */
/**
 * PostgREST reports a bad value without naming the table or the column — an
 * "invalid input syntax for type uuid" tells you nothing about which of the
 * eleven tables rejected it. The query builder carries its own endpoint URL, so
 * the table name is recoverable; adding it, plus the keys actually sent, turns
 * a blind failure into a locatable one.
 */
function tableNameOf(table: SupabaseTable): string {
  const url = (table as unknown as { url?: { pathname?: string } | string }).url;
  const pathname = typeof url === 'string' ? url : url?.pathname;
  return pathname ? (pathname.split('/').pop() ?? 'unknown') : 'unknown';
}

function describePayload(payload: Record<string, any> | undefined): string {
  if (!payload) return '';
  const empty = Object.entries(payload)
    .filter(([, value]) => value === '')
    .map(([key]) => key);
  const keys = Object.keys(payload).join(', ');
  return empty.length > 0
    ? ` | keys: [${keys}] | empty-string values: [${empty.join(', ')}]`
    : ` | keys: [${keys}]`;
}

function failed(
  table: SupabaseTable,
  operation: string,
  error: { message: string; code?: string },
  payload?: Record<string, any>,
): Error {
  return new Error(
    `${operation} on '${tableNameOf(table)}' failed: ${error.message}` +
      (error.code ? ` (${error.code})` : '') +
      describePayload(payload),
  );
}

function toColumnName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Splits a Mongo-style write into plain columns and dotted JSONB paths.
 *
 * `{ status: 'rejected', 'crawl.firstSeenAt': now }` addresses a column and a
 * field inside a JSONB column. Passing the dotted key straight through named a
 * column `crawl.first_seen_at`, which PostgREST rejects with "Could not find
 * the 'crawl.first_seen_at' column of 'products' in the schema cache" — the
 * error that failed every web listing before it reached the catalog.
 *
 * Note the two different casing rules: the part before the dot is a SQL column
 * and is snake_cased, while everything after it is a JSON property and keeps
 * its original spelling, because that is how the documents were written.
 */
function splitDottedPaths(value: Record<string, any>): {
  columns: Record<string, any>;
  nested: Record<string, Array<{ path: string[]; value: unknown }>>;
} {
  const columns: Record<string, any> = {};
  const nested: Record<string, Array<{ path: string[]; value: unknown }>> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!key.includes('.')) {
      columns[toColumnName(key)] = entry;
      continue;
    }
    const [root, ...path] = key.split('.');
    const column = toColumnName(root as string);
    (nested[column] ??= []).push({ path, value: entry });
  }

  return { columns, nested };
}

/** Writes `value` at `path` inside `target`, creating intermediate objects. */
function assignPath(target: Record<string, any>, path: string[], value: unknown): void {
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[path[path.length - 1] as string] = value;
}

function toDatabaseObject<T extends Record<string, any>>(value: T): Record<string, any> {
  const { columns, nested } = splitDottedPaths(value);
  // On an insert there is no stored row to merge with, so the dotted paths fold
  // into whatever literal object the same write already supplies for that
  // column (commonly none).
  for (const [column, writes] of Object.entries(nested)) {
    const base = typeof columns[column] === 'object' && columns[column] !== null
      ? { ...columns[column] }
      : {};
    for (const write of writes) assignPath(base, write.path, write.value);
    columns[column] = base;
  }
  return columns;
}

/**
 * Builds the column payload for an update, merging dotted JSONB paths into the
 * row's current value.
 *
 * A JSONB column can only be written whole over PostgREST, so setting one field
 * without first reading the column would drop its siblings — `crawl.failCount`
 * and `crawl.tier` would vanish when `crawl.lastCrawledAt` was touched.
 */
async function toUpdateObject(
  table: SupabaseTable,
  filters: Record<string, any>,
  update: Record<string, any>,
): Promise<Record<string, any>> {
  const { columns, nested } = splitDottedPaths(update);
  const roots = Object.keys(nested);
  if (roots.length === 0) return columns;

  let query = table.select(roots.join(','));
  query = applyFilters(query, filters);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  const current = (data ?? {}) as Record<string, any>;

  for (const [column, writes] of Object.entries(nested)) {
    const stored = current[column];
    const base = typeof stored === 'object' && stored !== null ? { ...stored } : {};
    if (typeof columns[column] === 'object' && columns[column] !== null) {
      Object.assign(base, columns[column]);
    }
    for (const write of writes) assignPath(base, write.path, write.value);
    columns[column] = base;
  }

  return columns;
}

/**
 * Renders a Mongo-style dotted path as a PostgREST JSON traversal.
 *
 * Only the final step may use `->>`: it yields `text`, while `->` yields
 * `jsonb` and is what the intermediate steps must use. Chaining `->>` through
 * the whole path produced `media->>hero->>blurhash`, which asks Postgres to
 * apply `->>` to a `text` value and fails with "operator does not exist:
 * text ->> unknown". Only paths two levels deep or more were affected, which is
 * why single-level filters like `source.domain` always worked.
 */
function toJsonColumn(key: string): string {
  if (key.includes('->')) return key;
  if (key.includes('.')) {
    const [column, ...path] = key.split('.');
    const leaf = path.pop() as string;
    const branches = path.map((segment) => `->${segment}`).join('');
    return `${toColumnName(column as string)}${branches}->>${leaf}`;
  }
  return toColumnName(key);
}

/**
 * Translates a projection list into column names.
 *
 * Callers write the application's camelCase field names — `select: 'sellerId'`
 * — which PostgREST rejects with "column products.sellerId does not exist"
 * because the column is `seller_id`. Already-snake_case names pass through
 * unchanged, so this is safe to apply to every projection.
 */
function toSelectList(select: string): string {
  return select
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '')
    .map((field) => (field === '*' ? field : toJsonColumn(field)))
    .join(',');
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

/**
 * Renders one `$or` branch as PostgREST filter syntax.
 *
 * Branches nest: cluster lookup builds `{ $or: [{ $or: [gtin, upc, ean] }, ...] }`
 * because a GTIN may be stored under any of three identifier fields. PostgREST
 * expresses that as a comma-separated list inside `or(...)`, so a nested branch
 * folds into a parenthesised `or(...)` group rather than becoming a column.
 */
function orConditions(clause: Record<string, any>): string[] {
  const parts: string[] = [];

  for (const [rawKey, value] of Object.entries(clause)) {
    if (rawKey === '$or' && Array.isArray(value)) {
      const nested = value.flatMap((entry) => orConditions(entry as Record<string, any>));
      if (nested.length > 0) parts.push(`or(${nested.join(',')})`);
      continue;
    }
    const key = toJsonColumn(rawKey);
    if (value === null || value === undefined) {
      parts.push(`${key}.is.null`);
      continue;
    }
    if (typeof value === 'object' && '$in' in value) {
      parts.push(`${key}.in.(${(value.$in as unknown[]).map(quoteValue).join(',')})`);
      continue;
    }
    parts.push(`${key}.eq.${quoteValue(value)}`);
  }

  return parts;
}

/** PostgREST splits on commas and parentheses, so values carrying either — a
 * title, a URL with a query string — have to travel quoted. */
function quoteValue(value: unknown): string {
  const text = String(value);
  return /[,.()"\s]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function applyFilters(query: any, filters: Record<string, any>): any {
  for (const [rawKey, value] of Object.entries(filters)) {
    // `$or` is a document-level operator, not a column. Passing it through
    // produced `column product_clusters.$or does not exist` and broke identifier
    // clustering for every ingested listing.
    if (rawKey === '$or' && Array.isArray(value)) {
      const parts = value.flatMap((entry) => orConditions(entry as Record<string, any>));
      if (parts.length > 0) query = query.or(parts.join(','));
      continue;
    }
    const key = toJsonColumn(rawKey);
    if (value === null || value === undefined) query = query.is(key, null);
    else if (typeof value === 'object' && '$ne' in value) query = query.neq(key, value.$ne);
    else if (typeof value === 'object' && '$in' in value) query = query.in(key, value.$in);
    else if (typeof value === 'object' && '$nin' in value) {
      // PostgREST spells "not in" as a negated `in`, and an empty exclusion
      // list must not become `not.in.()`, which it rejects.
      const excluded = value.$nin as unknown[];
      if (excluded.length > 0) query = query.not(key, 'in', `(${excluded.map(quoteValue).join(',')})`);
    }
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
  let query = table.select(options.select ? toSelectList(options.select) : '*');

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
    throw failed(table, 'findOne', error, filters);
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
  let query = table.select(options.select ? toSelectList(options.select) : '*');

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

  if (error) throw failed(table, 'find', error, filters);

  return fromDatabaseRows<T>(data);
}

/**
 * MongoDB insertOne equivalent
 */
export async function insertOne<T = any>(
  table: SupabaseTable,
  document: Record<string, any>
): Promise<T> {
  const payload = toDatabaseObject(document);
  const { data, error } = await table.insert(payload).select().single();

  if (error) throw failed(table, 'insertOne', error, payload);

  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB insert equivalent (for cases where we use .insert() directly)
 */
export async function insert<T = any>(
  table: SupabaseTable,
  document: Record<string, any>
): Promise<T> {
  const payload = toDatabaseObject(document);
  const { data, error } = await table.insert(payload).select().single();

  if (error) throw failed(table, 'insert', error, payload);

  return fromDatabaseRow<T>(data);
}

/**
 * MongoDB insertMany equivalent
 */
export async function insertMany<T = any>(
  table: SupabaseTable,
  documents: Record<string, any>[]
): Promise<T[]> {
  const rows = documents.map(toDatabaseObject);
  const { data, error } = await table.insert(rows).select();

  if (error) throw failed(table, 'insertMany', error, rows[0]);
  
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
  const payload = await toUpdateObject(table, filters, update);
  let query = table.update(payload);

  query = applyFilters(query, filters);

  const { data, error } = await query.select().single();

  if (error) throw failed(table, 'updateOne', error, payload);
  
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
  const payload = await toUpdateObject(table, filters, update);
  let query = table.update(payload);

  query = applyFilters(query, filters);

  const { data, error } = await query.select();

  if (error) throw failed(table, 'updateMany', error, payload);
  
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