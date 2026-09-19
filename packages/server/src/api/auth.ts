import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  ApiError,
  EMBEDDING_DIM,
  SESSION_CONFIG,
  type UserDoc,
} from '@window/shared';
import type { CollectionSet, User } from '../db/collections.js';
import { createBloom, serializeBloom } from '../lib/bloom.js';
import { requireSecret } from '../config/secrets.js';

/**
 * Identity.
 *
 * Anonymous device principals are first-class: there is no sign-in wall before
 * the feed — the single most common way feed products lose their funnel — so an
 * anonymous principal can do everything except place orders and link merchant
 * accounts.
 *
 * What makes that safe is the distinction this file draws between a *handle*
 * and a *secret*. `deviceUserId` is a public handle: stable, loggable,
 * returnable. The device secret is the credential, it is minted here with a
 * CSPRNG, and only its hash is ever stored — so a dump of the users collection
 * yields no way to authenticate as anybody. An identity a client can choose for
 * itself is an identity any client can choose for somebody else.
 */

export interface Principal {
  userId: ObjectId;
  /** The public handle, never the secret. */
  deviceUserId: string;
  /** Recomputed from the user document on every request, never read from the token. */
  isAnonymous: boolean;
  /** Session generation; a mismatch with the user document revokes the token. */
  epoch: number;
}

const SECRET = requireSecret('AUTH_SECRET');

/** Bumped when the token format changes, so old tokens fail closed rather than misparse. */
const TOKEN_VERSION = 'v2';
const AUDIENCE = 'window.api';

interface TokenPayload {
  /** Subject: the user id. */
  sub: string;
  /** Public device handle. */
  dev: string;
  /** Session epoch, checked against the user document. */
  epc: number;
  /** Issued at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. Absent in a v1 token, which is why v1 is refused. */
  exp: number;
  aud: string;
}

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** Hashes a bearer-grade secret for storage. The plaintext is never persisted. */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** 256 bits from the system CSPRNG. Not `Math.random`, which is seeded state, not entropy. */
export function mintDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** A public, non-secret handle for a device. Safe in logs, responses and traces. */
export function mintDeviceHandle(): string {
  return `dev_${randomBytes(8).toString('hex')}`;
}

export function mintToken(principal: Principal, now = Date.now()): string {
  const body: TokenPayload = {
    sub: principal.userId.toHexString(),
    dev: principal.deviceUserId,
    epc: principal.epoch,
    iat: now,
    exp: now + SESSION_CONFIG.tokenTtlMs,
    aud: AUDIENCE,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${sign(payload)}`;
}

/**
 * Verifies a token's signature, audience and expiry.
 *
 * It deliberately does *not* decide what the principal may do. `exp` bounds how
 * long a stolen token is useful; the epoch and the privilege level are settled
 * against the database in `authenticate`, because a token is a claim about the
 * past and authorization is a question about the present.
 */
export function verifyToken(token: string, now = Date.now()): Omit<Principal, 'isAnonymous'> {
  const parts = token.split('.');
  if (parts.length !== 3) throw ApiError.unauthorized('Malformed token.');

  const [version, payload, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) {
    // v1 tokens had no expiry and no epoch. There is no safe way to honour one.
    throw ApiError.unauthorized('Token format is no longer accepted; re-authenticate.');
  }

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Constant-time comparison: a token check that leaks timing leaks the token.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('Invalid token signature.');
  }

  let decoded: TokenPayload;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload;
  } catch {
    throw ApiError.unauthorized('Unreadable token.');
  }

  if (decoded.aud !== AUDIENCE) throw ApiError.unauthorized('Token was issued for another audience.');
  if (typeof decoded.exp !== 'number' || decoded.exp <= now) {
    throw ApiError.unauthorized('This session has expired; re-authenticate with the device secret.');
  }
  // A token dated in the future is either a clock problem or a forgery attempt
  // against a leaked key; neither is something to serve a feed for.
  if (typeof decoded.iat !== 'number' || decoded.iat > now + SESSION_CONFIG.clockSkewMs) {
    throw ApiError.unauthorized('Token is not yet valid.');
  }
  if (typeof decoded.sub !== 'string' || !ObjectId.isValid(decoded.sub)) {
    throw ApiError.unauthorized('Token subject is not an identity.');
  }

  return {
    userId: new ObjectId(decoded.sub),
    deviceUserId: typeof decoded.dev === 'string' ? decoded.dev : '',
    epoch: typeof decoded.epc === 'number' ? decoded.epc : 0,
  };
}

/**
 * Creates a brand-new anonymous identity, returning the secret exactly once.
 *
 * The document is created on first contact rather than at onboarding, because
 * the topic picker itself needs somewhere to write and the user has not agreed
 * to anything yet.
 */
export async function createDeviceUser(
  collections: CollectionSet,
  now = new Date(),
): Promise<{ user: User; deviceSecret: string }> {
  const deviceSecret = mintDeviceSecret();

  const blank: Omit<UserDoc<ObjectId>, '_id'> = {
    deviceUserId: mintDeviceHandle(),
    deviceSecretHash: hashDeviceSecret(deviceSecret),
    sessionEpoch: 1,
    auth: null,
    onboarding: null,
    // Null until the topic picker seeds it; retrieval falls back to the whole
    // taxonomy in the meantime, which is what makes a shared link work.
    interestVector: null,
    interestSet: [],
    explorationState: { counter: 0, lastTopic: null, rejected: [], pending: [] },
    pricePrior: { center: 8000, currency: 'USD', confidence: 0.1 },
    affinities: { brands: {}, sellers: {} },
    suppressions: { products: [], brands: [], sellers: [] },
    seenFilter: serializeBloom(createBloom(), now),
    counters: {
      interactionCount: 0,
      sessionCount: 0,
      lastActiveAt: now,
      lastDecayedOn: null,
    },
    settings: {
      reducedMotion: false,
      autoplayVideo: true,
      dataSaver: false,
      region: 'US',
      currency: 'USD',
    },
    createdAt: now,
    updatedAt: now,
  };

  const result = await collections.users.insertOne(blank as User);
  return { user: { ...blank, _id: result.insertedId } as User, deviceSecret };
}

/**
 * Resumes an existing identity from its device secret.
 *
 * A miss returns null and the caller mints a fresh identity rather than
 * adopting the one that was asked for. That asymmetry is the whole control: a
 * presented secret can only ever *resume* an account, never claim one, so
 * guessing at identities gains an attacker nothing but a new empty profile.
 */
export async function resumeDeviceUser(
  collections: CollectionSet,
  deviceSecret: string,
): Promise<User | null> {
  return collections.users.findOne({ deviceSecretHash: hashDeviceSecret(deviceSecret) });
}

/**
 * Invalidates every token issued for a user.
 *
 * Called on sign-out and on any credential change. Without it a token is valid
 * until it expires no matter what the user does, and "sign out everywhere"
 * is a button that lies.
 */
export async function revokeSessions(collections: CollectionSet, userId: ObjectId): Promise<number> {
  const updated = await collections.users.findOneAndUpdate(
    { _id: userId },
    { $inc: { sessionEpoch: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return updated?.sessionEpoch ?? 0;
}

/** Anonymous principals cannot place orders or link merchant accounts. */
export function requireAuthenticated(principal: Principal, action: string): void {
  if (principal.isAnonymous) throw ApiError.anonymousNotAllowed(action);
}

/**
 * Whether a user document represents a claimed account.
 *
 * This is the authority on the privilege level, and it reads the database
 * rather than the token. The token's own claim about itself is an assertion by
 * the holder about the holder — exactly the thing an access check must not take
 * at face value.
 */
export function isAnonymousUser(user: User): boolean {
  return user.auth === null || user.auth.emailVerifiedAt === null;
}

export const USER_VECTOR_DIM = EMBEDDING_DIM;
