import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergePinned } from './pinned.js';
import { demoProductId, demoSellerId } from '../config/demo-store.js';
import type { VectorCandidate } from '../vector/types.js';

/** Only the id is read by the merge; the rest is shape. */
function candidate(id: string): VectorCandidate {
  return { id, vectorScore: 0.5 } as unknown as VectorCandidate;
}

const ids = (items: readonly VectorCandidate[]): string[] => items.map((c) => c.id);

const ranked = (n: number): VectorCandidate[] =>
  Array.from({ length: n }, (_, i) => candidate(`r${i + 1}`));

describe('mergePinned', () => {
  it('places pinned products at the configured offset, not at the top', () => {
    const merged = mergePinned([candidate('pin-a'), candidate('pin-b')], ranked(20), 20, 15);
    assert.deepEqual(ids(merged).slice(14, 18), ['r15', 'pin-a', 'pin-b', 'r16']);
    assert.equal(merged.length, 20);
  });

  it('puts them at the end of a page shorter than the offset', () => {
    const merged = mergePinned([candidate('pin-a')], ranked(4), 8, 15);
    assert.deepEqual(ids(merged), ['r1', 'r2', 'r3', 'r4', 'pin-a']);
  });

  it('moves rather than repeats a pinned product the ranker also returned', () => {
    // The first page is the case: nothing is in the seen-set yet, so the
    // ranker can return a pinned product on merit and both paths supply it.
    const merged = mergePinned(
      [candidate('pin-a')],
      [candidate('r1'), candidate('pin-a'), candidate('r2')],
      5,
      1,
    );
    assert.deepEqual(ids(merged), ['r1', 'pin-a', 'r2']);
    assert.equal(merged.filter((c) => c.id === 'pin-a').length, 1);
  });

  it('keeps the requested page length, dropping from the back', () => {
    const merged = mergePinned([candidate('pin-a')], ranked(5), 5, 2);
    assert.deepEqual(ids(merged), ['r1', 'r2', 'pin-a', 'r3', 'r4']);
  });

  it('never drops a pinned product to honour a smaller limit', () => {
    // A limit that cuts the pin off would otherwise silently un-pin it, which
    // is the one outcome the caller cannot detect.
    const merged = mergePinned([candidate('pin-a'), candidate('pin-b')], ranked(3), 2, 15);
    assert.deepEqual(ids(merged), ['r1', 'r2', 'r3', 'pin-a', 'pin-b']);
  });

  it('still honours an explicit zero offset', () => {
    const merged = mergePinned([candidate('pin-a')], ranked(3), 5, 0);
    assert.deepEqual(ids(merged), ['pin-a', 'r1', 'r2', 'r3']);
  });

  it('is a passthrough when nothing is pinned', () => {
    const items = [candidate('r1'), candidate('r2')];
    assert.deepEqual(ids(mergePinned([], items, 5, 15)), ['r1', 'r2']);
  });
});

describe('demo store ids', () => {
  it('derives a stable uuid per handle so re-seeding updates in place', () => {
    const first = demoProductId('example.com', 'a-handle');
    assert.equal(first, demoProductId('example.com', 'a-handle'));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('separates stores, handles and the seller row', () => {
    assert.notEqual(
      demoProductId('a.example', 'handle'),
      demoProductId('b.example', 'handle'),
    );
    assert.notEqual(
      demoProductId('a.example', 'one'),
      demoProductId('a.example', 'two'),
    );
    assert.notEqual(demoSellerId('a.example'), demoProductId('a.example', 'one'));
  });
});
