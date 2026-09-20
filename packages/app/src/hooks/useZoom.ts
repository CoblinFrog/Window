import { useCallback, useRef, useState } from 'react';
import type { ViewStyle } from 'react-native';
import {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { MOTION, ZOOM } from '@window/shared';

/**
 * Stepping closer to the glass.
 *
 * Tapping a tile does not cut or cross-fade to the pane view — it zooms into
 * the tile. The window screen leans about the tile that was tapped, and the
 * pane view grows out of that tile's own rectangle to fill the frame.
 * Reversed, it puts the product back down where it was picked up.
 *
 * The point is answering "where did that go?" without the user having to ask.
 * A cross-fade leaves four tiles and one product with no relationship between
 * them; this makes the relationship the animation itself.
 *
 * Three details are load-bearing:
 *
 *   - The pane is scaled on each axis separately. A tile's proportions and the
 *     screen's never agree, so a uniform scale lands the pane *near* the tile
 *     instead of on it — and a zoom that starts from the wrong rectangle is
 *     just a card flying in from somewhere.
 *   - The grid leans rather than zooming. Scaling it all the way up to meet
 *     the pane throws the other three tiles off screen within a few frames,
 *     which reads as a glitch. Anchoring the lean on the tapped tile keeps
 *     that tile still, so the pane grows out of something that never moved.
 *   - `zooming` is separate from `progress`. Without it the styles cannot tell
 *     "settled in the grid" from "settled in the pane", and one of the two
 *     layouts ends up invisible at rest.
 *
 * The reset after a zoom out happens in a single JS callback, alongside the
 * state change that unmounts the pane view. Resetting on the UI thread instead
 * lets the pane snap back to full size for a frame before React catches up.
 */

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EASING = Easing.bezier(...(MOTION.easing as unknown as [number, number, number, number]));

export interface ZoomTransition {
  /** True while a zoom is in flight, and both layouts must stay mounted. */
  active: boolean;
  gridStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
  paneStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
  /** Zoom into `rect`, running `commit` at once so the pane paints throughout. */
  zoomIn(rect: TileRect | null, commit: () => void): void;
  /** Zoom back out to the remembered rect, running `commit` at the end. */
  zoomOut(commit: () => void): void;
}

export function useZoom(width: number, height: number, reducedMotion: boolean): ZoomTransition {
  const [active, setActive] = useState(false);

  /** 1 while a zoom is running. At 0 both layouts sit at their resting size. */
  const zooming = useSharedValue(0);
  /** 0 is "the size and place of the tile", 1 is "filling the frame". */
  const progress = useSharedValue(1);

  // The tile's rectangle within the stage, on the UI thread rather than in
  // state: a zoom that waits for a render to start stutters on its first frame.
  const rectX = useSharedValue(0);
  const rectY = useSharedValue(0);
  const rectW = useSharedValue(0);
  const rectH = useSharedValue(0);

  const gridStyle = useAnimatedStyle<ViewStyle>(() => {
    if (zooming.value === 0) return { opacity: 1, transform: [] };

    const t = progress.value;
    const fade = Math.max(0, 1 - t / ZOOM.gridFadeBy);
    if (rectW.value <= 0 || rectH.value <= 0) return { opacity: fade, transform: [] };

    const scale = 1 + (ZOOM.gridLean - 1) * t;

    // Transforms apply about the view's centre, so a point `offset` from that
    // centre lands at `offset * scale`. Translating back by the difference pins
    // the tapped tile in place while the rest of the grid expands past it.
    const offsetX = rectX.value + rectW.value / 2 - width / 2;
    const offsetY = rectY.value + rectH.value / 2 - height / 2;

    return {
      opacity: fade,
      transform: [
        { translateX: -offsetX * (scale - 1) },
        { translateY: -offsetY * (scale - 1) },
        { scale },
      ],
    };
  }, [width, height]);

  const paneStyle = useAnimatedStyle<ViewStyle>(() => {
    if (zooming.value === 0) return { opacity: 1, transform: [] };

    const t = progress.value;
    // Arrives quickly, so the product is legible for most of the travel — and
    // so the squashed early frames are spent below full opacity.
    const opacity = Math.min(1, t / ZOOM.paneFadeBy);
    if (rectW.value <= 0 || rectH.value <= 0) return { opacity, transform: [] };

    // Each axis independently, so at t = 0 the pane covers the tile exactly.
    const fromX = rectW.value / width;
    const fromY = rectH.value / height;
    const offsetX = rectX.value + rectW.value / 2 - width / 2;
    const offsetY = rectY.value + rectH.value / 2 - height / 2;

    return {
      opacity,
      transform: [
        // Size and position resolve on the same `t`, so the pane grows and
        // travels to the centre together rather than one then the other.
        { translateX: offsetX * (1 - t) },
        { translateY: offsetY * (1 - t) },
        { scaleX: fromX + (1 - fromX) * t },
        { scaleY: fromY + (1 - fromY) * t },
      ],
    };
  }, [width, height]);

  const settle = useCallback(() => {
    zooming.value = 0;
    progress.value = 1;
    setActive(false);
  }, [progress, zooming]);

  const zoomIn = useCallback(
    (rect: TileRect | null, commit: () => void) => {
      if (reducedMotion) {
        commit();
        return;
      }
      rectX.value = rect?.x ?? 0;
      rectY.value = rect?.y ?? 0;
      rectW.value = rect?.width ?? 0;
      rectH.value = rect?.height ?? 0;

      setActive(true);
      zooming.value = 1;
      progress.value = 0;
      // Dispatched now, not on completion: the pane view has to be mounted and
      // painting for the whole zoom, or the user watches an empty rectangle
      // grow and the product appear at the end of it.
      commit();
      progress.value = withTiming(1, { duration: MOTION.promoteMs, easing: EASING }, (finished) => {
        if (finished) runOnJS(settle)();
      });
    },
    [progress, rectH, rectW, rectX, rectY, reducedMotion, settle, zooming],
  );

  // The commit is stashed rather than captured, so the completion callback has
  // one stable identity for the life of the hook.
  const pendingOut = useRef<(() => void) | null>(null);

  const finishOut = useCallback(() => {
    // One JS callback, so React batches the unmount with the reset below and
    // the pane view is never drawn at full size on its way out.
    pendingOut.current?.();
    pendingOut.current = null;
    settle();
  }, [settle]);

  const zoomOut = useCallback(
    (commit: () => void) => {
      // Nothing was zoomed into, so there is nowhere to put it back.
      if (reducedMotion || rectW.value <= 0) {
        commit();
        return;
      }
      pendingOut.current = commit;
      setActive(true);
      zooming.value = 1;
      progress.value = withTiming(0, { duration: MOTION.promoteMs, easing: EASING }, (finished) => {
        if (finished) runOnJS(finishOut)();
      });
    },
    [finishOut, progress, rectW, reducedMotion, zooming],
  );

  return { active, gridStyle, paneStyle, zoomIn, zoomOut };
}
