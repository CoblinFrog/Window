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
 * What counts as the next gesture is the whole question, and it must not be a
 * duration. Paging again after the scroll had run for some interval made the
 * feed move twice for one flick simply because that flick was a hard one — the
 * length of a gesture became the number of pages, which is not something
 * anyone is aiming with.
 *
 * So there are exactly two ways to turn another page, and both mean "again"
 * rather than "still": the wheel falls quiet, or the deltas spike. Momentum
 * only ever decays, so a delta that jumps well above the one before it is a
 * hand shoving into the tail of its own flick — a second gesture that never
 * paused. Neither can happen while a flick coasts, however long it coasts for.
 *
 * A quiet gap is necessary but not sufficient, because the settle runs on this
 * same thread and a long frame swallows the events that should have arrived
 * during it. On the clock alone that stall is indistinguishable from the user
 * stopping, and a hard flick across three of them pages four times — which is
 * exactly the length-dependent double scroll this is supposed to prevent. The
 * deltas tell them apart: a flick coasting through a stall comes back decayed
 * by every frame it missed, where a genuinely new gesture comes back larger.
 *
 * The cost is that a scroll held at a constant speed is one gesture and pages
 * once, and to go further you lift, pause, or push. That is the rule working,
 * not failing.
 */
/** Quiet the wheel must fall for one gesture to have ended. */
const WHEEL_IDLE_GAP_MS = 100;
/**
 * Across that quiet the delta must not have kept decaying. Momentum always
 * does; a hand starting again does not. The margin is tight because the two
 * are only a couple of percent apart per event near the end of a tail.
 */
const WHEEL_STILL_COASTING = 0.99;
/**
 * A delta this many times the last one is a fresh push rather than a tail.
 * High enough that the wobble of a hand held on a trackpad never reaches it.
 */
const WHEEL_SPIKE = 2;
/** ...and this much above it, so the test still holds for small deltas. */
const WHEEL_SPIKE_FLOOR = 8;
/** Below this a wheel event is noise, not intent. */
const WHEEL_MIN_DELTA = 12;

export function useSnappedWheel(
  onNext: () => void,
  onPrev: () => void,
  enabled: boolean,
): void {
  /** When the previous wheel event arrived, burst or not. */
  const lastEventAt = useRef(0);
  /** The previous event's magnitude, for telling a push from a tail. */
  const lastDelta = useRef(0);
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

      const previous = lastDelta.current;
      lastDelta.current = delta;

      // Quiet before it, and not still coasting through it: a gesture that had
      // really ended. Or a spike: momentum only decays, so a jump is a hand
      // pushing again without having paused.
      const opensGesture =
        sincePrevious > WHEEL_IDLE_GAP_MS && delta > previous * WHEEL_STILL_COASTING;
      const pushedAgain = delta > previous * WHEEL_SPIKE + WHEEL_SPIKE_FLOOR;
      if (!opensGesture && !pushedAgain) return;

      if (event.deltaY > 0) next.current();
      else prev.current();
    };

    globalThis.addEventListener('wheel', listener, { passive: false });
    return () => globalThis.removeEventListener('wheel', listener);
  }, [enabled]);
}
