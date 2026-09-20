import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  COLORS,
  MOTION,
  RADIUS,
  SPACING,
  TYPE,
  formatMoney,
  type CartLine,
  type MediaImage,
} from '@window/shared';
import { Icon } from '../src/components/Icon.js';
import {
  cartDiffKey,
  useCart,
  watchConnectivity,
  type CartDiff,
} from '../src/store/cart.js';
import { useSession } from '../src/store/session.js';
import { goBackOrFeed } from '../src/navigation.js';

/**
 * The cart.
 *
 * Lines are grouped by merchant because that is how they will be bought: one
 * job per merchant, each authorized on its own. The screen's real job is the
 * diff list — price and stock are re-verified on open, and checkout stays shut
 * until every change has been looked at. Nothing here auto-accepts.
 */

/**
 * The best available image URL for a line, or null.
 *
 * A line whose product has no hero is an ordinary state — a listing can reach
 * the cart without usable imagery. Taking `MediaImage` non-null here meant one
 * such line threw inside `lines.map` and took down the whole cart screen,
 * including the items that were fine.
 */
function heroUri(hero: MediaImage | null | undefined): string | null {
  if (!hero) return null;
  return hero.webp?.[0] ?? hero.avif?.[0] ?? null;
}

interface ControlProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** Every control: 44 px floor, an accessible name, and a keyboard focus ring. */
function Control({ label, onPress, disabled, style, children }: ControlProps): React.ReactElement {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      focusable={!disabled}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.control, focused ? styles.focusRing : null, style]}
    >
      {children}
    </Pressable>
  );
}

function diffHeadline(diff: CartDiff): string {
  switch (diff.kind) {
    case 'price_up':
      return 'Price went up';
    case 'price_down':
      return 'Price went down';
    case 'out_of_stock':
      return 'Out of stock';
  }
}

function diffDetail(diff: CartDiff): string {
  if (diff.kind === 'out_of_stock') {
    return 'This line cannot be bought. Remove it, or check out without it.';
  }
  const from = diff.from ? formatMoney(diff.from) : 'unknown';
  const to = diff.to ? formatMoney(diff.to) : 'unknown';
  return `${from} when you added it, ${to} now.`;
}

export default function CartScreen(): React.ReactElement {
  const router = useRouter();
  const cart = useCart((state) => state.cart);
  const loading = useCart((state) => state.loading);
  const verifying = useCart((state) => state.verifying);
  const offline = useCart((state) => state.offline);
  const error = useCart((state) => state.error);
  const auctionBlock = useCart((state) => state.auctionBlock);
  const acknowledged = useCart((state) => state.acknowledged);

  const session = useSession();
  const load = useCart((state) => state.load);
  const restoreQueue = useCart((state) => state.restoreQueue);
  const acknowledgeDiff = useCart((state) => state.acknowledgeDiff);
  const acknowledgeDiffs = useCart((state) => state.acknowledgeDiffs);
  const setQuantity = useCart((state) => state.setQuantity);
  const remove = useCart((state) => state.remove);
  const clearAuctionBlock = useCart((state) => state.clearAuctionBlock);

  // Wait for the session before fetching.
  //
  // Opening /cart directly is a cold page load: the auth token lives in memory
  // and does not exist until `boot()` has run. Loading the cart before then
  // sends an unauthenticated request, gets a 401, and renders an empty cart
  // over a cart that actually has items in it — which reads as lost data
  // rather than as a race.
  useEffect(() => {
    if (session.status === 'idle') void session.boot();
  }, [session.status, session]);

  useEffect(() => {
    if (session.status !== 'ready') return;
    void restoreQueue().then(() => load());
    return watchConnectivity();
  }, [session.status, load, restoreQueue]);

  const linesById = new Map((cart?.lines ?? []).map((line) => [line.id, line]));
  const pendingDiffs = (cart?.diffs ?? []).filter(
    (diff) => !acknowledged.has(cartDiffKey(diff)),
  );
  const blockedReason = useCart((state) => state.checkoutBlockedReason());
  const canCheckout = blockedReason === null;

  // Browsing is anonymous; ordering is not. Rather than letting checkout fail
  // with "an anonymous principal cannot place orders" — which is true, and
  // useless to the person reading it — the button says what it needs and goes
  // and gets it.
  // Mirrors the server's policy. `session.requiresAccount` comes from the
  // bootstrap response, so a demo running without the requirement does not send
  // the user to a sign-in screen the server will not ask for.
  const needsAccount = session.isAnonymous && session.requiresAccount;

  const openBid = useCallback(() => {
    if (auctionBlock?.sourceUrl) void Linking.openURL(auctionBlock.sourceUrl);
    clearAuctionBlock();
  }, [auctionBlock, clearAuctionBlock]);

  /**
   * The screen arrives from the right.
   *
   * It is done here rather than by the navigator because the navigator cannot
   * do it on the web — `slide_from_right` is a native-stack option and is
   * simply dropped, which is why this screen used to appear on the spot. One
   * implementation, every platform.
   *
   * Only the entrance. Leaving would need the navigator to hold the screen
   * mounted while it animated out, which is the thing it is not doing.
   */
  const { width: screenWidth } = useWindowDimensions();
  const slide = useSharedValue(1);
  useEffect(() => {
    slide.value = withTiming(0, {
      duration: MOTION.sheetMs,
      easing: Easing.bezier(...(MOTION.easing as unknown as [number, number, number, number])),
    });
  }, [slide]);
  const enter = useAnimatedStyle(
    () => ({ transform: [{ translateX: slide.value * screenWidth }] }),
    [screenWidth],
  );

  return (
    <Animated.View style={[styles.screen, enter]}>
      <View style={styles.header}>
        <Control label="Back" onPress={goBackOrFeed} style={styles.headerButton}>
          <Icon name="back" size={20} />
        </Control>
        <Text style={styles.headerTitle}>Cart</Text>
        {verifying ? <Text style={styles.headerMeta}>Re-checking prices</Text> : null}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {offline ? (
          <View style={styles.notice}>
            <Icon name="warning" size={20} />
            <Text style={styles.noticeText}>
              Offline. Adds are held on this device and sent when you are back. Checkout needs a
              live price check, so it stays closed until then.
            </Text>
          </View>
        ) : null}

        {auctionBlock ? (
          <View style={styles.notice}>
            <Icon name="warning" size={20} />
            <View style={styles.noticeBody}>
              <Text style={styles.noticeText}>
                That listing is an auction. Window does not bid for you.
              </Text>
              <Control
                label="Open to bid on the source site"
                onPress={openBid}
                disabled={!auctionBlock.sourceUrl}
                style={styles.inlineButton}
              >
                <Icon name="link" size={20} />
                <Text style={styles.inlineButtonText}>Open to bid</Text>
              </Control>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {pendingDiffs.length > 0 ? (
          <View style={styles.diffBlock}>
            <Text style={styles.sectionTitle}>
              {pendingDiffs.length} change{pendingDiffs.length === 1 ? '' : 's'} since you added
              {pendingDiffs.length === 1 ? ' it' : ' them'}
            </Text>
            {pendingDiffs.map((diff) => {
              const line = linesById.get(diff.lineId);
              const key = cartDiffKey(diff);
              return (
                <View key={key} style={styles.diffRow}>
                  <View style={styles.diffText}>
                    <Text style={styles.bodyText}>
                      {diffHeadline(diff)} — {line?.title ?? 'A line in your cart'}
                    </Text>
                    <Text style={styles.smallText}>{diffDetail(diff)}</Text>
                  </View>
                  <Control
                    label={`Acknowledge: ${diffHeadline(diff)} on ${line?.title ?? 'this line'}`}
                    onPress={() => acknowledgeDiff(key)}
                    style={styles.inlineButton}
                  >
                    <Icon name="check" size={20} />
                    <Text style={styles.inlineButtonText}>Seen</Text>
                  </Control>
                </View>
              );
            })}
            {pendingDiffs.length > 1 ? (
              <Control
                label="Acknowledge every price and stock change"
                onPress={acknowledgeDiffs}
                style={styles.inlineButton}
              >
                <Text style={styles.inlineButtonText}>Seen all</Text>
              </Control>
            ) : null}
          </View>
        ) : null}

        {loading && !cart ? <Text style={styles.smallText}>Checking prices and stock…</Text> : null}

        {cart && cart.lines.length === 0 && !loading ? (
          <Text style={styles.bodyText}>Nothing in the cart.</Text>
        ) : null}

        {(cart?.byMerchant ?? []).map((group) => {
          const lines = group.lineIds
            .map((id) => linesById.get(id))
            .filter((line): line is CartLine => line !== undefined);
          return (
            <View key={group.domain} style={styles.merchant}>
              <View style={styles.merchantHeader}>
                <Text style={styles.bodyText}>{group.displayName}</Text>
                <Text style={styles.subtotal}>{formatMoney(group.subtotal)}</Text>
              </View>
              <Text style={styles.smallText}>
                Bought as its own order, authorized on its own.
              </Text>

              {lines.map((line) => (
                <View key={line.id} style={styles.line}>
                  {heroUri(line.hero) ? (
                    <Image
                      source={{ uri: heroUri(line.hero) as string }}
                      style={styles.thumb}
                      contentFit="cover"
                      accessibilityLabel={line.title}
                    />
                  ) : (
                    <View style={styles.thumb} />
                  )}

                  <View style={styles.lineBody}>
                    <Text style={styles.bodyText} numberOfLines={2}>
                      {line.title}
                    </Text>
                    {Object.keys(line.variant).length > 0 ? (
                      <Text style={styles.smallText}>
                        {Object.entries(line.variant)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(' · ')}
                      </Text>
                    ) : null}
                    <Text style={styles.price}>{formatMoney(line.priceNow)}</Text>
                    {line.priceChanged ? (
                      <Text style={styles.smallText}>
                        Was {formatMoney(line.priceAtAdd)} when you added it.
                      </Text>
                    ) : null}
                    {!line.available ? (
                      <Text style={styles.smallText}>Unavailable — it will not be bought.</Text>
                    ) : null}
                    {line.softHold ? (
                      // Window cannot reserve inventory it does not own, and the
                      // word "reserved" would imply it does.
                      <Text style={styles.smallText}>
                        Only one of these. Not reserved — Window cannot hold stock it does not
                        own, so someone else can still buy it first.
                      </Text>
                    ) : null}

                    <View style={styles.quantityRow}>
                      <Control
                        label={`Decrease quantity of ${line.title}`}
                        onPress={() => void setQuantity(line.id, line.quantity - 1)}
                        style={styles.stepper}
                      >
                        <Text style={styles.stepperGlyph}>−</Text>
                      </Control>
                      <Text
                        style={styles.quantity}
                        accessibilityLabel={`Quantity ${line.quantity}`}
                      >
                        {line.quantity}
                      </Text>
                      <Control
                        label={`Increase quantity of ${line.title}`}
                        onPress={() => void setQuantity(line.id, line.quantity + 1)}
                        style={styles.stepper}
                      >
                        <Text style={styles.stepperGlyph}>+</Text>
                      </Control>
                      <Control
                        label={`Remove ${line.title} from cart`}
                        onPress={() => void remove(line.id)}
                        style={styles.inlineButton}
                      >
                        <Text style={styles.inlineButtonText}>Remove</Text>
                      </Control>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.bodyText}>Total</Text>
          <Text style={styles.price}>
            {cart ? formatMoney(cart.total) : formatMoney({ amount: 0, currency: 'USD' })}
          </Text>
        </View>
        {(cart?.byMerchant.length ?? 0) > 1 ? (
          <Text style={styles.smallText}>
            {cart?.byMerchant.length} merchants, {cart?.byMerchant.length} separate orders.
          </Text>
        ) : null}
        {blockedReason ? <Text style={styles.smallText}>{blockedReason}</Text> : null}
        <Control
          label="Review checkout"
          onPress={() => router.push(needsAccount ? '/claim' : '/checkout')}
          disabled={!canCheckout}
          style={[styles.primary, canCheckout ? null : styles.primaryDisabled]}
        >
          <Text style={styles.primaryText}>
            {!canCheckout
              ? 'Checkout unavailable'
              : needsAccount
                ? 'Confirm your email to check out'
                : 'Review checkout'}
          </Text>
        </Control>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.screenMargin / 2,
    paddingHorizontal: SPACING.screenMargin,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.hairline,
  },
  headerButton: { width: 44, height: 44, alignItems: 'flex-start' },
  headerTitle: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  headerMeta: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  body: { padding: SPACING.screenMargin, gap: 20, paddingBottom: 40 },
  notice: {
    flexDirection: 'row',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    padding: 12,
    borderRadius: RADIUS.media,
  },
  noticeBody: { flex: 1, gap: 8 },
  noticeText: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  error: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  diffBlock: {
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    padding: 12,
    borderRadius: RADIUS.media,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  diffRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  diffText: { flex: 1, gap: 2 },
  merchant: { gap: 8 },
  merchantHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  subtotal: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  line: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  thumb: { width: 72, height: 96, borderRadius: RADIUS.media, backgroundColor: COLORS.sheet },
  lineBody: { flex: 1, gap: 4 },
  bodyText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
  },
  smallText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  price: {
    color: COLORS.accent,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.semibold,
  },
  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stepper: { width: 44, height: 44 },
  stepperGlyph: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
  },
  quantity: {
    minWidth: 32,
    textAlign: 'center',
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
  },
  control: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  focusRing: { borderWidth: 2, borderColor: COLORS.accent, borderRadius: RADIUS.media },
  inlineButton: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    borderRadius: RADIUS.media,
  },
  inlineButtonText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  footer: {
    gap: 8,
    padding: SPACING.screenMargin,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  primary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.textPrimary,
    borderRadius: RADIUS.media,
    paddingHorizontal: 16,
  },
  primaryDisabled: { borderColor: COLORS.hairline },
  primaryText: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
});
