import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Car } from '../types';

const STORAGE_KEY = 'active_car';

interface CarStore {
  activeCar: Car | null;
  setActiveCar: (car: Car | null) => void;
  loadActiveCar: () => Promise<void>;
}

export const useCarStore = create<CarStore>((set) => ({
  activeCar: null,

  setActiveCar: (car) => {
    set({ activeCar: car });
    if (car) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(car));
    } else {
      AsyncStorage.removeItem(STORAGE_KEY);
    }
  },

  loadActiveCar: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) set({ activeCar: JSON.parse(raw) as Car });
    } catch {
      // 読み込み失敗時は無視
    }
  },
}));
