/**
 * Auth state: Zustand, persisted to localStorage.
 *
 * Only the token and the user profile live here. Server state (runs, specs,
 * audit rows) belongs to TanStack Query, which handles caching and
 * invalidation properly. Mixing the two is how stores turn into a second,
 * worse cache.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setAuthToken } from '@/services/api';
import type { User } from '@/types';

interface AuthState {
  user: User | null;
  token: string | null;
  signIn: (user: User, token: string) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      signIn: (user, token) => { setAuthToken(token); set({ user, token }); },
      signOut: () => { setAuthToken(null); set({ user: null, token: null }); },
    }),
    {
      name: 'agentiq-auth',
      // Re-arm the axios interceptor after a reload rehydrates the store.
      onRehydrateStorage: () => (state) => setAuthToken(state?.token ?? null),
    },
  ),
);
