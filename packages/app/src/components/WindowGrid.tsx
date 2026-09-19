import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import {
  COLORS,
  RADIUS,
  SPACING,
  TYPE,
  formatMoney,
  type ProductCard,
} from '@window/shared';

/**
 * Window mode: a 2x2 grid filling the viewport.
 *
 * The grid is a shop window. Scrolling it is walking a street and glancing into
 * each storefront — four things visible at once, none of them demanding a
 * decision. Tapping a tile is stepping closer to the glass.
 *
 * Three consequences of that metaphor are load-bearing and non-negotiable:
 * quads are coherent rather than random, the action rail is hidden because you
 * do not interact with a shop window, and the grid is remembered after a
 * promote so stepping back puts you on the same street corner.
 *
 * Price only. This screen asks "which of these?", so anything that answers "do
 * you want this?" belongs on the other screen.
 */

export interface WindowGridProps {
  tiles: ProductCard[];
  width: number;
  height: number;
  /** Buffer index of the first tile, so taps resolve to absolute indexes. */
  startIndex: number;
  /** The tile carrying the cursor gets a 2 px accent border. */
  highlightIndex: number;
  onTap(index: number): void;
  onLongPress(index: number, card: ProductCard): void;
  dataSaver?: boolean;
}

export function WindowGrid({
  tiles,
  width,
  height,
  startIndex,
  highlightIndex,
  onTap,
  onLongPress,
  dataSaver = false,
}: WindowGridProps): React.ReactElement {
  // 2 px gutters between tiles: the grid should read as panes of one window,
  // not as four separate cards.
  const tileWidth = (width - SPACING.gutter) / 2;
  const tileHeight = (height - SPACING.gutter) / 2;

  return (
    <View style={[styles.grid, { width, height }]}>
      {tiles.map((card, offset) => {
        const index = startIndex + offset;
        const highlighted = index === highlightIndex;
        const hero = card.media.hero;
        const uri = dataSaver ? (hero.avif[0] ?? hero.webp[0]) : (hero.avif[1] ?? hero.avif[0]);

        return (
          <Pressable
            key={card.productId}
            onPress={() => onTap(index)}
            // Window mode hides the rail; a long press raises a two-option
            // radial with upvote and add to cart, sized for thumb reach.
            onLongPress={() => onLongPress(index, card)}
            delayLongPress={320}
            style={[
              styles.tile,
              { width: tileWidth, height: tileHeight },
              highlighted ? styles.tileHighlighted : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${card.title}, ${formatMoney(card.price)}`}
            accessibilityState={{ selected: highlighted }}
          >
            <Image
              source={{ uri }}
              placeholder={{ blurhash: hero.blurhash }}
              transition={0}
              contentFit="cover"
              style={StyleSheet.absoluteFill}
              recyclingKey={card.productId}
              cachePolicy="memory-disk"
            />
            {/* Price only, overlaid bottom-left, on the smallest scrim that
                clears AA against arbitrary photography. */}
            <View style={styles.priceWell} pointerEvents="none">
              <Text style={styles.price} numberOfLines={1}>
                {card.auction
                  ? formatMoney({
                      amount: card.auction.currentBid,
                      currency: card.price.currency,
                    })
                  : formatMoney(card.price)}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {/* A pane that could not be filled coherently is left short rather than
          padded with unrelated tiles. */}
      {tiles.length < 4
        ? Array.from({ length: 4 - tiles.length }, (_, index) => (
            <View
              key={`empty-${index}`}
              style={[styles.tile, styles.empty, { width: tileWidth, height: tileHeight }]}
            />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.gutter,
    backgroundColor: COLORS.surface,
  },
  tile: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.tile,
    overflow: 'hidden',
  },
  tileHighlighted: {
    borderWidth: 2,
    borderColor: COLORS.accent,
  },
  empty: {
    backgroundColor: '#050505',
  },
  priceWell: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  price: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
});
