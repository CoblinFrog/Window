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
 * What gets counted is how far a gesture has travelled, not what any single
 * event carried. Judging events one at a time meant a floor under each of
 * them, and a gentle scroll is not a small number of small events — it is a
 * run of events of two or three pixels each. Every one fell under the floor,
 * so a soft scroll did nothing at all and the only way to move the feed was to
 * shove it. Summing instead, a nudge of eighteen pixels spread over three
 * events counts the same as one event of eighteen.
 *
 * A gesture pages once, when its total passes `WHEEL_TRAVEL`, and then not
 * again however far it goes on to travel. That is what keeps a hard flick and
 * a soft one worth one page each: the length of a gesture must not decide the
 * number of pages.
 *
 * A gesture ends when the wheel falls quiet. The window is generous because
 * the settle runs on this same thread, and a long frame swallows the events
 * that should have arrived during it — on the clock, a stall is exactly what
 * stopping looks like, and a tighter window turned one flick through three
 * stalled frames into four pages.
 *
 * Two things restart a gesture without waiting for quiet, because both mean
 * "again" rather than "still". A spike: momentum only ever decays, so a delta
 * that jumps is a hand shoving into the tail of its own flick. And a notch: a
 * single large delta arriving well after the last one is a mouse wheel, where
 * every click is its own deliberate request and should page.
 */
/** Quiet the wheel must fall for one gesture to have ended. */
const WHEEL_IDLE_GAP_MS = 250;
/** How far a gesture must travel, in px, before it turns a page. */
const WHEEL_TRAVEL = 16;
/**
 * A delta this many times the last one is a fresh push rather than a tail.
 * High enough that the wobble of a hand held on a trackpad never reaches it.
 */
const WHEEL_SPIKE = 2;
/** ...and this much above it, so the test still holds for small deltas. */
const WHEEL_SPIKE_FLOOR = 8;
/** A delta at least this large, this long after the last, is a mouse notch. */
const WHEEL_NOTCH = 80;
const WHEEL_NOTCH_GAP_MS = 80;

export function useSnappedWheel(
  onNext: () => void,
  onPrev: () => void,
  enabled: boolean,
): void {
  /** When the previous wheel event arrived, burst or not. */
  const lastEventAt = useRef(0);
  /** The previous event's magnitude, for telling a push from a tail. */
  const lastDelta = useRef(0);
  /** How far the current gesture has travelled, signed. */
  const travelled = useRef(0);
  /** Whether this gesture has already turned its page. */
  const spent = useRef(false);
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
      // Only exact noise is dropped. There is no floor under a single event
      // any more; a soft scroll is made of events this small and it has to
      // count.
      if (delta < 1) return;

      const previous = lastDelta.current;
      lastDelta.current = delta;

      const fellQuiet = sincePrevious > WHEEL_IDLE_GAP_MS;
      const pushedAgain = delta > previous * WHEEL_SPIKE + WHEEL_SPIKE_FLOOR;
      const mouseNotch = delta >= WHEEL_NOTCH && sincePrevious >= WHEEL_NOTCH_GAP_MS;
      if (fellQuiet || pushedAgain || mouseNotch) {
        travelled.current = 0;
        spent.current = false;
      }

      travelled.current += event.deltaY;
      if (spent.current || Math.abs(travelled.current) < WHEEL_TRAVEL) return;
      spent.current = true;

      if (travelled.current > 0) next.current();
      else prev.current();
    };

    globalThis.addEventListener('wheel', listener, { passive: false });
    return () => globalThis.removeEventListener('wheel', listener);
  }, [enabled]);
}
