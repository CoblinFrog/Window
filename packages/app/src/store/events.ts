import { AppState } from 'react-native';
import {
  DWELL_THRESHOLDS,
  SIGNAL_QUALITY_RULES,
  SIGNAL_WEIGHTS,
  STRONG_SIGNAL_THRESHOLD,
  type ClientEvent,
  type FeedMode,
  type InteractionType,
  type UpvoteReason,
} from '@window/shared';
import { api } from '../api/client.js';

/**
 * Client-side event batching.
 *
 * Events batch and flush every five seconds, on backgrounding, and immediately
 * for any event at or above weight 0.45 so the next page reflects it. The queue
 * is fire-and-forget in both directions: a failed flush drops its batch rather
 * than retrying forever, because stale telemetry is worth less than the memory
 * it would hold.
 */

const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE = 400;

let queue: ClientEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let sessionId = 'pending';
let sequence = 0;

export function setEventSession(id: string): void {
  sessionId = id;
}

function key(type: string, productId: string): string {
  sequence += 1;
  return `${sessionId}:${type}:${productId}:${sequence}`;
}

export async function flushEvents(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    await api.events({ sessionId, events: batch });
  } catch {
    // Dropped on purpose. The collector is never on the critical path, and a
    // retry queue that survives a bad network is how a client leaks memory.
  }
}

export function startEventLoop(): () => void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void flushEvents(), FLUSH_INTERVAL_MS);

  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') void flushEvents();
  });

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    subscription.remove();
    void flushEvents();
  };
}

export interface EmitOptions {
  productId: string;
  position: number;
  mode: FeedMode;
  dwellMs?: number;
  reason?: UpvoteReason;
  isExploration?: boolean;
  viewportFraction?: number;
  foreground?: boolean;
}

export function emit(type: InteractionType, options: EmitOptions): void {
  const event: ClientEvent = {
    idempotencyKey: key(type, options.productId),
    type,
    productId: options.productId,
    position: options.position,
    mode: options.mode,
    clientTs: new Date().toISOString(),
    ...(options.dwellMs !== undefined ? { dwellMs: options.dwellMs } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.isExploration ? { isExploration: true } : {}),
    ...(options.viewportFraction !== undefined
      ? { viewportFraction: options.viewportFraction }
      : {}),
    ...(options.foreground !== undefined ? { foreground: options.foreground } : {}),
  };

  queue.push(event);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);

  // A strong signal changes the very next page, so it cannot wait for the timer.
  if (Math.abs(SIGNAL_WEIGHTS[type]) >= STRONG_SIGNAL_THRESHOLD) void flushEvents();
}

/**
 * Classifies a completed dwell and emits it, applying the two rules that
 * protect signal quality: a dwell only counts when the app is foregrounded and
 * the card filled at least 60% of the viewport, and the negative skip signal is
 * suppressed for the first three cards of a session.
 */
export function emitDwell(options: {
  productId: string;
  position: number;
  mode: FeedMode;
  dwellMs: number;
  viewportFraction: number;
  foreground: boolean;
  isExploration?: boolean;
}): void {
  const { dwellMs, viewportFraction, foreground } = options;
  if (!foreground && SIGNAL_QUALITY_RULES.requireForeground) return;
  if (viewportFraction < SIGNAL_QUALITY_RULES.minViewportFraction) return;

  let type: InteractionType | null = null;
  if (dwellMs < DWELL_THRESHOLDS.skipFastMaxMs) type = 'skip_fast';
  else if (dwellMs >= DWELL_THRESHOLDS.longMinMs) type = 'dwell_long';
  else if (dwellMs >= DWELL_THRESHOLDS.shortMinMs && dwellMs < DWELL_THRESHOLDS.shortMaxMs) {
    type = 'dwell_short';
  }
  if (!type) return;

  if (
    type === 'skip_fast' &&
    options.position < SIGNAL_QUALITY_RULES.suppressSkipForFirstNCards
  ) {
    return;
  }

  emit(type, { ...options, dwellMs, viewportFraction, foreground });
}
