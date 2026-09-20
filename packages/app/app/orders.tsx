import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  COLORS,
  RADIUS,
  SPACING,
  TYPE,
  formatMoney,
  imageUri,
  isoDay,
  type MediaImage,
  type OrderStatus,
  type OrderSummary,
} from '@window/shared';
import { Icon } from '../src/components/Icon.js';
import { api } from '../src/api/client.js';
import { useSession } from '../src/store/session.js';
import { goBackOrFeed } from '../src/navigation.js';

/**
 * Order history.
 *
 * A split cart produced several orders and they are listed as several orders,
 * here as everywhere else. A completed order is stated, never celebrated.
 */

const STATUS_WORD: Record<OrderStatus, string> = {
  pending: 'Not started',
  quoting: 'Quoting',
  awaiting_auth: 'Waiting for authorization',
  placing: 'Placing',
  placed: 'Placed',
  uncertain: 'Unconfirmed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** As in the cart: one helper, preferring the source's own CDN copy. */
function heroUri(hero: MediaImage | null): string | null {
  if (!hero) return null;
  return imageUri(hero) ?? null;
}

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface Group {
  day: string;
  orders: OrderSummary[];
}

function groupByDay(orders: readonly OrderSummary[]): Group[] {
  const groups: Group[] = [];
  for (const order of orders) {
    const day = isoDay(new Date(order.createdAt));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.orders.push(order);
    else groups.push({ day, orders: [order] });
  }
  return groups;
}

function Control({
  label,
  onPress,
  style,
  children,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}): React.ReactElement {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      focusable
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.control, focused ? styles.focusRing : null, style]}
    >
      {children}
    </Pressable>
  );
}

export default function OrdersScreen(): React.ReactElement {
  const router = useRouter();
  const session = useSession();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Opening /orders directly is a cold page load, and the auth token lives in
  // memory until `boot()` has run. Fetching before then sends an
  // unauthenticated request and renders its 401 as the screen's error — the
  // same race the cart had.
  useEffect(() => {
    if (session.status === 'idle') void session.boot();
  }, [session.status, session]);

  useEffect(() => {
    if (session.status !== 'ready') return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.orders();
        if (!cancelled) setOrders(response.orders);
      } catch (loadError) {
        if (!cancelled) setError((loadError as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.status]);

  const groups = groupByDay(orders ?? []);

  const insets = useSafeAreaInsets();

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + HEADER_PAD_V }]}>
        <Control label="Back" onPress={goBackOrFeed} style={styles.headerButton}>
          <Icon name="back" size={20} />
        </Control>
        <Text style={styles.headerTitle}>Orders</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {error ? <Text style={styles.bodyText}>{error}</Text> : null}
        {orders !== null && orders.length === 0 && !error ? (
          <Text style={styles.bodyText}>No orders yet.</Text>
        ) : null}

        {groups.map((group) => (
          <View key={group.day} style={styles.group}>
            <Text style={styles.dayHeading}>{dayLabel(group.day)}</Text>

            {group.orders.map((order) => (
              <View key={order.orderId} style={styles.order}>
                <View style={styles.orderHeader}>
                  <Text style={styles.bodyText}>{order.merchantName}</Text>
                  {order.total ? (
                    <Text style={styles.price}>{formatMoney(order.total)}</Text>
                  ) : null}
                </View>

                <Text style={styles.smallText}>{STATUS_WORD[order.status]}</Text>
                {order.merchantOrderNumber ? (
                  <Text style={styles.smallText}>
                    Merchant order number {order.merchantOrderNumber}
                  </Text>
                ) : null}
                {order.status === 'uncertain' ? (
                  <Text style={styles.smallText}>
                    Submitted, but the merchant's confirmation could not be read. It is being
                    verified against their order history.
                  </Text>
                ) : null}

                <View style={styles.thumbRow}>
                  {order.items.map((item) => {
                    const uri = heroUri(item.hero);
                    return uri ? (
                      <Image
                        key={item.productId}
                        source={{ uri }}
                        style={styles.thumb}
                        contentFit="cover"
                        accessibilityLabel={item.title}
                      />
                    ) : (
                      <View key={item.productId} style={styles.thumb} />
                    );
                  })}
                </View>

                {order.items.map((item) => (
                  <Text key={`${item.productId}-title`} style={styles.smallText} numberOfLines={1}>
                    {item.quantity} × {item.title}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The header's own vertical padding, named because the screen adds the device's
 * top inset to it at render time. A full-screen route starts at y=0, which on a
 * phone with a Dynamic Island is behind the island — the back button was there,
 * unreachable, rather than missing.
 */
const HEADER_PAD_V = 8;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.screenMargin / 2,
    paddingHorizontal: SPACING.screenMargin,
    paddingVertical: HEADER_PAD_V,
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
  body: { padding: SPACING.screenMargin, gap: 24, paddingBottom: 48 },
  group: { gap: 12 },
  dayHeading: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  order: {
    gap: 4,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  thumbRow: { flexDirection: 'row', gap: SPACING.gutter, marginVertical: 8 },
  thumb: { width: 56, height: 56, borderRadius: RADIUS.media, backgroundColor: COLORS.sheet },
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
  control: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  focusRing: { borderWidth: 2, borderColor: COLORS.accent, borderRadius: RADIUS.media },
});
