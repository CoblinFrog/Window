import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ICON, SPACING, type ProductCard } from '@window/shared';
import { Icon, type IconName } from './Icon.js';

/**
 * The action rail, pane view only.
 *
 * Deliberately TikTok-shaped: the gesture vocabulary is already learned, and a
 * shopping feed that behaves like a video feed inherits that muscle memory for
 * free. Four outline glyphs down the right edge of the photograph.
 *
 * Every control is simultaneously a UI action and a ranking signal, which is
 * why each takes both an `onPress` and an `onLongPress` — the long-press is
 * never decoration, it is always a more specific version of the same intent.
 *
 * Two rules keep it on the image, which is the only place it belongs:
 *
 *   - It sizes itself from the photograph it sits on, not from the window. The
 *     glass is a panel inside the window, and on a desktop or a short viewport
 *     those two heights are nothing like each other — measuring the wrong one
 *     is how a rail ends up running off the bottom of the frame.
 *   - The boxes shrink before the rail will overflow. Below 44 px they keep a
 *     44 px touch target through hit slop, so a cramped frame costs legibility
 *     rather than costing anyone the ability to press the thing.
 *
 * The seller is not on the rail: it lives on the merchant line beneath the
 * glass, where the seller's name already is.
 */

export interface ActionRailProps {
  card: ProductCard;
  upvoted: boolean;
  inCart: boolean;
  onUpvote(): void;
  onUpvoteLongPress(): void;
  onReviews(): void;
  onReviewsLongPress(): void;
  onCart(): void;
  onCartLongPress(): void;
  onShare(): void;
  onShareLongPress(): void;
}

function tick(): void {
  // An upvote is confirmed by the icon filling and a haptic tick, and nothing
  // else. No toast, no confetti, no counter animation.
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

interface RailButtonProps {
  name: IconName;
  label: string;
  active?: boolean;
  size: number;
  glyph: number;
  /** Restores the 44 px touch target when the glyph had to be drawn smaller. */
  slop: number;
  onPress(): void;
  onLongPress(): void;
}

function RailButton({
  name,
  label,
  active = false,
  size,
  glyph,
  slop,
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
      // The rail is icon-only: the counts it might carry are stated in full
      // beneath the glass, and the label is the accessible name rather than
      // text drawn across someone's product photograph.
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[styles.button, { width: size, height: size }]}
      hitSlop={slop}
    >
      <Icon name={name} active={active} size={glyph} />
    </Pressable>
  );
}

/** The rail is four targets plus the gaps between them. */
const RAIL_ITEMS = 4;
/** Clearance kept above and below, so it never touches the frame's edges. */
const EDGE_PADDING = 14;
/** Below this the glyphs stop reading as icons at arm's length. */
const MIN_GLYPH_BOX = 32;
const MIN_GAP = 4;
/**
 * Where the rail sits in the space left over: 0.5 is centred, and this is a
 * little below that, where the thumb already is and where it crosses the least
 * of a product shot, which is usually centred in its own frame.
 */
const VERTICAL_BIAS = 0.62;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function ActionRail(props: ActionRailProps): React.ReactElement {
  const { card } = props;

  // The height of the photograph this rail is drawn on. Zero until the first
  // layout pass, which renders at the natural size and corrects on the next.
  const [available, setAvailable] = useState(0);

  const onLayout = (event: LayoutChangeEvent): void => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0 && Math.abs(measured - available) > 1) setAvailable(measured);
  };

  const usable = Math.max(0, available - EDGE_PADDING * 2);

  // Solved rather than clamped after the fact, so the rail cannot overflow the
  // photograph however short it is: the gaps are held at their minimum and the
  // boxes take whatever is left, then any surplus goes back into the gaps.
  const size =
    usable > 0
      ? clamp((usable - (RAIL_ITEMS - 1) * MIN_GAP) / RAIL_ITEMS, MIN_GLYPH_BOX, ICON.target)
      : ICON.target;
  const gap =
    usable > 0
      ? clamp((usable - RAIL_ITEMS * size) / (RAIL_ITEMS - 1), MIN_GAP, SPACING.railItemGap)
      : SPACING.railItemGap;
  const glyph = Math.round(clamp(size * 0.54, 17, 30));
  const slop = Math.max(4, Math.ceil((ICON.minTarget - size) / 2));

  const railHeight = RAIL_ITEMS * size + (RAIL_ITEMS - 1) * gap;
  const slack = Math.max(0, usable - railHeight);

  return (
    <View
      style={[styles.rail, { paddingTop: EDGE_PADDING + slack * VERTICAL_BIAS }]}
      onLayout={onLayout}
      pointerEvents="box-none"
    >
      <View style={[styles.stack, { gap }]}>
        {/* 1 (top): upvote. Long-press opens the reason picker. */}
        <RailButton
          name="upvote"
          label="Upvote"
          active={props.upvoted}
          size={size}
          glyph={glyph}
          slop={slop}
          onPress={props.onUpvote}
          onLongPress={props.onUpvoteLongPress}
        />

        {/* 2: add to cart. Auction items get "Open to bid" instead. */}
        <RailButton
          name="cart"
          label={card.canAddToCart ? 'Add to cart' : 'Open to bid'}
          active={props.inCart}
          size={size}
          glyph={glyph}
          slop={slop}
          onPress={props.onCart}
          onLongPress={props.onCartLongPress}
        />

        {/* 3: reviews. Long-press jumps straight to critical reviews. */}
        <RailButton
          name="reviews"
          label="Reviews"
          size={size}
          glyph={glyph}
          slop={slop}
          onPress={props.onReviews}
          onLongPress={props.onReviewsLongPress}
        />

        {/* 4 (bottom): share. Long-press copies the link. */}
        <RailButton
          name="share"
          label="Share"
          size={size}
          glyph={glyph}
          slop={slop}
          onPress={props.onShare}
          onLongPress={props.onShareLongPress}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Spans the full height of the photograph, so `onLayout` measures the thing
  // the rail actually has to fit inside rather than the window around it.
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: SPACING.railRightInset - 6,
    // The stack's offset is computed, not centred: a percentage padding here
    // resolves against the rail's width rather than the photograph's height.
    justifyContent: 'flex-start',
  },
  stack: { alignItems: 'center' },
  button: { alignItems: 'center', justifyContent: 'center' },
});
