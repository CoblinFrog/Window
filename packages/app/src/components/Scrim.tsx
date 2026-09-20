import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SCRIM } from '@window/shared';

/**
 * The scrim.
 *
 * Gradients behind the three edges the pane view puts chrome on: the top for
 * the back control, the right for the action rail, the bottom for the gallery
 * ticks. This is the only way to hit WCAG AA over arbitrary product
 * photography — the alternative is relying on the image being dark, which is
 * not a property anyone controls when the catalog comes from forty merchants.
 *
 * It sits between the media and the chrome, never across the subject: the
 * product fills the frame and the gradient only exists where chrome lands.
 */
export interface ScrimProps {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
}

export function Scrim({ top = true, right = true, bottom = true }: ScrimProps): React.ReactElement {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {top ? (
        <LinearGradient
          colors={SCRIM.topStops as unknown as [string, string]}
          style={[styles.top, { height: `${SCRIM.topFraction * 100}%` }]}
        />
      ) : null}
      {bottom ? (
        <LinearGradient
          colors={SCRIM.bottomStops as unknown as [string, string, string]}
          locations={[0, 0.45, 1]}
          style={[styles.bottom, { height: `${SCRIM.bottomFraction * 100}%` }]}
        />
      ) : null}
      {right ? (
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
  top: { position: 'absolute', left: 0, right: 0, top: 0 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  right: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
