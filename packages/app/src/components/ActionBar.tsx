import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, ICON, TYPE, type ProductCard } from '@window/shared';
import { Icon, type IconName } from './Icon.js';
import { compact } from './Rating.js';

/**
 * The action bar: upvote, cart, reviews, share.
 *
 * A row across the foot of the pane rather than a rail down the side of the
 * photograph. Two things come of moving it off the image.
 *
 * The first is that the controls stop competing with the product. A rail laid
 * over a photograph has to be legible against whatever that photograph happens
 * to be, which is why it needed a gradient behind it and why it crossed the
 * subject on any shot composed to the right.
 *
 * The second is that the room is guaranteed rather than negotiated. The bar has
 * a fixed height and refuses to shrink, so the photograph above gives way first
 * on a short screen; the old rail measured the frame it sat in and shrank its
 * own targets to fit, which on a squeezed viewport meant controls smaller than
 * anyone should have to hit.
 *
 * Every control is simultaneously a UI action and a ranking signal, which is
 * why each takes both an `onPress` and an `onLongPress` — the long-press is
 * never decoration, it is always a more specific version of the same intent.
 *
 * The seller is not here: it lives on the merchant line above, where the
 * seller's name already is.
 */

/** Fixed, and never shrunk. The photograph gives way before the controls do. */
export const ACTION_BAR_HEIGHT = 64;

export interface ActionBarProps {
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

interface BarButtonProps {
  name: IconName;
  label: string;
  active?: boolean;
  /** The count under the glyph, where there is one worth reading. */
  caption?: string | undefined;
  onPress(): void;
  onLongPress(): void;
}

function BarButton({
  name,
  label,
  active = false,
  caption,
  onPress,
  onLongPress,
}: BarButtonProps): React.ReactElement {
  return (
    <Pressable
      onPress={() => {
        tick();
        onPress();
      }}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={caption ? `${label}, ${caption}` : label}
      accessibilityState={{ selected: active }}
      style={styles.button}
      hitSlop={6}
    >
      <Icon name={name} active={active} size={26} />
      {/* Off the photograph there is finally room for the counts, and they are
          the two numbers that say whether anyone else agreed. */}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </Pressable>
  );
}

export function ActionBar(props: ActionBarProps): React.ReactElement {
  const { card } = props;
  const upvotes = card.upvotes + (props.upvoted ? 1 : 0);

  return (
    <View style={styles.bar}>
      <BarButton
        name="upvote"
        label="Upvote"
        active={props.upvoted}
        caption={upvotes > 0 ? compact(upvotes) : undefined}
        onPress={props.onUpvote}
        onLongPress={props.onUpvoteLongPress}
      />

      {/* Auction items cannot be added to a cart; they deep-link to the bid book. */}
      <BarButton
        name="cart"
        label={card.canAddToCart ? 'Add to cart' : 'Open to bid'}
        active={props.inCart}
        onPress={props.onCart}
        onLongPress={props.onCartLongPress}
      />

      {/* Long-press jumps straight to the critical reviews. */}
      <BarButton
        name="reviews"
        label="Reviews"
        caption={card.reviews.count > 0 ? compact(card.reviews.count) : undefined}
        onPress={props.onReviews}
        onLongPress={props.onReviewsLongPress}
      />

      <BarButton
        name="share"
        label="Share"
        onPress={props.onShare}
        onLongPress={props.onShareLongPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: ACTION_BAR_HEIGHT,
    // Never gives up its height to the photograph above.
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: COLORS.surface,
  },
  button: {
    minWidth: ICON.target,
    minHeight: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  caption: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
});
