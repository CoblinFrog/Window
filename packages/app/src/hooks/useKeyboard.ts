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
 * There used to be a second way through. A scroll still going after a sustain
 * interval turned another page, on the theory that a long deliberate scroll
 * should not be taken for one flick and ignored. But Chrome delivers trackpad
 * momentum at a steady 60 Hz with a decaying delta for as long as it runs, so
 * "still going" is exactly what a flick the user has already finished looks
 * like. Replaying realistic timings through both versions: a 1.0 s flick paged
 * twice, a 1.6 s flick three times, a held two-finger scroll three times. One
 * gesture, one page now, with no exception — to go further, scroll again.
 *
 * The idle gap has to clear a trackpad's 16 ms delivery without swallowing a
 * mouse wheel's notches, which are single events maybe 120 ms apart and each
 * genuinely a separate request. At 140 ms it ate them; 100 ms passes every
 * notch while leaving momentum suppressed by a wide margin.
 */
/** Quiet the wheel must fall for one gesture to have ended. */
const WHEEL_IDLE_GAP_MS = 100;
/** Below this a wheel event is noise, not intent. */
const WHEEL_MIN_DELTA = 12;

export function useSnappedWheel(
  onNext: () => void,
  onPrev: () => void,
  enabled: boolean,
): void {
  /** When the previous wheel event arrived, burst or not. */
  const lastEventAt = useRef(0);
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

      if (Math.abs(event.deltaY) < WHEEL_MIN_DELTA) return;

      // Mid-burst: the tail of a flick already acted on.
      if (sincePrevious <= WHEEL_IDLE_GAP_MS) return;

      if (event.deltaY > 0) next.current();
      else prev.current();
    };

    globalThis.addEventListener('wheel', listener, { passive: false });
    return () => globalThis.removeEventListener('wheel', listener);
  }, [enabled]);
}
