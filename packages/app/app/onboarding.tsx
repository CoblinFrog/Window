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
} from '@window/shared';
import { LinearGradient } from 'expo-linear-gradient';
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

/**
 * The gradient behind a tile's label.
 *
 * Reaches 0.72 alpha a quarter of the way down and finishes near opaque, which
 * is what it takes to clear 4.5:1 for white text over a white product cut-out.
 * It covers the bottom 70% because a two-line label in a ~113 px tile occupies
 * nearly half of it — a band sized for a full-screen pane simply misses.
 */
const TILE_SCRIM = {
  colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0.9)'] as const,
  locations: [0, 0.25, 1] as const,
  heightFraction: 0.7,
} as const;

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
    async () => {
      if (!ready || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        // `priceBand` stays in the request and stays null. The server seeds a
        // price prior from it and already treats null as "no opinion", so
        // dropping the question costs nothing and keeps the field there for
        // whatever replaces it.
        await api.completeOnboarding({ topics: selected, priceBand: null });
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
                {/* Catalog photographs are mostly cut-outs on white, so the
                    label's background is the worst case for white text: a flat
                    35% wash over white leaves 1.6:1, and the pane's own scrim,
                    tuned for a full screen carrying a row of ticks, only
                    reaches about 0.2 alpha where a tile's label starts.
                    Contrast needs 0.54 alpha over white for 4.5:1, so this
                    ramps hard and early and holds ~0.8 across the whole label
                    rather than easing gently to the floor. */}
                <LinearGradient
                    colors={TILE_SCRIM.colors as unknown as [string, string, string]}
                    locations={TILE_SCRIM.locations as unknown as [number, number, number]}
                    style={styles.tileScrim}
                    pointerEvents="none"
                />
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

          {/* The band row used to live here and double as the submit control:
              picking a budget was how you finished. With the question gone the
              screen needs a button of its own, and it says what is missing
              rather than sitting there greyed out with no explanation. */}
          <Pressable
            disabled={!ready || submitting}
            onPress={() => void finish()}
            accessibilityRole="button"
            accessibilityLabel={
              ready
                ? 'Continue'
                : `Pick ${ONBOARDING_TOPIC_COUNT - selected.length} more to continue`
            }
            accessibilityState={{ disabled: !ready || submitting }}
            style={[styles.continue, ready && !submitting ? styles.continueReady : null]}
          >
            <Text style={[styles.continueText, ready ? styles.continueTextReady : null]}>
              {submitting
                ? 'One moment'
                : ready
                  ? 'Continue'
                  : `Pick ${ONBOARDING_TOPIC_COUNT - selected.length} more`}
            </Text>
          </Pressable>

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
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: `${TILE_SCRIM.heightFraction * 100}%`,
  },
  tileLabel: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
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
  continue: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.tile,
    borderWidth: 1,
    borderColor: COLORS.hairline,
  },
  continueReady: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  continueText: { color: COLORS.textSecondary, fontSize: TYPE.sizes.body },
  continueTextReady: {
    color: COLORS.textPrimary,
    fontWeight: TYPE.weights.semibold,
  },
  error: { color: COLORS.accent, fontSize: TYPE.sizes.small },
  action: { color: COLORS.accent, fontSize: TYPE.sizes.body, paddingHorizontal: SPACING.screenMargin },
});
