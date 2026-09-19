import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { COLORS, ICON, KEYBINDINGS, MOTION, SHEET, SPACING, TYPE } from '@window/shared';
import { Icon } from './Icon.js';

/**
 * The bottom sheet.
 *
 * One primitive serves every sheet in the app, because a second one would drift
 * and the sheet is the only surface allowed to sit above the feed. Three things
 * are load-bearing and easy to lose in a rewrite: the drag runs entirely on the
 * UI thread so it tracks the finger through a busy JS frame, the backdrop
 * swallows touches so the feed behind is frozen rather than merely covered, and
 * the skeleton is delayed rather than immediate so fast content never flashes a
 * loading state at the user.
 */

const EASING = Easing.bezier(
  MOTION.easing[0],
  MOTION.easing[1],
  MOTION.easing[2],
  MOTION.easing[3],
);

/** Past a quarter of the sheet, or a firm flick, the gesture reads as dismissal. */
const DISMISS_TRAVEL_FRACTION = 0.25;
const DISMISS_VELOCITY = 800;

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  /** Fraction of the viewport the sheet occupies. */
  heightFraction?: number;
  /** Also the sheet's accessible name, so it is never optional. */
  title: string;
  /** Drives the delayed skeleton. Content is rendered as soon as it exists. */
  loading?: boolean;
  reducedMotion?: boolean;
  children: React.ReactNode;
}

export function Sheet({
  visible,
  onClose,
  heightFraction = SHEET.reviewsHeightFraction,
  title,
  loading = false,
  reducedMotion = false,
  children,
}: SheetProps): React.ReactElement | null {
  const { height: viewportHeight } = useWindowDimensions();
  const sheetHeight = Math.round(viewportHeight * heightFraction);

  // Survives `visible` going false so the exit animation can finish.
  const [mounted, setMounted] = useState(visible);

  const translateY = useSharedValue(Dimensions.get('window').height);
  const backdrop = useSharedValue(0);

  // The gesture worklet needs the height without crossing back to JS, and the
  // open/close effect needs it without listing it as a dependency — a browser
  // resize must not replay the entrance.
  const heightRef = useRef(sheetHeight);
  heightRef.current = sheetHeight;
  const heightValue = useSharedValue(sheetHeight);
  useEffect(() => {
    heightValue.value = sheetHeight;
  }, [sheetHeight, heightValue]);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return;
    const config = { duration: reducedMotion ? 0 : MOTION.sheetMs, easing: EASING };

    if (visible) {
      translateY.value = heightRef.current;
      translateY.value = withTiming(0, config);
      backdrop.value = withTiming(1, config);
      return;
    }

    backdrop.value = withTiming(0, config);
    translateY.value = withTiming(heightRef.current, config, (finished) => {
      'worklet';
      if (finished) runOnJS(setMounted)(false);
    });
  }, [mounted, visible, reducedMotion, translateY, backdrop]);

  // The whole web client is keyboard-operable, and a sheet that traps the user
  // is the fastest way to break that promise.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const keys: readonly string[] = KEYBINDINGS.closeSheet;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (keys.includes(event.key)) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!loading || !mounted) {
      setShowSkeleton(false);
      return;
    }
    const timer = setTimeout(() => setShowSkeleton(true), SHEET.skeletonAfterMs);
    return () => clearTimeout(timer);
  }, [loading, mounted]);

  const pan = Gesture.Pan()
    // Downward only: an upward drag belongs to whatever scrolls inside.
    .activeOffsetY(6)
    .onUpdate((event) => {
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      const dismissed =
        event.translationY > heightValue.value * DISMISS_TRAVEL_FRACTION ||
        event.velocityY > DISMISS_VELOCITY;
      const config = { duration: reducedMotion ? 0 : MOTION.sheetMs, easing: EASING };
      if (dismissed) {
        backdrop.value = withTiming(0, config);
        translateY.value = withTiming(heightValue.value, config, (finished) => {
          'worklet';
          if (finished) runOnJS(onClose)();
        });
        return;
      }
      translateY.value = withTiming(0, config);
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  if (!mounted) return null;

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Animated.View style={[styles.backdropLayer, backdropStyle]}>
        <Pressable
          style={styles.backdropPress}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          focusable
        />
      </Animated.View>

      <Animated.View style={[styles.sheet, { height: sheetHeight }, sheetStyle]}>
        <GestureDetector gesture={pan}>
          <View style={styles.header}>
            <View style={styles.grabber} />
            <View style={styles.headerRow}>
              <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                {title}
              </Text>
              <Pressable
                onPress={onClose}
                style={styles.close}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title}`}
                focusable
              >
                <Icon name="close" size={ICON.glyph} color={COLORS.textPrimary} />
              </Pressable>
            </View>
          </View>
        </GestureDetector>

        <View style={styles.body}>{showSkeleton ? <SheetSkeleton /> : children}</View>
      </Animated.View>
    </View>
  );
}

/**
 * Four grey bars. No shimmer: a moving skeleton is motion that entertains, and
 * the only thing this needs to say is "the shape is coming".
 */
function SheetSkeleton(): React.ReactElement {
  return (
    <View style={styles.skeleton} accessibilityLabel="Loading" accessible>
      <View style={[styles.skeletonBar, styles.skeletonWide]} />
      <View style={[styles.skeletonBar, styles.skeletonFull]} />
      <View style={[styles.skeletonBar, styles.skeletonFull]} />
      <View style={[styles.skeletonBar, styles.skeletonNarrow]} />
    </View>
  );
}

export interface SheetOptionProps {
  label: string;
  /** Second line. Used to state plainly what an irreversible action does. */
  detail?: string;
  onPress: () => void;
  selected?: boolean;
  /**
   * Accent on the check mark. Reserved for upvote state: the accent has exactly
   * three sanctioned uses and "selected thing" is not one of them.
   */
  selectedAccent?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}

/** A full-width row inside a sheet, at the 44 px accessibility floor. */
export function SheetOption({
  label,
  detail,
  onPress,
  selected = false,
  selectedAccent = false,
  disabled = false,
  accessibilityHint,
}: SheetOptionProps): React.ReactElement {
  const handle = useCallback(() => {
    if (!disabled) onPress();
  }, [disabled, onPress]);

  return (
    <Pressable
      onPress={handle}
      disabled={disabled}
      style={disabled ? styles.optionDisabled : styles.option}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      focusable={!disabled}
    >
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
      </View>
      {selected ? (
        <Icon name="check" size={ICON.glyph} color={COLORS.textPrimary} active={selectedAccent} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    // Above the feed and above the rail; nothing stacks above a sheet.
    zIndex: 100,
  },
  backdropLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  backdropPress: {
    flex: 1,
  },
  sheet: {
    backgroundColor: COLORS.sheet,
    width: '100%',
    // No radius, no shadow. Sharp edges read as glass.
    overflow: 'hidden',
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.hairline,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 3,
    marginTop: 8,
    backgroundColor: COLORS.hairline,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: SPACING.screenMargin,
    paddingRight: 4,
    minHeight: ICON.minTarget,
  },
  title: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  close: {
    width: ICON.minTarget,
    height: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  skeleton: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: SPACING.screenMargin,
  },
  skeletonBar: {
    height: TYPE.lineHeights.body,
    marginBottom: 12,
    backgroundColor: COLORS.hairline,
  },
  skeletonWide: { width: '62%' },
  skeletonFull: { width: '100%' },
  skeletonNarrow: { width: '38%' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ICON.minTarget,
    paddingVertical: 10,
    paddingHorizontal: SPACING.screenMargin,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.hairline,
  },
  optionDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ICON.minTarget,
    paddingVertical: 10,
    paddingHorizontal: SPACING.screenMargin,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.hairline,
    opacity: 0.4,
  },
  optionText: {
    flex: 1,
    paddingRight: 12,
  },
  optionLabel: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  optionDetail: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
    marginTop: 2,
  },
});
