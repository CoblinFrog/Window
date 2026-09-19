import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  ApiError,
  EMBEDDING_DIM,
  type UserDoc,
} from '@window/shared';
import type { CollectionSet, User } from '../db/collections.js';
import { createBloom, serializeBloom } from '../lib/bloom.js';

/**
 * Identity.
 *
 * Anonymous device tokens are first-class principals. There is no sign-in wall
 * before the feed — the single most common way feed products lose their funnel
 * — so an anonymous principal can do everything except place orders and link
 * merchant accounts.
 */

export interface Principal {
  userId: ObjectId;
  deviceUserId: string;
  isAnonymous: boolean;
}

const SECRET =
  process.env.AUTH_SECRET ??
  // A per-process secret keeps development tokens from outliving the process
  // they were minted by, which is the right default when none is configured.
  randomBytes(32).toString('hex');

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function mintToken(principal: Principal): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: principal.userId.toHexString(),
      dev: principal.deviceUserId,
      anon: principal.isAnonymous,
      iat: Date.now(),
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): Principal {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw ApiError.unauthorized('Malformed token.');

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Constant-time comparison: a token check that leaks timing leaks the token.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('Invalid token signature.');
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub: string;
      dev: string;
      anon: boolean;
    };
    return {
      userId: new ObjectId(decoded.sub),
      deviceUserId: decoded.dev,
      isAnonymous: decoded.anon,
    };
  } catch {
    throw ApiError.unauthorized('Unreadable token.');
  }
}

/**
 * Resolves or creates the user behind a device identity. The document is
 * created on first contact rather than at onboarding, because the topic picker
 * itself needs somewhere to write and the user has not agreed to anything yet.
 */
export async function resolveDeviceUser(
  collections: CollectionSet,
  deviceUserId: string,
  now = new Date(),
): Promise<User> {
  const existing = await collections.users.findOne({ deviceUserId });
  if (existing) return existing;

  const blank: Omit<UserDoc<ObjectId>, '_id'> = {
    deviceUserId,
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

  try {
    const result = await collections.users.insertOne(blank as User);
    return { ...blank, _id: result.insertedId } as User;
  } catch (error) {
    // Two devices racing on first contact is normal; the unique index decides.
    if ((error as { code?: number }).code === 11000) {
      const raced = await collections.users.findOne({ deviceUserId });
      if (raced) return raced;
    }
    throw error;
  }
}

/** Anonymous principals cannot place orders or link merchant accounts. */
export function requireAuthenticated(principal: Principal, action: string): void {
  if (principal.isAnonymous) throw ApiError.anonymousNotAllowed(action);
}

export const USER_VECTOR_DIM = EMBEDDING_DIM;
