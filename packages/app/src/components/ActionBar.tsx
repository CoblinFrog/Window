import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS, ICON, TYPE, type ProductCard } from '@window/shared';
import { Icon, type IconName } from './Icon.js';
import { PressScale } from './PressScale.js';
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
  /**
   * The link for this product is on the clipboard. Said under the control that
   * did it rather than in a toast: a copy is invisible, so the only place the
   * confirmation means anything is where you just pressed.
   */
  shareCopied?: boolean;
  /**
   * Asks whether a press arriving right now is a drag's ghost. The bar rides
   * at the foot of a pane that scrolls, and on the web a drag that starts and
   * ends on the same element still emits a click — so a scroll begun on this
   * row added to a cart. Long presses are exempt: no drag produces one.
   */
  suppressTap?: (() => boolean) | undefined;
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
  suppressTap?: (() => boolean) | undefined;
}

function BarButton({
  name,
  label,
  active = false,
  caption,
  onPress,
  onLongPress,
  suppressTap,
}: BarButtonProps): React.ReactElement {
  return (
    <PressScale
      onPress={() => {
        if (suppressTap?.()) return;
        tick();
        onPress();
      }}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={caption ? `${label}, ${caption}` : label}
      accessibilityState={{ selected: active }}
      style={styles.button}
      contentStyle={styles.buttonContent}
      hitSlop={6}
    >
      <Icon name={name} active={active} size={26} />
      {/* Off the photograph there is finally room for the counts, and they are
          the two numbers that say whether anyone else agreed.

          The slot is always here, even on the two controls that have nothing to
          put in it. A column that renders no caption is shorter than one that
          does, and four columns of two different heights centred in a row put
          their glyphs on two different baselines — which is the misalignment,
          not the caption itself. Reserving the line costs 17 px of a bar that
          already refuses to shrink. */}
      <Text style={styles.caption} numberOfLines={1}>
        {caption ?? ''}
      </Text>
    </PressScale>
  );
}

export function ActionBar(props: ActionBarProps): React.ReactElement {
  const { card, suppressTap } = props;
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
        suppressTap={suppressTap}
      />

      {/* Auction items cannot be added to a cart; they deep-link to the bid
          book, so they keep the plain cart — a plus would promise something
          that control does not do. */}
      <BarButton
        name={card.canAddToCart ? 'cartAdd' : 'cart'}
        label={card.canAddToCart ? 'Add to cart' : 'Open to bid'}
        active={props.inCart}
        onPress={props.onCart}
        onLongPress={props.onCartLongPress}
        suppressTap={suppressTap}
      />

      {/* Long-press jumps straight to the critical reviews. */}
      <BarButton
        name="reviews"
        label="Reviews"
        caption={card.reviews.count > 0 ? compact(card.reviews.count) : undefined}
        onPress={props.onReviews}
        onLongPress={props.onReviewsLongPress}
        suppressTap={suppressTap}
      />

      <BarButton
        name="share"
        // The label stays "Share" — the caption below becomes the confirmation,
        // and the accessible name is built from both, so putting it in both
        // read out as "Link copied, Link copied".
        label="Share"
        // The caption slot is already reserved on every control, so the
        // confirmation costs no layout — nothing below it moves when the text
        // appears and nothing moves back when it goes.
        caption={props.shareCopied ? 'Link copied' : undefined}
        onPress={props.onShare}
        onLongPress={props.onShareLongPress}
        suppressTap={suppressTap}
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
    backgroundColor: COLORS.surface,
  },
  buttonContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  button: {
    // Four equal columns rather than four intrinsic widths spaced apart. Under
    // `space-around` a control is as wide as its widest child, so a product
    // with 12.4K reviews made the reviews column wider than the others and
    // pushed every glyph off the quarter-points it should sit on — the count
    // moved the icon. Equal flex means the text can grow to the column and
    // stop, and where the glyphs sit stops depending on the numbers.
    flex: 1,
    minHeight: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    gap: 2,
  },
  caption: {
    height: TYPE.lineHeights.small,
    // Counts are two or three characters; "Link copied" is eleven, and a
    // quarter of a narrow screen is not much. Smaller, and allowed to use the
    // whole column rather than just the glyph's width.
    maxWidth: '100%',
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    textAlign: 'center',
  },
});
