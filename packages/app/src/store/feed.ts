import { create } from 'zustand';
import {
  BUFFER_CONFIG,
  CATALOG_WINDOW,
  INITIAL_CURSOR_STATE,
  PANE_SIZE,
  cursorReducer,
  paneStart,
  paneToRender,
  type CursorAction,
  type CursorState,
  type FeedMode,
  type ChatPickResponse,
  type ProductCard,
} from '@window/shared';
import { api } from '../api/client.js';
import { picksToCards } from './pickCard.js';

/**
 * The feed buffer and the shared cursor.
 *
 * Both modes read from this one ranked buffer, addressed by a single integer
 * cursor. A horizontal swipe switches layout; it never fetches a different
 * list. That invariant is what makes tap-to-promote feel instant, so the buffer
 * is append-only within a session and products already shown are never
 * re-ranked into it.
 */

export interface FeedState extends CursorState {
  buffer: ProductCard[];
  /** Ids already served, sent up with each page request. */
  seen: string[];
  loading: boolean;
  /** Set when the server served a degraded page, for the stale-prices bar. */
  degraded: FeedPageDegradation;
  offline: boolean;
  rankingConfigVersion: string;
  explorationProductIds: Set<string>;
  dispatch(action: CursorAction): void;
  ensureBuffer(mode: FeedMode): Promise<void>;
  reset(): Promise<void>;
  setOffline(offline: boolean): void;
  current(): ProductCard | null;
  pane(): ProductCard[];
  /** Hero images to prefetch, per the prefetch rules for the current mode. */
  prefetchTargets(dataSaver: boolean): string[];
  /** Video is prefetched for cursor+1 only and evicted beyond cursor+3. */
  videoWindow(): { play: string | null; prefetch: string | null; evictBeyond: number };
  swapDeadListing(productId: string): void;
  /** Replace a buffered card in place — e.g. with a live-refreshed detail. */
  patchCard(card: ProductCard): void;
  /**
   * Replace the buffer with the assistant's own picks and open `productId` in
   * Single mode. The one sanctioned exception to the append-only buffer rule:
   * the shopper tapped a specific listing, so continuing to scroll the old
   * ranked list would answer a question they have moved on from.
   *
   * Addressed by id rather than by position, because a pick the feed cannot
   * render is dropped on the way in and every index after it would shift.
   */
  seedFromPicks(picks: readonly ChatPickResponse[], productId: string): boolean;
}

type FeedPageDegradation = 'cache' | 'topic_popularity' | 'global_popularity' | null;

let sessionId = `s_${Date.now().toString(36)}`;
let inFlight: Promise<void> | null = null;

/**
 * When this session last asked the server to rotate the catalog window.
 *
 * Module state rather than store state: it is bookkeeping about a request, not
 * something any view renders, and keeping it out of the store means a rotation
 * never triggers a re-render of the feed.
 */
let lastRotationAt = 0;

/**
 * Advances the rolling catalog window once the cursor passes the threshold.
 *
 * Fire-and-forget by design. The rotation refills the catalog for later
 * scrolling, so nothing on screen waits for it, and a failure is invisible.
 * The cooldown is what makes scrolling back and forth across the threshold
 * cost one crawl rather than one per crossing.
 */
function maybeRotateCatalog(cursor: number): void {
  if (cursor < CATALOG_WINDOW.threshold) return;
  const now = Date.now();
  if (now - lastRotationAt < CATALOG_WINDOW.cooldownMs) return;
  lastRotationAt = now;
  void api.rotateCatalog({ add: CATALOG_WINDOW.add, drop: CATALOG_WINDOW.drop });
}

/** Test seam: forget that a rotation ever happened. */
export function resetCatalogRotation(): void {
  lastRotationAt = 0;
}

export function setFeedSessionId(id: string): void {
  sessionId = id;
}

/** The current feed session, for calls that report against the same session. */
export function feedSessionId(): string {
  return sessionId;
}

/**
 * The grid is the feed's main mode: you walk a street glancing into shop
 * windows, and Single is what you get by stepping closer to one. The shared
 * cursor model is unchanged — this is only which layout it opens in.
 */
const INITIAL: CursorState = { ...INITIAL_CURSOR_STATE, mode: 'window' };

export const useFeed = create<FeedState>((set, get) => ({
  ...INITIAL,
  buffer: [],
  seen: [],
  loading: false,
  degraded: null,
  offline: false,
  rankingConfigVersion: '',
  explorationProductIds: new Set<string>(),

  dispatch(action) {
    const state = get();
    // The cursor is bounded by what is loaded; the refill below covers the gap.
    const next = cursorReducer(state, action, Math.max(0, state.buffer.length - 1));
    const moved =
      next.mode !== state.mode ||
      next.cursor !== state.cursor ||
      next.lastPane !== state.lastPane;

    if (moved) set(next);

    // Refill and rotation are driven by every scroll, not only by ones that
    // moved the cursor. A scroll that changed nothing means the cursor is
    // pinned to the end of the buffer, which is the strongest signal there is
    // that more is needed — returning early there left the feed stuck at the
    // last card with nothing fetching and nothing restocking.
    void get().ensureBuffer(next.mode);

    // Scrolling past the threshold is what ages the catalog: the listings
    // behind the cursor have been seen and the ones ahead need restocking.
    maybeRotateCatalog(next.cursor);
  },

  /**
   * A page request for 20 more fires when fewer than 15 remain ahead. Window
   * mode consumes four products per scroll, so the same threshold in panes is
   * reached four times faster — which is exactly why the server is told the
   * mode and returns coherent quads rather than a deeper slice of the same list.
   */
  async ensureBuffer(mode) {
    const state = get();
    const ahead = state.buffer.length - state.cursor - 1;
    if (ahead >= BUFFER_CONFIG.refillThreshold && state.buffer.length > 0) return;
    if (inFlight) return inFlight;

    set({ loading: true });
    const promise = (async () => {
      try {
        const page = await api.feedPage({
          mode,
          limit: BUFFER_CONFIG.pageSize,
          cursor: get().cursor,
          sessionId,
          // Only the last 200 travel with the request; the server holds the rest.
          seenIds: get().seen.slice(-BUFFER_CONFIG.seenIdsInRequest),
          context: {
            region: 'US',
            currency: 'USD',
            connection: get().offline ? 'offline' : 'unknown',
          },
        });

        if (!page) {
          // The feed never surfaces a network error. It just stops advancing.
          set({ loading: false });
          return;
        }

        set((previous) => {
          const known = new Set(previous.buffer.map((card) => card.productId));
          const fresh = page.items.filter((card) => !known.has(card.productId));
          const exploration = new Set(previous.explorationProductIds);
          for (const index of page.explorationIndexes) {
            const card = page.items[index];
            if (card) exploration.add(card.productId);
          }

          return {
            buffer: [...previous.buffer, ...fresh],
            seen: [...previous.seen, ...fresh.map((card) => card.productId)],
            loading: false,
            degraded: page.degraded,
            rankingConfigVersion: page.rankingConfigVersion,
            explorationProductIds: exploration,
          };
        });
      } catch {
        // `ensureBuffer` is fired from effects with `void`, so a rejection here
        // becomes an unhandled rejection and a full-screen error overlay — for
        // something the user should never even learn about. It stops advancing
        // and nothing else.
        set({ loading: false });
      } finally {
        inFlight = null;
      }
    })();

    inFlight = promise;
    return promise;
  },

  async reset() {
    await api.refreshFeed().catch(() => undefined);
    sessionId = `s_${Date.now().toString(36)}`;
    set({
      ...INITIAL,
      buffer: [],
      seen: [],
      degraded: null,
      explorationProductIds: new Set<string>(),
    });
    await get().ensureBuffer(get().mode);
  },

  seedFromPicks(picks, productId) {
    const cards = picksToCards(picks);
    if (cards.length === 0) return false;
    // A pick with no image never became a card, so the tapped one may not be
    // here. Opening the answer at its start is the honest fallback.
    const found = cards.findIndex((card) => card.productId === productId);
    const cursor = found === -1 ? 0 : found;
    set({
      ...INITIAL,
      // Single, not Window: they tapped one listing, so they get that listing
      // full-bleed and can keep scrolling through the rest of the answer.
      mode: 'single',
      cursor,
      buffer: cards,
      // Picks are not catalog rows, so they never enter the seen-set — the
      // server would not recognise these ids, and a later real row for the
      // same product must not be suppressed by one of these.
      seen: [],
      loading: false,
      degraded: null,
      explorationProductIds: new Set<string>(),
    });
    return true;
  },

  setOffline(offline) {
    set({ offline });
  },

  current() {
    const { buffer, cursor } = get();
    return buffer[cursor] ?? null;
  },

  pane() {
    const state = get();
    const start = paneToRender(state);
    return state.buffer.slice(start, start + PANE_SIZE);
  },

  /**
   * Hero images are prefetched for the next 12 products in Single mode and the
   * next 8 panes — 32 tiles — in Window mode. Data saver cuts the depth to 4.
   */
  prefetchTargets(dataSaver) {
    const state = get();
    const depth = dataSaver
      ? BUFFER_CONFIG.dataSaverPrefetchDepth
      : state.mode === 'single'
        ? BUFFER_CONFIG.prefetch.singleHeroImages
        : BUFFER_CONFIG.prefetch.windowPanes * PANE_SIZE;

    const start = state.mode === 'single' ? state.cursor + 1 : paneStart(state.cursor) + PANE_SIZE;
    const width = dataSaver ? 0 : 1;

    return state.buffer
      .slice(start, start + depth)
      .map((card) => card.media.hero.avif[width] ?? card.media.hero.avif[0])
      .filter((url): url is string => Boolean(url));
  },

  videoWindow() {
    const state = get();
    const current = state.buffer[state.cursor];
    const next = state.buffer[state.cursor + BUFFER_CONFIG.prefetch.videoLookahead];
    return {
      play: current?.media.video?.hls ?? null,
      prefetch: next?.media.video?.hls ?? null,
      evictBeyond: state.cursor + BUFFER_CONFIG.prefetch.videoEvictBeyond,
    };
  },

  /**
   * A product that fails a freshness check at render time is swapped out of the
   * buffer silently before it reaches the viewport. Nothing is shown to the
   * user: a dead listing is our problem, not theirs.
   */
  swapDeadListing(productId) {
    set((state) => {
      const index = state.buffer.findIndex((card) => card.productId === productId);
      // Only swap ahead of the cursor; removing the card under the user's thumb
      // would make the feed jump.
      if (index <= state.cursor) return state;
      return { buffer: state.buffer.filter((card) => card.productId !== productId) };
    });
  },

  patchCard(card) {
    set((state) => ({
      buffer: state.buffer.map((entry) =>
        entry.productId === card.productId ? { ...entry, ...card } : entry,
      ),
    }));
  },
}));

/** True when the cursor is inside the loaded buffer and safe to render. */
export function hasCard(state: FeedState): boolean {
  return state.buffer.length > 0 && state.cursor < state.buffer.length;
}

