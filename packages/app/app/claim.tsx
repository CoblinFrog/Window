import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, SPACING, TYPE } from '@window/shared';
import { api, setAuthToken } from '../src/api/client.js';
import { useSession } from '../src/store/session.js';

/**
 * Claiming the profile.
 *
 * Browsing is anonymous by design — there is no sign-in wall before the feed —
 * but placing an order is not, because an order is a real charge against a real
 * person and an unverified identity cannot be one. This is the one screen that
 * crosses that line, and it is deliberately the smallest thing that can: an
 * address, a code sent to it, and nothing else. No password to forget, no
 * profile to fill in, no data collected that checkout does not need.
 *
 * The interest model built while browsing carries over. Losing a week of
 * behaviour at sign-in is the fastest way to make an account feel like a
 * downgrade, so the device identity is kept and upgraded rather than replaced.
 */
export default function ClaimScreen(): React.ReactElement {
  const router = useRouter();
  const session = useSession();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code' | 'done'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startEmailClaim(email.trim());
      setStage('code');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [email]);

  const submitCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.claimWithEmailCode(email.trim(), code.trim());
      // The claim regenerates the session, so the token minted before it is
      // already revoked. Adopting the new one immediately keeps the next
      // request from 401-ing on a credential that was valid a second ago.
      setAuthToken(token);
      setStage('done');
      await session.refreshSession().catch(() => undefined);
      router.back();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [email, code, router, session]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>
        {stage === 'email' ? 'Confirm your email' : 'Enter the code'}
      </Text>
      <Text style={styles.subtitle}>
        {stage === 'email'
          ? 'Browsing stays anonymous. Placing an order needs an address we can send the receipt to.'
          : `We sent a six-digit code to ${email.trim()}. It expires in ten minutes.`}
      </Text>

      {stage === 'email' ? (
        <TextInput
          style={styles.field}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={COLORS.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          accessibilityLabel="Email address"
          onSubmitEditing={() => void sendCode()}
        />
      ) : (
        <TextInput
          style={styles.field}
          value={code}
          onChangeText={setCode}
          placeholder="123456"
          placeholderTextColor={COLORS.textSecondary}
          keyboardType="number-pad"
          maxLength={6}
          accessibilityLabel="Verification code"
          onSubmitEditing={() => void submitCode()}
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, busy ? styles.buttonBusy : null]}
        disabled={busy}
        accessibilityRole="button"
        onPress={() => void (stage === 'email' ? sendCode() : submitCode())}
      >
        <Text style={styles.buttonText}>
          {busy ? 'Working…' : stage === 'email' ? 'Send code' : 'Confirm'}
        </Text>
      </Pressable>

      {stage === 'code' ? (
        <Pressable accessibilityRole="button" onPress={() => setStage('email')}>
          <Text style={styles.secondary}>Use a different address</Text>
        </Pressable>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => router.back()}>
        <Text style={styles.secondary}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.surface,
    padding: SPACING.screenMargin * 1.5,
    justifyContent: 'center',
    gap: SPACING.screenMargin,
  },
  title: { color: COLORS.textPrimary, fontSize: TYPE.sizes.price, fontWeight: TYPE.weights.semibold },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.sizes.body, lineHeight: TYPE.lineHeights.body },
  field: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: COLORS.textPrimary,
    borderRadius: 10,
    paddingHorizontal: SPACING.screenMargin,
    paddingVertical: SPACING.screenMargin * 0.75,
    fontSize: TYPE.sizes.body,
  },
  button: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: SPACING.screenMargin * 0.75,
    alignItems: 'center',
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { color: COLORS.textPrimary, fontSize: TYPE.sizes.body, fontWeight: TYPE.weights.semibold },
  secondary: { color: COLORS.textSecondary, fontSize: TYPE.sizes.small, textAlign: 'center' },
  error: { color: COLORS.accent, fontSize: TYPE.sizes.small },
});
