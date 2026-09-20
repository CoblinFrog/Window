import React, { useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { goBackOrFeed } from '../src/navigation.js';
import {
  COLORS,
  RADIUS,
  SPACING,
  TYPE,
  formatMoney,
  formatTimeRemaining,
  type CheckoutInputPrompt,
  type CheckoutJobSummary,
  type OrderStatus,
} from '@window/shared';
import { Icon } from '../src/components/Icon.js';
import { useCheckout, type CouponAttempt } from '../src/store/checkout.js';

/**
 * Quote and authorization.
 *
 * One card per merchant job, and they never merge. The agent has navigated,
 * filled and tried codes on its own; it stops here, at the last screen before
 * money moves, and nothing crosses that line without a tap against the exact
 * numbers on screen.
 */

const STATUS_WORD: Record<OrderStatus, string> = {
  pending: 'Not started',
  quoting: 'Working at the merchant',
  awaiting_auth: 'Waiting for you',
  placing: 'Placing the order',
  placed: 'Order placed',
  uncertain: 'Unconfirmed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * The shared helper reports in minutes, which is the right grain for an auction
 * and the wrong one for the last sixty seconds of a ten-minute quote.
 */
function expiryLabel(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return null;
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return formatTimeRemaining(expiresAt, new Date(now));
}

/**
 * A coupon attempt carries no currency of its own, so the amount is only shown
 * once the quote has told us which one it is. An unlabelled number next to a
 * price is worse than no number.
 */
function couponLine(attempt: CouponAttempt, currency: string | null): string {
  if (!attempt.ok) return `${attempt.code} — ${attempt.reason ?? 'not accepted'}`;
  if (!currency || attempt.discount <= 0) return `${attempt.code} applied`;
  return `${attempt.code} applied — ${formatMoney({ amount: attempt.discount, currency })} off at the merchant`;
}

interface ControlProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** 44 px floor, an accessible name, and a keyboard focus ring on web. */
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

interface PromptProps {
  jobId: string;
  prompt: CheckoutInputPrompt;
}

/**
 * `request_user_input`.
 *
 * Options are rendered as real controls. A CAPTCHA, a one-time code or a 3-D
 * Secure step is handed to the user in full, and the copy says so plainly: the
 * agent never requests, reads or handles a one-time code.
 */
function Prompt({ jobId, prompt }: PromptProps): React.ReactElement {
  const answerPrompt = useCheckout((state) => state.answerPrompt);
  const [text, setText] = useState('');

  const handoff =
    prompt.kind === 'captcha' || prompt.kind === 'twofa' || prompt.kind === 'three_ds';

  return (
    <View style={styles.block}>
      <Text style={styles.sectionTitle}>The agent needs you</Text>
      <Text style={styles.bodyText}>{prompt.message}</Text>

      {handoff ? (
        <View style={styles.blockInner}>
          <Text style={styles.smallText}>
            {prompt.kind === 'twofa'
              ? 'You will enter this code yourself. Window never asks for, reads or types a one-time code on your behalf.'
              : prompt.kind === 'three_ds'
                ? 'Your bank needs to check this with you directly. You complete it yourself; the agent waits.'
                : 'The merchant is asking for a human check. You solve it yourself and the agent resumes from where it stopped.'}
          </Text>
          <Control
            label="Open the live view to continue"
            disabled={!prompt.handoffUrl}
            onPress={() => {
              if (prompt.handoffUrl) void Linking.openURL(prompt.handoffUrl);
            }}
            style={styles.inlineButton}
          >
            <Icon name="link" size={20} />
            <Text style={styles.inlineButtonText}>Open the live view</Text>
          </Control>
          {prompt.handoffUrl ? <Text style={styles.smallText}>{prompt.handoffUrl}</Text> : null}
          <Control
            label="I have finished, resume the job"
            onPress={() => void answerPrompt(jobId, prompt.promptId, 'done')}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>I have finished</Text>
          </Control>
        </View>
      ) : null}

      {!handoff && prompt.options && prompt.options.length > 0
        ? prompt.options.map((option) => (
            <Control
              key={option.id}
              label={`Choose ${option.label}${option.detail ? `, ${option.detail}` : ''}`}
              onPress={() => void answerPrompt(jobId, prompt.promptId, option.id)}
              style={styles.optionButton}
            >
              <View style={styles.optionBody}>
                <Text style={styles.bodyText}>{option.label}</Text>
                {option.detail ? <Text style={styles.smallText}>{option.detail}</Text> : null}
              </View>
            </Control>
          ))
        : null}

      {!handoff && (!prompt.options || prompt.options.length === 0) ? (
        <View style={styles.blockInner}>
          <TextInput
            value={text}
            onChangeText={setText}
            accessibilityLabel={prompt.message}
            placeholder="Your answer"
            placeholderTextColor={COLORS.textSecondary}
            style={styles.input}
          />
          <Control
            label="Send this answer to the agent"
            disabled={text.trim().length === 0}
            onPress={() => void answerPrompt(jobId, prompt.promptId, text.trim())}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>Send</Text>
          </Control>
        </View>
      ) : null}
    </View>
  );
}

interface JobCardProps {
  job: CheckoutJobSummary;
  now: number;
}

function JobCard({ job, now }: JobCardProps): React.ReactElement {
  const steps = useCheckout((state) => state.steps[job.jobId]) ?? [];
  const attempts = useCheckout((state) => state.couponAttempts[job.jobId]) ?? [];
  const conflict = useCheckout((state) => state.conflict[job.jobId]) ?? null;
  const jobError = useCheckout((state) => state.jobError[job.jobId]) ?? null;
  const authorizing = useCheckout((state) => state.authorizing[job.jobId]) ?? false;
  const cancelling = useCheckout((state) => state.cancelling[job.jobId]) ?? false;
  const overdue = useCheckout((state) => state.overdue[job.jobId]) ?? false;
  const authorize = useCheckout((state) => state.authorize);
  const cancel = useCheckout((state) => state.cancel);
  const start = useCheckout((state) => state.start);

  const quote = job.quote;
  const remaining = quote ? expiryLabel(quote.expiresAt, now) : null;
  const expired = quote !== null && remaining === null;
  const authorizable =
    quote !== null &&
    !expired &&
    job.status === 'awaiting_auth' &&
    job.needsInput === null &&
    !authorizing;
  const cancellable =
    job.status === 'pending' ||
    job.status === 'quoting' ||
    job.status === 'awaiting_auth';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.sectionTitle}>{job.merchantName}</Text>
        {/* A word, not a hue: nothing here communicates through colour alone. */}
        <Text style={styles.smallText}>{STATUS_WORD[job.status]}</Text>
      </View>

      {job.items.map((item) => (
        <Text key={item.productId} style={styles.smallText} numberOfLines={1}>
          {item.quantity} × {item.title}
        </Text>
      ))}

      {steps.length > 0 && !quote ? (
        <View style={styles.blockInner}>
          {steps.slice(-5).map((step, index) => (
            <Text key={`${step}-${index}`} style={styles.smallText}>
              {step}
            </Text>
          ))}
        </View>
      ) : null}

      {attempts.length > 0 ? (
        <View style={styles.blockInner}>
          <Text style={styles.smallText}>Codes tried at the merchant</Text>
          {attempts.map((attempt, index) => (
            <Text key={`${attempt.code}-${index}`} style={styles.smallText}>
              {couponLine(attempt, quote?.currency ?? null)}
            </Text>
          ))}
        </View>
      ) : null}

      {overdue && !quote ? (
        <Text style={styles.smallText}>
          This job has been running longer than its 180 second limit. It will stop on its own; the
          cart is kept either way.
        </Text>
      ) : null}

      {job.riskInterstitial ? (
        <View style={styles.interstitial}>
          <Icon name="warning" size={20} />
          {/* Shown verbatim. Softening a specific caution into "this may be
              risky" is how a caution stops being read. */}
          <Text style={styles.noticeText}>{job.riskInterstitial}</Text>
        </View>
      ) : null}

      {quote ? (
        <View style={styles.quote}>
          <Row label="Item price" value={{ amount: quote.subtotal, currency: quote.currency }} />
          <Row label="Shipping" value={{ amount: quote.shipping, currency: quote.currency }} />
          <Row label="Tax" value={{ amount: quote.tax, currency: quote.currency }} />
          <Row
            label="Discount"
            value={{ amount: quote.discount, currency: quote.currency }}
            negated={quote.discount > 0}
          />
          <View style={styles.totalRow}>
            <Text style={styles.bodyText}>Total</Text>
            <Text style={styles.price}>
              {formatMoney({ amount: quote.total, currency: quote.currency })}
            </Text>
          </View>
          {job.savings ? (
            <Text style={styles.smallText}>
              {formatMoney(job.savings)} less than the merchant's own total before the code
              {job.coupon ? ` ${job.coupon.code}` : ''}.
            </Text>
          ) : null}
          {job.protocol && job.protocol !== 'browser' ? (
            <Text style={styles.smallText}>Checked out over the merchant's agent protocol.</Text>
          ) : null}
        </View>
      ) : null}

      {job.needsInput ? <Prompt jobId={job.jobId} prompt={job.needsInput} /> : null}

      {quote && job.status === 'awaiting_auth' ? (
        <View style={styles.blockInner}>
          <Text style={styles.smallText}>
            {remaining
              ? `This quote holds for ${remaining}. After that it has to be re-run.`
              : 'This quote has expired. Re-run it to see current prices.'}
          </Text>
          <Control
            label={`Authorize ${formatMoney({ amount: quote.total, currency: quote.currency })} at ${job.merchantName}`}
            disabled={!authorizable}
            onPress={() => void authorize(job.jobId)}
            style={[styles.primary, authorizable ? null : styles.primaryDisabled]}
          >
            <Text style={styles.primaryText}>
              {authorizing
                ? 'Authorizing…'
                : expired
                  ? 'Quote expired'
                  : `Authorize ${formatMoney({ amount: quote.total, currency: quote.currency })}`}
            </Text>
          </Control>
        </View>
      ) : null}

      {conflict ? (
        <View style={styles.blockInner}>
          <Text style={styles.bodyText}>{conflict}</Text>
          <Control
            label="Re-run the quote"
            onPress={() => void start()}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>Re-run the quote</Text>
          </Control>
        </View>
      ) : null}

      {jobError ? <Text style={styles.bodyText}>{jobError}</Text> : null}

      {job.status === 'placed' ? (
        <Text style={styles.bodyText}>
          Order placed at {job.merchantName}
          {job.merchantOrderNumber ? `. Merchant order number ${job.merchantOrderNumber}.` : '.'}
        </Text>
      ) : null}

      {job.status === 'uncertain' ? (
        <Text style={styles.bodyText}>
          Unconfirmed. The order was submitted but the merchant's confirmation could not be read,
          so this is being verified against their order history. It will not be submitted a second
          time.
        </Text>
      ) : null}

      {job.status === 'failed' ? (
        <View style={styles.blockInner}>
          <Text style={styles.bodyText}>
            Failed — {job.failure?.message ?? 'the job stopped before anything was submitted.'}
          </Text>
          <Text style={styles.smallText}>Nothing was charged. The cart is kept.</Text>
          <Control
            label={`Open ${job.merchantDomain} to finish manually`}
            onPress={() => void Linking.openURL(`https://${job.merchantDomain}`)}
            style={styles.inlineButton}
          >
            <Icon name="link" size={20} />
            <Text style={styles.inlineButtonText}>Finish at {job.merchantDomain}</Text>
          </Control>
        </View>
      ) : null}

      {job.status === 'cancelled' ? (
        <Text style={styles.bodyText}>Cancelled. Nothing was submitted.</Text>
      ) : null}

      {cancellable ? (
        <Control
          label={`Cancel the ${job.merchantName} job`}
          disabled={cancelling}
          onPress={() => void cancel(job.jobId)}
          style={styles.inlineButton}
        >
          <Text style={styles.inlineButtonText}>{cancelling ? 'Cancelling…' : 'Cancel'}</Text>
        </Control>
      ) : null}
    </View>
  );
}

function Row({
  label,
  value,
  negated = false,
}: {
  label: string;
  value: { amount: number; currency: string };
  negated?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.smallText}>{label}</Text>
      <Text style={styles.smallText}>
        {negated ? '−' : ''}
        {formatMoney(value)}
      </Text>
    </View>
  );
}

export default function CheckoutScreen(): React.ReactElement {
  const router = useRouter();
  const jobIds = useCheckout((state) => state.jobIds);
  const jobs = useCheckout((state) => state.jobs);
  const phase = useCheckout((state) => state.phase);
  const error = useCheckout((state) => state.error);
  const start = useCheckout((state) => state.start);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (useCheckout.getState().phase === 'idle') void start();
    // Every stream and timer belongs to this screen; leaving one behind would
    // keep polling a merchant after the user walked away.
    return () => useCheckout.getState().teardown();
  }, [start]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Control label="Back to cart" onPress={goBackOrFeed} style={styles.headerButton}>
          <Icon name="back" size={20} />
        </Control>
        <Text style={styles.headerTitle}>Checkout</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {jobIds.length > 1 ? (
          <Text style={styles.smallText}>
            {jobIds.length} merchants, {jobIds.length} separate orders. Each one is authorized on
            its own and reports on its own.
          </Text>
        ) : null}

        {phase === 'quoting' && jobIds.length === 0 ? (
          <Text style={styles.smallText}>Opening the merchants…</Text>
        ) : null}

        {phase === 'error' ? (
          <View style={styles.blockInner}>
            <Text style={styles.bodyText}>{error}</Text>
            <Control label="Try the quote again" onPress={() => void start()} style={styles.inlineButton}>
              <Text style={styles.inlineButtonText}>Try again</Text>
            </Control>
          </View>
        ) : null}

        {jobIds.map((jobId) => {
          const job = jobs[jobId];
          return job ? <JobCard key={jobId} job={job} now={now} /> : null;
        })}
      </ScrollView>
    </View>
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
  body: { padding: SPACING.screenMargin, gap: 24, paddingBottom: 48 },
  card: {
    gap: 8,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
    fontWeight: TYPE.weights.semibold,
  },
  block: {
    gap: 8,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    borderRadius: RADIUS.media,
  },
  blockInner: { gap: 8 },
  interstitial: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    borderRadius: RADIUS.media,
  },
  noticeText: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    lineHeight: TYPE.lineHeights.body,
  },
  quote: { gap: 4, marginTop: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 4,
  },
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
  inlineButton: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
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
  optionButton: {
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    borderRadius: RADIUS.media,
  },
  optionBody: { gap: 2 },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    color: COLORS.textPrimary,
    fontSize: TYPE.sizes.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    borderRadius: RADIUS.media,
  },
  primary: {
    alignSelf: 'flex-start',
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
