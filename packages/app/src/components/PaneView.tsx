import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import {
  COLORS,
  RADIUS,
  SPACING,
  TYPE,
  formatMoney,
  formatTimeRemaining,
  imageUri,
  type ProductCard,
} from '@window/shared';
import { Icon } from './Icon.js';
import { Scrim } from './Scrim.js';

/**
 * The pane view.
 *
 * One product, stepped up close. The photograph is a single pane of glass —
 * inset, rounded, uncropped — and a flap hangs off the bottom of it carrying
 * everything that answers "do you want this?": who is selling it, what it is,
 * what it costs.
 *
 * This screen asks exactly one question, so it carries no comparison
 * affordance of its own. The one exit it offers is "View Similar Products",
 * which hands the question back to the window screen rather than answering it
 * here.
 *
 * The image is not full-bleed, and that is the departure from a video feed's
 * grammar: a video fills the frame because it is the whole experience, whereas
 * a product photograph cropped to 9:16 loses the product.
 *
 * Nothing here is a `Pressable` over the photograph. The deck arbitrates tap
 * against drag through the gesture handler, because on the web a drag that
 * begins and ends on the same element still emits a click — and this element
 * is the whole screen, so every scroll would finish with a phantom tap.
 */

/** Inset either side of the glass, so it reads as a panel laid on the black. */
const GLASS_MARGIN = 12;

/**
 * The fraction of the frame, from the left edge, where a tap means "the
 * photograph before this one".
 */
const GALLERY_BACK_ZONE = 0.3;

const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  like_new: 'Like new',
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  for_parts: 'For parts',
  unknown: 'Condition unknown',
};

/**
 * How many photographs this product has, which is not always how many have
 * arrived.
 *
 * A card promoted from the window screen was fetched in window mode, where the
 * server sends `galleryCount` but not the gallery itself — so the array holds
 * only the hero until the live refresh lands. Counting the array would draw one
 * tick for a product with nine pictures and then silently grow, which reads as
 * the indicator being broken. Counting what the server says exists is right the
 * moment the pane opens.
 */
export function galleryLength(card: ProductCard): number {
  return Math.max(1 + card.media.gallery.length, 1 + card.media.galleryCount);
}

export interface PaneViewProps {
  card: ProductCard;
  width: number;
  height: number;
  /**
   * Which gallery image to show. Owned by the deck rather than by this view:
   * the tap that advances it has to be arbitrated against the drag that
   * scrolls the feed, and only the deck can see both.
   */
  galleryIndex?: number;
  /**
   * The story-style tap zones over the photograph: a strip down the left edge
   * steps back through the gallery, the rest of the frame steps on.
   *
   * They are `Pressable`s rather than gesture-handler taps because a
   * `Gesture.Tap` composed alongside the deck's pan never recognises — see the
   * note in PaneDeck, which also guards them against a drag's stray click.
   */
  onStepBack?: (() => void) | undefined;
  onStepForward?: (() => void) | undefined;
  onDoubleTap?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  /** Back to wherever this pane was opened from — always the window screen. */
  onBack(): void;
  /** The merchant line is the seller sheet's entry point. */
  onSeller(): void;
  /**
   * Opens a window screen of similar products. Omitted inside that screen,
   * because a "similar" affordance on a similar-products result is a loop with
   * no floor: every pane would offer another pane of neighbours forever.
   */
  onSimilar?: (() => void) | undefined;
  /** The action rail, overlaid on the glass by the parent. */
  rail?: React.ReactNode;
  dataSaver?: boolean;
}

export function PaneView({
  card,
  width,
  height,
  galleryIndex = 0,
  onStepBack,
  onStepForward,
  onDoubleTap,
  onLongPress,
  onBack,
  onSeller,
  onSimilar,
  rail,
  dataSaver = false,
}: PaneViewProps): React.ReactElement {
  const images = [card.media.hero, ...card.media.gallery];
  // The index can run ahead of what has loaded while the live refresh is in
  // flight; hold on the last image we have rather than blanking the pane.
  const image = images[Math.min(galleryIndex, images.length - 1)] ?? card.media.hero;
  const total = galleryLength(card);

  // How tall the glass needs to be for the photograph to fill it exactly.
  //
  // `contain` inside a panel that always fills the screen leaves a band of
  // black above and below a square product shot — most of a listing's
  // photographs are square, so that is the common case, not the edge one.
  // Capping the panel at the height the image actually wants removes the bands
  // and lets the flap sit under the photograph instead of under a void.
  //
  // The cap comes from the hero rather than the current gallery image, so the
  // panel holds still while someone taps through the gallery; a panel that
  // resized per photograph would walk the price up and down the screen.
  const hero = card.media.hero;
  const glassWidth = width - GLASS_MARGIN * 2;
  const heroAspect =
    hero.width > 0 && hero.height > 0 ? hero.height / hero.width : 1;
  const glassMaxHeight = Math.round(glassWidth * heroAspect);

  // Data saver serves 480 px images; everything else takes the 1080 px variant,
  // which is under the 120 KB per-card budget at typical compression. The
  // helper prefers the listing's own image over our derivatives.
  const sourceUri = imageUri(image, dataSaver);

  const badges = card.badges;
  const timeRemaining = badges.endsAt ? formatTimeRemaining(badges.endsAt) : null;
  const discounted = card.originalPrice !== null && card.originalPrice.amount > card.price.amount;

  return (
    <View style={[styles.container, { width, height }]}>
      {/* ---- The glass ---------------------------------------------------- */}
      <View style={[styles.glass, { maxHeight: glassMaxHeight }]}>
        <View
          style={StyleSheet.absoluteFill}
          accessibilityRole="image"
          accessibilityLabel={card.title}
        >
          <Image
            source={{ uri: sourceUri }}
            placeholder={{ blurhash: image.blurhash }}
            transition={0}
            // `contain`, so the whole product is in frame. The glass is a
            // fixed panel and product photography is mostly square, so `cover`
            // scales to the panel's height and takes the sides off — which on a
            // listing shot is where the product usually ends. Letterboxing costs
            // some black; cropping costs the thing being sold.
            contentFit="contain"
            style={StyleSheet.absoluteFill}
            recyclingKey={card.productId}
            cachePolicy="memory-disk"
          />
        </View>

        {/* The tap zones sit above the photograph and below every control, so
            the back chevron and the rail keep their own presses. */}
        {onStepForward ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <Pressable
              style={[styles.tapZone, styles.tapZoneBack]}
              onPress={onStepBack}
              onLongPress={onLongPress}
              delayLongPress={380}
              accessibilityRole="button"
              accessibilityLabel="Previous photo"
              disabled={!onStepBack || galleryIndex === 0}
            />
            <Pressable
              style={[styles.tapZone, styles.tapZoneForward]}
              onPress={onStepForward}
              onLongPress={onLongPress}
              delayLongPress={380}
              accessibilityRole="button"
              accessibilityLabel={
                total > 1 ? `Next photo, ${galleryIndex + 1} of ${total}` : 'Product detail'
              }
            />
          </View>
        ) : null}

        <Scrim top right bottom={total > 1} />

        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to the window"
          style={styles.back}
          hitSlop={10}
        >
          <Icon name="back" size={26} />
        </Pressable>

        {rail}

        {/* Gallery position, as dashes rather than dots-with-a-count: one per
            photograph the product has. Nothing appears until it is needed, so a
            single-image listing gets no indicator at all. */}
        {total > 1 ? (
          <View style={styles.ticks} pointerEvents="none">
            {Array.from({ length: total }, (_, index) => (
              <View
                key={`${card.productId}-${index}`}
                style={[styles.tick, index === galleryIndex ? styles.tickActive : null]}
              />
            ))}
          </View>
        ) : null}

        {/* A high-risk listing reachable by direct link gets the whole pane
            dimmed rather than a badge; it was excluded from the feed for a
            reason, and a caution the eye can skip is a caution that failed. */}
        {card.warning ? (
          <View style={styles.warningVeil} pointerEvents="none">
            <Icon name="warning" size={30} color={COLORS.accent} />
            <Text style={styles.warningText}>{card.warning}</Text>
          </View>
        ) : null}
      </View>

      {/* ---- The flap ------------------------------------------------------ */}
      <View style={styles.meta}>
        <Pressable
          onPress={onSeller}
          accessibilityRole="button"
          accessibilityLabel={`Seller ${card.seller.displayName} on ${card.merchant.domain}`}
          hitSlop={6}
        >
          <Text style={styles.merchant} numberOfLines={1}>
            {card.merchant.domain}
          </Text>
        </Pressable>

        {/* The title opens the listing it came from. Expanding the truncation
            moves to a long press so the tap can carry the link; a card with no
            source url keeps plain, unlinked text. */}
        <Pressable
          onPress={() => {
            if (card.sourceUrl) void Linking.openURL(card.sourceUrl);
          }}
          disabled={!card.sourceUrl}
          accessibilityRole={card.sourceUrl ? 'link' : 'text'}
          accessibilityLabel={
            card.sourceUrl
              ? `${card.title}. Opens the listing on ${card.merchant.displayName}.`
              : card.title
          }
        >
          <Text
            style={[styles.title, card.sourceUrl ? styles.titleLink : null]}
            numberOfLines={2}
          >
            {card.title}
          </Text>
        </Pressable>

        <View style={styles.priceRow}>
          <View style={styles.priceGroup}>
            {card.auction ? (
              <>
                <Text style={styles.price}>
                  {formatMoney({
                    amount: card.auction.currentBid,
                    currency: card.price.currency,
                  })}
                </Text>
                <Text style={styles.secondary}>
                  {card.auction.bidCount} {card.auction.bidCount === 1 ? 'bid' : 'bids'}
                  {timeRemaining ? ` · ends in ${timeRemaining}` : ''}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.price}>{formatMoney(card.price)}</Text>
                {discounted && card.originalPrice ? (
                  <Text style={styles.struck}>{formatMoney(card.originalPrice)}</Text>
                ) : null}
              </>
            )}
          </View>

          {onSimilar ? (
            <Pressable
              onPress={onSimilar}
              accessibilityRole="button"
              accessibilityLabel="View similar products"
              hitSlop={8}
            >
              <Text style={styles.similar}>View Similar Products &gt;</Text>
            </Pressable>
          ) : null}
        </View>

        {/* One line of provenance, and only the trust signals that carry a
            consequence. Everything else lives in the detail view. */}
        <Text style={styles.secondary} numberOfLines={1}>
          {[
            badges.condition ? CONDITION_LABELS[badges.condition] : null,
            card.shipping.free
              ? 'Free shipping'
              : `+ ${formatMoney({
                  amount: card.shipping.amount,
                  currency: card.shipping.currency,
                })} shipping`,
            badges.onlyOne ? 'Only one left' : null,
            card.otherOffers
              ? `${card.otherOffers.count} other ${
                  card.otherOffers.count === 1 ? 'seller' : 'sellers'
                }, from ${formatMoney({
                  amount: card.otherOffers.fromAmount,
                  currency: card.otherOffers.currency,
                })}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>

        {badges.riskFlag ? <Text style={styles.warning}>{badges.riskFlag}</Text> : null}
        {!badges.riskFlag && badges.caution ? (
          <Text style={styles.caution}>{badges.caution}</Text>
        ) : null}
        {badges.priceContext && !badges.riskFlag ? (
          <Text style={styles.secondary}>
            {badges.priceContext === 'below' ? 'Below' : 'Above'} the typical price for this item
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Centred, because the glass is capped at the photograph's own height: a
  // square product shot leaves the page with space to spare, and hanging it all
  // off the bottom makes the pane look like it failed to load rather than like
  // it fits.
  container: { backgroundColor: COLORS.surface, justifyContent: 'center' },
  // The photograph is the top of the screen and the information hangs off the
  // bottom of it as a flap. The inset is what makes the pane read as a single
  // pane of glass laid on the black rather than as a full-bleed background.
  glass: {
    flex: 1,
    marginHorizontal: GLASS_MARGIN,
    marginTop: 14,
    marginBottom: 0,
    borderRadius: RADIUS.media,
    overflow: 'hidden',
    backgroundColor: '#111111',
  },
  // Story-style: the narrower strip goes back, because going forward is what
  // almost every tap means and the rest of the frame should not need aiming.
  tapZone: { position: 'absolute', top: 0, bottom: 0 },
  tapZoneBack: { left: 0, width: `${GALLERY_BACK_ZONE * 100}%` },
  tapZoneForward: { left: `${GALLERY_BACK_ZONE * 100}%`, right: 0 },
  back: {
    position: 'absolute',
    top: 10,
    left: 10,
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ticks: {
    position: 'absolute',
    bottom: 14,
    left: 24,
    right: 24,
    flexDirection: 'row',
    gap: 8,
  },
  tick: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.34)' },
  tickActive: { backgroundColor: COLORS.textPrimary },
  warningVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  warningText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    textAlign: 'center',
    fontWeight: TYPE.weights.semibold,
  },
  // Tight to the glass above it, so the two read as one object.
  meta: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 4,
  },
  merchant: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.subhead,
    lineHeight: TYPE.lineHeights.subhead,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.subhead,
    lineHeight: TYPE.lineHeights.subhead,
    fontWeight: TYPE.weights.bold,
  },
  // The only cue that the title leaves the app. Underline rather than a colour
  // shift, which would not survive being drawn over arbitrary photography.
  titleLink: { textDecorationLine: 'underline' },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 2,
  },
  priceGroup: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 1 },
  price: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.hero,
    lineHeight: TYPE.lineHeights.hero,
    fontWeight: TYPE.weights.bold,
  },
  struck: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.body,
    textDecorationLine: 'line-through',
  },
  similar: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.subhead,
    lineHeight: TYPE.lineHeights.subhead,
    paddingBottom: 6,
  },
  secondary: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  // The accent is load-bearing: it is the one colour in the frame, and a
  // warning is one of the three things allowed to use it.
  warning: {
    color: COLORS.accent,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
  caution: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
});
