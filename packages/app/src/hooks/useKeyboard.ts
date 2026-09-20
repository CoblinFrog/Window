import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { KEYBINDINGS } from '@window/shared';

/**
 * Desktop keyboard control.
 *
 * The entire web client is keyboard-operable, and on desktop the keyboard is
 * the primary input rather than an accessibility afterthought — arrow keys move
 * the cursor, arrow left and right switch mode, and L, C and B mirror the rail.
 */

export interface KeyboardHandlers {
  onNext(): void;
  onPrev(): void;
  onModeLeft(): void;
  onModeRight(): void;
  onUpvote(): void;
  onReviews(): void;
  onCart(): void;
  onPlayPause(): void;
  onEscape(): void;
}

function matches(binding: readonly string[], key: string): boolean {
  return binding.includes(key);
}

export function useKeyboardControls(
  handlers: KeyboardHandlers,
  enabled: boolean,
  /**
   * Whether a sheet is covering the feed.
   *
   * This suppresses the *feed* bindings without suppressing the hook, because
   * Escape is how a sheet is closed. Disabling the whole listener while a sheet
   * is open makes the one key that can dismiss it the one key that cannot run —
   * and since the wheel is suppressed too, the result is an interface that
   * accepts no keyboard or scroll input at all until the user finds the close
   * control with a mouse.
   */
  sheetOpen = false,
): void {
  // Handlers change every render; the listener is registered once and reads
  // them through a ref so a key press never runs against a stale closure.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    if (typeof globalThis.document === 'undefined') return;

    const listener = (event: KeyboardEvent): void => {
      // A shortcut must never steal a keystroke from a text field.
      const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Escape always runs. Everything else waits for the sheet to close: the
      // feed must not advance underneath something the user is reading.
      if (sheetOpen) {
        if (matches(KEYBINDINGS.closeSheet, event.key)) {
          ref.current.onEscape();
          event.preventDefault();
        }
        return;
      }

      const handled = (): boolean => {
        if (matches(KEYBINDINGS.closeSheet, event.key)) {
          ref.current.onEscape();
          return true;
        }
        if (matches(KEYBINDINGS.nextCard, event.key)) {
          ref.current.onNext();
          return true;
        }
        if (matches(KEYBINDINGS.prevCard, event.key)) {
          ref.current.onPrev();
          return true;
        }
        if (matches(KEYBINDINGS.modeLeft, event.key)) {
          ref.current.onModeLeft();
          return true;
        }
        if (matches(KEYBINDINGS.modeRight, event.key)) {
          ref.current.onModeRight();
          return true;
        }
        if (matches(KEYBINDINGS.upvote, event.key)) {
          ref.current.onUpvote();
          return true;
        }
        if (matches(KEYBINDINGS.reviews, event.key)) {
          ref.current.onReviews();
          return true;
        }
        if (matches(KEYBINDINGS.cart, event.key)) {
          ref.current.onCart();
          return true;
        }
        if (matches(KEYBINDINGS.playPause, event.key)) {
          ref.current.onPlayPause();
          return true;
        }
        return false;
      };

      if (handled()) event.preventDefault();
    };

    globalThis.addEventListener('keydown', listener);
    return () => globalThis.removeEventListener('keydown', listener);
  }, [enabled, sheetOpen]);
}

/**
 * Snapped scroll-wheel input: one gesture equals one page.
 *
 * A trackpad flick is not one event, it is a burst of dozens followed by a
 * momentum tail that can run for a second. Throttling that on a fixed interval
 * still pages several times from a single flick, which is how a feed ends up
 * three products further on than anyone asked for.
 *
 * So the burst is what gets counted, not the events: an event acts only if the
 * wheel was quiet for long enough beforehand, and the tail behind it is
 * discarded.
 *
 * That alone is too strict, and shipping it broke scrolling. A wheel spun
 * continuously never falls quiet, so after the first page it never turned
 * another — the feed simply stopped responding while the user kept scrolling.
 * A gesture that has not ended still has to be able to ask for more.
 *
 * What separates the two is the shape of the deltas, not their timing.
 * Momentum only ever decays, and it decays proportionally, so a delta that
 * holds steady or grows is a hand still on the wheel; a delta that jumps is a
 * hand pushing again into the tail of its own flick. Neither can happen while
 * a flick coasts. Only once the deltas say the input is live does a held
 * scroll page again, and then no faster than `WHEEL_REPEAT_MS`.
 *
 * Replaying realistic timings: flicks of every strength up to 2.5 s turn one
 * page, a held scroll turns one roughly every 400 ms, a mouse wheel turns one
 * per notch, and a flick the user pushes again mid-tail turns two.
 */
/** Quiet the wheel must fall for one gesture to have ended. */
const WHEEL_IDLE_GAP_MS = 100;
/** A scroll the deltas say is still being driven pages again, no faster than this. */
const WHEEL_REPEAT_MS = 400;
/** Consecutive non-decaying events before the input counts as live. */
const WHEEL_LIVE_RUN = 2;
/** A delta this much above the last is a fresh push, not a tail. */
const WHEEL_SPIKE = 1.5;
/** Below this a wheel event is noise, not intent. */
const WHEEL_MIN_DELTA = 12;

export function useSnappedWheel(
  onNext: () => void,
  onPrev: () => void,
  enabled: boolean,
): void {
  /** When the previous wheel event arrived, burst or not. */
  const lastEventAt = useRef(0);
  /** When a page was last turned. */
  const lastActionAt = useRef(0);
  /** The previous event's magnitude, for reading the decay curve. */
  const lastDelta = useRef(0);
  /** Consecutive events that did not decay. */
  const liveRun = useRef(0);
  /** Whether the deltas say a hand is still driving this. */
  const live = useRef(false);
  const next = useRef(onNext);
  const prev = useRef(onPrev);
  next.current = onNext;
  prev.current = onPrev;

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    if (typeof globalThis.document === 'undefined') return;

    const listener = (event: WheelEvent): void => {
      event.preventDefault();
      const now = Date.now();
      const sincePrevious = now - lastEventAt.current;
      lastEventAt.current = now;

      const delta = Math.abs(event.deltaY);
      if (delta < WHEEL_MIN_DELTA) {
        lastDelta.current = delta;
        return;
      }

      // Read the decay curve. Coasting momentum falls away proportionally on
      // every event; anything that holds, grows, or jumps is a hand.
      if (delta > lastDelta.current * WHEEL_SPIKE + 5) {
        live.current = true;
        liveRun.current = WHEEL_LIVE_RUN;
      } else if (delta > lastDelta.current * 0.99) {
        liveRun.current += 1;
        if (liveRun.current >= WHEEL_LIVE_RUN) live.current = true;
      } else {
        liveRun.current = 0;
      }
      lastDelta.current = delta;

      const opensGesture = sincePrevious > WHEEL_IDLE_GAP_MS;
      const stillDriven = live.current && now - lastActionAt.current > WHEEL_REPEAT_MS;
      if (!opensGesture && !stillDriven) return;

      lastActionAt.current = now;
      live.current = false;
      liveRun.current = 0;

      if (event.deltaY > 0) next.current();
      else prev.current();
    };

    globalThis.addEventListener('wheel', listener, { passive: false });
    return () => globalThis.removeEventListener('wheel', listener);
  }, [enabled]);
}
