/**
 * The shared cursor model.
 *
 * Both modes read from the same client-side ranked buffer, addressed by a single
 * integer `cursor`. A horizontal swipe switches layout; it never fetches a
 * different list. This is the single most important invariant in the product,
 * so it lives here as a pure reducer and is unit-tested rather than being
 * scattered through component state.
 */

import type { FeedMode } from './types.js';

export const PANE_SIZE = 4;

export interface CursorState {
  mode: FeedMode;
  /** Index of the current product in the ranked buffer. */
  cursor: number;
  /**
   * The grid pane that was showing when a tile was promoted, as a pane-start
   * index. Cleared the moment the user scrolls vertically in Single mode.
   */
  lastPane: number | null;
}

export type CursorAction =
  | { kind: 'swipe_left' }
  | { kind: 'swipe_right' }
  | { kind: 'scroll_next' }
  | { kind: 'scroll_prev' }
  | { kind: 'tap_tile'; index: number }
  | { kind: 'jump'; index: number };

export const INITIAL_CURSOR_STATE: CursorState = {
  mode: 'single',
  cursor: 0,
  lastPane: null,
};

/** The pane-start index of the pane containing `cursor`. */
export function paneStart(cursor: number): number {
  return Math.floor(cursor / PANE_SIZE) * PANE_SIZE;
}

/** The four buffer indexes rendered by Window mode for a given cursor. */
export function paneIndexes(cursor: number): number[] {
  const start = paneStart(cursor);
  return [start, start + 1, start + 2, start + 3];
}

/** True when this tile carries the 2 px accent border marking the current cursor. */
export function isHighlightedTile(state: CursorState, index: number): boolean {
  return state.mode === 'window' && index === state.cursor;
}

/**
 * The pane Window mode should render. Uses `lastPane` when the user arrived in
 * Single mode by promoting a tile, so the grid does not shift under them while
 * they triage the remaining three.
 */
export function paneToRender(state: CursorState): number {
  return state.lastPane ?? paneStart(state.cursor);
}

function clamp(index: number, max: number): number {
  if (index < 0) return 0;
  if (max >= 0 && index > max) return max;
  return index;
}

/**
 * Applies a gesture. `maxIndex` bounds the cursor to the loaded buffer; pass
 * `Infinity` when the buffer is still filling and the caller handles refill.
 */
export function cursorReducer(
  state: CursorState,
  action: CursorAction,
  maxIndex: number,
): CursorState {
  switch (action.kind) {
    // Single --swipe left--> Window, preserving the cursor.
    // Promoted --swipe left--> Window, returning to the remembered pane.
    case 'swipe_left': {
      if (state.mode === 'window') return state;
      return { mode: 'window', cursor: state.cursor, lastPane: state.lastPane };
    }

    // Window --swipe right--> Single at the same cursor, not at the pane start.
    case 'swipe_right': {
      if (state.mode === 'single') return state;
      return { mode: 'single', cursor: state.cursor, lastPane: state.lastPane };
    }

    // A vertical swipe moves the cursor by 1 in Single, or by a whole pane in
    // Window, snapping to the pane boundary.
    case 'scroll_next': {
      if (state.mode === 'single') {
        return {
          mode: 'single',
          cursor: clamp(state.cursor + 1, maxIndex),
          // Scrolling vertically in Single mode releases the remembered grid.
          lastPane: null,
        };
      }
      const next = clamp(paneStart(state.cursor) + PANE_SIZE, maxIndex);
      return { mode: 'window', cursor: next, lastPane: null };
    }

    case 'scroll_prev': {
      if (state.mode === 'single') {
        return {
          mode: 'single',
          cursor: clamp(state.cursor - 1, maxIndex),
          lastPane: null,
        };
      }
      const prev = clamp(paneStart(state.cursor) - PANE_SIZE, maxIndex);
      return { mode: 'window', cursor: prev, lastPane: null };
    }

    // Tapping a tile promotes it: the cursor becomes that index, the layout
    // cross-fades to Single, and the pane that was showing is remembered.
    case 'tap_tile': {
      if (state.mode !== 'window') return state;
      return {
        mode: 'single',
        cursor: clamp(action.index, maxIndex),
        lastPane: paneStart(state.cursor),
      };
    }

    // Deep link or share-link entry. Lands in Single at that product.
    case 'jump': {
      return { mode: 'single', cursor: clamp(action.index, maxIndex), lastPane: null };
    }
  }
}

/**
 * How many products the mode consumes per vertical scroll. Window mode burns
 * through the ranked list four times faster, which is why the server is told
 * the mode on every page request.
 */
export function consumptionRate(mode: FeedMode): number {
  return mode === 'window' ? PANE_SIZE : 1;
}
