import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { ClipPath, Defs, Path, Rect } from 'react-native-svg';
import { COLORS, TYPE } from '@window/shared';
import { Icon } from './Icon.js';

/**
 * A rating readout: the mean, and five stars.
 *
 * The count used to sit on the end, coloured as a link, on the argument that
 * "13.2K" is the number that makes a reader want to go and read them. That is
 * true where the row opens the reviews, and this row does not — the only
 * caller draws it inside a tile whose tap opens the pane view. So it was a
 * link-coloured number that led nowhere, repeated across every tile on the
 * screen, competing with the price for the one line under the title. The
 * count is still on the reviews control in the pane, and in the sheet itself.
 *
 * The mean is drawn to a fifth of a star rather than rounded to a whole one. A
 * 4.5 shown as five filled stars is a small lie told thousands of times a day,
 * and this product's entire argument is that it does not do that with reviews.
 */

const STAR_PATH =
  'M12 3.2l2.7 5.6 6 .85-4.35 4.3 1.05 6.05L12 17.14 6.6 20l1.05-6.05L3.3 9.65l6-.85L12 3.2Z';

const SLOTS = [0, 1, 2, 3, 4];

export interface RatingProps {
  /** Mean rating out of five, or null when the corpus has none. */
  rating: number | null;
  /**
   * How many reviews there are. Not drawn — it decides whether this row is
   * drawn at all, since no rating and no reviews is an unrated product rather
   * than a zero-star one.
   */
  count: number;
  size?: number;
  /** Dark backgrounds need the light text ramp. */
  onDark?: boolean;
  /** The chevron is only honest where the row actually opens the reviews. */
  interactive?: boolean;
}

export function Rating({
  rating,
  count,
  size = 15,
  onDark = false,
  interactive = true,
}: RatingProps): React.ReactElement | null {
  // No rating and no reviews is not a zero-star product, it is an unrated one.
  // Drawing five empty stars for it would be the same lie in the other
  // direction, so the row is omitted entirely.
  if (rating === null && count === 0) return null;

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole={interactive ? 'button' : 'text'}
      // Says what is drawn and no more. A name that announces a count the
      // screen does not show sends a reader looking for something that is not
      // there.
      accessibilityLabel={
        rating === null ? `${count.toLocaleString()} reviews` : `${rating.toFixed(1)} out of 5 stars`
      }
    >
      {rating !== null ? (
        <>
          <Text style={[styles.mean, onDark ? styles.onDark : null, { fontSize: size - 1 }]}>
            {rating.toFixed(1)}
          </Text>
          <Stars rating={rating} size={size} />
        </>
      ) : null}

      {interactive ? (
        <Icon
          name="chevronDown"
          size={size - 2}
          color={onDark ? COLORS.textSecondary : COLORS.textSecondaryLight}
        />
      ) : null}
    </View>
  );
}

/** Five stars, the last partly filled. Used on its own by the reviews sheet. */
export function Stars({ rating, size = 15 }: { rating: number; size?: number }): React.ReactElement {
  return (
    <View style={styles.stars} accessible accessibilityLabel={`${rating.toFixed(1)} out of 5 stars`}>
      {SLOTS.map((slot) => (
        <Star key={slot} fraction={Math.max(0, Math.min(1, rating - slot))} size={size} />
      ))}
    </View>
  );
}

/** One star, filled left-to-right by `fraction`, so 4.5 draws a real half. */
function Star({ fraction, size }: { fraction: number; size: number }): React.ReactElement {
  const clipId = `star-clip-${Math.round(fraction * 100)}-${size}`;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={STAR_PATH} fill={COLORS.hairlineLight} />
      {fraction > 0 ? (
        <>
          <Defs>
            <ClipPath id={clipId}>
              <Rect x={0} y={0} width={24 * fraction} height={24} />
            </ClipPath>
          </Defs>
          <Path d={STAR_PATH} fill={COLORS.star} clipPath={`url(#${clipId})`} />
        </>
      ) : null}
    </Svg>
  );
}

/** 13200 becomes "13.2K". A count is scanned, not read. */
export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  stars: { flexDirection: 'row' },
  mean: { color: COLORS.textPrimaryLight, fontWeight: TYPE.weights.semibold, marginRight: 2 },
  onDark: { color: COLORS.textPrimary },
});
