import React, { useCallback } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { MOTION } from '@window/shared';

/**
 * A button that answers the finger.
 *
 * Every control in the app was a bare `Pressable`, which on the web means a
 * press produces nothing at all until whatever it triggers happens — and for
 * an upvote, which is deliberately confirmed by nothing louder than the icon
 * filling, that left a gap where the tap seemed not to have landed.
 *
 * Down is a fast timing and up is a spring, which is the asymmetry that makes
 * it feel like a physical button rather than an easing curve: real things
 * compress the instant they are pushed and take their own time coming back.
 *
 * The pop is the overshoot on release, and it has to be aimed at rather than
 * hoped for. The spring runs on the compression, not on the scale, so when it
 * overshoots past zero the control goes *above* its resting size — a damping
 * ratio of 0.33 puts the peak around 5% over, which is the difference between
 * a button that springs back and one that you can see spring back. The first
 * attempt at this was 0.42, and at that ratio the peak is 2% and nobody
 * noticed it was there.
 */

const PRESSED = 0.86;
const DOWN_MS = 80;
/** Damping ratio near 0.33: fast, and overshooting enough to read as a pop. */
const RELEASE = { damping: 9, stiffness: 380, mass: 0.5 } as const;

export interface PressScaleProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /**
   * Layout for the children. The scaling view sits between the pressable and
   * them, so anything that arranges them — alignment, gaps — has to live on it
   * rather than on the outer style, or it applies to a box with one child in it.
   */
  contentStyle?: StyleProp<ViewStyle>;
  /** How far it compresses. Larger controls want less. */
  scale?: number;
  children: React.ReactNode;
}

export function PressScale({
  style,
  contentStyle,
  scale = PRESSED,
  children,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressScaleProps): React.ReactElement {
  const pressed = useSharedValue(0);

  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - scale) * pressed.value }],
  }));

  const down = useCallback(
    (event: Parameters<NonNullable<PressableProps['onPressIn']>>[0]) => {
      pressed.value = withTiming(1, { duration: DOWN_MS });
      onPressIn?.(event);
    },
    [onPressIn, pressed],
  );

  const up = useCallback(
    (event: Parameters<NonNullable<PressableProps['onPressOut']>>[0]) => {
      pressed.value = withSpring(0, RELEASE);
      onPressOut?.(event);
    },
    [onPressOut, pressed],
  );

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      // A disabled control must not appear to respond. It is still a
      // `Pressable` so its accessibility state is announced.
      onPressIn={disabled ? undefined : down}
      onPressOut={disabled ? undefined : up}
      style={style}
    >
      <Animated.View style={[contentStyle, animated]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Kept in step with the rest of the system's motion. */
export const PRESS_MOTION = { downMs: DOWN_MS, sheetMs: MOTION.sheetMs } as const;
