import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  COLORS,
  SPACING,
  TYPE,
  formatMoney,
  formatTimeRemaining,
  type ProductCard,
} from '@window/shared';

/**
 * The bottom metadata bar.
 *
 * Occupies the lower-left, mirroring where TikTok puts the caption. Three
 * lines, never more — the fourth line is always the one that starts the slide
 * back into a product detail page, which is the thing this feed exists not to be.
 *
 * Price is the only element allowed visual emphasis, because price is the only
 * thing a browsing user scans for.
 */

const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  like_new: 'Like new',
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  for_parts: 'For parts',
  unknown: 'Condition unknown',
};

const SOURCE_LABELS: Record<string, string> = {
  new: 'New',
  secondhand: 'Secondhand',
  auction: 'Auction',
};

export interface MetadataBarProps {
  card: ProductCard;
  /** Desktop renders the rail outside the column, so the bar can use full width. */
  fullWidth?: boolean;
}

export function MetadataBar({ card, fullWidth = false }: MetadataBarProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const badges = card.badges;

  const timeRemaining = badges.endsAt ? formatTimeRemaining(badges.endsAt) : null;
  const discounted =
    card.originalPrice !== null && card.originalPrice.amount > card.price.amount;

  return (
    <View
      style={[styles.container, fullWidth ? styles.fullWidth : styles.inset]}
      accessible
      accessibilityRole="summary"
      // Screen readers announce title, price, merchant and condition in that
      // order, which is the order a sighted user scans them in.
      accessibilityLabel={[
        card.title,
        formatMoney(card.price),
        card.merchant.displayName,
        badges.condition ? CONDITION_LABELS[badges.condition] : SOURCE_LABELS[badges.source],
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {/* Line 1: merchant, source badge, condition or time remaining. */}
      <View style={styles.line}>
        <Text style={styles.merchant} numberOfLines={1}>
          {card.merchant.displayName}
        </Text>
        <Text style={styles.separator}>·</Text>
        <Text style={styles.badge}>{SOURCE_LABELS[badges.source] ?? badges.source}</Text>
        {badges.condition ? (
          <>
            <Text style={styles.separator}>·</Text>
            <Text style={styles.badge}>{CONDITION_LABELS[badges.condition]}</Text>
          </>
        ) : null}
        {timeRemaining ? (
          <>
            <Text style={styles.separator}>·</Text>
            <Text style={styles.badge}>Ends in {timeRemaining}</Text>
          </>
        ) : null}
        {badges.onlyOne ? (
          <>
            <Text style={styles.separator}>·</Text>
            <Text style={styles.badge}>Only one</Text>
          </>
        ) : null}
      </View>

      {/* Line 2: the title, which opens the listing it came from.
          Expanding the truncation moves to a long press so the tap can carry
          the link; a card with no source url keeps the old tap-to-expand. */}
      <Pressable
        onPress={() => {
          if (card.sourceUrl) void Linking.openURL(card.sourceUrl);
          else setExpanded((value) => !value);
        }}
        onLongPress={() => setExpanded((value) => !value)}
        accessibilityRole={card.sourceUrl ? 'link' : 'button'}
        accessibilityLabel={
          card.sourceUrl
            ? `${card.title}. Opens the listing on ${card.merchant.displayName}.`
            : expanded ? 'Collapse title' : 'Expand title'
        }
        accessibilityHint={card.sourceUrl ? 'Long press to expand the full title' : undefined}
      >
        <Text
          style={[styles.title, card.sourceUrl ? styles.titleLink : null]}
          numberOfLines={expanded ? undefined : 2}
        >
          {card.title}
        </Text>
      </Pressable>

      {/* Line 3: price. Auctions show the current bid and bid count instead. */}
      <View style={styles.line}>
        {card.auction ? (
          <>
            <Text style={styles.price}>
              {formatMoney({ amount: card.auction.currentBid, currency: card.price.currency })}
            </Text>
            <Text style={styles.secondary}>
              {card.auction.bidCount} {card.auction.bidCount === 1 ? 'bid' : 'bids'}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.price}>{formatMoney(card.price)}</Text>
            {discounted && card.originalPrice ? (
              <Text style={styles.struck}>{formatMoney(card.originalPrice)}</Text>
            ) : null}
            {!card.shipping.free ? (
              <Text style={styles.secondary}>
                + {formatMoney({ amount: card.shipping.amount, currency: card.shipping.currency })}{' '}
                shipping
              </Text>
            ) : null}
          </>
        )}
      </View>

      {/* Trust signals that carry a warning are never folded into the badge row:
          a caution the eye can skip is a caution that failed. */}
      {badges.riskFlag ? <Text style={styles.warning}>{badges.riskFlag}</Text> : null}
      {!badges.riskFlag && badges.caution ? (
        <Text style={styles.caution}>{badges.caution}</Text>
      ) : null}
      {badges.priceContext && !badges.riskFlag ? (
        <Text style={styles.secondary}>
          {badges.priceContext === 'below' ? 'Below' : 'Above'} the typical price for this item
        </Text>
      ) : null}
      {card.otherOffers ? (
        <Text style={styles.secondary}>
          {card.otherOffers.count} other {card.otherOffers.count === 1 ? 'seller' : 'sellers'}, from{' '}
          {formatMoney({
            amount: card.otherOffers.fromAmount,
            currency: card.otherOffers.currency,
          })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: SPACING.screenMargin,
    bottom: SPACING.screenMargin,
    gap: 4,
  },
  // The rail occupies the right 20%; the bar stops short of it.
  inset: { right: '22%' },
  fullWidth: { right: SPACING.screenMargin },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 6,
  },
  merchant: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  badge: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  separator: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
  },
  // The only cue that the title leaves the app. Underline rather than a colour
  // shift, which would not survive being drawn over arbitrary photography.
  titleLink: {
    textDecorationLine: 'underline',
  },
  price: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.semibold,
  },
  struck: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    textDecorationLine: 'line-through',
  },
  secondary: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  // The accent is load-bearing here: it is the one colour in the frame, and a
  // warning is one of the three things allowed to use it.
  warning: {
    color: COLORS.accent,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  caution: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
});
