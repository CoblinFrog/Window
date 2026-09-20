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
 * So the burst is what gets counted, not the events: an event acts only if it
 * opens a new one — meaning the wheel was quiet for long enough beforehand —
 * and the tail behind it is discarded. A scroll held continuously still pages,
 * slowly, on the sustain interval, so a long deliberate scroll is not mistaken
 * for a single flick and ignored.
 */
/** Quiet time that marks the end of one wheel gesture and the start of the next. */
const WHEEL_IDLE_GAP_MS = 140;
/** A scroll held down keeps paging, but no faster than this. */
const WHEEL_SUSTAIN_MS = 650;
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

      // Mid-burst: this is the tail of a flick already acted on, unless the
      // scroll has been sustained long enough to mean a second page.
      const startsNewGesture = sincePrevious > WHEEL_IDLE_GAP_MS;
      const sustained = now - lastActionAt.current > WHEEL_SUSTAIN_MS;
      if (!startsNewGesture && !sustained) return;

      lastActionAt.current = now;
      if (event.deltaY > 0) next.current();
      else prev.current();
    };

    globalThis.addEventListener('wheel', listener, { passive: false });
    return () => globalThis.removeEventListener('wheel', listener);
  }, [enabled]);
}
