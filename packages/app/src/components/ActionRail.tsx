import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { COLORS, ICON, SPACING, TYPE, type ProductCard } from '@window/shared';
import { Icon, type IconName } from './Icon.js';

/**
 * The right-side action rail, Single mode only.
 *
 * Deliberately TikTok-shaped: the gesture vocabulary is already learned, and a
 * shopping feed that behaves like a video feed inherits that muscle memory for
 * free. Stacked bottom-up, 56 px targets, 20 px from the right edge.
 *
 * Every control here is simultaneously a UI action and a ranking signal, which
 * is why each one takes both an `onPress` and an `onLongPress` — the long-press
 * is never decoration, it is always a more specific version of the same intent.
 */

export interface ActionRailProps {
  card: ProductCard;
  upvoted: boolean;
  inCart: boolean;
  onSeller(): void;
  onSellerLongPress(): void;
  onUpvote(): void;
  onUpvoteLongPress(): void;
  onReviews(): void;
  onReviewsLongPress(): void;
  onCart(): void;
  onCartLongPress(): void;
  onShare(): void;
  onShareLongPress(): void;
  /** Desktop places the rail outside the column, with labels next to the icons. */
  withLabels?: boolean;
  reducedMotion?: boolean;
}

function tick(): void {
  // An upvote is confirmed by the icon filling and a haptic tick, and nothing
  // else. No toast, no burst of confetti, no counter animation.
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

interface RailButtonProps {
  name: IconName;
  label: string;
  active?: boolean;
  caption?: string;
  withLabels: boolean;
  onPress(): void;
  onLongPress(): void;
}

function RailButton({
  name,
  label,
  active = false,
  caption,
  withLabels,
  onPress,
  onLongPress,
}: RailButtonProps): React.ReactElement {
  return (
    <Pressable
      onPress={() => {
        tick();
        onPress();
      }}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[styles.button, withLabels ? styles.buttonWithLabel : null]}
      hitSlop={4}
    >
      <Icon name={name} active={active} />
      {/* The caption is the count, not a word. The rail is icon-only furniture
          on a phone; on desktop the label moves out beside the glyph. */}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      {withLabels ? <Text style={styles.label}>{label}</Text> : null}
    </Pressable>
  );
}

/** The rail is five 56 px targets plus the gaps between them. */
const RAIL_ITEMS = 5;

export function ActionRail(props: ActionRailProps): React.ReactElement {
  const { card, withLabels = false } = props;
  const { height } = useWindowDimensions();

  // The rail is anchored to the bottom, so on a short viewport a fixed gap
  // pushes the top control off the screen entirely — the seller avatar is the
  // first thing to go, and it is the one control with no keyboard equivalent.
  // The gap absorbs the shortfall before anything is allowed to overflow.
  const available = height * 0.84 - 24;
  const gap = Math.max(
    4,
    Math.min(SPACING.railItemGap, (available - RAIL_ITEMS * ICON.target) / (RAIL_ITEMS - 1)),
  );

  return (
    <View
      style={[styles.rail, withLabels ? styles.railOutside : styles.railOverlay, { gap }]}
    >
      {/* 1 (top): seller avatar. Long-press mutes them. */}
      <Pressable
        onPress={props.onSeller}
        onLongPress={props.onSellerLongPress}
        delayLongPress={320}
        accessibilityRole="button"
        accessibilityLabel={`Seller ${card.seller.displayName}. Long press to mute.`}
        style={[styles.button, withLabels ? styles.buttonWithLabel : null]}
      >
        {card.seller.avatarUrl ? (
          <Image
            source={{ uri: card.seller.avatarUrl }}
            style={styles.avatar}
            contentFit="cover"
            transition={0}
          />
        ) : (
          <View style={styles.avatarFallback}>
            <Icon name="seller" size={20} />
          </View>
        )}
        {withLabels ? <Text style={styles.label}>Seller</Text> : null}
      </Pressable>

      {/* 2: upvote. Long-press opens the reason picker. */}
      <RailButton
        name="upvote"
        label="Upvote"
        active={props.upvoted}
        caption={card.upvotes > 0 ? compact(card.upvotes + (props.upvoted ? 1 : 0)) : undefined}
        withLabels={withLabels}
        onPress={props.onUpvote}
        onLongPress={props.onUpvoteLongPress}
      />

      {/* 3: reviews. Long-press jumps straight to critical reviews. */}
      <RailButton
        name="reviews"
        label="Reviews"
        caption={card.reviews.count > 0 ? compact(card.reviews.count) : undefined}
        withLabels={withLabels}
        onPress={props.onReviews}
        onLongPress={props.onReviewsLongPress}
      />

      {/* 4: add to cart. Auction items get "Open to bid" instead. */}
      <RailButton
        name="cart"
        label={card.canAddToCart ? 'Add to cart' : 'Open to bid'}
        active={props.inCart}
        withLabels={withLabels}
        onPress={props.onCart}
        onLongPress={props.onCartLongPress}
      />

      {/* 5 (bottom): share. Long-press copies the link. */}
      <RailButton
        name="share"
        label="Share"
        withLabels={withLabels}
        onPress={props.onShare}
        onLongPress={props.onShareLongPress}
      />
    </View>
  );
}

/** 1200 becomes "1.2k". Counts are scanned, not read. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    alignItems: 'center',
  },
  // Vertically centred in the lower two-thirds, where the thumb already is.
  railOverlay: {
    right: SPACING.railRightInset,
    bottom: '16%',
  },
  railOutside: {
    right: -96,
    bottom: '16%',
    alignItems: 'flex-start',
  },
  button: {
    width: ICON.target,
    minHeight: ICON.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // "The action rail sits immediately right of the column, outside it, with
  // labels next to the icons." Beside, not beneath — a stacked label makes the
  // rail twice as tall and stops it fitting the lower two-thirds.
  buttonWithLabel: {
    flexDirection: 'row',
    width: 'auto',
    justifyContent: 'flex-start',
    gap: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  avatarFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    marginTop: 2,
  },
  label: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
});
