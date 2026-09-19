import React, { useCallback } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, SPACING, TYPE, UPVOTE_REASONS, type UpvoteReason } from '@window/shared';
import { Sheet, SheetOption } from './Sheet.js';

/**
 * The upvote long-press.
 *
 * The reason rides along on the upvote event rather than being stored as an
 * opinion, which is why this is four fixed tags and not a text field: the
 * ranker can act on "price" and can do nothing useful with a sentence.
 */

const REASON_LABELS: Record<UpvoteReason, string> = {
  price: 'Price',
  design: 'Design',
  brand: 'Brand',
  need_it: 'Need it',
};

const SHEET_HEIGHT_FRACTION = 0.42;

export interface ReasonPickerProps {
  visible: boolean;
  onClose: () => void;
  /** The chosen tag travels with the upvote; the caller owns the emit. */
  onPick: (reason: UpvoteReason) => void;
  selected?: UpvoteReason | null;
  reducedMotion?: boolean;
}

export function ReasonPicker({
  visible,
  onClose,
  onPick,
  selected = null,
  reducedMotion = false,
}: ReasonPickerProps): React.ReactElement {
  const choose = useCallback(
    (reason: UpvoteReason) => {
      // An upvote is confirmed by the icon filling and a haptic tick, and
      // nothing else.
      if (Platform.OS !== 'web') void Haptics.selectionAsync();
      onPick(reason);
      onClose();
    },
    [onPick, onClose],
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Why this one?"
      heightFraction={SHEET_HEIGHT_FRACTION}
      reducedMotion={reducedMotion}
    >
      <View>
        {UPVOTE_REASONS.map((reason) => (
          <SheetOption
            key={reason}
            label={REASON_LABELS[reason]}
            onPress={() => choose(reason)}
            selected={selected === reason}
            selectedAccent
          />
        ))}
        <Text style={styles.note}>Optional. The upvote counts either way.</Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  note: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 14,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
});
