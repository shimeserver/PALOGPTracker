import { create } from 'zustand';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { auth } from '../firebase/config';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  init: () => () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  error: null,

  init: () => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      set({ user, loading: false });
    });
    return unsubscribe;
  },

  signIn: async (email, password) => {
    set({ error: null });
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  signUp: async (email, password) => {
    set({ error: null });
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    }
  },

  logout: async () => {
    await signOut(auth);
    set({ user: null });
  },
}));
