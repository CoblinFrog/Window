import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SCRIM } from '@window/shared';

/**
 * The scrim.
 *
 * A vertical gradient over the bottom 35% and a horizontal one over the right
 * 20%. This is the only way to hit WCAG AA over arbitrary product photography:
 * the alternative is relying on the image being dark, which is not a property
 * anyone controls when the catalog comes from forty different merchants.
 *
 * It sits between the media and the chrome, never across the subject — the
 * product fills the frame and the gradient only exists where text lands.
 */
export function Scrim({ rail = true }: { rail?: boolean }): React.ReactElement {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={SCRIM.bottomStops as unknown as [string, string, string]}
        locations={[0, 0.45, 1]}
        style={[styles.bottom, { height: `${SCRIM.bottomFraction * 100}%` }]}
      />
      {rail ? (
        <LinearGradient
          colors={SCRIM.rightStops as unknown as [string, string]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[styles.right, { width: `${SCRIM.rightFraction * 100}%` }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  right: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
  },
});
