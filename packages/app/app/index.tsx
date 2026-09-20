import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { Redirect, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  COLORS,
  PANE_SIZE,
  MOTION,
  SCROLL,
  SPACING,
  TYPE,
  paneToRender,
  type ChatResponse,
  type ProductCard,
  type UpvoteReason,
} from '@window/shared';
import { api } from '../src/api/client.js';
import { ActionBar } from '../src/components/ActionBar.js';
import { ASK_PILL_HEIGHT, ASK_PILL_TOP, AskPanel } from '../src/components/AskPanel.js';
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
import { feedSessionId, useFeed } from '../src/store/feed.js';
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
/** How long "Link copied" stays up. Long enough to read, short enough not to nag. */
const COPIED_MS = 1800;

export default function FeedScreen(): React.ReactElement {
  const layout = useLayout();
  const reducedMotion = useReducedMotion();

  const session = useSession();
  const feed = useFeed();
  const cart = useCart();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [reviewsFor, setReviewsFor] = useState<{ card: ProductCard; critical: boolean } | null>(
    null,
  );
  const [sellerFor, setSellerFor] = useState<ProductCard | null>(null);
  const [menuFor, setMenuFor] = useState<ProductCard | null>(null);
  const [reasonFor, setReasonFor] = useState<ProductCard | null>(null);
  const [upvoted, setUpvoted] = useState<Set<string>>(new Set());
  const [showSwipeHint, setShowSwipeHint] = useState(true);
  const [askOpen, setAskOpen] = useState(false);

  const patchCard = feed.patchCard;
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

  /**
   * A card the assistant produced rather than the catalog. Its id says so.
   *
   * These come off a live storefront search and have no row behind them, which
   * is why everything needing one was switched off. `canAddToCart` is false for
   * auctions too, and those genuinely cannot be bought here — so the id is what
   * separates "nothing to add" from "nothing added *yet*".
   */
  const isPick = (target: ProductCard): boolean => target.productId.startsWith('web:');

  const adoptAndAdd = useCallback(
    async (target: ProductCard) => {
      // The control has to answer now, not when the ingest finishes. What the
      // card is showing is the pick's id, so that is the id marked; the add
      // below names the adopted one and clears it.
      cart.markPending(target.productId);
      const outcome = await api
        .adoptListing({
          url: target.sourceUrl ?? '',
          sourceId: target.productId.split(':').slice(2).join(':') || null,
          title: target.title,
          priceMinor: target.price.amount,
          imageUrl: target.media.hero.avif[0] ?? null,
        })
        .catch(() => ({ adopted: false as const, reason: 'unreachable' }));

      if (!outcome.adopted) {
        // The catalog would not take it. Sending the shopper to the listing is
        // what this control did before, and it still beats a dead button — but
        // the control must stop claiming the thing is in a cart.
        cart.clearPending(target.productId);
        if (target.sourceUrl) void Linking.openURL(target.sourceUrl);
        return;
      }

      await cart.add(outcome.productId);
      // Reload it as the product it now is, so the rest of the controls —
      // reviews, the detail link, a second add — work against the real row.
      void api
        .product(outcome.productId)
        .then((detail) => feed.adoptCard(target.productId, detail))
        .catch(() => undefined);
    },
    [cart, feed],
  );

  const addToCart = useCallback(
    (target: ProductCard) => {
      // A pick has no catalog row yet, so it is adopted into one and *then*
      // added. This is the only control that writes, so it is the one that
      // pays for the ingest.
      if (isPick(target) && target.sourceUrl) {
        void adoptAndAdd(target);
        return;
      }
      // Adding to cart never navigates away. An auction card has no bag button
      // at all; it deep-links out to the source bid book instead — to the
      // listing itself, not the storefront's front page, which is where this
      // used to land.
      if (!target.canAddToCart) {
        void Linking.openURL(target.sourceUrl ?? `https://${target.merchant.domain}`);
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
    [adoptAndAdd, cart, feed.cursor, feed.mode],
  );

  /**
   * Share, which is copying the link.
   *
   * It used to be two different things depending on where it ran: the web
   * share sheet where that exists, and otherwise `openURL` — which does not
   * share anything, it navigates away from the app to the page you were trying
   * to send someone. One behaviour now, everywhere, and one that cannot fail
   * silently: the link goes to the clipboard and the control says so.
   */
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const share = useCallback(
    (target: ProductCard) => {
      // A pick has no page here to share — `window.app/p/web:amazon.com:B0…`
      // resolves to nothing. Its own listing is the only real link it has.
      const url = isPick(target)
        ? (target.sourceUrl ?? `https://${target.merchant.domain}`)
        : `https://window.app/p/${target.clusterId ?? target.productId}`;
      void Clipboard.setStringAsync(url)
        .then((copied) => {
          // Only on success, and success is the value rather than the promise:
          // on the web this resolves either way, falling back to the legacy
          // copy when the clipboard API refuses and returning whether *that*
          // worked. A confirmation shown regardless is worse than none,
          // because it stops you checking.
          if (!copied) return;
          setCopiedFor(target.productId);
          if (copiedTimer.current) clearTimeout(copiedTimer.current);
          copiedTimer.current = setTimeout(() => setCopiedFor(null), COPIED_MS);
        })
        .catch(() => undefined);
      emit('share', { productId: target.productId, position: feed.cursor, mode: feed.mode });
    },
    [feed.cursor, feed.mode],
  );

  // The sheets emit `reviews_open` and `seller_open` themselves, so opening one
  // is purely a state change here. Emitting from both sides would double-count
  // the strongest intent signals in the whole model.
  const openReviews = useCallback((target: ProductCard, critical: boolean) => {
    // The sheet reads a cluster, and a pick has none — so this used to set a
    // state that rendered nothing and the control did nothing at all. The
    // reviews for a pick exist, they are just still on the storefront.
    if (target.clusterId === null) {
      if (target.sourceUrl) void Linking.openURL(target.sourceUrl);
      return;
    }
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

  /**
   * Fetch a card's full detail and patch it into the buffer.
   *
   * A feed page carries the hero image and a count of the rest; the gallery
   * itself only comes with the detail. Never awaited — whatever prompted this
   * has already happened on screen and must not wait on the network.
   *
   * `live` additionally re-fetches the listing at its source. That belongs to
   * the tile tap, which is someone choosing a product and the one moment the
   * price is worth a marketplace round-trip. It does not belong to arriving at
   * a product by scrolling: the gallery is in the stored row either way, and
   * making every scroll step scrape a storefront would be a real cost for
   * products nobody has decided to look at yet.
   */
  const detailed = useRef<Set<string>>(new Set());
  const loadDetail = useCallback(
    (productId: string, live: boolean) => {
      if (!live && detailed.current.has(productId)) return;
      detailed.current.add(productId);
      void api
        .product(productId, { live })
        .then((detail) => patchCard(detail))
        // Left out of the set again so arriving a second time can retry; a
        // product whose detail never loads is one whose gallery cannot be
        // stepped, and that is worth another attempt rather than a permanent
        // row of ticks that do nothing.
        .catch(() => {
          detailed.current.delete(productId);
        });
    },
    [patchCard],
  );

  // The card in view needs its gallery whether it was tapped or scrolled to.
  // Only the tap used to ask, so a product reached by scrolling showed ticks
  // for photographs it had never fetched, and every tap on the frame was a
  // no-op against a gallery of one.
  useEffect(() => {
    if (feed.mode !== 'single' || !card) return;
    // Not for a pick. Its id is not a uuid, and the detail route answers that
    // with a 500 from the database driver rather than a 404 — so this fired on
    // every assistant answer and logged an unhandled error each time.
    if (card.productId.startsWith('web:')) return;
    loadDetail(card.productId, false);
  }, [card?.productId, feed.mode, loadDetail]);

  const tapTile = useCallback(
    (index: number, card: ProductCard, rect: TileRect | null) => {
      zoom.zoomIn(rect, () => feed.dispatch({ kind: 'tap_tile', index }));
      // Not for a pick: its id is not a uuid and the detail route answers that
      // with a 500 from the database driver rather than a 404.
      if (!card.productId.startsWith('web:')) loadDetail(card.productId, true);
    },
    [feed, loadDetail, zoom],
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

  // ---- Ask ---------------------------------------------------------------
  const ask = useCallback(
    (
      turn: {
        message: string;
        history: Array<{ role: 'user' | 'assistant'; text: string }>;
        standing: ChatResponse['standing'];
      },
      signal: AbortSignal,
    ) => api.ask({ ...turn, sessionId: feedSessionId() }, signal),
    [],
  );

  /**
   * Tapping an answer's listing. The picks become the feed and it opens on the
   * one that was tapped, so the answer turns into scrolling instead of a trip
   * to Amazon. The dwell for the card we are leaving is flushed first: the
   * buffer is about to be replaced, and an unflushed dwell would be attributed
   * to whatever lands in its place.
   */
  const openPick = useCallback(
    (picks: ChatResponse['picks'], productId: string) => {
      flushDwell();
      dwellCard.current = null;
      return feed.seedFromPicks(picks, productId);
    },
    [feed, flushDwell],
  );

  // ---- Gestures ----------------------------------------------------------
  // Owned by the two layouts. See the note at the top of this file.

  // The ask panel counts as covering the feed: while it is open the arrow keys
  // belong to the person typing in it, not to the feed underneath.
  const sheetOpen =
    reviewsFor !== null || sellerFor !== null || menuFor !== null || reasonFor !== null || askOpen;

  /** The pane view is the only place a single product is what the screen is about. */
  const inPane = feed.mode === 'single';

  // The cart is loaded here rather than only by the cart screen, because the
  // count on the button has to be right before anyone has opened that screen.
  // A cart that fills up silently and shows nothing until you go looking is
  // the same as no cart at all.
  const loadCart = cart.load;
  useEffect(() => {
    if (session.status !== 'ready') return;
    void loadCart();
  }, [session.status, loadCart]);

  const cartCount = cart.itemCount();


  const openCart = useCallback(() => {
    router.push('/cart');
  }, [router]);

  useKeyboardControls(
    {
      onNext: next,
      onPrev: prev,
      onModeLeft: () => switchMode('left'),
      onModeRight: () => switchMode('right'),
      // The card bindings belong to the pane view and nowhere else. The window
      // screen shows four products at once and singles none of them out, so
      // there is nothing on screen that "upvote" could be pointing at. It used
      // to act on `feed.cursor` anyway — a cursor the grid barely expresses —
      // so pressing L there liked whichever of the four the feed happened to
      // be counting from, which from the outside is one of them at random.
      //
      // Scrolling and the mode keys stay: those act on the screen itself,
      // which is a thing the window screen does have.
      onUpvote: () => inPane && card && toggleUpvote(card),
      onReviews: () => inPane && card && openReviews(card, false),
      onCart: () => inPane && card && addToCart(card),
      onPlayPause: () => undefined,
      onEscape: () => {
        // The panel closes itself on Escape; the feed must not also act on it.
        if (askOpen) return;
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
    layout.isWeb,
    sheetOpen,
  );
  // The wheel stays suppressed while a sheet is open — the feed must not move
  // behind it — but the keyboard above keeps Escape live so the sheet can be
  // dismissed without reaching for the mouse.
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
                renderActions={(target: ProductCard, suppressTap: () => boolean) => (
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
                    shareCopied={copiedFor === target.productId}
                    suppressTap={suppressTap}
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
          {inPane
            ? '↑↓ scroll · Esc back · L upvote · C reviews · B cart'
            : '↑↓ scroll · tap to step closer'}
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

      {/* The way to the cart, and the only one: nothing else in the app
          navigates to that screen.

          It sits beside the ask pill on the same band, anchored to the screen
          rather than to the column — the pill is, and two controls that are
          meant to read as a pair cannot be pinned to two different boxes. It
          borrows the pill's height so they match, and takes the top-right
          corner. The strip between them is inset from both edges, so neither
          corner is ever under the pull zone.

          The count rides on the button, because a cart you cannot see the size
          of is one you have to open to learn anything about. */}
      {!inPane ? (
        <Pressable
          onPress={openCart}
          accessibilityRole="button"
          accessibilityLabel={
            cartCount > 0
              ? `Cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`
              : 'Cart, empty'
          }
          style={[styles.cartButton, { top: insets.top + ASK_PILL_TOP }]}
          hitSlop={8}
        >
          {/* The button's body is `card`, which is white — the window screen
              inverts the frame. So the glyph takes the light-surface ink, not
              the default, which is also white. */}
          <Icon name="cart" size={18} color={COLORS.textPrimaryLight} />
          {cartCount > 0 ? (
            <View style={styles.cartBadge}>
              <Text style={styles.cartBadgeText}>{cartCount > 9 ? '9+' : cartCount}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}

      {/* Pulled down from the top edge, over the feed. Mounted outside the
          column because on desktop the column is centred and the pull belongs
          to the top of the screen, not to the top of the card. */}
      <AskPanel
        onAsk={ask}
        onOpenPick={openPick}
        onOpenChange={setAskOpen}
        reducedMotion={reducedMotion}
      />

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
  // Circular, in the top right, on the ask pill's band and at its height. The
  // pill is inset 60 px from each edge, so the two never meet. `top` is set
  // where it is rendered, because it has to clear the safe area.
  cartButton: {
    position: 'absolute',
    right: 12,
    width: ASK_PILL_HEIGHT,
    height: ASK_PILL_HEIGHT,
    borderRadius: ASK_PILL_HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairlineLight,
  },
  cartBadge: {
    position: 'absolute',
    top: -2,
    left: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  cartBadgeText: {
    color: COLORS.textPrimary,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: TYPE.weights.semibold,
  },
  staleBar: {
    position: 'absolute',
    // Below the control band, which the cart button now occupies on this side.
    top: 56,
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
