import { create } from 'zustand';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TrackPoint, Route, TrackingMode } from '../types';
import { saveRoute } from '../firebase/routes';

const RECOVERY_KEY = 'route_recovery';

export interface RecoveryData {
  points: TrackPoint[];
  startTime: number;
  mode: TrackingMode;
  savedAt: number;
}

export async function loadRecovery(): Promise<RecoveryData | null> {
  try {
    const raw = await AsyncStorage.getItem(RECOVERY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function clearRecovery(): Promise<void> {
  try { await AsyncStorage.removeItem(RECOVERY_KEY); } catch {}
}

async function saveRecovery(points: TrackPoint[], startTime: number, mode: TrackingMode) {
  try {
    const data: RecoveryData = { points, startTime, mode, savedAt: Date.now() };
    await AsyncStorage.setItem(RECOVERY_KEY, JSON.stringify(data));
  } catch {}
}

export const LOCATION_TASK = 'gps-background-tracking';

function haversine(p1: TrackPoint, p2: TrackPoint): number {
  const R = 6371;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface TrackingState {
  isTracking: boolean;
  isPaused: boolean;
  currentPoints: TrackPoint[];
  currentSpeed: number;
  startTime: number | null;
  trackingMode: TrackingMode;
  setTrackingMode: (mode: TrackingMode) => void;
  addPoints: (locations: Location.LocationObject[]) => void;
  startTracking: () => Promise<void>;
  pauseTracking: () => void;
  resumeTracking: () => void;
  stopTracking: (userId: string, name?: string, tagIds?: string[]) => Promise<string | null>;
  clearTrack: () => void;
}

export const useTrackingStore = create<TrackingState>((set, get) => ({
  isTracking: false,
  isPaused: false,
  currentPoints: [],
  currentSpeed: 0,
  startTime: null,
  trackingMode: 'car',
  setTrackingMode: (mode) => set({ trackingMode: mode }),

  addPoints: (locations) => {
    if (get().isPaused) return; // 一時停止中はポイントを無視
    const newPoints: TrackPoint[] = locations.map(loc => ({
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      timestamp: loc.timestamp,
      speed: loc.coords.speed != null && loc.coords.speed >= 0
        ? loc.coords.speed * 3.6  // m/s → km/h
        : 0,
    }));
    set(state => {
      const updated = [...state.currentPoints, ...newPoints];
      // 30pt毎にAsyncStorageへ自動バックアップ（電源断対策）
      if (state.startTime && updated.length % 30 === 0) {
        saveRecovery(updated, state.startTime, state.trackingMode);
      }
      return {
        currentPoints: updated,
        currentSpeed: newPoints[newPoints.length - 1]?.speed ?? state.currentSpeed,
      };
    });
  },

  pauseTracking: () => set({ isPaused: true, currentSpeed: 0 }),
  resumeTracking: () => set({ isPaused: false }),

  startTracking: async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') throw new Error('位置情報の許可が必要です');

    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') throw new Error('バックグラウンド位置情報の許可が必要です（設定から「常に許可」にしてください）');

    await clearRecovery(); // 前回の残存データをクリア
    set({ isTracking: true, isPaused: false, currentPoints: [], startTime: Date.now() });

    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 3000,
      distanceInterval: 5,
      foregroundService: {
        notificationTitle: 'PALOGPTracker 記録中',
        notificationBody: 'GPSルートを記録しています',
        notificationColor: '#2563eb',
      },
      showsBackgroundLocationIndicator: true,
    });
  },

  stopTracking: async (userId, name, tagIds) => {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (isRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    set({ isTracking: false, isPaused: false });

    const { currentPoints, startTime } = get();
    if (currentPoints.length < 2) return null;

    let totalDist = 0;
    for (let i = 1; i < currentPoints.length; i++) {
      totalDist += haversine(currentPoints[i - 1], currentPoints[i]);
    }
    const speeds = currentPoints.map(p => p.speed).filter(s => s > 0);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b) / speeds.length : 0;
    const maxSpeed = speeds.length > 0 ? speeds.reduce((m, s) => s > m ? s : m, 0) : 0;
    const endTime = currentPoints[currentPoints.length - 1].timestamp;

    const { trackingMode } = get();
    const route: Omit<Route, 'id'> = {
      userId,
      name: name || `ルート ${new Date(startTime!).toLocaleDateString('ja-JP')}`,
      tags: tagIds ?? [],
      startTime: startTime!,
      endTime,
      totalDistance: totalDist,
      avgSpeed,
      maxSpeed,
      points: currentPoints,
      source: 'recorded',
      mode: trackingMode,
      createdAt: Date.now(),
    };

    const id = await saveRoute(route);
    await clearRecovery(); // 保存完了後にバックアップを削除
    return id;
  },

  clearTrack: () => set({ currentPoints: [], startTime: null }),
}));

// バックグラウンドタスク定義（モジュールのトップレベルで必須）
TaskManager.defineTask(LOCATION_TASK, ({ data, error }: TaskManager.TaskManagerTaskBody) => {
  if (error) { console.error('[GPS Task]', error); return; }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    useTrackingStore.getState().addPoints(locations);
  }
});
