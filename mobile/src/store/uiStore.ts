import { create } from 'zustand';

interface UiStore {
  helpTarget: string | null;
  setHelpTarget: (s: string | null) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  helpTarget: null,
  setHelpTarget: (s) => set({ helpTarget: s }),
}));
