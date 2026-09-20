import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { MOTION, SCROLL } from '@window/shared';

/**
 * A vertical pager: one continuous surface, snapped to page boundaries.
 *
 * Both feeds scroll this way — the window screen a pane of four at a time, the
 * pane view a product at a time — and they have to feel identical, so the
 * behaviour lives here once rather than being written twice and drifting.
 *
 * The position is a single shared value measured in pixels down an infinite
 * column of pages. A drag moves it with the finger so the neighbouring page
 * comes into view as the current one leaves; letting go settles onto whichever
 * page the gesture was heading for.
 *
 * The load-bearing detail is that pages are positioned at **absolute**
 * multiples of the page height rather than relative to whichever is current.
 * When the settle finishes and the index advances, the surrounding pages
 * re-render at new positions but each is still at the same absolute offset, and
 * the scroll is already sitting on the new page — so the React update moves
 * nothing. Positioning them relative to the current page instead means
 * resetting the scroll and advancing the index in the same frame, and whichever
 * lands first is a visible jump backwards.
 *
 * Direction comes from the distance actually travelled, never from the
 * velocity's sign: on the web that sign does not agree with `translationY`, and
 * trusting it sends a backward pull forwards. Speed only lowers the distance
 * needed, which is what makes a short flick work without making a slow
 * half-drag snap back.
 */

const EASING = Easing.bezier(...(MOTION.easing as unknown as [number, number, number, number]));

/** How long after a drag a click is still assumed to be that drag's ghost. */
const DRAG_CLICK_WINDOW_MS = 280;

export interface PagerOptions {
  /** Index of the page in view. */
  index: number;
  /** How many pages exist. The last index is `count - 1`. */
  count: number;
  /** Height of one page, in px. */
  height: number;
  reducedMotion: boolean;
  /** Called once a drag has settled onto the neighbouring page. */
  onPage(direction: 'next' | 'prev'): void;
  /**
   * Called when a settle *begins*, with the page it is heading for.
   *
   * `onPage` fires at the far end of the travel, because the index must not
   * move until the surface has arrived — the buffer, the seen-set and the dwell
   * timers all read it and all have to agree with what is on screen. Anything
   * that wants to animate *with* the travel rather than after it needs the near
   * end instead, which is this.
   */
  onSettleStart?(target: number, direction: 1 | -1): void;
  /** Pages kept mounted either side of the one in view. Defaults to 1. */
  neighbours?: number;
}

export interface Pager {
  /** Attach to a `GestureDetector` around the surface, or compose it. */
  pan: ReturnType<typeof Gesture.Pan>;
  /**
   * True if a drag finished within the last a few hundred milliseconds.
   *
   * On the web a drag whose start and end land on the same element still emits
   * a click when the finger lifts, and a full-screen surface makes that the
   * common case rather than the edge one. Anything that handles taps on top of
   * this pager has to ask.
   */
  justDragged(): boolean;
  /** Apply to the surface holding the pages. */
  surfaceStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
  /** Indices to keep mounted, ascending. */
  pages: number[];
  /** A page's absolute top within the surface. */
  topOf(index: number): number;
  /** A page's offset from the one in view, for rects measured inside it. */
  offsetOf(index: number): number;
}

export function usePager({
  index,
  count,
  height,
  reducedMotion,
  onPage,
  onSettleStart,
  neighbours = 1,
}: PagerOptions): Pager {
  const last = Math.max(0, count - 1);
  const current = Math.max(0, Math.min(last, index));

  /** Pixels scrolled down the column of pages. `current * height` at rest. */
  const scrollY = useSharedValue(current * height);
  /** `scrollY` when the current drag began. */
  const dragOrigin = useSharedValue(0);
  /** Non-zero while a finger is down, so the sync effect keeps out of the way. */
  const dragging = useSharedValue(0);

  const settleStart = useCallback(
    (target: number, direction: 1 | -1) => {
      onSettleStart?.(target, direction);
    },
    [onSettleStart],
  );

  /** The index this effect last saw, so a relayout is not mistaken for a move. */
  const previousIndex = useRef(current);

  // Keeps the surface in step with the index when something other than a drag
  // moved it — the keyboard, the wheel, a deep link, a refill landing. Those
  // get the same settle as a release rather than a cut.
  useEffect(() => {
    const from = previousIndex.current;
    previousIndex.current = current;
    if (dragging.value === 1) return;
    const target = current * height;
    // Already there: the drag path, which moved the surface first and is only
    // now committing the index. It announced its own settle at the near end.
    if (Math.abs(scrollY.value - target) < 0.5) return;
    // A height change is a relayout, not a move, and must not announce one.
    if (from !== current) settleStart(current, current > from ? 1 : -1);
    scrollY.value = reducedMotion
      ? target
      : withTiming(target, { duration: SCROLL.settleMs, easing: EASING });
  }, [current, height, reducedMotion, scrollY, dragging, settleStart]);

  const commit = useCallback(
    (direction: 'next' | 'prev') => {
      onPage(direction);
    },
    [onPage],
  );

  // When a drag last ended, on the JS side, for `justDragged` below.
  const draggedAt = useRef(0);
  const markDragged = useCallback(() => {
    draggedAt.current = Date.now();
  }, []);
  const justDragged = useCallback(() => Date.now() - draggedAt.current < DRAG_CLICK_WINDOW_MS, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Vertical only, and only past enough movement that a tap is never
        // stolen by the scroller.
        .activeOffsetY([-SCROLL.activationSlop, SCROLL.activationSlop])
        .failOffsetX([-24, 24])
        .onBegin(() => {
          dragging.value = 1;
          dragOrigin.value = scrollY.value;
        })
        .onUpdate((event) => {
          const next = dragOrigin.value - event.translationY;
          const min = 0;
          const max = last * height;
          // Rubber band past the first page and past the last one loaded, so
          // the end of the feed is something you feel rather than hit.
          if (next < min) scrollY.value = min + (next - min) * SCROLL.edgeResistance;
          else if (next > max) scrollY.value = max + (next - max) * SCROLL.edgeResistance;
          else scrollY.value = next;
        })
        .onEnd((event) => {
          // Negative means the surface moved forward, towards the next page.
          const travelled = dragOrigin.value - scrollY.value;
          // A drag that actually went somewhere is about to produce a stray
          // click; anything handling taps above this needs to know.
          if (Math.abs(travelled) > SCROLL.activationSlop) runOnJS(markDragged)();
          const flick =
            Math.abs(event.velocityY) > SCROLL.flickVelocity &&
            Math.abs(travelled) > SCROLL.flickMinTravel;
          const far = Math.abs(travelled) > height * SCROLL.advanceFraction;

          let target = current;
          if (far || flick) target = travelled < 0 ? current + 1 : current - 1;
          target = Math.max(0, Math.min(last, target));

          const direction = target > current ? 'next' : target < current ? 'prev' : null;

          // The near end of the travel. Anything that animates the arriving
          // page starts now, alongside it, rather than when it lands.
          if (direction) runOnJS(settleStart)(target, direction === 'next' ? 1 : -1);

          scrollY.value = withTiming(
            target * height,
            { duration: SCROLL.settleMs, easing: EASING },
            (finished) => {
              // The index moves only once the surface has arrived, so the
              // buffer, the seen-set and the dwell timers all agree with what
              // is on screen.
              if (finished && direction) runOnJS(commit)(direction);
            },
          );
        })
        // `onFinalize`, not `onEnd`. Gesture-handler calls `onEnd` only for a
        // gesture that activated, and this pan deliberately does not activate
        // until the finger has travelled past `activationSlop` — that is what
        // keeps it from stealing taps. So every tap on the surface ran
        // `onBegin`, set this flag, and never cleared it.
        //
        // The flag gates the effect below that moves the surface when something
        // other than a drag changed the page, which is the wheel, the keyboard,
        // a deep link and a refill landing. Stuck at 1, all four stopped
        // moving: the cursor still advanced, the surface did not follow, and
        // after two steps the viewport was parked between pages showing
        // nothing at all. `onFinalize` runs for every gesture, activated or
        // not, which is the guarantee this needs.
        .onFinalize(() => {
          dragging.value = 0;
        }),
    [commit, current, dragOrigin, dragging, height, last, markDragged, scrollY, settleStart],
  );

  const surfaceStyle = useAnimatedStyle<ViewStyle>(() => ({
    transform: [{ translateY: -scrollY.value }],
  }));

  // The page in view and its immediate neighbours. Rendering the neighbours is
  // what makes a drag show where it is going.
  const pages = useMemo(() => {
    const out: number[] = [];
    for (let page = current - neighbours; page <= current + neighbours; page++) {
      if (page < 0 || page > last) continue;
      out.push(page);
    }
    return out;
  }, [current, last, neighbours]);

  const topOf = useCallback((page: number) => page * height, [height]);
  const offsetOf = useCallback((page: number) => (page - current) * height, [current, height]);

  return { pan, justDragged, surfaceStyle, pages, topOf, offsetOf };
}
