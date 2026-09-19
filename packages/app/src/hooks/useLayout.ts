import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions } from 'react-native';
import { BREAKPOINTS } from '@window/shared';

/**
 * Responsive rules.
 *
 * The vertical feed is preserved on desktop rather than reflowed into a grid.
 * Widening the feed into multiple columns on large screens destroys the
 * single-item focus that makes Single mode work, so above 1600 px the extra
 * space stays empty — that is the rule, not an oversight.
 */

export type Breakpoint = 'phone' | 'tablet' | 'desktop' | 'wide';

export interface LayoutInfo {
  breakpoint: Breakpoint;
  /** Width of the feed column itself. */
  columnWidth: number;
  columnHeight: number;
  /** True when the rail sits outside the column, with labels. */
  railOutside: boolean;
  /** True when the feed is a centred column on a dimmed backdrop. */
  centred: boolean;
  showKeyboardHints: boolean;
  isWeb: boolean;
}

export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();

  const breakpoint: Breakpoint =
    width < BREAKPOINTS.phone
      ? 'phone'
      : width < BREAKPOINTS.tablet
        ? 'tablet'
        : width < BREAKPOINTS.wide
          ? 'desktop'
          : 'wide';

  if (breakpoint === 'phone') {
    return {
      breakpoint,
      columnWidth: width,
      columnHeight: height,
      railOutside: false,
      centred: false,
      showKeyboardHints: false,
      isWeb: Platform.OS === 'web',
    };
  }

  // A centred 9:16 column, capped at 480 px wide, on a dimmed backdrop. The
  // column is height-constrained first: a tall browser window should not
  // produce a column wider than the cap.
  const availableHeight = height - 48;
  const byHeight = availableHeight * BREAKPOINTS.columnAspect;
  const columnWidth = Math.min(BREAKPOINTS.columnMaxWidth, byHeight, width - 32);
  const columnHeight = Math.min(availableHeight, columnWidth / BREAKPOINTS.columnAspect);

  return {
    breakpoint,
    columnWidth,
    columnHeight,
    // Below 1024 px the rail stays overlaid inside the column; above it, the
    // rail moves out beside the column and gains labels.
    railOutside: breakpoint === 'desktop' || breakpoint === 'wide',
    centred: true,
    showKeyboardHints: breakpoint === 'desktop' || breakpoint === 'wide',
    isWeb: Platform.OS === 'web',
  };
}

/**
 * `prefers-reduced-motion` replaces the promote cross-fade, the upvote burst
 * and video autoplay with instant cuts. Nothing in the interface communicates
 * through motion alone, so removing it costs no information.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      if (active) setReduced(value);
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
