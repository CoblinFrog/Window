import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_CURSOR_STATE,
  PANE_SIZE,
  consumptionRate,
  cursorReducer,
  isHighlightedTile,
  paneIndexes,
  paneStart,
  paneToRender,
  type CursorState,
} from '@window/shared';

/**
 * The shared cursor model.
 *
 * This is the single most important invariant in the product: both modes read
 * from one ranked buffer addressed by one integer, and a horizontal swipe
 * switches layout without ever fetching a different list. Every behaviour the
 * PRD spells out for it is pinned here, because a regression in this file is a
 * regression the user feels as the grid shifting under their thumb.
 */

const MAX = 1000;

function state(partial: Partial<CursorState>): CursorState {
  return { ...INITIAL_CURSOR_STATE, ...partial };
}

describe('pane arithmetic', () => {
  it('derives the pane containing the cursor', () => {
    assert.equal(paneStart(0), 0);
    assert.equal(paneStart(3), 0);
    assert.equal(paneStart(4), 4);
    assert.equal(paneStart(9), 8);
    assert.equal(paneStart(11), 8);
  });

  it('renders four indexes per pane', () => {
    assert.deepEqual(paneIndexes(9), [8, 9, 10, 11]);
  });

  it('consumes four products per scroll in Window mode', () => {
    assert.equal(consumptionRate('single'), 1);
    assert.equal(consumptionRate('window'), PANE_SIZE);
  });
});

describe('mode switching', () => {
  it('preserves the cursor from Single into Window', () => {
    // "Swiping from Single at index 9 into Window shows the pane holding
    // indices 8-11, with index 9 highlighted."
    const next = cursorReducer(state({ cursor: 9 }), { kind: 'swipe_left' }, MAX);
    assert.equal(next.mode, 'window');
    assert.equal(next.cursor, 9);
    assert.deepEqual(paneIndexes(next.cursor), [8, 9, 10, 11]);
    assert.ok(isHighlightedTile(next, 9));
    assert.ok(!isHighlightedTile(next, 8));
  });

  it('returns from Window to Single at the same cursor, not the pane start', () => {
    const inWindow = state({ mode: 'window', cursor: 9 });
    const next = cursorReducer(inWindow, { kind: 'swipe_right' }, MAX);
    assert.equal(next.mode, 'single');
    assert.equal(next.cursor, 9, 'must not snap back to 8');
  });

  it('ignores a swipe that would switch to the mode already showing', () => {
    const single = state({ cursor: 5 });
    assert.deepEqual(cursorReducer(single, { kind: 'swipe_right' }, MAX), single);
    const window = state({ mode: 'window', cursor: 5 });
    assert.deepEqual(cursorReducer(window, { kind: 'swipe_left' }, MAX), window);
  });
});

describe('scrolling', () => {
  it('moves by one card in Single mode', () => {
    assert.equal(cursorReducer(state({ cursor: 7 }), { kind: 'scroll_next' }, MAX).cursor, 8);
    assert.equal(cursorReducer(state({ cursor: 7 }), { kind: 'scroll_prev' }, MAX).cursor, 6);
  });

  it('moves by a whole pane in Window mode, snapping to the boundary', () => {
    // From cursor 9 (pane 8-11) the next pane starts at 12, not at 13.
    const next = cursorReducer(
      state({ mode: 'window', cursor: 9 }),
      { kind: 'scroll_next' },
      MAX,
    );
    assert.equal(next.cursor, 12);

    const prev = cursorReducer(
      state({ mode: 'window', cursor: 9 }),
      { kind: 'scroll_prev' },
      MAX,
    );
    assert.equal(prev.cursor, 4);
  });

  it('clamps at both ends of the loaded buffer', () => {
    assert.equal(cursorReducer(state({ cursor: 0 }), { kind: 'scroll_prev' }, MAX).cursor, 0);
    assert.equal(cursorReducer(state({ cursor: MAX }), { kind: 'scroll_next' }, MAX).cursor, MAX);
  });
});

describe('tap to promote', () => {
  it('sets the cursor to the tapped tile and remembers the pane', () => {
    const inWindow = state({ mode: 'window', cursor: 8 });
    const promoted = cursorReducer(inWindow, { kind: 'tap_tile', index: 10 }, MAX);

    assert.equal(promoted.mode, 'single');
    assert.equal(promoted.cursor, 10);
    assert.equal(promoted.lastPane, 8);
  });

  it('returns to the remembered pane so the grid does not shift under the user', () => {
    // The whole point: after promoting tile 10, swiping back must show the same
    // pane the user was triaging, not the pane derived from the new cursor.
    const promoted = state({ mode: 'single', cursor: 10, lastPane: 8 });
    const back = cursorReducer(promoted, { kind: 'swipe_left' }, MAX);

    assert.equal(back.mode, 'window');
    assert.equal(paneToRender(back), 8);
  });

  it('keeps the remembered pane across all four tiles of a triage', () => {
    let current = state({ mode: 'window', cursor: 8 });
    for (const index of [8, 9, 10, 11]) {
      current = cursorReducer(current, { kind: 'tap_tile', index }, MAX);
      assert.equal(current.cursor, index);
      current = cursorReducer(current, { kind: 'swipe_left' }, MAX);
      assert.equal(paneToRender(current), 8, `pane shifted while triaging tile ${index}`);
    }
  });

  it('clears the remembered pane the moment the user scrolls in Single mode', () => {
    const promoted = state({ mode: 'single', cursor: 10, lastPane: 8 });
    const scrolled = cursorReducer(promoted, { kind: 'scroll_next' }, MAX);

    assert.equal(scrolled.lastPane, null);
    // With nothing remembered, Window mode derives the pane from the cursor.
    const back = cursorReducer(scrolled, { kind: 'swipe_left' }, MAX);
    assert.equal(paneToRender(back), paneStart(11));
  });

  it('cannot promote from Single mode', () => {
    const single = state({ cursor: 3 });
    assert.deepEqual(cursorReducer(single, { kind: 'tap_tile', index: 7 }, MAX), single);
  });
});

describe('deep links', () => {
  it('lands in Single mode at the linked product with no remembered pane', () => {
    const jumped = cursorReducer(
      state({ mode: 'window', cursor: 4, lastPane: 4 }),
      { kind: 'jump', index: 42 },
      MAX,
    );
    assert.equal(jumped.mode, 'single');
    assert.equal(jumped.cursor, 42);
    assert.equal(jumped.lastPane, null);
  });
});
