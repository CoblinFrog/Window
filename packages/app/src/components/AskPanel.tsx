import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { COLORS, ICON, MOTION, RADIUS, SPACING, TYPE, type ChatResponse } from '@window/shared';
import { Icon } from './Icon.js';
import { PressScale } from './PressScale.js';

/**
 * Ask — the shopping assistant, pulled down from the top edge.
 *
 * It is a separate primitive from `Sheet` rather than a variant of it. A sheet
 * is a modal that takes over: it dims the screen, traps focus, and is dismissed
 * before anything else happens. This is the opposite gesture in every sense —
 * it comes from the top, it is pulled open by degrees rather than presented,
 * and the feed stays legible underneath because the answer is *about* what you
 * would otherwise be scrolling. Forcing both behaviours through one component
 * would have meant a flag on every rule in it.
 *
 * It opens by expanding. The pill is the panel at rest, and pressing it grows
 * that same box into the full prompt rather than dropping a separate surface
 * over the screen — so the thing you pressed is the thing you get, and there
 * is no moment where the control you touched has vanished and been replaced.
 *
 * It used to be pulled open from a strip along the top edge, which asked the
 * user to know that the edge was draggable. Nothing said so, and on a pointer
 * there is nothing to pull with. The strip is gone; what is left is a button.
 *
 * The contents fade in behind the growth rather than scaling with it. Text
 * scaled from a third of its size arrives blurred and then snaps sharp, which
 * reads as a rendering fault rather than as motion.
 */

const EASING = Easing.bezier(
  MOTION.easing[0],
  MOTION.easing[1],
  MOTION.easing[2],
  MOTION.easing[3],
);

export const ASK_PILL_HEIGHT = 34;
export const ASK_PILL_TOP = 10;
/**
 * The pill's width at rest, which is where the expansion starts.
 *
 * The label needs every pixel of it: the icon, the gap and "Ask for anything"
 * come to almost exactly 152, which is where it was, and at exactly its own
 * width text wraps rather than fits.
 */
const ASK_PILL_WIDTH = 176;
/** How much of the growth is over before the contents begin to appear. */
const CONTENT_FADE_IN = 0.45;
/** The panel never takes more than this much of the screen. */
const MAX_HEIGHT_FRACTION = 0.82;
/**
 * The option square. Wide enough to judge a product by and narrow enough that
 * the next one is visibly there — a rail that shows exactly one option reads
 * as a carousel nobody knows to swipe.
 */
const PICK_WIDTH = 168;

/** One line of the visible transcript. Assistant lines keep their full reply. */
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  reply: ChatResponse | null;
}

export interface AskPanelProps {
  /** Runs one turn. Rejects on failure; the panel renders the reason. */
  onAsk(
    ask: {
      message: string;
      history: Array<{ role: 'user' | 'assistant'; text: string }>;
      standing: ChatResponse['standing'];
    },
    signal: AbortSignal,
  ): Promise<ChatResponse>;
  /**
   * Tapping a pick. The answer's listings become the feed, opened on this one
   * — the app keeps the shopper rather than handing them to the storefront.
   */
  onOpenPick(picks: ChatResponse['picks'], productId: string): boolean;
  /** Told to the parent so it can stand down its own keyboard handling. */
  onOpenChange?(open: boolean): void;
  reducedMotion?: boolean;
}

export function AskPanel({
  onAsk,
  onOpenPick,
  onOpenChange,
  reducedMotion = false,
}: AskPanelProps): React.ReactElement {
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const maxHeight = Math.round(viewportHeight * MAX_HEIGHT_FRACTION);
  // The panel is the one surface pinned to the top edge, so it is the one that
  // has to clear the notch. The prompt is unusable underneath it, and the pull
  // zone has to start below it or the system gesture takes the drag first.
  const topInset = insets.top;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const input = useRef<TextInput>(null);
  const transcript = useRef<ScrollView>(null);
  const inFlight = useRef<AbortController | null>(null);

  // The most recent answer, which is where the conversation currently stands.
  // Only the standing request reads from it — every answer's options stay
  // tappable, but "cheaper" has to refine the latest one, not an older one.
  const latest = [...turns].reverse().find((turn) => turn.role === 'assistant')?.reply ?? null;

  // 0 closed, 1 open. The drag writes it directly from the UI thread so the
  // panel tracks the finger through a busy JS frame.
  const progress = useSharedValue(0);
  // Where the drag started from. A shared value rather than the `open` state
  // because the gesture worklet cannot read React state without a round trip
  // to JS, which is the round trip this whole design exists to avoid.
  const openRef = useSharedValue(0);
  // The panel's own height, measured once it has content. Until then the peek
  // uses the travel distance, which is close enough for an empty prompt.
  // Until the contents have been measured, the pill's own height is the
  // truthful answer: a shut bubble is exactly that tall.
  const height = useSharedValue(ASK_PILL_HEIGHT);

  const settle = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
      if (next) {
        // Focus follows the commitment, never the peek.
        requestAnimationFrame(() => input.current?.focus());
      }
    },
    [onOpenChange],
  );

  const animateTo = useCallback(
    (target: 0 | 1) => {
      openRef.value = target;
      progress.value = withTiming(target, {
        duration: reducedMotion ? 0 : MOTION.sheetMs,
        easing: EASING,
      });
    },
    [progress, openRef, reducedMotion],
  );

  const close = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setAsking(false);
    animateTo(0);
    settle(false);
    input.current?.blur();
  }, [animateTo, settle]);

  const openPanel = useCallback(() => {
    animateTo(1);
    settle(true);
  }, [animateTo, settle]);

  // Escape closes on web, like every other layer in the app.
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  // A panel torn down mid-request must not leave the fetch running.
  useEffect(() => () => inFlight.current?.abort(), []);

  const submit = useCallback(() => {
    const message = draft.trim();
    if (message === '' || asking) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    // The transcript that goes up is the one from before this message, and the
    // standing request is whatever the last answer settled on. Both are read
    // from state here rather than tracked separately, so what the server sees
    // is exactly what the user can see on screen.
    const history = turns.map((turn) => ({ role: turn.role, text: turn.text }));
    const standing = latest?.standing ?? null;

    setTurns((previous) => [...previous, { role: 'user', text: message, reply: null }]);
    setDraft('');
    setAsking(true);
    setError(null);

    void onAsk({ message, history, standing }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTurns((previous) => [
          ...previous,
          { role: 'assistant', text: next.message, reply: next },
        ]);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          (cause as Error)?.message ?? 'Could not reach the assistant. Try again in a moment.',
        );
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setAsking(false);
        inFlight.current = null;
      });
  }, [draft, asking, onAsk, turns, latest]);

  /** Start over. The feed keeps whatever the last answer put there. */
  const reset = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setAsking(false);
    setTurns([]);
    setError(null);
    setDraft('');
    input.current?.focus();
  }, []);

  const openPick = useCallback(
    (picks: ChatResponse['picks'], productId: string) => {
      // The panel only closes if the feed actually took the picks; otherwise
      // the shopper would be dropped onto the old feed with no explanation.
      if (onOpenPick(picks, productId)) close();
    },
    [onOpenPick, close],
  );

  // The pull. Two detectors need it — the top-edge strip that opens the panel
  // and the handle on the panel's own bottom edge that drags it shut — and a
  // gesture instance belongs to one detector, so the rule is built twice from
  // one definition rather than written twice.

  /**
   * The bubble growing into the panel.
   *
   * Every edge is interpolated rather than the whole box being scaled: a
   * scaled box takes its text with it, and text grown from a fifth of its size
   * arrives blurred. Width, height, position and corner radius all travel from
   * the pill's geometry to the panel's, and the contents simply appear inside
   * a box that is already the right shape.
   *
   * `height.value` is measured from the contents, not from this box, which is
   * why the measuring view sits inside rather than being this one — a box
   * whose height is animated cannot also be what reports its natural height.
   */
  const bubbleStyle = useAnimatedStyle(() => {
    const t = progress.value;
    return {
      top: interpolate(t, [0, 1], [topInset + ASK_PILL_TOP, 0]),
      left: interpolate(t, [0, 1], [(viewportWidth - ASK_PILL_WIDTH) / 2, 0]),
      width: interpolate(t, [0, 1], [ASK_PILL_WIDTH, viewportWidth]),
      height: interpolate(t, [0, 1], [ASK_PILL_HEIGHT, Math.min(height.value, maxHeight)]),
      borderRadius: interpolate(t, [0, 1], [ASK_PILL_HEIGHT / 2, 0]),
      // No opacity ramp. At rest this box *is* the pill, so fading it in from
      // nothing leaves the control invisible until someone presses where they
      // cannot see it.
    };
  }, [topInset, viewportWidth, maxHeight]);

  /** The contents, which arrive once the box has most of its size. */
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [CONTENT_FADE_IN, 1], [0, 1]),
  }));

  /** The pill itself, which is what the box looks like while it is small. */
  const pillStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.25], [1, 0]),
  }));

  // The scrim only darkens what the panel does not already cover, and it fades
  // in late: a peek should not dim the feed the user is still reading.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 0.55]),
  }));


  return (
    <View style={styles.layer} pointerEvents="box-none">
      {/* Dims the feed behind an open panel and stops it being scrolled by
          accident. It no longer closes on a tap: there is one close control
          and it is the cross on the prompt row. */}
      <Animated.View style={[styles.scrim, scrimStyle]} pointerEvents={open ? 'auto' : 'none'} />

      <Animated.View
        style={[styles.bubble, bubbleStyle]}
        pointerEvents={open ? 'auto' : 'box-none'}
        accessibilityElementsHidden={false}
      >
        {/* What the box looks like while it is still small. It is the button:
            pressing anywhere on the shut bubble opens it. */}
        {!open ? (
          <PressScale
            onPress={openPanel}
            accessibilityRole="button"
            accessibilityLabel="Ask the shopping assistant"
            style={styles.pillPress}
            contentStyle={styles.pillContent}
          >
            <Animated.View style={[styles.askPillInner, pillStyle]}>
              <Icon name="search" size={16} color={COLORS.textSecondaryLight} />
              <Text style={styles.askPillText} numberOfLines={1}>
                Ask for anything
              </Text>
            </Animated.View>
          </PressScale>
        ) : null}

        {/* The panel's contents. Measured here rather than on the box above,
            whose height is animated — a box cannot both be driven to a height
            and report the height it would naturally take. */}
        <Animated.View
          // Absolute and at the panel's final width, both deliberately. Laid
          // out inside the box it would be as short as the box currently is —
          // and the box's height comes from this measurement, so the two would
          // agree on 34 px forever. At a fixed width it also means the text is
          // never reflowed by the growth, only revealed by it.
          style={[styles.content, { width: viewportWidth }, contentStyle]}
          pointerEvents={open ? 'auto' : 'none'}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          onLayout={(event) => {
            const measured = event.nativeEvent.layout.height;
            if (measured > 0) height.value = measured;
          }}
        >
          <View style={[styles.prompt, { paddingTop: topInset + SPACING.screenMargin }]}>
            <TextInput
              ref={input}
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              placeholder={
                turns.length === 0
                  ? 'Ask for anything — “quiet mechanical keyboard under $80”'
                  : 'Cheaper? In white? Ask a follow-up'
              }
              placeholderTextColor={COLORS.textSecondary}
              returnKeyType="search"
              editable={!asking}
              accessibilityLabel="Ask the shopping assistant"
              multiline={false}
            />
            <PressScale
              onPress={asking ? close : submit}
              disabled={!asking && draft.trim() === ''}
              style={styles.submit}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={asking ? 'Cancel' : 'Ask'}
            >
              {asking ? (
                <ActivityIndicator color={COLORS.textSecondary} />
              ) : (
                <Icon
                  name="check"
                  size={ICON.glyph}
                  color={draft.trim() === '' ? COLORS.textSecondary : COLORS.textPrimary}
                />
              )}
            </PressScale>

            {/* The one way out. On the right of the row that opened, where the
                thing being closed is, rather than at the foot of a panel whose
                length depends on how long the conversation ran. */}
            <PressScale
              onPress={close}
              style={styles.close}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close ask"
            >
              <Icon name="close" size={ICON.glyph} color={COLORS.textSecondary} />
            </PressScale>
          </View>

          {turns.length > 0 || error !== null || asking ? (
            <ScrollView
              ref={transcript}
              style={styles.answer}
              contentContainerStyle={styles.answerContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() =>
                transcript.current?.scrollToEnd({ animated: !reducedMotion })
              }
            >
              {turns.map((turn, index) =>
                turn.role === 'user' ? (
                  <Text
                    key={`u${index}`}
                    style={styles.said}
                    accessibilityLabel={`You asked: ${turn.text}`}
                  >
                    {turn.text}
                  </Text>
                ) : (
                  <AnswerTurn
                    key={`a${index}`}
                    reply={turn.reply as ChatResponse}
                    onOpenPick={openPick}
                  />
                ),
              )}

              {asking ? <Text style={styles.thinking}>Searching Amazon and eBay…</Text> : null}
              {error !== null ? <Text style={styles.error}>{error}</Text> : null}
            </ScrollView>
          ) : null}

          {/* Starting over is not closing, so it keeps its own place. The
              handle that used to drag the panel shut is gone with the pull. */}
          {turns.length > 0 ? (
            <View style={styles.footer}>
              <PressScale
                onPress={reset}
                hitSlop={8}
                style={styles.restart}
                accessibilityRole="button"
                accessibilityLabel="Start a new conversation"
              >
                <Text style={styles.restartLabel}>New</Text>
              </PressScale>
            </View>
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/**
 * One answer in the transcript: what was said, the constraints in force, and
 * the listings it found.
 *
 * Every answer stays usable, not just the newest. An earlier turn is not a
 * stale record — those listings are as live as the ones below them, and
 * "the second one you showed me" is a normal way to shop a conversation. So
 * the rails scroll and the options open however far back you go; tapping one
 * seeds the feed from *that* turn's picks, not the latest.
 */
function AnswerTurn({
  reply,
  onOpenPick,
}: {
  reply: ChatResponse;
  onOpenPick(picks: ChatResponse['picks'], productId: string): void;
}): React.ReactElement {
  // An option is a picture. One without an image cannot be judged here and
  // would open as a black card in the feed, so it is not offered at all.
  const options = reply.picks.filter((pick) => pick.imageUrl !== null);
  const constraints = [
    reply.budgetMinor !== null ? `under $${(reply.budgetMinor / 100).toFixed(2)}` : null,
    ...reply.requirements,
  ].filter((part): part is string => part !== null);

  return (
    <View>
      <Text style={styles.message}>{reply.message}</Text>

      {constraints.length > 0 ? (
        <Text style={styles.constraints}>{constraints.join(' · ')}</Text>
      ) : null}

      {options.length > 0 ? (
        /* A horizontal rail: options sit side by side to be compared at a
           glance, and the transcript stays short enough to scroll. */
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
          keyboardShouldPersistTaps="handled"
        >
          {options.map((pick) => (
            <PickRow
              key={pick.productId}
              pick={pick}
              onPress={() => onOpenPick(reply.picks, pick.productId)}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * One option, led by its picture.
 *
 * The product is the interface here as much as it is in the feed, so the image
 * is the option rather than an icon beside it: a square big enough to judge
 * the thing by, with the words underneath it. A row of 64px thumbnails asked
 * the shopper to choose between five paragraphs.
 *
 * Tapping does not leave for the storefront. It hands the answer to the feed
 * and opens this listing there, which is the whole point — the app is where
 * the scrolling happens, and a link out is the end of the session.
 */
function PickRow({
  pick,
  onPress,
}: {
  pick: ChatResponse['picks'][number];
  onPress(): void;
}): React.ReactElement {
  const price = `$${(pick.priceMinor / 100).toFixed(2)}`;
  return (
    <Pressable
      onPress={onPress}
      style={styles.pick}
      accessibilityRole="button"
      accessibilityLabel={`${pick.title}, ${price} on ${pick.sourceDomain ?? 'the store'}`}
      accessibilityHint="Opens this listing in the feed"
    >
      <Image
        source={{ uri: pick.imageUrl ?? undefined }}
        style={styles.shot}
        contentFit="cover"
        transition={0}
        accessibilityIgnoresInvertColors
      />

      <Text style={styles.pickPrice}>
        {price}
        <Text style={styles.pickDomain}>
          {pick.sourceDomain !== null ? `  ${pick.sourceDomain}` : ''}
        </Text>
      </Text>
      <Text style={styles.pickTitle} numberOfLines={2}>
        {pick.title}
      </Text>
      {pick.reviewNote !== null ? (
        <Text style={styles.pickReview} numberOfLines={1}>
          {pick.reviewNote}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    // Above the feed and the rail, below a sheet: a sheet is modal and this
    // is not, so a sheet opened from a pick still covers this.
    zIndex: 90,
  },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
  /**
   * The box that grows. Its geometry is entirely animated, so nothing here
   * sets a size — and it clips, because the contents inside are laid out at
   * full width the whole time and would otherwise spill out of a pill.
   */
  bubble: {
    position: 'absolute',
    backgroundColor: COLORS.sheet,
    overflow: 'hidden',
  },
  pillPress: { ...StyleSheet.absoluteFillObject },
  pillContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { position: 'absolute', top: 0, left: 0 },
  close: {
    width: ICON.minTarget,
    height: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: SPACING.screenMargin,
    paddingRight: 4,
    minHeight: ICON.minTarget,
  },
  input: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    paddingVertical: 10,
    // RN web draws a focus ring that fights the app's own focus treatment.
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as never } : null),
  },
  submit: {
    width: ICON.minTarget,
    height: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // React Native does not default `flexShrink` to 1 the way the web does, so
  // without this the answers push the footer handle out of the capped panel.
  answer: { flexGrow: 0, flexShrink: 1 },
  answerContent: { paddingBottom: 8 },
  /** What the shopper said, set apart from what the assistant answered. */
  said: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 16,
  },
  message: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 12,
  },
  constraints: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 4,
  },
  thinking: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 12,
  },
  error: {
    color: COLORS.accent,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 12,
  },
  rail: {
    paddingHorizontal: SPACING.screenMargin,
    paddingTop: 14,
    gap: 12,
  },
  pick: { width: PICK_WIDTH },
  shot: {
    width: PICK_WIDTH,
    height: PICK_WIDTH,
    backgroundColor: COLORS.backdrop,
  },
  pickTitle: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    marginTop: 2,
  },
  pickPrice: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.price,
    lineHeight: TYPE.lineHeights.price,
    fontWeight: TYPE.weights.semibold,
    marginTop: 8,
  },
  pickDomain: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    fontWeight: TYPE.weights.regular,
  },
  pickReview: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    marginTop: 4,
  },
  // Holds only "New" now. The handle that dragged the panel shut went with
  // the pull, and the cross moved up to the prompt row.
  footer: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  askPill: {
    minHeight: ICON.minTarget,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  askPillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: ASK_PILL_HEIGHT,
    paddingHorizontal: 14,
    borderRadius: RADIUS.tile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairlineLight,
    backgroundColor: COLORS.card,
  },
  askPillText: {
    // `card` is white. The default secondary ink is white too, so the label
    // was white on white — present in the accessibility tree and invisible on
    // the screen.
    color: COLORS.textSecondaryLight,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
  },
  restart: {
    position: 'absolute',
    // Was inset to clear the close control that used to sit beside it here.
    right: SPACING.screenMargin,
    height: ICON.minTarget,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restartLabel: {
    color: COLORS.textSecondary,
    fontSize: TYPE.sizes.small,
    lineHeight: TYPE.lineHeights.small,
    fontWeight: TYPE.weights.semibold,
  },
});
