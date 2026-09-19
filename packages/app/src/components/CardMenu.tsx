import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SPACING, TYPE, COLORS, type FeedMode, type ProductCard } from '@window/shared';
import { api } from '../api/client.js';
import { emit } from '../store/events.js';
import { Sheet, SheetOption } from './Sheet.js';

/**
 * The long-press card menu.
 *
 * Every entry here is a negative or an exit, which is why it is behind a
 * long-press rather than on the rail: the feed should never advertise the ways
 * out of it. Hide and mute write suppressions that the ranker also reads as
 * strong negative signal, so a tap here changes the next page, not just this
 * card.
 */

/** The typed report reasons. Free text is deliberately absent: it would need moderation. */
const REPORT_REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'counterfeit', label: 'Counterfeit' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'seller_unresponsive', label: 'Seller unresponsive' },
  { value: 'price_manipulation', label: 'Price manipulation' },
  { value: 'stolen_photos', label: 'Stolen photos' },
];

const MENU_HEIGHT_FRACTION = 0.42;
const REPORT_HEIGHT_FRACTION = 0.56;

/** Shared links are cluster-scoped, so all of a product's offers resolve to one page. */
const SHARE_ORIGIN = 'https://window.app/p/';

export interface CardMenuProps {
  visible: boolean;
  onClose: () => void;
  /** The long-pressed card. Supplies the product, the brand and the share target. */
  card: ProductCard;
  /** Overrides the derived `window.app/p/{clusterId}` link. */
  shareUrl?: string;
  position?: number;
  mode?: FeedMode;
  reducedMotion?: boolean;
  /** Fired after a suppression lands so the caller can drop the card. */
  onHidden?: (kind: 'product' | 'brand') => void;
}

export function CardMenu({
  visible,
  onClose,
  card,
  shareUrl,
  position = 0,
  mode = 'single',
  reducedMotion = false,
  onHidden,
}: CardMenuProps): React.ReactElement {
  const [view, setView] = useState<'menu' | 'report'>('menu');
  const { productId, brand } = card;
  // An unclustered listing has no canonical page, so it has no link to copy.
  const shareTarget = shareUrl ?? (card.clusterId ? `${SHARE_ORIGIN}${card.clusterId}` : null);

  useEffect(() => {
    if (!visible) setView('menu');
  }, [visible]);

  const hideProduct = useCallback(async () => {
    try {
      await api.suppress({ kind: 'product', value: productId, productId });
    } catch {
      return;
    }
    emit('hide_product', { productId, position, mode });
    onHidden?.('product');
    onClose();
  }, [productId, position, mode, onHidden, onClose]);

  const hideBrand = useCallback(async () => {
    if (!brand) return;
    try {
      await api.suppress({ kind: 'brand', value: brand, productId });
    } catch {
      return;
    }
    emit('hide_brand', { productId, position, mode });
    onHidden?.('brand');
    onClose();
  }, [brand, productId, position, mode, onHidden, onClose]);

  const copyLink = useCallback(async () => {
    if (!shareTarget) return;
    await shareOrCopy(shareTarget);
    onClose();
  }, [shareTarget, onClose]);

  const report = useCallback(
    async (reason: string) => {
      try {
        await api.report({ productId, reason });
      } catch {
        return;
      }
      tick();
      // No confirmation screen. The sheet closing is the acknowledgement, and a
      // "thanks for reporting" toast is exactly the reassurance this app omits.
      onClose();
    },
    [productId, onClose],
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={view === 'menu' ? 'This listing' : 'Report this listing'}
      heightFraction={view === 'menu' ? MENU_HEIGHT_FRACTION : REPORT_HEIGHT_FRACTION}
      reducedMotion={reducedMotion}
    >
      {view === 'menu' ? (
        <View>
          <SheetOption
            label="Hide this"
            detail="You will not see this listing again."
            onPress={() => void hideProduct()}
          />
          {brand ? (
            <SheetOption
              label={`Hide everything from ${brand}`}
              detail="Removes this brand from your feed."
              onPress={() => void hideBrand()}
            />
          ) : null}
          <SheetOption
            label="Report"
            onPress={() => setView('report')}
            accessibilityHint="Choose a reason on the next screen"
          />
          {shareTarget ? (
            <SheetOption label="Copy link" onPress={() => void copyLink()} />
          ) : null}
        </View>
      ) : (
        <View>
          {REPORT_REASONS.map((reason) => (
            <SheetOption
              key={reason.value}
              label={reason.label}
              onPress={() => void report(reason.value)}
            />
          ))}
          <SheetOption label="Back" onPress={() => setView('menu')} />
          <Text style={styles.note}>
            Reports are reviewed against the listing, not the seller's account.
          </Text>
        </View>
      )}
    </Sheet>
  );
}

/**
 * Web has a clipboard API and native does not without another dependency, so
 * native hands the link to the system share sheet — which is where a user who
 * asked to copy a link was going anyway.
 */
async function shareOrCopy(url: string): Promise<void> {
  const clipboard = (
    globalThis as {
      navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
    }
  ).navigator?.clipboard;

  if (Platform.OS === 'web' && clipboard) {
    await clipboard.writeText(url).catch(() => undefined);
    return;
  }

  await Share.share({ message: url }).catch(() => undefined);
}

function tick(): void {
  if (Platform.OS === 'web') return;
  void Haptics.selectionAsync();
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
