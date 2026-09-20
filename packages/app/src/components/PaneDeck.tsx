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
 * The gallery is tapped through rather than swiped, the way a story is: the
 * left edge steps back, the rest of the frame steps on. That leaves the
 * horizontal drag free to mean one thing — a rightward swipe goes back to the
 * window screen — instead of having to mean "previous photograph" and "leave"
 * at once, which is a choice no gesture can make without surprising someone.
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
  /** The action bar for the card in view, built by the parent. */
  renderActions(card: ProductCard, suppressTap: () => boolean): React.ReactNode;
  onSeller(card: ProductCard): void;
  onSimilar?: ((card: ProductCard) => void) | undefined;
  onGalleryAdvance(card: ProductCard, index: number): void;
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
  renderActions,
  onSeller,
  onSimilar,
  onGalleryAdvance,
  onDoubleTap: onDoubleTapProp,
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
  // How many photographs have actually arrived, which is not always how many
  // the product claims: the gallery fills in behind the live refresh, and
  // stepping has to respect what is really there.
  const loaded = card ? Math.max(1, 1 + card.media.gallery.length) : 1;

  // A new card starts at its first image. Arriving at a product part-way
  // through its gallery would make the feed feel like it remembered something
  // it should not.
  const [galleryIndex, setGalleryIndex] = useState(0);
  useEffect(() => {
    setGalleryIndex(0);
  }, [card?.productId]);

  /**
   * Move through the gallery. `delta` is +1 forward, -1 back.
   *
   * Both ends are walls. Tapping past the last photograph used to push a
   * separate landing screen, which meant the last tap of a gallery quietly
   * left the feed for a page with a button on it asking to be let back in.
   * Running out of photographs is not a destination.
   */
  const stepGallery = useCallback(
    (delta: number) => {
      if (!card) return;
      const next = galleryIndex + delta;
      if (next < 0 || next >= loaded) return;
      setGalleryIndex(next);
      if (delta > 0) onGalleryAdvance(card, next);
    },
    [card, galleryIndex, loaded, onGalleryAdvance],
  );

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

  // The taps are `Pressable`s inside the pane view rather than gesture-handler
  // taps. A `Gesture.Tap` composed alongside the pan never recognises here —
  // the pan holds the touch and the tap's `onEnd` simply never arrives — and a
  // gallery you cannot advance is worse than one whose taps need guarding.
  //
  // What they need guarding against is the stray click a drag leaves behind:
  // on the web, a drag that starts and ends on the same element still emits
  // one when the finger lifts, and here that element is the whole frame. The
  // pager knows when it last moved, so the zones ask before acting.
  const onEdgeTap = useCallback(
    (direction: 1 | -1) => {
      if (pager.justDragged()) return;
      stepGallery(direction);
    },
    [pager, stepGallery],
  );

  const onDoubleTap = useCallback(() => {
    if (!card || pager.justDragged()) return;
    onDoubleTapProp(card);
  }, [card, onDoubleTapProp, pager]);

  const onCardLongPress = useCallback(() => {
    if (!card) return;
    onLongPress(card);
  }, [card, onLongPress]);

  const gesture = useMemo(
    () => Gesture.Race(pager.pan, swipeBack),
    [pager.pan, swipeBack],
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
                  // Only the card in view gets live controls; a neighbour half
                  // on screen mid-drag is scenery, not something to press.
                  actions={isCurrent ? renderActions(page, pager.justDragged) : null}
                  // Story-style: a strip down the left edge steps back through
                  // the photographs, the rest of the frame steps on.
                  onStepBack={() => onEdgeTap(-1)}
                  onStepForward={() => onEdgeTap(1)}
                  onDoubleTap={onDoubleTap}
                  onLongPress={onCardLongPress}
                  onBack={onBack}
                  onSeller={() => onSeller(page)}
                  // The flap scrolls with the pane, so every control on it has
                  // to be able to tell a tap from the click a drag leaves
                  // behind.
                  suppressTap={pager.justDragged}
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
