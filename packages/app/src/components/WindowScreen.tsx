import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  CAPTION_MAX_LINES,
  CAPTION_SPACING,
  COLORS,
  PANE_SIZE,
  RADIUS,
  STRETCH,
  TYPE,
  WINDOW,
  formatMoney,
  imageUri,
  planPane,
  type PaneTileSource,
  type ProductCard,
  type TilePlan,
} from '@window/shared';
import { usePager } from '../hooks/usePager.js';
import type { TileRect } from '../hooks/useZoom.js';
import { Rating } from './Rating.js';

/**
 * The window screen.
 *
 * Four products at a time, two columns. The grid is a shop window and scrolling
 * it is walking a street: four things visible at once, none demanding a
 * decision. Tapping a tile is stepping closer to the glass, which is the pane
 * view.
 *
 * A tile is a white card carrying a photograph and, beneath it, a flap with the
 * product's name and the verdict on it. The geometry lives in `planPane` in the
 * shared package, where it is pure and tested; everything here is rendering.
 *
 * Scrolling is a continuous surface snapped to pane boundaries, driven by
 * `usePager` — the same hook the pane view scrolls on, so the two feeds cannot
 * drift apart. The settle plays afterwards, on arrival: it is the pane settling
 * in, not the pane travelling, because the travelling already happened under
 * the finger.
 *
 * Two omissions are deliberate. There is no action rail — you do not interact
 * with a shop window — and there is no price. This screen asks "which of
 * these?", and price answers "do you want this?", which is the other screen's
 * question. Price stays in the accessibility label, because a screen reader
 * user is scanning the same four things without the photographs to scan by.
 */

/**
 * The reach of the settle, as distinct from its return.
 *
 * `out(exp)` front-loads almost all of the travel and then decelerates for a
 * long time, so the page springs out and hangs at the top rather than arriving
 * at a constant rate. A bezier tuned to look similar still crosses its midpoint
 * around halfway through; this one is most of the way there by a third.
 */
const REACH_EASING = Easing.out(Easing.exp);

export interface WindowScreenProps {
  /** The whole ranked buffer; this screen windows it itself. */
  buffer: ProductCard[];
  /** Buffer index of the first tile of the pane in view. Always a multiple of 4. */
  paneStart: number;
  width: number;
  height: number;
  /** Carries the cursor. Announced to assistive tech; not drawn. */
  highlightIndex?: number;
  onTap(index: number, card: ProductCard, rect: TileRect | null): void;
  onLongPress(index: number, card: ProductCard): void;
  /** Called once a drag has settled onto the neighbouring pane. */
  onScroll(direction: 'next' | 'prev'): void;
  dataSaver?: boolean;
  reducedMotion?: boolean;
}

export function WindowScreen({
  buffer,
  paneStart,
  width,
  height,
  highlightIndex,
  onTap,
  onLongPress,
  onScroll,
  dataSaver = false,
  reducedMotion = false,
}: WindowScreenProps): React.ReactElement {
  const ordinal = Math.max(0, Math.round(paneStart / PANE_SIZE));
  const paneCount = Math.max(1, Math.ceil(buffer.length / PANE_SIZE));

  const pager = usePager({
    index: ordinal,
    count: paneCount,
    height,
    reducedMotion,
    onPage: onScroll,
  });

  // Which way the surface last moved, and whether it moved at all.
  //
  // The settle belongs to scrolling. Mounting is not scrolling: arriving here
  // from the pane view, or from a fresh load, puts a pane on screen without it
  // having travelled, and bouncing then says the feed moved when it did not.
  // So the first render after a mount is explicitly not a settle — the ref
  // starts empty and only a later change to `ordinal` counts.
  const previousOrdinal = useRef<number | null>(null);
  const settleDirection: 1 | -1 | 0 =
    previousOrdinal.current === null || previousOrdinal.current === ordinal
      ? 0
      : ordinal > previousOrdinal.current
        ? 1
        : -1;

  // Effects run children-first, so every tile has already read the direction
  // above by the time this records the new position for next time.
  useEffect(() => {
    previousOrdinal.current = ordinal;
  }, [ordinal]);

  return (
    <GestureDetector gesture={pager.pan}>
      <View style={[styles.screen, { width, height }]}>
        <Animated.View style={[StyleSheet.absoluteFill, pager.surfaceStyle]}>
          {pager.pages.map((page) => (
            <View
              key={page}
              // Absolute in pane-ordinal space, which is what lets the cursor
              // advance without anything moving. See `usePager`.
              style={{ position: 'absolute', top: pager.topOf(page), width, height }}
              // Only the pane in view takes touches; a neighbour half on screen
              // mid-drag is scenery, not a target.
              pointerEvents={page === ordinal ? 'auto' : 'none'}
            >
              <Pane
                buffer={buffer}
                paneStart={page * PANE_SIZE}
                paneOffset={pager.offsetOf(page)}
                width={width}
                height={height}
                highlightIndex={highlightIndex}
                settleKey={ordinal}
                settleDirection={settleDirection}
                // The neighbours are mounted so a drag can show where it is
                // going. They are not what arrived, so they do not settle.
                isCurrent={page === ordinal}
                reducedMotion={reducedMotion}
                dataSaver={dataSaver}
                onTap={onTap}
                onLongPress={onLongPress}
              />
            </View>
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

interface PaneProps {
  buffer: ProductCard[];
  paneStart: number;
  /** This pane's offset from the one in view, for tile rects the zoom uses. */
  paneOffset: number;
  width: number;
  height: number;
  highlightIndex: number | undefined;
  /** Changes when a pane arrives, which is what plays the settle. */
  settleKey: number;
  /** Which way it arrived: 1 scrolled forward, -1 back, 0 not a scroll. */
  settleDirection: 1 | -1 | 0;
  /** True for the pane in view. Only it settles. */
  isCurrent: boolean;
  reducedMotion: boolean;
  dataSaver: boolean;
  onTap(index: number, card: ProductCard, rect: TileRect | null): void;
  onLongPress(index: number, card: ProductCard): void;
}

function Pane({
  buffer,
  paneStart,
  paneOffset,
  width,
  height,
  highlightIndex,
  settleKey,
  settleDirection,
  isCurrent,
  reducedMotion,
  dataSaver,
  onTap,
  onLongPress,
}: PaneProps): React.ReactElement | null {
  const tiles = useMemo(
    () => buffer.slice(paneStart, paneStart + PANE_SIZE),
    [buffer, paneStart],
  );

  const plan = useMemo(() => {
    const sources: PaneTileSource[] = tiles.map((card) => ({
      id: card.productId,
      imageWidth: card.media.hero.width,
      imageHeight: card.media.hero.height,
      title: card.title,
    }));
    return planPane(sources, { width, height });
  }, [tiles, width, height]);

  // Measured tile rectangles, keyed by product id. A ref rather than state:
  // nothing renders from these, and setting state on every layout pass would
  // replay the settle on a screen that has not moved.
  const rects = useRef(new Map<string, TileRect>());

  const columnX = useCallback(
    (column: 0 | 1): number => WINDOW.screenPad + column * (plan.columnWidth + WINDOW.columnGap),
    [plan.columnWidth],
  );

  // 0 at rest, 1 at the peak of the stretch.
  //
  // One value for the whole page. It used to be one per tile, each on its own
  // staggered delay, and the ripple that produced read as the contents
  // twitching independently rather than as the page arriving — twelve small
  // boxes disagreeing about when they had landed. A single transform on the
  // column box moves everything at once, and because the box is the height of
  // the viewport the same percentage buys five times the travel it did on a
  // tile.
  const stretch = useSharedValue(0);
  // Signed, so the page overshoots the way the surface was travelling: up when
  // it came from below, down when it came from above. An unsigned lift makes a
  // backwards scroll settle forwards, which reads as the feed disagreeing with
  // the finger.
  const lift = useSharedValue(0);
  const mounted = useRef(false);

  useEffect(() => {
    // Mounting is not scrolling. A pane on screen because the user came back
    // from the pane view has not travelled, so it does not settle.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reducedMotion || settleDirection === 0 || !isCurrent) {
      stretch.value = 0;
      return;
    }

    lift.value = settleDirection;
    stretch.value = withSequence(
      withTiming(1, { duration: STRETCH.upMs, easing: REACH_EASING }),
      // A spring back, so the page overshoots and settles rather than stopping
      // dead on the mark. This is the bounce.
      withSpring(0, {
        damping: STRETCH.settleDamping,
        stiffness: STRETCH.settleStiffness,
        mass: STRETCH.settleMass,
      }),
    );
    // A pane arriving is the whole trigger: a re-render for any other reason
    // must not replay it, or the grid twitches while it sits still.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleKey]);

  const settle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -STRETCH.lift * lift.value * stretch.value },
      { scaleY: 1 + (STRETCH.scale - 1) * stretch.value },
    ],
  }));

  if (tiles.length === 0) return null;

  return (
    <View style={[styles.pane, { width, height }]}>
      <Animated.View style={[styles.columns, settle]}>
        {([0, 1] as const).map((column) => (
          <View
            key={column}
            style={[styles.column, { width: plan.columnWidth, paddingTop: plan.drops[column] }]}
          >
            {plan.tiles
              .filter((tile) => tile.column === column)
              .map((tile) => {
                const card = tiles[tile.order];
                if (!card) return null;
                return (
                  <WindowTile
                    key={card.productId}
                    card={card}
                    tile={tile}
                    columnWidth={plan.columnWidth}
                    dataSaver={dataSaver}
                    selected={paneStart + tile.order === highlightIndex}
                    onLayout={(event: LayoutChangeEvent) => {
                      const { x, y, width: w, height: h } = event.nativeEvent.layout;
                      // `x` and `y` are relative to the column's border box, so
                      // the column's own `paddingTop` — the drop — is already in
                      // `y`. The pane's offset from the one in view is not.
                      rects.current.set(card.productId, {
                        x: columnX(column) + x,
                        y: y + paneOffset,
                        width: w,
                        height: h,
                      });
                    }}
                    onPress={() =>
                      onTap(paneStart + tile.order, card, rects.current.get(card.productId) ?? null)
                    }
                    onLongPress={() => onLongPress(paneStart + tile.order, card)}
                  />
                );
              })}
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

interface WindowTileProps {
  card: ProductCard;
  tile: TilePlan;
  columnWidth: number;
  dataSaver: boolean;
  selected: boolean;
  onPress(): void;
  onLongPress(): void;
  onLayout(event: LayoutChangeEvent): void;
}

/**
 * A tile is now purely a tile. The settle belongs to the page above it, which
 * is the thing that actually arrived.
 */
function WindowTile({
  card,
  tile,
  columnWidth,
  dataSaver,
  selected,
  onPress,
  onLongPress,
  onLayout,
}: WindowTileProps): React.ReactElement {
  const hero = card.media.hero;
  // The shared helper, which prefers the listing's own image over our
  // derivatives — a real listing's photograph lives at the source until the
  // media pipeline has caught up with it, and often never moves.
  const uri = imageUri(hero, dataSaver);

  return (
    <View style={{ marginBottom: tile.gapBelow }} onLayout={onLayout}>
      <Pressable
        onPress={onPress}
        // The window screen has no rail, so a long press is the only way to
        // reach hide, mute and report from here.
        onLongPress={onLongPress}
        delayLongPress={320}
        style={[styles.card, { width: columnWidth, padding: tile.pad }]}
        accessibilityRole="button"
        accessibilityLabel={`${card.title}, ${formatMoney(
          card.auction
            ? { amount: card.auction.currentBid, currency: card.price.currency }
            : card.price,
        )}`}
        accessibilityState={{ selected }}
      >
        {/* The rounding lives on this wrapper, which clips, rather than on the
            image itself. A radius set on the image only rounds the box it is
            given, and `contain` leaves the painted photograph smaller than that
            box whenever the declared dimensions and the real file disagree — so
            the corners stayed square and the leftover band read as a slab of
            padding above the caption. Clipping the container rounds whatever
            actually gets painted. */}
        <View
          style={[
            styles.imageFrame,
            { width: tile.imageWidth, height: tile.imageHeight },
          ]}
        >
          <Image
            source={{ uri }}
            placeholder={{ blurhash: hero.blurhash }}
            // The blurhash paints immediately and the photograph replaces it
            // without a fade: a cross-fade here reads as the page loading twice.
            transition={0}
            // `cover`, so the photograph fills the frame and is clipped to its
            // corners. The frame was already sized from this photograph's own
            // aspect ratio, so there is nothing to crop when the metadata is
            // right — and when it is wrong, a hairline crop is a better answer
            // than white bands wedged between the image and its caption.
            contentFit="cover"
            style={StyleSheet.absoluteFill}
            recyclingKey={card.productId}
            cachePolicy="memory-disk"
          />
        </View>

        {/* The flap: the name and the verdict, tucked under the photograph. Its
            spacing comes from the shared tokens the layout planner measures
            with, so what is drawn and what was planned cannot drift apart. */}
        <Text style={styles.caption} numberOfLines={CAPTION_MAX_LINES}>
          {card.title}
        </Text>

        <View style={styles.rating}>
          <Rating
            rating={card.reviews.meanRating}
            count={card.reviews.count}
            size={13}
            // The row is part of the tile's tap target, which opens the pane
            // view rather than the reviews, so it must not claim otherwise.
            interactive={false}
          />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: COLORS.surface,
    // The neighbouring panes exist to be glimpsed during a drag, never to spill
    // out of the feed's own frame.
    overflow: 'hidden',
  },
  pane: { backgroundColor: COLORS.surface },
  columns: {
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: WINDOW.screenPad,
    gap: WINDOW.columnGap,
  },
  column: { alignItems: 'center' },
  imageFrame: {
    borderRadius: RADIUS.tileImage,
    overflow: 'hidden',
    backgroundColor: COLORS.hairlineLight,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.tile,
    alignItems: 'center',
    overflow: 'hidden',
  },
  caption: {
    color: COLORS.textPrimaryLight,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.bold,
    textAlign: 'center',
    marginTop: CAPTION_SPACING.above,
    marginBottom: CAPTION_SPACING.between,
  },
  rating: { height: CAPTION_SPACING.ratingRow, marginBottom: CAPTION_SPACING.below },
});
