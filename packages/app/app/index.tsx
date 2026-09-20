import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Redirect, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import {
  COLORS,
  PANE_SIZE,
  SCROLL,
  SPACING,
  TYPE,
  paneToRender,
  type ProductCard,
  type UpvoteReason,
} from '@window/shared';
import { api } from '../src/api/client.js';
import { ActionBar } from '../src/components/ActionBar.js';
import { CardMenu } from '../src/components/CardMenu.js';
import { Icon } from '../src/components/Icon.js';
import { ReasonPicker } from '../src/components/ReasonPicker.js';
import { ReviewsSheet } from '../src/components/ReviewsSheet.js';
import { SellerSheet } from '../src/components/SellerSheet.js';
import { PaneDeck } from '../src/components/PaneDeck.js';
import { WindowScreen } from '../src/components/WindowScreen.js';
import { useLayout, useReducedMotion } from '../src/hooks/useLayout.js';
import { useZoom, type TileRect } from '../src/hooks/useZoom.js';
import { useKeyboardControls, useSnappedWheel } from '../src/hooks/useKeyboard.js';
import { useCart } from '../src/store/cart.js';
import { emit, emitDwell } from '../src/store/events.js';
import { useFeed } from '../src/store/feed.js';
import { useSession } from '../src/store/session.js';

/**
 * The feed.
 *
 * One ranked list rendered through two layouts — the window screen, four
 * products at a time, and the pane view, one product stepped up close. A tap
 * promotes a tile into the pane; back returns to the pane of the window it came
 * from. Neither transition fetches a different list.
 *
 * Both layouts are scrolling surfaces that track the finger and own their own
 * gestures, so there is no stage-level gesture out here: one would only be
 * competing with them for the same drag.
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
  // Tapping a tile zooms into it: the pane grows out of that tile's rectangle
  // while the grid leans on it and fades. Going back puts the product down
  // where it was picked up. Under reduced motion both are cuts, which lose
  // nothing — the animation only ever answered "where did that go?", and the
  // remembered pane answers it on arrival anyway.
  const zoom = useZoom(layout.columnWidth, layout.columnHeight, reducedMotion);

  const switchMode = useCallback(
    (direction: 'left' | 'right') => {
      setShowSwipeHint(false);
      const commit = (): void =>
        feed.dispatch({ kind: direction === 'left' ? 'swipe_left' : 'swipe_right' });

      // Leaving the pane view is the zoom running backwards. Entering it by a
      // swipe is not a zoom at all: no tile was touched, so there is nothing to
      // grow out of.
      if (direction === 'left' && feed.mode === 'single') zoom.zoomOut(commit);
      else commit();
    },
    [feed, zoom],
  );

  const tapTile = useCallback(
    (index: number, card: ProductCard, rect: TileRect | null) => {
      zoom.zoomIn(rect, () => feed.dispatch({ kind: 'tap_tile', index }));
      // A tap is also the moment to ask the source for the freshest copy of
      // this listing; the refreshed detail patches the card in place when it
      // lands. It is deliberately not awaited — the zoom has already started
      // and must not wait on the network to finish.
      void api
        .product(card.productId, { live: true })
        .then((detail) => feed.patchCard(detail))
        .catch(() => undefined);
    },
    [feed, zoom],
  );

  // One page per settle, whatever asked for it.
  //
  // A drag is self-pacing — it commits only once the surface has arrived — but
  // the wheel and a held arrow key are not, and two requests landing inside one
  // settle move the cursor twice while the surface animates straight past the
  // page in between. The feed then reads as having skipped something, which
  // for a ranked list it has.
  const lastStepAt = useRef(0);
  const step = useCallback(
    (action: 'scroll_next' | 'scroll_prev') => {
      const now = Date.now();
      if (now - lastStepAt.current < SCROLL.settleMs) return;
      lastStepAt.current = now;
      flushDwell();
      feed.dispatch({ kind: action });
    },
    [feed, flushDwell],
  );

  const next = useCallback(() => step('scroll_next'), [step]);

  const prev = useCallback(() => step('scroll_prev'), [step]);

  // ---- Gestures ----------------------------------------------------------
  // Owned by the two layouts. See the note at the top of this file.

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
          {/* Both layouts stay mounted for the length of a zoom: the grid has
              to be visible leaning about the tile, and the pane has to be
              painting the product the whole way out of it. The window screen is
              drawn first so the pane arrives on top of it. */}
          {feed.mode === 'window' || zoom.active ? (
            <Animated.View style={[styles.layer, { width, height }, zoom.gridStyle]}>
              <WindowScreen
                buffer={feed.buffer}
                paneStart={paneStartIndex}
                width={width}
                height={height}
                highlightIndex={feed.cursor}
                reducedMotion={reducedMotion}
                dataSaver={session.session?.user.settings.dataSaver ?? false}
                onTap={tapTile}
                onLongPress={(_index, tile) => setMenuFor(tile)}
                onScroll={(direction) => (direction === 'next' ? next() : prev())}
              />
            </Animated.View>
          ) : null}

          {feed.mode === 'single' && card ? (
            <Animated.View style={[styles.layer, { width, height }, zoom.paneStyle]}>
              <PaneDeck
                buffer={feed.buffer}
                cursor={feed.cursor}
                width={width}
                height={height}
                dataSaver={session.session?.user.settings.dataSaver ?? false}
                reducedMotion={reducedMotion}
                onScroll={(direction) => (direction === 'next' ? next() : prev())}
                // Back returns to the remembered pane rather than to wherever
                // scrolling has since carried the cursor.
                onBack={() => switchMode('left')}
                // The controls belong to the card, not to the stage: anchored
                // to the stage they land off the right edge on desktop, where
                // the column is narrower than the window.
                renderActions={(target: ProductCard) => (
                  <ActionBar
                    card={target}
                    upvoted={upvoted.has(target.productId)}
                    inCart={cart.contains(target.productId)}
                    onUpvote={() => toggleUpvote(target)}
                    onUpvoteLongPress={() => setReasonFor(target)}
                    onReviews={() => openReviews(target, false)}
                    onReviewsLongPress={() => openReviews(target, true)}
                    onCart={() => addToCart(target)}
                    onCartLongPress={() => addToCart(target)}
                    onShare={() => share(target)}
                    onShareLongPress={() => share(target)}
                  />
                )}
                onSeller={openSeller}
                onGalleryAdvance={(target) =>
                  emit('gallery_advance', {
                    productId: target.productId,
                    position: feed.cursor,
                    mode: feed.mode,
                  })
                }
                onGalleryEnd={(target) =>
                  router.push({
                    pathname: '/p/[clusterId]',
                    params: { clusterId: target.clusterId ?? target.productId },
                  })
                }
                onDoubleTap={toggleUpvote}
                onLongPress={setMenuFor}
              />
            </Animated.View>
          ) : null}

          {/* Offline: the buffer keeps serving cached products behind a
              persistent pill. Checkout is blocked, and this says why.

              A degraded page gets no banner. The ranking ladder falling back to
              popularity changes which products are shown, not whether they can
              be trusted or bought, so announcing it reports on the backend
              rather than telling anyone something they can use. */}
          {feed.offline ? (
            <View style={styles.staleBar} pointerEvents="none">
              <Text style={styles.staleText}>Offline — prices may be stale</Text>
            </View>
          ) : null}

          {/* The single coach mark in the product: a 2-second hint, dismissed
              on first interaction and never shown again. */}
          {showSwipeHint && feed.mode === 'window' && card ? (
            <SwipeHint onDone={() => setShowSwipeHint(false)} />
          ) : null}
        </View>
      </View>

      {layout.showKeyboardHints ? (
        <Text style={styles.hints}>
          ↑↓ scroll · tap to step closer · Esc back · L upvote · C reviews · B cart
        </Text>
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
  // The two layouts occupy the same rectangle so a zoom can hold both.
  layer: { ...StyleSheet.absoluteFillObject },
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
  // A floating pill in the top right. Every other corner is spoken for: the
  // back control has the top left, the price and similar-products link have the
  // bottom, and the middle is the photograph.
  staleBar: {
    position: 'absolute',
    top: 14,
    right: 14,
    maxWidth: '62%',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  staleText: { color: COLORS.textSecondary, fontSize: TYPE.sizes.small, textAlign: 'right' },
  hint: {
    position: 'absolute',
    bottom: '42%',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  hintText: { color: COLORS.textPrimary, fontSize: TYPE.sizes.small },
  hints: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
  },
});
