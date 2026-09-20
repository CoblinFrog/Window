import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { persistWebListings } from './web-persistence.js';
import type { RawListing } from './types.js';

const listing = (sourceId: string): RawListing => ({ sourceId } as RawListing);

describe('persistWebListings', () => {
  it('stops once the requested number has been ingested, not merely attempted', async () => {
    const calls: string[] = [];
    const pipeline = {
      async ingest(row: RawListing) {
        calls.push(row.sourceId);
        return row.sourceId === 'rejected'
          ? { status: 'rejected', productId: null, clusterId: null, rejectReason: 'price_missing', matchStrength: 'none' }
          : { status: 'ingested', productId: row.sourceId, clusterId: 'cluster', rejectReason: null, matchStrength: 'none' };
      },
    };

    // A rejection in the middle must not consume one of the two requested
    // slots: the walk continues to `second` and stops only after two products
    // have actually been written, leaving `not-attempted` untouched.
    const stats = await persistWebListings(
      pipeline as never,
      [listing('first'), listing('rejected'), listing('second'), listing('not-attempted')],
      2,
    );

    assert.deepEqual(calls, ['first', 'rejected', 'second']);
    assert.deepEqual(stats, {
      attempted: 3,
      ingested: 2,
      rejected: 1,
      unchanged: 0,
      errors: 0,
      reasons: { price_missing: 1 },
    });
  });

  it('stops when the collected pool runs out before the limit is reached', async () => {
    const pipeline = {
      async ingest() {
        return { status: 'rejected', productId: null, clusterId: null, rejectReason: 'price_missing', matchStrength: 'none' };
      },
    };

    const stats = await persistWebListings(pipeline as never, [listing('a'), listing('b')], 4);

    assert.equal(stats.attempted, 2);
    assert.equal(stats.ingested, 0);
    assert.equal(stats.rejected, 2);
  });

  it('continues after a pipeline error and records it separately', async () => {
    const failed: string[] = [];
    const pipeline = {
      async ingest(row: RawListing) {
        if (row.sourceId === 'broken') throw new Error('storage unavailable');
        return { status: 'unchanged', productId: row.sourceId, clusterId: null, rejectReason: null, matchStrength: 'none' };
      },
    };

    const stats = await persistWebListings(
      pipeline as never,
      [listing('broken'), listing('same')],
      2,
      new Date('2026-01-01T00:00:00Z'),
      (row) => failed.push(row.sourceId),
    );

    assert.deepEqual(failed, ['broken']);
    assert.equal(stats.errors, 1);
    assert.equal(stats.unchanged, 1);
    assert.deepEqual(stats.reasons, { pipeline_error: 1 });
  });
});
