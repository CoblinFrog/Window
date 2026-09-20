import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, SESSION_CONFIG } from '@window/shared';
import { cacheKeys, type KeyValueCache } from '../cache/index.js';
import { logger } from '../lib/logger.js';
import { secretsAreProduction } from '../config/secrets.js';

const log = logger.child('claims');

/**
 * Claiming an anonymous profile.
 *
 * This is the only path in the system that raises a principal's privilege — it
 * is what turns a browser into an account that may spend money — so it is the
 * one place where an unverified assertion costs the most. The previous version
 * refused unverified Apple and Google tokens but accepted the email path with
 * any token and any address, which meant the gate on placing orders was a
 * single unauthenticated field.
 *
 * Both paths now prove ownership or refuse. Neither pretends.
 */

// ---------------------------------------------------------------------------
// Email ownership
// ---------------------------------------------------------------------------

interface StoredChallenge {
  /** SHA-256 of the code. The code itself is never stored, only delivered. */
  codeHash: string;
  email: string;
  attempts: number;
  issuedAt: number;
}

/**
 * Delivers a verification code out of band.
 *
 * The interface exists so that "we send an email" is a dependency rather than
 * an assumption. Without a configured transport, production refuses to issue
 * challenges at all — an unsendable code is a verification step that silently
 * degrades into no verification step.
 */
export interface Mailer {
  readonly kind: 'logging' | 'smtp';
  send(to: string, code: string): Promise<void>;
}

/**
 * Development transport: the code goes to the server log and to a local file.
 *
 * The file is what lets the end-to-end smoke test complete a real claim without
 * a test-only bypass in the claim route itself. That distinction matters: a
 * backdoor in the verification path is a backdoor in production too, whereas a
 * file written by a transport that production refuses to construct cannot
 * exist there. The smoke test reads the same code a human would read out of
 * their inbox, and the code it reads is checked by the same verifier.
 */
export class LoggingMailer implements Mailer {
  readonly kind = 'logging' as const;

  constructor(private readonly outbox = DEV_OUTBOX_DIR) {}

  async send(to: string, code: string): Promise<void> {
    log.warn('email verification code issued to the log, not to an inbox', {
      to,
      code,
      note: 'Development transport. Production refuses to boot without a real one.',
    });

    try {
      await mkdir(this.outbox, { recursive: true });
      await writeFile(
        join(this.outbox, `${devOutboxName(to)}.json`),
        JSON.stringify({ to, code, sentAt: new Date().toISOString() }),
      );
    } catch (error) {
      log.debug('could not write the development outbox', { error: (error as Error).message });
    }
  }
}

/** Where the development transport drops codes. Never written in production. */
export const DEV_OUTBOX_DIR = new URL('../../../../.data/dev-mail', import.meta.url).pathname;

/** Address to filename, with no path separators surviving the trip. */
export function devOutboxName(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 32);
}

export function createMailer(): Mailer {
  if (secretsAreProduction) {
    // Deliberately loud, in the same spirit as the payment rail: a claim flow
    // that cannot deliver a code must not quietly accept one.
    throw new Error(
      'No mail transport is configured. Email claims cannot be verified without one; ' +
        'wire a Mailer implementation before enabling the email provider in production.',
    );
  }
  return new LoggingMailer();
}

/** A six-digit code from the CSPRNG. `Math.random` is a sequence, not a secret. */
function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Normalizes an address for comparison and storage.
 *
 * Case-folding the domain is required; case-folding the local part is a
 * deliberate choice, because treating `A@x` and `a@x` as different accounts
 * creates two profiles for one human and a support ticket nobody can resolve.
 */
export function normalizeEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) throw ApiError.validation('That is not an email address.');
  return `${email.slice(0, at).toLowerCase()}@${email.slice(at + 1).toLowerCase()}`;
}

/**
 * Issues a challenge for one user and one address.
 *
 * Exactly one challenge is live per user: re-requesting overwrites, so a
 * thousand requests leave one valid code rather than a thousand.
 */
export async function issueEmailChallenge(
  cache: KeyValueCache,
  mailer: Mailer,
  userId: string,
  email: string,
  now = Date.now(),
): Promise<{ expiresAt: Date }> {
  const normalized = normalizeEmail(email);
  const code = mintCode();

  const challenge: StoredChallenge = {
    codeHash: hashCode(code),
    email: normalized,
    attempts: 0,
    issuedAt: now,
  };
  await cache.set(cacheKeys.emailChallenge(userId), challenge, SESSION_CONFIG.emailCodeTtlMs);
  await mailer.send(normalized, code);

  return { expiresAt: new Date(now + SESSION_CONFIG.emailCodeTtlMs) };
}

export type ChallengeResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'no_challenge' | 'wrong_address' | 'bad_code' | 'too_many_attempts' };

/**
 * Checks a submitted code.
 *
 * A wrong code burns an attempt and, past the ceiling, the whole challenge. The
 * ceiling is what makes a six-digit code sound: a million possibilities is
 * nothing to a script that may guess forever, and plenty against one that gets
 * five tries per ten minutes.
 */
export async function verifyEmailChallenge(
  cache: KeyValueCache,
  userId: string,
  email: string,
  code: string,
): Promise<ChallengeResult> {
  const key = cacheKeys.emailChallenge(userId);
  const challenge = await cache.get<StoredChallenge>(key);
  if (!challenge) return { ok: false, reason: 'no_challenge' };

  let normalized: string;
  try {
    normalized = normalizeEmail(email);
  } catch {
    return { ok: false, reason: 'wrong_address' };
  }

  if (challenge.email !== normalized) {
    // The challenge is bound to the address it was sent to, so a code delivered
    // to an inbox the caller controls cannot be redeemed against another.
    return { ok: false, reason: 'wrong_address' };
  }

  const provided = Buffer.from(hashCode(code), 'hex');
  const expected = Buffer.from(challenge.codeHash, 'hex');
  const matches = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!matches) {
    const attempts = challenge.attempts + 1;
    if (attempts >= SESSION_CONFIG.emailCodeMaxAttempts) {
      await cache.del(key);
      return { ok: false, reason: 'too_many_attempts' };
    }
    await cache.set(key, { ...challenge, attempts }, SESSION_CONFIG.emailCodeTtlMs);
    return { ok: false, reason: 'bad_code' };
  }

  // Single use. A correct code is spent whether or not the claim that follows
  // succeeds, so it can never be replayed against a second account.
  await cache.del(key);
  return { ok: true, email: normalized };
}

// ---------------------------------------------------------------------------
// OAuth / OIDC
// ---------------------------------------------------------------------------

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Verifies an Apple or Google ID token.
 *
 * A real implementation fetches the provider's JWKS, checks the signature, the
 * issuer, the audience against our own client id, the expiry, and the nonce
 * bound to the sign-in attempt. None of that is configured here, so the
 * implementation below refuses rather than returning a plausible identity —
 * the same rule the payment rail follows, for the same reason: a verification
 * step that pretends to work is worse than one that is absent, because the
 * absent one is visible.
 */
export interface OidcVerifier {
  readonly configured: boolean;
  verify(provider: 'apple' | 'google', idToken: string): Promise<VerifiedIdentity>;
}

export class UnconfiguredOidcVerifier implements OidcVerifier {
  readonly configured = false;

  async verify(provider: 'apple' | 'google'): Promise<VerifiedIdentity> {
    throw ApiError.validation(
      `${provider} sign-in needs ID-token verification against the provider's JWKS, which is ` +
        'not configured. Claims from this provider are refused rather than trusted.',
    );
  }
}

export function createOidcVerifier(): OidcVerifier {
  return new UnconfiguredOidcVerifier();
}
