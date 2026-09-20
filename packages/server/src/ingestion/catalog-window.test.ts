import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { oldestProductIds, removeProducts } from './catalog-window.js';
import type { CollectionSet } from '../db/supabase-collections.js';

/**
 * The deletion order is the whole point of `removeProducts`, and it is a
 * property of the schema rather than of any one row: clusters have to go first
 * or Postgres refuses the product delete. These stubs record the order so that
 * invariant is checked without a database.
 */
function stubCollections(options: {
  products: Array<{ id: string; clusterId: string | null }>;
  order: string[];
}): CollectionSet {
  const deleteBuilder = (table: string) => ({
    delete() {
      return {
        in(_column: string, ids: string[]) {
          options.order.push(`${table}:${ids.join(',')}`);
          return Promise.resolve({ error: null });
        },
      };
    },
    select(_columns?: string) {
      const rows = options.products.map((p) => ({ id: p.id }));
      const result = {
        eq(column: string, value: string) { options.order.push(`filter:${column}=${value}`); return result; },
        order() { return result; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        in() { return Promise.resolve({ data: options.products, error: null }); },
      };
      return result;
    },
  });

  return {
    products: deleteBuilder('products') as never,
    clusters: deleteBuilder('clusters') as never,
  } as unknown as CollectionSet;
}

describe('removeProducts', () => {
  it('deletes clusters before products, so the canonical FK never blocks', async () => {
    const order: string[] = [];
    const collections = stubCollections({
      products: [
        { id: 'p1', clusterId: 'c1' },
        { id: 'p2', clusterId: 'c2' },
      ],
      order,
    });

    const removed = await removeProducts(collections, ['p1', 'p2']);

    assert.equal(removed, 2);
    assert.deepEqual(order, ['clusters:c1,c2', 'products:p1,p2']);
  });

  it('skips the cluster step for products that are not clustered', async () => {
    const order: string[] = [];
    const collections = stubCollections({
      products: [{ id: 'p1', clusterId: null }],
      order,
    });

    await removeProducts(collections, ['p1']);

    assert.deepEqual(order, ['products:p1']);
  });

  it('does nothing when given no ids', async () => {
    const order: string[] = [];
    const collections = stubCollections({ products: [], order });

    assert.equal(await removeProducts(collections, []), 0);
    assert.deepEqual(order, []);
  });
});

describe('oldestProductIds', () => {
  it('never returns ids it was told to exclude', async () => {
    const collections = stubCollections({
      products: [
        { id: 'new1', clusterId: null },
        { id: 'old1', clusterId: null },
        { id: 'old2', clusterId: null },
      ],
      order: [],
    });

    // The freshly-added listings must survive the rotation that added them.
    const ids = await oldestProductIds(collections, 2, ['new1']);

    assert.deepEqual(ids, ['old1', 'old2']);
  });

  it('considers only active rows, so tombstones are never retired in their place', async () => {
    const order: string[] = [];
    const collections = stubCollections({ products: [{ id: 'a', clusterId: null }], order });

    await oldestProductIds(collections, 1);

    assert.ok(order.includes('filter:status=active'));
  });

  it('returns nothing for a non-positive limit', async () => {
    const collections = stubCollections({ products: [{ id: 'a', clusterId: null }], order: [] });
    assert.deepEqual(await oldestProductIds(collections, 0), []);
  });
});
