import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, ICON, SPACING, TYPE } from '@window/shared';
import { Sheet } from './Sheet.js';

/**
 * The cart button's long-press.
 *
 * A plain tap adds the merchant's default; this exists so a user who cares
 * about size or colour never has to leave the feed to say so. Only option
 * groups the listing actually exposes are rendered — a "Colour: One colour"
 * row would be invented data, and the picker would be lying about the listing.
 */

const MIN_QUANTITY = 1;
const DEFAULT_MAX_QUANTITY = 10;
const SHEET_HEIGHT_FRACTION = 0.55;

export interface VariantOptionGroup {
  /** The option name as the merchant exposes it, e.g. "Size". */
  key: string;
  values: string[];
}

export interface VariantSelection {
  variant: Record<string, string>;
  quantity: number;
}

export interface VariantPickerProps {
  visible: boolean;
  onClose: () => void;
  options: VariantOptionGroup[];
  initialVariant?: Record<string, string>;
  initialQuantity?: number;
  maxQuantity?: number;
  confirmLabel?: string;
  onConfirm: (selection: VariantSelection) => void;
  reducedMotion?: boolean;
}

export function VariantPicker({
  visible,
  onClose,
  options,
  initialVariant,
  initialQuantity = MIN_QUANTITY,
  maxQuantity = DEFAULT_MAX_QUANTITY,
  confirmLabel = 'Add to cart',
  onConfirm,
  reducedMotion = false,
}: VariantPickerProps): React.ReactElement {
  const [variant, setVariant] = useState<Record<string, string>>(initialVariant ?? {});
  const [quantity, setQuantity] = useState(initialQuantity);

  // Each open starts from what the caller knows, not from the last session's
  // half-made choice.
  useEffect(() => {
    if (!visible) return;
    setVariant(initialVariant ?? {});
    setQuantity(initialQuantity);
  }, [visible, initialVariant, initialQuantity]);

  const choose = useCallback((key: string, value: string) => {
    tick();
    setVariant((current) => ({ ...current, [key]: value }));
  }, []);

  const step = useCallback(
    (delta: number) => {
      tick();
      setQuantity((current) => Math.min(maxQuantity, Math.max(MIN_QUANTITY, current + delta)));
    },
    [maxQuantity],
  );

  const complete = options.every((group) => Boolean(variant[group.key]));

  const confirm = useCallback(() => {
    if (!complete) return;
    tick();
    onConfirm({ variant, quantity });
    onClose();
  }, [complete, onConfirm, variant, quantity, onClose]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Options"
      heightFraction={SHEET_HEIGHT_FRACTION}
      reducedMotion={reducedMotion}
    >
      <ScrollView contentContainerStyle={styles.content}>
        {options.map((group) => (
          <View key={group.key} style={styles.group}>
            <Text style={styles.groupLabel} accessibilityRole="header">
              {group.key}
            </Text>
            <View style={styles.values}>
              {group.values.map((value) => {
                const selected = variant[group.key] === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => choose(group.key, value)}
                    style={selected ? styles.valueSelected : styles.value}
                    accessibilityRole="button"
                    accessibilityLabel={`${group.key}: ${value}`}
                    accessibilityState={{ selected }}
                    focusable
                  >
                    <Text style={selected ? styles.valueTextSelected : styles.valueText}>
                      {value}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        <View style={styles.group}>
          <Text style={styles.groupLabel} accessibilityRole="header">
            Quantity
          </Text>
          <View style={styles.stepper}>
            <Pressable
              onPress={() => step(-1)}
              disabled={quantity <= MIN_QUANTITY}
              style={styles.stepButton}
              accessibilityRole="button"
              accessibilityLabel="Decrease quantity"
              accessibilityState={{ disabled: quantity <= MIN_QUANTITY }}
              focusable={quantity > MIN_QUANTITY}
            >
              <Text style={styles.stepGlyph}>−</Text>
            </Pressable>
            <Text style={styles.quantity} accessibilityLabel={`Quantity ${quantity}`}>
              {quantity}
            </Text>
            <Pressable
              onPress={() => step(1)}
              disabled={quantity >= maxQuantity}
              style={styles.stepButton}
              accessibilityRole="button"
              accessibilityLabel="Increase quantity"
              accessibilityState={{ disabled: quantity >= maxQuantity }}
              focusable={quantity < maxQuantity}
            >
              <Text style={styles.stepGlyph}>+</Text>
            </Pressable>
          </View>
        </View>

        <Pressable
          onPress={confirm}
          disabled={!complete}
          style={complete ? styles.confirm : styles.confirmDisabled}
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          accessibilityState={{ disabled: !complete }}
          accessibilityHint={complete ? undefined : 'Choose every option first'}
          focusable={complete}
        >
          <Text style={styles.confirmText}>{confirmLabel}</Text>
        </Pressable>
      </ScrollView>
    </Sheet>
  );
}

function tick(): void {
  if (Platform.OS === 'web') return;
  void Haptics.selectionAsync();
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: SPACING.screenMargin,
    paddingBottom: 32,
  },
  group: {
    marginBottom: 18,
  },
  groupLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
    marginBottom: 8,
  },
  values: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  value: {
    minHeight: ICON.minTarget,
    minWidth: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginRight: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  // Selection inverts rather than tints: the accent is not a selection colour.
  valueSelected: {
    minHeight: ICON.minTarget,
    minWidth: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginRight: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: COLORS.textPrimary,
    backgroundColor: COLORS.textPrimary,
  },
  valueText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  valueTextSelected: {
    color: COLORS.surface,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepButton: {
    width: ICON.minTarget,
    height: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  stepGlyph: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.regular,
  },
  quantity: {
    minWidth: 48,
    textAlign: 'center',
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  confirm: {
    minHeight: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.textPrimary,
  },
  confirmDisabled: {
    minHeight: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.textPrimary,
    opacity: 0.35,
  },
  confirmText: {
    color: COLORS.surface,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
});
