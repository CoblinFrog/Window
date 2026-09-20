import type { ViewStyle } from 'react-native';

/**
 * The four edges pinned to their parent.
 *
 * This used to be `StyleSheet.absoluteFillObject`, which React Native removed
 * in 0.86 — from the types and from the runtime. `StyleSheet.absoluteFill` is
 * not a replacement for the spread: on native it is now a frozen plain object
 * and spreading it works, but on web `react-native-web` still registers it as
 * a compiled style, and spreading *that* gets you whatever internal shape the
 * registry happens to use rather than four offsets.
 *
 * `StyleSheet.absoluteFill` is still right where a style is *passed* — in a
 * `style` prop or an array — because both platforms accept their own form
 * there. It is only spreading into a `StyleSheet.create` block that needs
 * this, and this is the literal both platforms would have produced anyway.
 */
export const ABSOLUTE_FILL: ViewStyle = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
