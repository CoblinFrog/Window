import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Redirect, useRouter } from 'expo-router';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  COLORS,
  MOTION,
  PANE_SIZE,
  SPACING,
  TYPE,
  paneToRender,
  type ProductCard,
  type UpvoteReason,
} from '@window/shared';
import { ActionRail } from '../src/components/ActionRail.js';
import { CardMenu } from '../src/components/CardMenu.js';
import { Icon } from '../src/components/Icon.js';
import { ReasonPicker } from '../src/components/ReasonPicker.js';
import { ReviewsSheet } from '../src/components/ReviewsSheet.js';
import { SellerSheet } from '../src/components/SellerSheet.js';
import { SingleCard } from '../src/components/SingleCard.js';
import { WindowGrid } from '../src/components/WindowGrid.js';
import { useLayout, useReducedMotion } from '../src/hooks/useLayout.js';
import { useKeyboardControls, useSnappedWheel } from '../src/hooks/useKeyboard.js';
import { useCart } from '../src/store/cart.js';
import { emit, emitDwell } from '../src/store/events.js';
import { useFeed } from '../src/store/feed.js';
import { useSession } from '../src/store/session.js';

/**
 * The feed.
 *
 * One ranked list rendered through two layouts. A horizontal swipe switches
 * layout; it never fetches a different list. Everything on this screen exists
 * to keep that invariant true, because it is what makes tap-to-promote feel
 * instant rather than like a navigation.
 */
export default function FeedScreen(): React.ReactElement {
  const router = useRouter();
  const layout = useLayout();
  const reducedMotion = useReducedMotion();

  const session = useSession();
  const feed = useFeed();
  const cart = useCart();

  const [reviewsFor, setReviewsFor] = useState<{ card: ProductCard; critical: boolean } | null>(
    null,
  );
  const [sellerFor, setSellerFor] = useState<ProductCard | null>(null);
  const [menuFor, setMenuFor] = useState<ProductCard | null>(null);
  const [reasonFor, setReasonFor] = useState<ProductCard | null>(null);
  const [upvoted, setUpvoted] = useState<Set<string>>(new Set());
  const [showSwipeHint, setShowSwipeHint] = useState(true);

  const card = feed.buffer[feed.cursor] ?? null;
  const paneStartIndex = paneToRender(feed);
  const pane = useMemo(
    () => feed.buffer.slice(paneStartIndex, paneStartIndex + PANE_SIZE),
    [feed.buffer, paneStartIndex],
  );

  // ---- Dwell tracking ----------------------------------------------------
  // A card's dwell begins when it becomes current and is reported when it stops
  // being current. Anything shorter-lived than that is not a view.
  const dwellStart = useRef(Date.now());
  const dwellCard = useRef<ProductCard | null>(null);
  const dwellPosition = useRef(0);

  const flushDwell = useCallback(() => {
    const previous = dwellCard.current;
    if (!previous) return;
    emitDwell({
      productId: previous.productId,
      position: dwellPosition.current,
      mode: feed.mode,
      dwellMs: Date.now() - dwellStart.current,
      viewportFraction: 1,
      foreground: true,
      isExploration: previous.isExploration,
    });
  }, [feed.mode]);

  useEffect(() => {
    if (!card) return;
    if (dwellCard.current?.productId === card.productId) return;

    flushDwell();
    dwellCard.current = card;
    dwellPosition.current = feed.cursor;
    dwellStart.current = Date.now();

    emit('impression', {
      productId: card.productId,
      position: feed.cursor,
      mode: feed.mode,
      isExploration: card.isExploration,
    });
  }, [card, feed.cursor, feed.mode, flushDwell]);

  // ---- Prefetch ----------------------------------------------------------
  useEffect(() => {
    const dataSaver = session.session?.user.settings.dataSaver ?? false;
    const targets = feed.prefetchTargets(dataSaver);
    if (targets.length > 0) void Image.prefetch(targets);
  }, [feed.cursor, feed.mode, feed.buffer.length, session.session?.user.settings.dataSaver]);

  // Effects run even on the renders that bail out to a placeholder below, so
  // this has to wait for the session rather than relying on those guards. The
  // first fetch is gated on a completed boot because before one there is no
  // device token, and on onboarding because before that there is no user vector
  // to rank against.
  useEffect(() => {
    if (session.status !== 'ready' || !session.onboarded) return;
    void feed.ensureBuffer(feed.mode);
  }, [session.status, session.onboarded]);

  // ---- Actions -----------------------------------------------------------
  const toggleUpvote = useCallback(
    (target: ProductCard, reason?: UpvoteReason) => {
      setUpvoted((previous) => {
        const next = new Set(previous);
        if (next.has(target.productId)) {
          next.delete(target.productId);
          emit('upvote_removed', {
            productId: target.productId,
            position: feed.cursor,
            mode: feed.mode,
          });
        } else {
          next.add(target.productId);
          emit('upvote', {
            productId: target.productId,
            position: feed.cursor,
            mode: feed.mode,
            isExploration: target.isExploration,
            ...(reason ? { reason } : {}),
          });
        }
        return next;
      });
    },
    [feed.cursor, feed.mode],
  );

  const addToCart = useCallback(
    (target: ProductCard) => {
      // Adding to cart never navigates away. An auction card has no bag button
      // at all; it deep-links out to the source bid book instead.
      if (!target.canAddToCart) {
        void Linking.openURL(`https://${target.merchant.domain}`);
        return;
      }
      void cart.add(target.productId);
      emit('cart_add', {
        productId: target.productId,
        position: feed.cursor,
        mode: feed.mode,
        isExploration: target.isExploration,
      });
    },
    [cart, feed.cursor, feed.mode],
  );

  const share = useCallback(
    (target: ProductCard) => {
      const url = `https://window.app/p/${target.clusterId ?? target.productId}`;
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        void navigator.share({ title: target.title, url }).catch(() => undefined);
      } else {
        void Linking.openURL(url).catch(() => undefined);
      }
      emit('share', { productId: target.productId, position: feed.cursor, mode: feed.mode });
    },
    [feed.cursor, feed.mode],
  );

  // The sheets emit `reviews_open` and `seller_open` themselves, so opening one
  // is purely a state change here. Emitting from both sides would double-count
  // the strongest intent signals in the whole model.
  const openReviews = useCallback((target: ProductCard, critical: boolean) => {
    setReviewsFor({ card: target, critical });
  }, []);

  const openSeller = useCallback((target: ProductCard) => {
    setSellerFor(target);
  }, []);

  // ---- Mode switching and promote ---------------------------------------
  // The cross-fade is a shared-element transition: the tapped tile becomes the
  // card. Under reduced motion it is a cut, which loses nothing because the
  // animation only ever answered "where did that go?".
  const promote = useSharedValue(1);
  const promoteStyle = useAnimatedStyle(() => ({ opacity: promote.value }));

  const runPromote = useCallback(
    (after: () => void) => {
      if (reducedMotion) {
        after();
        return;
      }
      promote.value = withTiming(0, { duration: MOTION.promoteMs / 2 }, (finished) => {
        if (!finished) return;
        runOnJS(after)();
        promote.value = withTiming(1, { duration: MOTION.promoteMs / 2 });
      });
    },
    [promote, reducedMotion],
  );

  const switchMode = useCallback(
    (direction: 'left' | 'right') => {
      setShowSwipeHint(false);
      runPromote(() =>
        feed.dispatch({ kind: direction === 'left' ? 'swipe_left' : 'swipe_right' }),
      );
    },
    [feed, runPromote],
  );

  const tapTile = useCallback(
    (index: number) => {
      runPromote(() => feed.dispatch({ kind: 'tap_tile', index }));
    },
    [feed, runPromote],
  );

  const next = useCallback(() => {
    flushDwell();
    feed.dispatch({ kind: 'scroll_next' });
  }, [feed, flushDwell]);

  const prev = useCallback(() => {
    flushDwell();
    feed.dispatch({ kind: 'scroll_prev' });
  }, [feed, flushDwell]);

  // ---- Gestures ----------------------------------------------------------
  // The pan runs on the UI thread and only crosses to JS when a swipe resolves;
  // mode switching and promote must never depend on a JS round trip.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(18)
        .onEnd((event) => {
          const horizontal = Math.abs(event.translationX) > Math.abs(event.translationY);
          if (horizontal) {
            if (event.translationX < -40) runOnJS(switchMode)('left');
            else if (event.translationX > 40) runOnJS(switchMode)('right');
            return;
          }
          if (event.translationY < -40) runOnJS(next)();
          else if (event.translationY > 40) runOnJS(prev)();
        }),
    [next, prev, switchMode],
  );

  const sheetOpen = reviewsFor !== null || sellerFor !== null || menuFor !== null || reasonFor !== null;

  useKeyboardControls(
    {
      onNext: next,
      onPrev: prev,
      onModeLeft: () => switchMode('left'),
      onModeRight: () => switchMode('right'),
      onUpvote: () => card && toggleUpvote(card),
      onReviews: () => card && openReviews(card, false),
      onCart: () => card && addToCart(card),
      onPlayPause: () => undefined,
      onEscape: () => {
        const anySheetOpen =
          reviewsFor !== null || sellerFor !== null || menuFor !== null || reasonFor !== null;
        if (anySheetOpen) {
          setReviewsFor(null);
          setSellerFor(null);
          setMenuFor(null);
          setReasonFor(null);
          return;
        }
        // Nothing covering the feed: Escape is "back to the grid".
        if (feed.mode === 'single') switchMode('left');
      },
    },
    layout.isWeb && !sheetOpen,
  );
  useSnappedWheel(next, prev, layout.isWeb && !sheetOpen);

  // ---- Guards ------------------------------------------------------------
  if (session.status === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.plain}>Could not reach Window.</Text>
        <Pressable onPress={() => void session.boot()} accessibilityRole="button">
          <Text style={styles.action}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (session.status !== 'ready') return <View style={styles.centre} />;
  if (!session.onboarded) return <Redirect href="/onboarding" />;
  if (feed.buffer.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.plain}>
          {feed.loading ? 'Loading products…' : 'Could not load products.'}
        </Text>
        {!feed.loading ? (
          <Pressable onPress={() => void feed.ensureBuffer(feed.mode)} accessibilityRole="button">
            <Text style={styles.action}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const width = layout.columnWidth;
  const height = layout.columnHeight;

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={[styles.stage, layout.centred ? styles.stageCentred : null]}>
        {/* The column is its own positioning context. Everything overlaid on
            the feed anchors to it rather than to the stage, because on desktop
            the stage is the whole window and the rail sits *outside* the
            column — anchored to the stage it lands off the right edge. */}
        <View style={{ width, height }}>
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ width, height }, promoteStyle]}>
            {feed.mode === 'single' && card ? (
              <SingleCard
                card={card}
                width={width}
                height={height}
                dataSaver={session.session?.user.settings.dataSaver ?? false}
                showRailScrim={!layout.railOutside}
                fullWidthMetadata={layout.railOutside}
                onGalleryAdvance={() =>
                  emit('gallery_advance', {
                    productId: card.productId,
                    position: feed.cursor,
                    mode: feed.mode,
                  })
                }
                onGalleryEnd={() =>
                  router.push({
                    pathname: '/p/[clusterId]',
                    params: { clusterId: card.clusterId ?? card.productId },
                  })
                }
                onDoubleTap={() => toggleUpvote(card)}
                onLongPress={() => setMenuFor(card)}
              />
            ) : null}

            {feed.mode === 'window' ? (
              <WindowGrid
                tiles={pane}
                width={width}
                height={height}
                startIndex={paneStartIndex}
                highlightIndex={feed.cursor}
                dataSaver={session.session?.user.settings.dataSaver ?? false}
                onTap={tapTile}
                onLongPress={(_index, tile) => setMenuFor(tile)}
              />
            ) : null}
          </Animated.View>
        </GestureDetector>

        {/* The rail is the only standing furniture, and it is hidden entirely
            in Window mode: you do not interact with a shop window. */}
        {feed.mode === 'single' && card ? (
          <ActionRail
            card={card}
            upvoted={upvoted.has(card.productId)}
            inCart={cart.contains(card.productId)}
            withLabels={layout.railOutside}
            onSeller={() => openSeller(card)}
            onSellerLongPress={() => setMenuFor(card)}
            onUpvote={() => toggleUpvote(card)}
            onUpvoteLongPress={() => setReasonFor(card)}
            onReviews={() => openReviews(card, false)}
            onReviewsLongPress={() => openReviews(card, true)}
            onCart={() => addToCart(card)}
            onCartLongPress={() => addToCart(card)}
            onShare={() => share(card)}
            onShareLongPress={() => share(card)}
          />
        ) : null}

        {/* Offline: the buffer keeps serving cached products behind a
            persistent bar. Checkout is blocked; the bar says why. */}
        {feed.offline || feed.degraded ? (
          <View style={styles.staleBar} pointerEvents="none">
            <Text style={styles.staleText}>
              {feed.offline
                ? 'Offline — prices may be stale'
                : 'Showing popular items while the feed catches up'}
            </Text>
          </View>
        ) : null}

        {/* The single coach mark in the product: a 2-second swipe hint,
            dismissed on first swipe and never shown again. */}
        {showSwipeHint && feed.mode === 'window' && card ? (
          <SwipeHint onDone={() => setShowSwipeHint(false)} />
        ) : null}

        {/* The only way out of the enlarged view. The grid is where the user
            came from, so this reads as "back", not as a mode switch — and it
            returns to the remembered pane rather than to wherever scrolling
            has since carried the cursor. */}
        {feed.mode === 'single' ? (
          <Pressable
            onPress={() => switchMode('left')}
            accessibilityRole="button"
            accessibilityLabel="Back to the grid"
            style={styles.back}
            hitSlop={8}
          >
            <Icon name="back" size={22} />
          </Pressable>
        ) : null}
        </View>
      </View>

      {layout.showKeyboardHints ? (
        <Text style={styles.hints}>↑↓ scroll · tap to enlarge · Esc back · L upvote · C reviews · B cart</Text>
      ) : null}

      {reviewsFor?.card.clusterId ? (
        <ReviewsSheet
          clusterId={reviewsFor.card.clusterId}
          productId={reviewsFor.card.productId}
          position={feed.cursor}
          mode={feed.mode}
          visible
          jumpToCritical={reviewsFor.critical}
          reducedMotion={reducedMotion}
          onClose={() => setReviewsFor(null)}
        />
      ) : null}

      {sellerFor ? (
        <SellerSheet
          sellerId={sellerFor.seller.id}
          productId={sellerFor.productId}
          position={feed.cursor}
          mode={feed.mode}
          visible
          reducedMotion={reducedMotion}
          onClose={() => setSellerFor(null)}
          // A muted seller's cards are pulled from the buffer ahead of the
          // cursor rather than left to reappear on the next scroll.
          onMuted={() => {
            for (const entry of feed.buffer) {
              if (entry.seller.id === sellerFor.seller.id) feed.swapDeadListing(entry.productId);
            }
            setSellerFor(null);
          }}
        />
      ) : null}

      {menuFor ? (
        <CardMenu
          card={menuFor}
          position={feed.cursor}
          mode={feed.mode}
          visible
          reducedMotion={reducedMotion}
          onClose={() => setMenuFor(null)}
          onHidden={(kind) => {
            // Hiding a brand drops every card from it, not just this one.
            for (const entry of feed.buffer) {
              const matches =
                kind === 'brand'
                  ? entry.brand !== null && entry.brand === menuFor.brand
                  : entry.productId === menuFor.productId;
              if (matches) feed.swapDeadListing(entry.productId);
            }
            setMenuFor(null);
          }}
        />
      ) : null}

      {reasonFor ? (
        <ReasonPicker
          visible
          reducedMotion={reducedMotion}
          onClose={() => setReasonFor(null)}
          onPick={(reason: UpvoteReason) => {
            toggleUpvote(reasonFor, reason);
            setReasonFor(null);
          }}
        />
      ) : null}
    </GestureHandlerRootView>
  );
}

/** Shown once, for two seconds, and never again. */
function SwipeHint({ onDone }: { onDone(): void }): React.ReactElement {
  useEffect(() => {
    const timer = setTimeout(onDone, 2000);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <View style={styles.hint} pointerEvents="none">
      <Text style={styles.hintText}>Tap a window to step closer</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.backdrop },
  stage: { flex: 1, backgroundColor: COLORS.surface },
  stageCentred: { alignItems: 'center', justifyContent: 'center' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
    gap: 12,
  },
  plain: { color: COLORS.textPrimary, fontSize: TYPE.sizes.body },
  action: { color: COLORS.accent, fontSize: TYPE.sizes.body, fontWeight: TYPE.weights.semibold },
  staleBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingVertical: 8,
    paddingHorizontal: SPACING.screenMargin,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  staleText: { color: COLORS.textSecondary, fontSize: TYPE.sizes.small },
  hint: {
    position: 'absolute',
    bottom: '42%',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  hintText: { color: COLORS.textPrimary, fontSize: TYPE.sizes.small },
  back: {
    position: 'absolute',
    top: 12,
    left: 8,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hints: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
  },
});
