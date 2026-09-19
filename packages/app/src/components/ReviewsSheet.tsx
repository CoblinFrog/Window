import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import * as Linking from 'expo-linking';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Svg, { Path } from 'react-native-svg';
import {
  COLORS,
  DWELL_THRESHOLDS,
  ICON,
  SHEET,
  SPACING,
  TYPE,
  type ClusterResponse,
  type FeedMode,
  type ReviewBucket,
  type ReviewItem,
  type ReviewTheme,
  type UpvoteReason,
} from '@window/shared';
import { api } from '../api/client.js';
import { emit } from '../store/events.js';
import { Icon } from './Icon.js';
import { Sheet } from './Sheet.js';

/**
 * The reviews sheet.
 *
 * The comments button opens this instead of a comment thread, so everything
 * here is borrowed: every review carries its source domain and a link to the
 * original, and the only synthesized string in the sheet — the one-sentence
 * verdict — is labelled as model-generated wherever it appears. Presenting
 * either as native to Window would be a trust failure, not a copy nit, which is
 * why the attribution is structural rather than a caption we could drop.
 *
 * Window's own upvotes sit in their own block at the bottom for the same
 * reason: they are a ranking signal, not an opinion anyone wrote down.
 */

const BUCKETS: ReadonlyArray<{ value: ReviewBucket; label: string }> = [
  { value: 'recent', label: 'Recent' },
  { value: 'helpful', label: 'Helpful' },
  { value: 'critical', label: 'Critical' },
  { value: 'positive', label: 'Positive' },
];

const SORTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'recent', label: 'Newest' },
  { value: 'rating_desc', label: 'Highest rated' },
  { value: 'rating_asc', label: 'Lowest rated' },
];

const REASON_LABELS: Record<UpvoteReason, string> = {
  price: 'Price',
  design: 'Design',
  brand: 'Brand',
  need_it: 'Need it',
};

const MAX_THEMES = 5;

export interface ReviewsSheetProps {
  clusterId: string;
  /** The card the sheet was opened from; every ranking signal is keyed to it. */
  productId: string;
  visible: boolean;
  onClose: () => void;
  position?: number;
  mode?: FeedMode;
  reducedMotion?: boolean;
  /** The rail's long-press lands the user straight in the critical bucket. */
  jumpToCritical?: boolean;
}

export function ReviewsSheet({
  clusterId,
  productId,
  visible,
  onClose,
  position = 0,
  mode = 'single',
  reducedMotion = false,
  jumpToCritical = false,
}: ReviewsSheetProps): React.ReactElement {
  const [bucket, setBucket] = useState<ReviewBucket>(jumpToCritical ? 'critical' : 'recent');
  const [sort, setSort] = useState<string>('recent');

  useEffect(() => {
    if (!visible) return;
    setBucket(jumpToCritical ? 'critical' : 'recent');
    setSort('recent');
  }, [visible, jumpToCritical]);

  const cluster = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.cluster(clusterId),
    enabled: visible,
  });

  const reviews = useInfiniteQuery({
    queryKey: ['reviews', clusterId, bucket, sort],
    enabled: visible,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.reviews(clusterId, { bucket, sort, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });

  // `reviews_open` is a strong signal and flushes immediately; the dwell is the
  // slower one that separates a glance from actually reading the corpus.
  useEffect(() => {
    if (!visible) return;
    emit('reviews_open', { productId, position, mode });
    const timer = setTimeout(() => {
      emit('reviews_dwell', {
        productId,
        position,
        mode,
        dwellMs: DWELL_THRESHOLDS.reviewsDwellMs,
      });
    }, DWELL_THRESHOLDS.reviewsDwellMs);
    return () => clearTimeout(timer);
  }, [visible, productId, position, mode]);

  const items = useMemo<ReviewItem[]>(
    () => reviews.data?.pages.flatMap((page) => page.items) ?? [],
    [reviews.data],
  );

  const onEndReached = useCallback(() => {
    if (reviews.hasNextPage && !reviews.isFetchingNextPage) void reviews.fetchNextPage();
  }, [reviews]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ReviewItem>) => <ReviewRow review={item} />,
    [],
  );

  const asOf = reviews.data?.pages[0]?.asOf ?? cluster.data?.reviews.asOf ?? null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Reviews"
      heightFraction={SHEET.reviewsHeightFraction}
      loading={cluster.isPending || reviews.isPending}
      reducedMotion={reducedMotion}
    >
      <FlatList
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={
          <Header
            cluster={cluster.data ?? null}
            asOf={asOf}
            bucket={bucket}
            sort={sort}
            onBucket={setBucket}
            onSort={setSort}
          />
        }
        ListFooterComponent={<WindowUpvotes cluster={cluster.data ?? null} />}
      />
    </Sheet>
  );
}

function keyExtractor(review: ReviewItem): string {
  return review.id;
}

function Separator(): React.ReactElement {
  return <View style={styles.separator} />;
}

// ---------------------------------------------------------------------------
// a. Verdict strip, b. sentiment bars, and the filters
// ---------------------------------------------------------------------------

interface HeaderProps {
  cluster: ClusterResponse | null;
  asOf: string | null;
  bucket: ReviewBucket;
  sort: string;
  onBucket: (bucket: ReviewBucket) => void;
  onSort: (sort: string) => void;
}

function Header({
  cluster,
  asOf,
  bucket,
  sort,
  onBucket,
  onSort,
}: HeaderProps): React.ReactElement {
  const summary = cluster?.reviews.summary ?? null;
  const mean = cluster?.reviews.meanRating ?? null;
  const total = cluster?.reviews.count ?? 0;
  const perSource = cluster?.reviews.perSource ?? [];
  const themes = (cluster?.reviews.themes ?? []).slice(0, MAX_THEMES);
  const asOfLabel = formatDay(asOf);

  return (
    <View>
      <View style={styles.verdict}>
        {mean !== null ? (
          <View style={styles.verdictRow}>
            <Stars rating={mean} />
            <Text style={styles.verdictScore}>{mean.toFixed(1)}</Text>
          </View>
        ) : null}

        {total > 0 ? (
          <Text style={styles.verdictCount}>
            {`${total.toLocaleString()} ${total === 1 ? 'review' : 'reviews'}`}
            {perSource.length > 0
              ? ` across ${perSource.length} ${perSource.length === 1 ? 'source' : 'sources'}`
              : ''}
          </Text>
        ) : null}

        {/* The per-source breakdown stays visible: a combined rating hides which
            corpus it came from, and that is exactly what a reader needs. */}
        {perSource.length > 0 ? (
          <View style={styles.sourceList}>
            {perSource.map((source) => (
              <Text key={source.domain} style={styles.sourceEntry}>
                {`${source.domain} ${source.meanRating.toFixed(1)} (${source.count.toLocaleString()})`}
              </Text>
            ))}
          </View>
        ) : null}

        {summary ? (
          <View style={styles.summary}>
            <Text style={styles.summaryLabel}>Model-generated summary</Text>
            <Text style={styles.summaryText}>{summary.text}</Text>
            <Text style={styles.summaryMeta}>
              {`Written by a model, not a reviewer${
                formatDay(summary.generatedAt) ? ` · ${formatDay(summary.generatedAt)}` : ''
              }`}
            </Text>
          </View>
        ) : null}

        {asOfLabel ? <Text style={styles.asOf}>{`Reviews as of ${asOfLabel}`}</Text> : null}
      </View>

      {themes.length > 0 ? (
        <View style={styles.themes}>
          <Text style={styles.sectionLabel} accessibilityRole="header">
            What reviewers mention
          </Text>
          {themes.map((theme) => (
            <ThemeBar key={theme.name} theme={theme} />
          ))}
        </View>
      ) : null}

      <View style={styles.filters}>
        <ChipRow label="Show">
          {BUCKETS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.label}
              selected={entry.value === bucket}
              onPress={() => onBucket(entry.value)}
            />
          ))}
        </ChipRow>
        <ChipRow label="Sort">
          {SORTS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.label}
              selected={entry.value === sort}
              onPress={() => onSort(entry.value)}
            />
          ))}
        </ChipRow>
      </View>
    </View>
  );
}

function ThemeBar({ theme }: { theme: ReviewTheme }): React.ReactElement {
  const total = theme.positive + theme.negative;
  const positivePct = total > 0 ? Math.round((theme.positive / total) * 100) : 0;
  const negativePct = 100 - positivePct;
  const mentions = `${theme.mentions.toLocaleString()} ${
    theme.mentions === 1 ? 'mention' : 'mentions'
  }`;
  const readout = `${positivePct}% positive · ${negativePct}% negative · ${mentions}`;

  return (
    <View style={styles.theme} accessible accessibilityLabel={`${theme.name}. ${readout}`}>
      <Text style={styles.themeName}>{theme.name}</Text>
      {/* The split is stated in words as well as drawn, because a bar that only
          differs by fill is a colour-alone signal. */}
      <View style={styles.bar}>
        <View style={[styles.barPositive, { flexGrow: positivePct }]} />
        <View style={[styles.barNegative, { flexGrow: negativePct }]} />
      </View>
      <Text style={styles.themeMeta}>{readout}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// c. The review list
// ---------------------------------------------------------------------------

const ReviewRow = React.memo(function ReviewRow({
  review,
}: {
  review: ReviewItem;
}): React.ReactElement {
  const openOriginal = useCallback(() => {
    void Linking.openURL(review.source.url);
  }, [review.source.url]);

  const outOfFive = toFiveScale(review.rating, review.ratingScale);
  const day = formatDay(review.postedAt);

  return (
    <View style={styles.review}>
      <View style={styles.reviewTop}>
        <Stars rating={outOfFive} />
        <Text style={styles.reviewScore}>{outOfFive.toFixed(1)}</Text>
        {day ? <Text style={styles.reviewDate}>{day}</Text> : null}
      </View>

      <Text style={styles.reviewExcerpt}>{review.excerpt}</Text>

      <View style={styles.reviewMeta}>
        <Text style={styles.domainBadge}>{review.source.domain}</Text>
        {review.verifiedPurchase === true ? (
          <Text style={styles.metaText}>Verified purchase</Text>
        ) : null}
        {review.authorHandle ? (
          <Text style={styles.metaText}>{review.authorHandle}</Text>
        ) : null}
      </View>

      <Pressable
        onPress={openOriginal}
        style={styles.linkOut}
        accessibilityRole="link"
        accessibilityLabel={`Read the full review on ${review.source.domain}`}
        focusable
      >
        <Icon name="link" size={16} color={COLORS.textSecondary} />
        <Text style={styles.linkOutText}>{`Read on ${review.source.domain}`}</Text>
      </Pressable>
    </View>
  );
});

// ---------------------------------------------------------------------------
// d. Window upvotes — deliberately not a review
// ---------------------------------------------------------------------------

function WindowUpvotes({ cluster }: { cluster: ClusterResponse | null }): React.ReactElement | null {
  if (!cluster) return null;
  const { count, reasons } = cluster.windowUpvotes;

  return (
    <View style={styles.upvotes}>
      <Text style={styles.upvotesKicker} accessibilityRole="header">
        Window upvotes — not reviews
      </Text>
      <Text style={styles.upvotesCount}>
        {`${count.toLocaleString()} ${count === 1 ? 'person' : 'people'} upvoted this on Window`}
      </Text>
      {reasons.length > 0 ? (
        <View style={styles.reasonRow}>
          {reasons.map((entry) => (
            <Text key={entry.reason} style={styles.reasonTag}>
              {`${REASON_LABELS[entry.reason]} ${entry.count.toLocaleString()}`}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.upvotesNote}>
        An upvote is a one-tap ranking signal. Nobody writes reviews inside Window.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STAR_PATH = 'M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9Z';
const STAR_COUNT = 5;
const STAR_SLOTS = [0, 1, 2, 3, 4];

function Stars({ rating, size = 13 }: { rating: number; size?: number }): React.ReactElement {
  const filled = Math.round(rating);
  return (
    <View
      style={styles.starRow}
      accessible
      accessibilityLabel={`${rating.toFixed(1)} out of ${STAR_COUNT} stars`}
    >
      {STAR_SLOTS.map((slot) => (
        <Svg key={slot} width={size} height={size} viewBox="0 0 24 24">
          <Path
            d={STAR_PATH}
            fill={slot < filled ? COLORS.textPrimary : 'none'}
            stroke={COLORS.textSecondary}
            strokeWidth={ICON.strokeWidth}
            strokeLinejoin="round"
          />
        </Svg>
      ))}
    </View>
  );
}

function ChipRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.chipRow}>
      <Text style={styles.chipRowLabel}>{label}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={selected ? styles.chipSelected : styles.chip}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      focusable
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

/** Per-source ratings arrive on their own scale; the display is always out of 5. */
function toFiveScale(rating: number, scale: number): number {
  if (!scale || scale === STAR_COUNT) return rating;
  return (rating / scale) * STAR_COUNT;
}

function formatDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.hairline,
    marginHorizontal: SPACING.screenMargin,
  },

  verdict: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: SPACING.screenMargin,
  },
  verdictRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  verdictScore: {
    marginLeft: 8,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  verdictCount: {
    marginTop: 4,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  sourceList: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  sourceEntry: {
    marginRight: 12,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  summary: {
    marginTop: 14,
    paddingLeft: 10,
    borderLeftWidth: 1,
    borderLeftColor: COLORS.hairline,
  },
  summaryLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  summaryText: {
    marginTop: 4,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  summaryMeta: {
    marginTop: 4,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  asOf: {
    marginTop: 12,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  themes: {
    marginTop: 18,
    paddingHorizontal: SPACING.screenMargin,
  },
  sectionLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
    marginBottom: 8,
  },
  theme: {
    marginBottom: 12,
  },
  themeName: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  bar: {
    flexDirection: 'row',
    height: 4,
    marginTop: 5,
    backgroundColor: COLORS.hairline,
  },
  barPositive: {
    backgroundColor: COLORS.textPrimary,
  },
  barNegative: {
    backgroundColor: 'rgba(255,255,255,0.20)',
  },
  themeMeta: {
    marginTop: 5,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  filters: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 6,
    paddingBottom: 12,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  chipRowLabel: {
    width: 44,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  chips: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chip: {
    minHeight: ICON.minTarget,
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginRight: 6,
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  chipSelected: {
    minHeight: ICON.minTarget,
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginRight: 6,
    borderWidth: 1,
    borderColor: COLORS.textPrimary,
    backgroundColor: COLORS.textPrimary,
  },
  chipText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  chipTextSelected: {
    color: COLORS.surface,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },

  review: {
    paddingHorizontal: SPACING.screenMargin,
    paddingVertical: 14,
  },
  reviewTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewScore: {
    marginLeft: 8,
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  reviewDate: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  reviewExcerpt: {
    marginTop: 6,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  reviewMeta: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  domainBadge: {
    marginRight: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  metaText: {
    marginRight: 8,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  linkOut: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ICON.minTarget,
  },
  linkOutText: {
    marginLeft: 6,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  upvotes: {
    marginTop: 8,
    padding: SPACING.screenMargin,
    // Its own surface and a hard rule above it: this block must not be mistaken
    // for another review at a glance.
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  upvotesKicker: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  upvotesCount: {
    marginTop: 6,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  reasonRow: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  reasonTag: {
    marginRight: 6,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  upvotesNote: {
    marginTop: 8,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  starRow: {
    flexDirection: 'row',
  },
});
