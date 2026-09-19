import AsyncStorageStatic from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { FeedSessionResponse } from '@window/shared';
import { api, setAuthToken } from '../api/client.js';

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
 * AsyncStorage is optional here: on web a first-party cookie or localStorage is
 * the natural home, and the app must still boot if neither is available. A
 * device id that does not survive a restart costs the user their history, so
 * this falls back rather than failing.
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

const DEVICE_KEY = 'window.deviceUserId';

function mintDeviceId(): string {
  // Not a security boundary: it identifies a device, and the server binds it to
  // a signed token on first contact.
  const random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `dev_${Date.now().toString(36)}${random}`.slice(0, 48);
}

export interface SessionState {
  status: 'idle' | 'booting' | 'ready' | 'error';
  deviceUserId: string | null;
  userId: string | null;
  isAnonymous: boolean;
  onboarded: boolean;
  session: FeedSessionResponse | null;
  error: string | null;
  boot(): Promise<void>;
  markOnboarded(): void;
  refreshSession(): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'idle',
  deviceUserId: null,
  userId: null,
  isAnonymous: true,
  onboarded: false,
  session: null,
  error: null,

  async boot() {
    if (get().status === 'booting' || get().status === 'ready') return;
    set({ status: 'booting', error: null });

    try {
      let deviceUserId = await storage.getItem(DEVICE_KEY);
      if (!deviceUserId) {
        deviceUserId = mintDeviceId();
        await storage.setItem(DEVICE_KEY, deviceUserId);
      }

      const bootstrap = await api.bootstrapDevice(deviceUserId);
      setAuthToken(bootstrap.token);

      const session = await api.session();
      set({
        status: 'ready',
        deviceUserId,
        userId: bootstrap.userId,
        isAnonymous: bootstrap.isAnonymous,
        onboarded: bootstrap.onboarded,
        session,
      });
    } catch (error) {
      set({ status: 'error', error: (error as Error).message });
    }
  },

  markOnboarded() {
    set({ onboarded: true });
  },

  async refreshSession() {
    const session = await api.session();
    set({ session });
  },
}));
