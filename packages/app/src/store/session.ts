import AsyncStorageStatic from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { FeedSessionResponse } from '@window/shared';
import { api, setAuthToken, setReauthorizer } from '../api/client.js';

/**
 * Identity and session.
 *
 * The app opens straight into the topic picker: an anonymous `deviceUserId` is
 * minted locally and the profile is claimable later. No sign-in wall exists
 * before the feed, which is the single most important thing this file does.
 */

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/**
 * Where the device secret lives.
 *
 * AsyncStorage is optional here: on web, localStorage is the natural home, and
 * the app must still boot if neither is available. A secret that does not
 * survive a restart costs the user their history, so this falls back rather
 * than failing.
 *
 * What it stores is now a credential rather than an identifier, and that raises
 * the bar on native: AsyncStorage is an unencrypted file in the app sandbox,
 * readable on a rooted or jailbroken device and sometimes present in a device
 * backup. `expo-secure-store` — Keychain on iOS, Keystore on Android — is the
 * right home for it, and it is a drop-in for this same two-method interface.
 * That dependency is not added here rather than left as a silent assumption:
 * this comment is the seam.
 */
const storage: Storage = (() => {
  const native = AsyncStorageStatic as unknown as Storage | undefined;
  if (native?.getItem) return native;

  if (typeof globalThis.localStorage !== 'undefined') {
    return {
      async getItem(key) {
        return globalThis.localStorage.getItem(key);
      },
      async setItem(key, value) {
        globalThis.localStorage.setItem(key, value);
      },
    };
  }

  const memory = new Map<string, string>();
  return {
    async getItem(key) {
      return memory.get(key) ?? null;
    },
    async setItem(key, value) {
      memory.set(key, value);
    },
  };
})();

/**
 * The device secret.
 *
 * This is a credential, not an identifier: whoever holds it can resume this
 * account. It is minted by the server from 256 bits of CSPRNG output, returned
 * exactly once, and stored here — the client never generates it, because a
 * client-chosen identity is one any other client can also choose. The previous
 * version minted it locally with `Math.random()` under a comment saying it was
 * not a security boundary, which was true of the intent and false of the
 * effect.
 */
const SECRET_KEY = 'window.deviceSecret';

export interface SessionState {
  status: 'idle' | 'booting' | 'ready' | 'error';
  deviceUserId: string | null;
  userId: string | null;
  isAnonymous: boolean;
  /** Mirrors the server's policy on whether ordering needs an account. */
  requiresAccount: boolean;
  onboarded: boolean;
  session: FeedSessionResponse | null;
  error: string | null;
  boot(): Promise<void>;
  markOnboarded(): void;
  /**
   * Adopts the token a successful claim returned and drops the anonymous flag.
   *
   * The claim regenerates the session server-side, so the old token is already
   * revoked — and `isAnonymous` is what every gate in the app reads. Refreshing
   * the feed session is not enough: it refetches a ranked buffer and leaves the
   * privilege flag exactly as it was, so checkout keeps asking for an email the
   * user has just confirmed.
   */
  markClaimed(token: string): void;
  refreshSession(): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'idle',
  deviceUserId: null,
  userId: null,
  isAnonymous: true,
  requiresAccount: true,
  onboarded: false,
  session: null,
  error: null,

  async boot() {
    if (get().status === 'booting' || get().status === 'ready') return;
    set({ status: 'booting', error: null });

    try {
      const bootstrap = await api.bootstrapDevice(await storage.getItem(SECRET_KEY));

      // A secret arrives only when a new identity was minted, and it is the
      // only time the server will ever send it.
      if (bootstrap.deviceSecret) await storage.setItem(SECRET_KEY, bootstrap.deviceSecret);
      setAuthToken(bootstrap.token);

      // Tokens expire. Re-deriving one from the stored secret is the ordinary
      // return path for a device that has been closed for a month, so it is
      // wired here rather than surfaced to the user as a session error.
      setReauthorizer(async () => {
        const secret = await storage.getItem(SECRET_KEY);
        if (!secret) return null;
        const refreshed = await api.bootstrapDevice(secret);
        setAuthToken(refreshed.token);
        set({ isAnonymous: refreshed.isAnonymous });
        return refreshed.token;
      });

      const session = await api.session();
      set({
        status: 'ready',
        deviceUserId: bootstrap.deviceUserId,
        userId: bootstrap.userId,
        isAnonymous: bootstrap.isAnonymous,
        requiresAccount: bootstrap.requiresAccount ?? true,
        onboarded: bootstrap.onboarded,
        session,
      });
    } catch (error) {
      set({ status: 'error', error: (error as Error).message });
    }
  },

  markClaimed(token: string) {
    setAuthToken(token);
    set({ isAnonymous: false });
  },

  markOnboarded() {
    set({ onboarded: true });
  },

  async refreshSession() {
    const session = await api.session();
    set({ session });
  },
}));
