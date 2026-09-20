import AsyncStorageStatic from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  PROBLEM_TYPES,
  type CartLine,
  type CartResponse,
  type FeedMode,
  type Money,
} from '@window/shared';
import { ApiRequestError, api } from '../api/client.js';
import { emit } from './events.js';

/**
 * The cart.
 *
 * One Window cart holds lines from any number of merchants, and it decomposes
 * into one checkout job per merchant downstream. The single rule this file
 * exists to enforce is that nothing is ever bought at a price the user has not
 * seen: every server-reported diff starts life unacknowledged, and checkout
 * stays blocked until the user has actually looked at each one. Acknowledgement
 * is never inferred from a render, a scroll or a retry.
 */

export type CartDiff = CartResponse['diffs'][number];
export type CartMerchantGroup = CartResponse['byMerchant'][number];

/**
 * A diff is identified by where it lands, not by when it arrived. Re-verifying
 * the cart re-emits the same diff for an unchanged price, and re-asking about a
 * change the user already accepted would train them to dismiss the dialog. A
 * *further* move produces a different `to`, so it correctly reads as new.
 */
function diffKey(diff: CartDiff): string {
  const to = diff.to ? `${diff.to.amount}${diff.to.currency}` : 'gone';
  return `${diff.lineId}|${diff.kind}|${to}`;
}

/**
 * Ranking context for a cart signal raised from the cart screen itself.
 *
 * The collector wants the feed position the interaction happened at. A removal
 * from the cart has no feed position, and reporting 0 would tell the ranker the
 * user acted on the first card of the session. -1 says "not from the feed".
 */
const OFF_FEED: { position: number; mode: FeedMode } = { position: -1, mode: 'single' };

interface QueuedAdd {
  productId: string;
  variant: Record<string, string> | undefined;
  quantity: number;
  signal: { position: number; mode: FeedMode };
}

export type CartAddOutcome =
  | { kind: 'added' }
  /** Held locally; it replays when connectivity returns. */
  | { kind: 'queued' }
  /**
   * Auction items cannot be added to cart at all. The caller shows "Open to
   * bid" and deep-links out. There is nothing to retry here.
   */
  | { kind: 'auction'; productId: string; sourceUrl: string | null }
  | { kind: 'rejected'; message: string };

// ---------------------------------------------------------------------------
// Local queue persistence
// ---------------------------------------------------------------------------

const QUEUE_KEY = 'window.cart.queue';

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/** Same fallback ladder as the session store: a missing store must not break the cart. */
const storage: Storage = (() => {
  const native = AsyncStorageStatic as unknown as Storage | undefined;
  if (native?.getItem) return native;
  if (typeof globalThis.localStorage !== 'undefined') {
    return {
      async getItem(key) {
        return globalThis.localStorage.getItem(key);
      },
      async setItem(key, value) {
        globalThis.localStorage.setItem(key, value);
      },
    };
  }
  const memory = new Map<string, string>();
  return {
    async getItem(key) {
      return memory.get(key) ?? null;
    },
    async setItem(key, value) {
      memory.set(key, value);
    },
  };
})();

function persistQueue(queue: readonly QueuedAdd[]): void {
  void storage.setItem(QUEUE_KEY, JSON.stringify(queue)).catch(() => undefined);
}

/**
 * A transport failure, as opposed to a refusal.
 *
 * `ApiRequestError` means the server answered and said no, which is a decision
 * the user needs to see. Anything else is the network, which is ours to absorb.
 */
function isTransportFailure(error: unknown): boolean {
  return !(error instanceof ApiRequestError);
}

function problemType(error: unknown): string | null {
  return error instanceof ApiRequestError ? (error.problem?.type ?? null) : null;
}

function problemString(error: unknown, key: string): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  const value = error.problem?.[key];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CartState {
  cart: CartResponse | null;
  /** First load only. A re-verify uses `verifying` so the lines stay on screen. */
  loading: boolean;
  /** Price and stock are being re-checked; the screen shows stale prices meanwhile. */
  verifying: boolean;
  error: string | null;
  /** Keys of diffs the user has explicitly looked at. */
  acknowledged: Set<string>;
  offline: boolean;
  /** Adds taken while offline, in the order they were made. */
  queued: QueuedAdd[];
  /**
   * Adds that are in flight.
   *
   * `contains` counts these, so the control fills the moment it is pressed
   * rather than when the server gets back. The offline queue below has always
   * been counted for exactly this reason — the icon going back to empty reads
   * as the tap having been lost — and an add that is merely slow is no
   * different to the person who pressed it. Removed on either outcome: the
   * cart itself holds it once the add lands, and a refusal has to be allowed
   * to take it away again.
   */
  pending: Set<string>;
  /** The last auction refusal, so the caller can render "Open to bid". */
  auctionBlock: { productId: string; sourceUrl: string | null } | null;

  /**
   * Mark an id as being added, for a caller that has to do work first.
   *
   * Adopting an assistant's pick fetches and ingests the listing before the
   * cart hears anything, and the add that follows names the *new* id — so the
   * card on screen, still carrying `web:…`, showed nothing for the second or
   * two that took. The caller marks the id it is showing; `add` clears it.
   */
  markPending(productId: string): void;
  /** Take it back when the work the mark was covering did not happen. */
  clearPending(productId: string): void;
  load(): Promise<void>;
  add(
    productId: string,
    options?: {
      variant?: Record<string, string>;
      quantity?: number;
      signal?: { position: number; mode: FeedMode };
    },
  ): Promise<CartAddOutcome>;
  setQuantity(lineId: string, quantity: number): Promise<void>;
  setVariant(lineId: string, variant: Record<string, string>): Promise<void>;
  remove(lineId: string): Promise<void>;
  acknowledgeDiff(key: string): void;
  acknowledgeDiffs(): void;
  clearAuctionBlock(): void;
  setOffline(offline: boolean): void;
  /** Drains the offline queue in order. Stops at the first transport failure. */
  replayQueue(): Promise<void>;
  restoreQueue(): Promise<void>;

  unacknowledgedDiffs(): CartDiff[];
  linesFor(group: CartMerchantGroup): CartLine[];
  itemCount(): number;
  /** Drives the bag icon's filled state on a feed card. */
  contains(productId: string): boolean;
  /** Null when checkout may proceed; otherwise the reason, in plain language. */
  checkoutBlockedReason(): string | null;
}

export const useCart = create<CartState>((set, get) => ({
  cart: null,
  loading: false,
  verifying: false,
  error: null,
  acknowledged: new Set<string>(),
  offline: false,
  queued: [],
  pending: new Set<string>(),
  auctionBlock: null,

  /**
   * Opening the cart re-verifies price and stock. The budget for that is 400 ms
   * p50, so the previous lines stay rendered with a verifying flag rather than
   * being replaced by a spinner.
   */
  markPending(productId) {
    set({ pending: new Set(get().pending).add(productId) });
  },

  clearPending(productId) {
    const next = new Set(get().pending);
    next.delete(productId);
    set({ pending: next });
  },

  async load() {
    const first = get().cart === null;
    set(first ? { loading: true, error: null } : { verifying: true, error: null });
    try {
      const cart = await api.cart();
      set({ cart, loading: false, verifying: false, offline: false });
      void get().replayQueue();
    } catch (error) {
      if (isTransportFailure(error)) {
        // The cart is the one screen where stale prices are worse than no
        // prices, so going offline is stated rather than hidden.
        set({ loading: false, verifying: false, offline: true });
        return;
      }
      set({ loading: false, verifying: false, error: (error as Error).message });
    }
  },

  async add(productId, options = {}) {
    const signal = options.signal ?? OFF_FEED;
    const quantity = options.quantity ?? 1;

    if (get().offline) {
      const queued: QueuedAdd = { productId, variant: options.variant, quantity, signal };
      const next = [...get().queued, queued];
      set({ queued: next });
      persistQueue(next);
      return { kind: 'queued' };
    }

    // Marked before the request, so the control fills on the press rather than
    // on the reply. Cleared on both paths below.
    set({ pending: new Set(get().pending).add(productId) });
    const settle = (): void => {
      const next = new Set(get().pending);
      next.delete(productId);
      set({ pending: next });
    };

    try {
      const cart = await api.addToCart({
        productId,
        ...(options.variant ? { variant: options.variant } : {}),
        quantity,
      });
      set({ cart, auctionBlock: null });
      settle();
      // Emitted on acceptance, not on intent: a refused add is not a signal.
      emit('cart_add', { productId, position: signal.position, mode: signal.mode });
      return { kind: 'added' };
    } catch (error) {
      // Whatever happened, this add is no longer in flight. The queue below
      // keeps the control filled where the add is only deferred; a refusal
      // lets it empty again, which is the honest answer.
      settle();
      if (isTransportFailure(error)) {
        const queued: QueuedAdd = { productId, variant: options.variant, quantity, signal };
        const next = [...get().queued, queued];
        set({ offline: true, queued: next });
        persistQueue(next);
        return { kind: 'queued' };
      }
      if (problemType(error) === PROBLEM_TYPES.auctionNotPurchasable) {
        const sourceUrl = problemString(error, 'sourceUrl');
        set({ auctionBlock: { productId, sourceUrl } });
        return { kind: 'auction', productId, sourceUrl };
      }
      return { kind: 'rejected', message: (error as Error).message };
    }
  },

  async setQuantity(lineId, quantity) {
    if (quantity < 1) {
      await get().remove(lineId);
      return;
    }
    try {
      set({ cart: await api.updateCartItem(lineId, { quantity }) });
    } catch (error) {
      if (isTransportFailure(error)) set({ offline: true });
      else set({ error: (error as Error).message });
    }
  },

  async setVariant(lineId, variant) {
    try {
      set({ cart: await api.updateCartItem(lineId, { variant }) });
    } catch (error) {
      if (isTransportFailure(error)) set({ offline: true });
      else set({ error: (error as Error).message });
    }
  },

  async remove(lineId) {
    const line = get().cart?.lines.find((candidate) => candidate.id === lineId);
    try {
      const cart = await api.removeCartItem(lineId);
      set({ cart });
      if (line) {
        emit('cart_remove', {
          productId: line.productId,
          position: OFF_FEED.position,
          mode: OFF_FEED.mode,
        });
      }
    } catch (error) {
      if (isTransportFailure(error)) set({ offline: true });
      else set({ error: (error as Error).message });
    }
  },

  acknowledgeDiff(key) {
    const next = new Set(get().acknowledged);
    next.add(key);
    set({ acknowledged: next });
  },

  acknowledgeDiffs() {
    const next = new Set(get().acknowledged);
    for (const diff of get().cart?.diffs ?? []) next.add(diffKey(diff));
    set({ acknowledged: next });
  },

  clearAuctionBlock() {
    set({ auctionBlock: null });
  },

  setOffline(offline) {
    const was = get().offline;
    set({ offline });
    if (was && !offline) void get().replayQueue();
  },

  async replayQueue() {
    const pending = get().queued;
    if (pending.length === 0 || get().offline) return;

    const remaining = [...pending];
    while (remaining.length > 0) {
      const next = remaining[0];
      if (!next) break;
      try {
        const cart = await api.addToCart({
          productId: next.productId,
          ...(next.variant ? { variant: next.variant } : {}),
          quantity: next.quantity,
        });
        set({ cart });
        emit('cart_add', {
          productId: next.productId,
          position: next.signal.position,
          mode: next.signal.mode,
        });
        remaining.shift();
      } catch (error) {
        if (isTransportFailure(error)) {
          // Still offline. Keep the rest of the queue intact and stop.
          set({ offline: true, queued: remaining });
          persistQueue(remaining);
          return;
        }
        // A refusal — auction, blocked, gone. Replaying it forever would be a
        // loop, so it is dropped and the refusal surfaced once.
        remaining.shift();
        if (problemType(error) === PROBLEM_TYPES.auctionNotPurchasable) {
          set({
            auctionBlock: {
              productId: next.productId,
              sourceUrl: problemString(error, 'sourceUrl'),
            },
          });
        } else {
          set({ error: (error as Error).message });
        }
      }
    }
    set({ queued: remaining });
    persistQueue(remaining);
  },

  async restoreQueue() {
    try {
      const raw = await storage.getItem(QUEUE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as QueuedAdd[];
      if (Array.isArray(parsed) && parsed.length > 0) set({ queued: parsed });
    } catch {
      // A corrupt queue is not worth a crash on cold start.
    }
  },

  unacknowledgedDiffs() {
    const { cart, acknowledged } = get();
    return (cart?.diffs ?? []).filter((diff) => !acknowledged.has(diffKey(diff)));
  },

  linesFor(group) {
    const byId = new Map((get().cart?.lines ?? []).map((line) => [line.id, line]));
    return group.lineIds
      .map((id) => byId.get(id))
      .filter((line): line is CartLine => line !== undefined);
  },

  itemCount() {
    return (get().cart?.lines ?? []).reduce((sum, line) => sum + line.quantity, 0);
  },

  contains(productId) {
    const state = get();
    if (state.cart?.lines.some((line) => line.productId === productId)) return true;
    // An add still on its way counts, and so does one queued offline: the user
    // pressed the button, and the icon staying empty until the network agrees
    // reads as the tap having been lost.
    if (state.pending.has(productId)) return true;
    return state.queued.some((queued) => queued.productId === productId);
  },

  checkoutBlockedReason() {
    const state = get();
    if (state.offline) {
      // Checkout is blocked rather than queued: an authorization made against
      // prices we could not re-verify is exactly the thing the contract forbids.
      return 'You are offline. Checkout needs a live price check before anything is authorized.';
    }
    if (state.queued.length > 0) {
      return `${state.queued.length} item${state.queued.length === 1 ? '' : 's'} still waiting to sync.`;
    }
    if (!state.cart || state.cart.lines.length === 0) return 'The cart is empty.';
    if (!state.cart.lines.some((line) => line.available)) {
      return 'Nothing in the cart is available right now.';
    }
    const pending = state.unacknowledgedDiffs().length;
    if (pending > 0) {
      return `${pending} price or stock change${pending === 1 ? '' : 's'} to review first.`;
    }
    return null;
  },
}));

/** Exposed for the screens, which key their diff rows on it. */
export function cartDiffKey(diff: CartDiff): string {
  return diffKey(diff);
}

/** The merchant-level subtotal, straight from the server's own grouping. */
export function merchantSubtotal(group: CartMerchantGroup): Money {
  return group.subtotal;
}

/**
 * Web connectivity. React Native has no `online` event and this app carries no
 * NetInfo dependency, so on native the store learns it is offline the only
 * honest way available: a request failed at the transport layer.
 */
export function watchConnectivity(): () => void {
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    navigator?: { onLine?: boolean };
  };
  if (typeof target.addEventListener !== 'function') return () => undefined;

  const goOnline = (): void => useCart.getState().setOffline(false);
  const goOffline = (): void => useCart.getState().setOffline(true);

  if (target.navigator?.onLine === false) goOffline();
  target.addEventListener('online', goOnline);
  target.addEventListener('offline', goOffline);

  return () => {
    target.removeEventListener?.('online', goOnline);
    target.removeEventListener?.('offline', goOffline);
  };
}
