import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { useQuery } from '@tanstack/react-query';
import {
  COLORS,
  ICON,
  RADIUS,
  SHEET,
  SPACING,
  TYPE,
  formatMoney,
  type FeedMode,
  type ProductCard,
  imageUri,
  type SellerResponse,
} from '@window/shared';
import { api } from '../api/client.js';
import { emit } from '../store/events.js';
import { Icon } from './Icon.js';
import { Sheet } from './Sheet.js';

/**
 * The seller sheet.
 *
 * A secondhand seller's profile is a mirror of public source-site data, so the
 * sheet is built entirely out of fields the source already exposes and links
 * out for anything else. Nothing here is a contact channel, and nothing here is
 * inferred: a missing metric renders as nothing rather than a dash, because a
 * placeholder on a trust surface reads as a fact.
 */

/** Three across, so a 20 px semibold price still fits under each tile. */
const TILE_WIDTH = '33.3333%';
const MAX_LISTINGS = 9;

export interface SellerSheetProps {
  sellerId: string;
  /** The card the sheet was opened from; the mute signal is keyed to it. */
  productId: string;
  visible: boolean;
  onClose: () => void;
  position?: number;
  mode?: FeedMode;
  reducedMotion?: boolean;
  /** Fired after a successful mute so the caller can drop the seller's cards. */
  onMuted?: (sellerId: string) => void;
}

export function SellerSheet({
  sellerId,
  productId,
  visible,
  onClose,
  position = 0,
  mode = 'single',
  reducedMotion = false,
  onMuted,
}: SellerSheetProps): React.ReactElement {
  const seller = useQuery({
    queryKey: ['seller', sellerId],
    queryFn: () => api.seller(sellerId),
    enabled: visible,
  });

  const listings = useQuery({
    queryKey: ['seller-listings', sellerId],
    queryFn: () => api.sellerListings(sellerId),
    enabled: visible,
  });

  useEffect(() => {
    if (!visible) return;
    emit('seller_open', { productId, position, mode });
  }, [visible, productId, position, mode]);

  const [confirmingMute, setConfirmingMute] = useState(false);
  useEffect(() => {
    if (!visible) setConfirmingMute(false);
  }, [visible]);

  const mute = useCallback(async () => {
    try {
      await api.suppress({ kind: 'seller', value: sellerId });
    } catch {
      // Nothing was hidden, so nothing is claimed. The control simply resets.
      setConfirmingMute(false);
      return;
    }
    emit('mute_seller', { productId, position, mode });
    onMuted?.(sellerId);
    onClose();
  }, [sellerId, productId, position, mode, onMuted, onClose]);

  const data = seller.data ?? null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Seller"
      heightFraction={SHEET.sellerHeightFraction}
      loading={seller.isPending}
      reducedMotion={reducedMotion}
    >
      <ScrollView contentContainerStyle={styles.content}>
        {data ? (
          <>
            <Identity seller={data} />
            <Facts seller={data} />
            <Listings items={listings.data?.items ?? []} reducedMotion={reducedMotion} />
            <ProfileLink seller={data} />
            <MuteControl
              muted={data.muted}
              confirming={confirmingMute}
              onArm={() => setConfirmingMute(true)}
              onCancel={() => setConfirmingMute(false)}
              onConfirm={() => void mute()}
            />
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function Identity({ seller }: { seller: SellerResponse }): React.ReactElement {
  return (
    <View style={styles.identity}>
      {seller.avatarUrl ? (
        <Image source={{ uri: seller.avatarUrl }} style={styles.avatar} contentFit="cover" />
      ) : null}
      <View style={styles.identityText}>
        <Text style={styles.name}>{seller.displayName}</Text>
        <Text style={styles.sub}>{`${sellerKind(seller.type)} · ${seller.sourceDomain}`}</Text>
      </View>
    </View>
  );
}

/**
 * The three source types answer different questions — a retailer's return
 * window, an individual's track record, an auction house's premium — so this is
 * a switch rather than one superset layout with empty rows.
 */
function Facts({ seller }: { seller: SellerResponse }): React.ReactElement {
  const { metrics, policies, auctionTerms } = seller;

  switch (seller.type) {
    case 'retailer':
      return (
        <View style={styles.facts}>
          {policies ? (
            <>
              <Fact
                label="Returns"
                value={`${policies.returnWindowDays}-day return window`}
              />
              <Fact label="Shipping" value={policies.shippingSummary} />
            </>
          ) : null}
          {seller.liveListingCount > 0 ? (
            <Fact
              label="In your feed"
              value={`${seller.liveListingCount.toLocaleString()} of their products`}
            />
          ) : null}
        </View>
      );

    case 'individual':
      return (
        <View style={styles.facts}>
          <Fact label="Handle" value={seller.handle} />
          {metrics.rating !== null ? (
            <Fact
              label="Source rating"
              value={`${metrics.rating.toFixed(1)} out of 5 from ${metrics.reviewCount.toLocaleString()} reviews on ${seller.sourceDomain}`}
            />
          ) : null}
          {metrics.memberSince ? (
            <Fact label="Member since" value={formatMonth(metrics.memberSince) ?? ''} />
          ) : null}
          {metrics.salesCount > 0 ? (
            <Fact label="Items sold" value={metrics.salesCount.toLocaleString()} />
          ) : null}
          {metrics.responseTime ? (
            <Fact label="Responds" value={metrics.responseTime} />
          ) : null}
        </View>
      );

    case 'auction_house':
      return (
        <View style={styles.facts}>
          {seller.liveListingCount > 0 ? (
            <Fact label="Lots" value={`${seller.liveListingCount.toLocaleString()} open lots`} />
          ) : null}
          {auctionTerms ? (
            <Fact label="Buyer premium" value={`${auctionTerms.buyerPremiumPct}%`} />
          ) : null}
          {auctionTerms ? (
            <LinkRow label="Bidding terms" url={auctionTerms.termsUrl} />
          ) : null}
        </View>
      );
  }
}

function Fact({ label, value }: { label: string; value: string }): React.ReactElement | null {
  if (!value) return null;
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function Listings({
  items,
  reducedMotion,
}: {
  items: ProductCard[];
  reducedMotion: boolean;
}): React.ReactElement | null {
  const visible = items.slice(0, MAX_LISTINGS);
  if (visible.length === 0) return null;

  return (
    <View style={styles.listings}>
      <Text style={styles.sectionLabel} accessibilityRole="header">
        Their other listings
      </Text>
      <View style={styles.grid}>
        {visible.map((item) => (
          <ListingTile key={item.productId} item={item} reducedMotion={reducedMotion} />
        ))}
      </View>
    </View>
  );
}

function ListingTile({
  item,
  reducedMotion,
}: {
  item: ProductCard;
  reducedMotion: boolean;
}): React.ReactElement | null {
  const uri = imageUri(item.media.hero, true);
  if (!uri) return null;
  const price = formatMoney(item.price);

  return (
    <View style={styles.tile} accessible accessibilityLabel={`${item.title}, ${price}`}>
      <Image
        source={{ uri }}
        style={styles.tileImage}
        contentFit="cover"
        transition={reducedMotion ? 0 : 120}
      />
      <Text style={styles.tilePrice} numberOfLines={1}>
        {price}
      </Text>
    </View>
  );
}

function ProfileLink({ seller }: { seller: SellerResponse }): React.ReactElement {
  return (
    <View style={styles.profile}>
      <LinkRow label={`Full profile on ${seller.sourceDomain}`} url={seller.profileUrl} />
      <Text style={styles.profileNote}>
        Window shows the public metrics this source publishes and nothing else.
      </Text>
    </View>
  );
}

function LinkRow({ label, url }: { label: string; url: string }): React.ReactElement {
  const open = useCallback(() => {
    void Linking.openURL(url);
  }, [url]);

  return (
    <Pressable
      onPress={open}
      style={styles.linkRow}
      accessibilityRole="link"
      accessibilityLabel={label}
      focusable
    >
      <Icon name="link" size={16} color={COLORS.textSecondary} />
      <Text style={styles.linkRowText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Muting is permanent and there is no toast to undo from, so the control says
 * what it does before it does it and takes a second tap. That confirm step is
 * the only reassurance this app offers, and it is here because the action is
 * irreversible rather than because it is important.
 */
function MuteControl({
  muted,
  confirming,
  onArm,
  onCancel,
  onConfirm,
}: {
  muted: boolean;
  confirming: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  if (muted) {
    return (
      <View style={styles.mute}>
        <Text style={styles.muteState}>Muted. Their listings no longer appear in your feed.</Text>
      </View>
    );
  }

  if (!confirming) {
    return (
      <View style={styles.mute}>
        <Pressable
          onPress={onArm}
          style={styles.muteButton}
          accessibilityRole="button"
          accessibilityLabel="Mute this seller"
          accessibilityHint="Permanently hides every listing from this seller"
          focusable
        >
          <Text style={styles.muteLabel}>Mute this seller</Text>
        </Pressable>
        <Text style={styles.muteNote}>
          Hides every listing from this seller, permanently. There is no undo.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.mute}>
      <Pressable
        onPress={onConfirm}
        style={styles.muteButton}
        accessibilityRole="button"
        accessibilityLabel="Confirm muting this seller permanently"
        focusable
      >
        <Text style={styles.muteLabel}>Mute permanently</Text>
      </Pressable>
      <Pressable
        onPress={onCancel}
        style={styles.muteButton}
        accessibilityRole="button"
        accessibilityLabel="Keep seeing this seller"
        focusable
      >
        <Text style={styles.muteCancel}>Keep seeing this seller</Text>
      </Pressable>
    </View>
  );
}

function sellerKind(type: SellerResponse['type']): string {
  switch (type) {
    case 'retailer':
      return 'Retailer';
    case 'individual':
      return 'Secondhand seller';
    case 'auction_house':
      return 'Auction house';
  }
}

function formatMonth(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 32,
  },

  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: SPACING.screenMargin,
  },
  avatar: {
    width: 48,
    height: 48,
    marginRight: 12,
    backgroundColor: COLORS.hairline,
  },
  identityText: {
    flex: 1,
  },
  name: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  sub: {
    marginTop: 2,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  facts: {
    marginTop: 16,
    paddingHorizontal: SPACING.screenMargin,
  },
  fact: {
    marginBottom: 10,
  },
  factLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  factValue: {
    marginTop: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },

  listings: {
    marginTop: 10,
    paddingHorizontal: SPACING.screenMargin,
  },
  sectionLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
    marginBottom: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Negative inset so the 2 px gutter is between tiles, not at the margin.
    marginHorizontal: -SPACING.gutter / 2,
  },
  tile: {
    width: TILE_WIDTH,
    paddingHorizontal: SPACING.gutter / 2,
    paddingBottom: SPACING.gutter * 4,
  },
  tileImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: RADIUS.tile,
    backgroundColor: COLORS.hairline,
  },
  tilePrice: {
    marginTop: 4,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.semibold,
  },

  profile: {
    marginTop: 10,
    paddingHorizontal: SPACING.screenMargin,
  },
  profileNote: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ICON.minTarget,
  },
  linkRowText: {
    marginLeft: 6,
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },

  mute: {
    marginTop: 18,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  muteButton: {
    minHeight: ICON.minTarget,
    justifyContent: 'center',
  },
  muteLabel: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  muteCancel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
  muteNote: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.regular,
  },
  muteState: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.regular,
  },
});
