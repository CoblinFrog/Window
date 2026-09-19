import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  COLORS,
  ONBOARDING_TOPIC_COUNT,
  RADIUS,
  SPACING,
  TYPE,
  type PriceBand,
} from '@window/shared';
import { api } from '../src/api/client.js';
import { useLayout } from '../src/hooks/useLayout.js';
import { useSession } from '../src/store/session.js';

/**
 * Onboarding.
 *
 * Three taps and under twenty seconds. Anything longer trades away the users
 * who came to browse, not to configure — which is most of them.
 *
 * The continue button activates at exactly three selections and hard-caps
 * there. Forcing exactly three, rather than "three or more", keeps the seed
 * vector sharp: the average of seven centroids is close to the catalog mean,
 * which is the one thing a cold-start vector must not be.
 */

const PRICE_BANDS: Array<{ id: PriceBand | null; label: string }> = [
  { id: 'budget', label: 'Budget' },
  { id: 'mid', label: 'Mid' },
  { id: 'premium', label: 'Premium' },
  { id: null, label: 'Skip' },
];

export default function OnboardingScreen(): React.ReactElement {
  const router = useRouter();
  const layout = useLayout();
  const session = useSession();

  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topics = useQuery({
    queryKey: ['onboarding-topics'],
    queryFn: () => api.onboardingTopics(),
    enabled: session.status === 'ready',
  });

  const ready = selected.length === ONBOARDING_TOPIC_COUNT;

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      if (previous.includes(id)) return previous.filter((value) => value !== id);
      // The hard cap is enforced here rather than by disabling tiles: a grid of
      // dead tiles reads as broken, while a cap that simply refuses reads as a
      // rule.
      if (previous.length >= ONBOARDING_TOPIC_COUNT) return previous;
      return [...previous, id];
    });
  }, []);

  const finish = useCallback(
    async (priceBand: PriceBand | null) => {
      if (!ready || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.completeOnboarding({ topics: selected, priceBand });
        session.markOnboarded();
        await session.refreshSession();
        router.replace('/');
      } catch (cause) {
        setError((cause as Error).message);
        setSubmitting(false);
      }
    },
    [ready, router, selected, session, submitting],
  );

  // Three columns on a phone, six on a wide screen: an 18-tile grid should read
  // as one glanceable set rather than a scrollable list.
  const columns = layout.breakpoint === 'phone' ? 3 : 6;
  const gridWidth = layout.centred ? Math.min(760, layout.columnWidth * 1.8) : layout.columnWidth;
  const tileSize = useMemo(
    () => (gridWidth - SPACING.screenMargin * 2 - SPACING.gutter * (columns - 1)) / columns,
    [columns, gridWidth],
  );

  return (
    <View style={styles.root}>
      <View style={[styles.frame, { width: gridWidth }]}>
        <Text style={styles.title}>Pick three things you like</Text>

        {topics.isLoading ? (
          <ActivityIndicator color={COLORS.textSecondary} style={styles.loader} />
        ) : null}

        {topics.isError ? (
          <Pressable onPress={() => void topics.refetch()} accessibilityRole="button">
            <Text style={styles.action}>Could not load topics. Try again.</Text>
          </Pressable>
        ) : null}

        <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
          {(topics.data?.topics ?? []).map((topic) => {
            const isSelected = selected.includes(topic.id);
            const order = selected.indexOf(topic.id) + 1;
            return (
              <Pressable
                key={topic.id}
                onPress={() => toggle(topic.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={topic.displayName}
                style={[
                  styles.tile,
                  { width: tileSize, height: tileSize },
                  isSelected ? styles.tileSelected : null,
                ]}
              >
                <Image
                  source={{ uri: topic.image }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={0}
                  cachePolicy="memory-disk"
                />
                <View style={styles.tileScrim} pointerEvents="none" />
                <Text style={styles.tileLabel} numberOfLines={2}>
                  {topic.displayName}
                </Text>
                {/* Selection is shown by an ordinal, not only by the accent
                    border: nothing here communicates through colour alone. */}
                {isSelected ? (
                  <View style={styles.tileBadge}>
                    <Text style={styles.tileBadgeText}>{order}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.footer}>
          <Text style={styles.counter}>
            {selected.length} of {ONBOARDING_TOPIC_COUNT}
          </Text>

          {/* One tap: budget, mid, premium, or skip. A soft price prior, not a
              filter, and skipping is a real answer rather than an escape. */}
          <View style={styles.bands}>
            {PRICE_BANDS.map((band) => (
              <Pressable
                key={band.label}
                disabled={!ready || submitting}
                onPress={() => void finish(band.id)}
                accessibilityRole="button"
                accessibilityLabel={
                  band.id ? `Continue with a ${band.label} budget` : 'Continue without a budget'
                }
                accessibilityState={{ disabled: !ready || submitting }}
                style={[styles.band, !ready || submitting ? styles.bandDisabled : null]}
              >
                <Text style={[styles.bandText, ready ? styles.bandTextReady : null]}>
                  {band.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { flex: 1, paddingTop: 64, paddingBottom: 24 },
  title: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.semibold,
    paddingHorizontal: SPACING.screenMargin,
    marginBottom: 16,
  },
  loader: { marginVertical: 24 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.gutter,
    paddingHorizontal: SPACING.screenMargin,
    paddingBottom: 16,
  },
  tile: {
    backgroundColor: '#0B0B0B',
    borderRadius: RADIUS.tile,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  tileSelected: { borderWidth: 2, borderColor: COLORS.accent },
  tileScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  tileLabel: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    padding: 8,
  },
  tileBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBadgeText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    fontWeight: TYPE.weights.semibold,
  },
  footer: { paddingHorizontal: SPACING.screenMargin, gap: 12 },
  counter: { color: COLORS.textSecondary, fontSize: TYPE.sizes.small },
  bands: { flexDirection: 'row', gap: 8 },
  band: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  bandDisabled: { opacity: 0.4 },
  bandText: { color: COLORS.textSecondary, fontSize: TYPE.sizes.body },
  bandTextReady: { color: COLORS.textPrimary },
  error: { color: COLORS.accent, fontSize: TYPE.sizes.small },
  action: { color: COLORS.accent, fontSize: TYPE.sizes.body, paddingHorizontal: SPACING.screenMargin },
});
