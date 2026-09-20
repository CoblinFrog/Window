import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import { COLORS, type ProductCard } from '@window/shared';
import { usePager } from '../hooks/usePager.js';
import { PaneView } from './PaneView.js';

/**
 * The pane view as a scrolling deck.
 *
 * One product fills the frame and the next is already there behind it, so a
 * drag shows what is coming rather than cutting to it. This is the same
 * `usePager` surface the window screen scrolls on, a product at a time instead
 * of four, because the two feeds share a cursor and should share a feel.
 *
 * Every interaction with the photograph is a gesture-handler gesture rather
 * than a `Pressable`, composed so the drag always outranks the taps. That is
 * not tidiness: on the web a drag whose start and end land on the same element
 * still emits a click, and here that element is the whole screen — so with a
 * `Pressable` every scroll finished with a phantom tap, which advanced the
 * gallery and eventually navigated away mid-scroll.
 *
 * The gallery index lives here for the same reason. The tap that advances it
 * has to be arbitrated against the drag that scrolls the feed, and only the
 * component that owns both can do that.
 *
 * Only the card in view takes touches. A neighbour half on screen mid-drag is
 * scenery: tapping it would advance a gallery nobody is looking at, and its
 * rail would be a live control for a product the user has not arrived at yet.
 */

export interface PaneDeckProps {
  buffer: ProductCard[];
  /** Index of the product in view. */
  cursor: number;
  width: number;
  height: number;
  /** Called once a drag has settled onto the neighbouring product. */
  onScroll(direction: 'next' | 'prev'): void;
  /** Back to the window screen: the control, and the rightward swipe. */
  onBack(): void;
  /** The action rail for the card in view, built by the parent. */
  renderRail(card: ProductCard): React.ReactNode;
  onSeller(card: ProductCard): void;
  onSimilar?: ((card: ProductCard) => void) | undefined;
  onGalleryAdvance(card: ProductCard, index: number): void;
  onGalleryEnd(card: ProductCard): void;
  onDoubleTap(card: ProductCard): void;
  onLongPress(card: ProductCard): void;
  dataSaver?: boolean;
  reducedMotion?: boolean;
}

export function PaneDeck({
  buffer,
  cursor,
  width,
  height,
  onScroll,
  onBack,
  renderRail,
  onSeller,
  onSimilar,
  onGalleryAdvance,
  onGalleryEnd,
  onDoubleTap,
  onLongPress,
  dataSaver = false,
  reducedMotion = false,
}: PaneDeckProps): React.ReactElement {
  const pager = usePager({
    index: cursor,
    count: buffer.length,
    height,
    reducedMotion,
    onPage: onScroll,
  });

  const card = buffer[cursor] ?? null;
  const images = card ? 1 + card.media.gallery.length : 1;

  // A new card starts at its first image. Arriving at a product part-way
  // through its gallery would make the feed feel like it remembered something
  // it should not.
  const [galleryIndex, setGalleryIndex] = useState(0);
  useEffect(() => {
    setGalleryIndex(0);
  }, [card?.productId]);

  const advanceGallery = useCallback(() => {
    if (!card) return;
    const next = galleryIndex + 1;
    if (next >= images) {
      onGalleryEnd(card);
      return;
    }
    setGalleryIndex(next);
    onGalleryAdvance(card, next);
  }, [card, galleryIndex, images, onGalleryAdvance, onGalleryEnd]);

  const swipeBack = useMemo(
    () =>
      Gesture.Pan()
        // Rightward only. A single positive value means "activate once
        // translationX passes this"; the two-element form would also activate
        // on the way back from zero, which is every touch.
        .activeOffsetX(24)
        .failOffsetY([-16, 16])
        .onEnd((event) => {
          if (event.translationX > 40) runOnJS(onBack)();
        }),
    [onBack],
  );

  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDistance(12)
        .onEnd((_event, success) => {
          if (success && card) runOnJS(onDoubleTap)(card);
        }),
    [card, onDoubleTap],
  );

  const singleTap = useMemo(
    () =>
      Gesture.Tap()
        // A tap is a tap, not the end of a drag: past this it is a scroll.
        .maxDistance(12)
        .onEnd((_event, success) => {
          if (success) runOnJS(advanceGallery)();
        }),
    [advanceGallery],
  );

  const longPress = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(380)
        .maxDistance(12)
        .onStart(() => {
          if (card) runOnJS(onLongPress)(card);
        }),
    [card, onLongPress],
  );

  // A race at the top level, with only the two taps disambiguated by priority
  // inside it.
  //
  // The drags and the taps are already mutually exclusive by configuration —
  // the pan needs 12px of movement to activate and the taps allow at most 12px
  // — so they do not need `Exclusive` to keep them apart. Putting the pan
  // inside one actively harms it: the pan has to wait on the other gestures
  // resolving before it finalises, and its `onEnd` never arrives, which leaves
  // a drag tracking the finger perfectly and then never settling onto a page.
  const taps = useMemo(() => Gesture.Exclusive(doubleTap, singleTap), [doubleTap, singleTap]);
  const gesture = useMemo(
    () => Gesture.Race(pager.pan, swipeBack, taps, longPress),
    [pager.pan, swipeBack, taps, longPress],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.deck, { width, height }]}>
        <Animated.View style={[StyleSheet.absoluteFill, pager.surfaceStyle]}>
          {pager.pages.map((index) => {
            const page = buffer[index];
            if (!page) return null;
            const isCurrent = index === cursor;
            return (
              <View
                key={page.productId}
                style={{ position: 'absolute', top: pager.topOf(index), width, height }}
                pointerEvents={isCurrent ? 'auto' : 'none'}
              >
                <PaneView
                  card={page}
                  width={width}
                  height={height}
                  galleryIndex={isCurrent ? galleryIndex : 0}
                  dataSaver={dataSaver}
                  // The rail is only built for the card in view. Off-screen
                  // neighbours get none: it is a live control, and a stack of
                  // them in a deck is one too many.
                  rail={isCurrent ? renderRail(page) : null}
                  onBack={onBack}
                  onSeller={() => onSeller(page)}
                  onSimilar={onSimilar ? () => onSimilar(page) : undefined}
                />
              </View>
            );
          })}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  deck: {
    backgroundColor: COLORS.surface,
    // The neighbouring cards exist to be glimpsed during a drag, never to spill
    // out of the feed's own frame.
    overflow: 'hidden',
  },
});
