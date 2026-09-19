import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { COLORS, RADIUS, type ProductCard } from '@window/shared';
import { MetadataBar } from './MetadataBar.js';
import { Scrim } from './Scrim.js';

/**
 * Single mode: one product, full bleed, edge to edge.
 *
 * The product is the interface. Media is full-bleed and unobstructed, chrome
 * sits at the edges over a gradient scrim, and nothing is ever drawn across the
 * subject. The only screen furniture is the rail, which the parent overlays.
 *
 * This screen asks exactly one question — do you want this? — so it carries no
 * comparison affordance and no navigation.
 */

export interface SingleCardProps {
  card: ProductCard;
  width: number;
  height: number;
  /** Tap advances the gallery; at the last image it opens the detail sheet. */
  onGalleryEnd(): void;
  onGalleryAdvance(index: number): void;
  onDoubleTap(): void;
  onLongPress(): void;
  showRailScrim?: boolean;
  fullWidthMetadata?: boolean;
  /** Autoplay is disabled under reduced motion, low power and data saver. */
  allowVideo?: boolean;
  dataSaver?: boolean;
}

/** A single tap must not fire when a double tap is coming. */
const DOUBLE_TAP_WINDOW_MS = 260;

export function SingleCard({
  card,
  width,
  height,
  onGalleryEnd,
  onGalleryAdvance,
  onDoubleTap,
  onLongPress,
  showRailScrim = true,
  fullWidthMetadata = false,
  dataSaver = false,
}: SingleCardProps): React.ReactElement {
  const [galleryIndex, setGalleryIndex] = useState(0);
  const lastTapAt = useRef(0);
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new card resets the gallery: arriving at a product part-way through its
  // images would make the feed feel like it remembered something it should not.
  useEffect(() => {
    setGalleryIndex(0);
  }, [card.productId]);

  useEffect(
    () => () => {
      if (pendingTap.current) clearTimeout(pendingTap.current);
    },
    [],
  );

  const images = [card.media.hero, ...card.media.gallery];
  const image = images[Math.min(galleryIndex, images.length - 1)] ?? card.media.hero;

  // Data saver serves 480 px images; everything else takes the 1080 px variant,
  // which is under the 120 KB per-card budget at typical compression.
  const sourceUri = dataSaver ? (image.avif[0] ?? image.webp[0]) : (image.avif[1] ?? image.avif[0]);

  const handleTap = (): void => {
    const now = Date.now();
    if (now - lastTapAt.current < DOUBLE_TAP_WINDOW_MS) {
      if (pendingTap.current) {
        clearTimeout(pendingTap.current);
        pendingTap.current = null;
      }
      lastTapAt.current = 0;
      onDoubleTap();
      return;
    }
    lastTapAt.current = now;
    pendingTap.current = setTimeout(() => {
      pendingTap.current = null;
      const next = galleryIndex + 1;
      if (next >= images.length) {
        onGalleryEnd();
        return;
      }
      setGalleryIndex(next);
      onGalleryAdvance(next);
    }, DOUBLE_TAP_WINDOW_MS);
  };

  return (
    <View style={[styles.container, { width, height }]}>
      <Pressable
        onPress={handleTap}
        onLongPress={onLongPress}
        delayLongPress={380}
        style={StyleSheet.absoluteFill}
        accessibilityRole="image"
        accessibilityLabel={card.title}
      >
        <Image
          source={{ uri: sourceUri }}
          placeholder={{ blurhash: image.blurhash }}
          // The blurhash paints immediately and the real image replaces it
          // without a fade: a cross-fade here reads as the page loading twice.
          transition={0}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
          recyclingKey={card.productId}
          cachePolicy="memory-disk"
        />
      </Pressable>

      <Scrim rail={showRailScrim} />

      {/* Gallery position, as ticks rather than dots-with-a-count. Nothing
          appears until it is needed: one image means no indicator at all. */}
      {images.length > 1 ? (
        <View style={styles.ticks} pointerEvents="none">
          {images.map((entry, index) => (
            <View
              key={`${card.productId}-${index}`}
              style={[styles.tick, index === galleryIndex ? styles.tickActive : null]}
            />
          ))}
        </View>
      ) : null}

      {/* A high-risk listing reachable by direct link gets a full-card warning
          rather than a badge; it was excluded from the feed for a reason. */}
      {card.warning ? (
        <View style={styles.warningPanel} pointerEvents="none">
          <MetadataBar card={card} fullWidth />
        </View>
      ) : (
        <MetadataBar card={card} fullWidth={fullWidthMetadata} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
    borderRadius: RADIUS.media,
  },
  ticks: {
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 3,
  },
  tick: {
    flex: 1,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  tickActive: {
    backgroundColor: COLORS.textPrimary,
  },
  warningPanel: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
});
