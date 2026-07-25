import { create } from 'zustand';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TrackPoint, Route, TrackingMode } from '../types';
import { saveRoute } from '../firebase/routes';
import { enqueuePendingRoute } from '../utils/uploadQueue';
import { bridgeGaps } from '../utils/gapBridge';

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
  } catch (e) {
    console.warn('[Recovery] save failed:', e);
  }
}

export const LOCATION_TASK = 'gps-background-tracking';

// 前回リカバリー保存時のポイント数（バッチ受信で30の倍数を跨いでも確実に保存するため）
let lastBackupLen = 0;

const LOCATION_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 3000,
  distanceInterval: 5,
  // バックグラウンド時はアプリへの配信を30秒ごとにまとめる（測位自体は3秒間隔のまま）。
  // アプリの起床回数が減り、電池消費・発熱を抑える。フォアグラウンドはリアルタイムのまま。
  deferredUpdatesInterval: 30000,
  deferredUpdatesDistance: 0,
  foregroundService: {
    notificationTitle: 'PALOGPTracker 記録中',
    notificationBody: 'GPSルートを記録しています',
    notificationColor: '#2563eb',
  },
  showsBackgroundLocationIndicator: true,
};

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

// モード別のジャンプ判定上限（km/h）。これ超の移動を示す点はGPSジャンプとみなして捨てる。
// walk は公共交通（新幹線=最高320km/h）を含むため上限を高くしている。
const MODE_MAX_KMH: Record<TrackingMode, number> = { car: 300, walk: 330, bicycle: 120 };

// GPS復帰直後（60秒以上受信が途切れた後）の最初のfixは精度が悪いことが多い。
// その場合は精度30m以下を要求する。ただし連続3点まで＝それ以降は通常基準(50m)に
// 戻して受け入れる（トンネル出口などで精度が回復しない環境でのデータ全損を防ぐ）。
const REENTRY_GAP_MS = 60000;
const REENTRY_MAX_ACC_M = 30;
let reentryRejects = 0;

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
  pauseTracking: () => Promise<void>;
  resumeTracking: () => Promise<void>;
  stopTracking: (userId: string, name?: string, tagIds?: string[]) => Promise<string | 'queued' | null>;
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
    if (get().isPaused) return;
    const existing = get().currentPoints;
    const newPoints: TrackPoint[] = [];
    for (const loc of locations) {
      // 精度が50m超の場合はスキップ（GPSが安定していない）
      if (loc.coords.accuracy != null && loc.coords.accuracy > 50) continue;
      // GPS復帰直後の低精度fixを破棄（最大3点まで）
      const lastPt = newPoints[newPoints.length - 1] ?? existing[existing.length - 1];
      if (lastPt && loc.timestamp - lastPt.timestamp > REENTRY_GAP_MS
        && loc.coords.accuracy != null && loc.coords.accuracy > REENTRY_MAX_ACC_M
        && reentryRejects < 3) {
        reentryRejects++;
        continue;
      }
      reentryRejects = 0;
      const pt: TrackPoint = {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        timestamp: loc.timestamp,
        speed: loc.coords.speed != null && loc.coords.speed >= 0
          ? loc.coords.speed * 3.6
          : 0,
        // 高度(m)。標高プロファイル用。undefinedはFirestoreが拒否するため条件付きで付与
        ...(loc.coords.altitude != null ? { alt: Math.round(loc.coords.altitude * 10) / 10 } : {}),
      };
      // 直前点との速度チェック（モード別上限超 = GPSジャンプとみなしてスキップ）
      const prev = newPoints[newPoints.length - 1] ?? existing[existing.length - 1];
      if (prev) {
        const dtH = (pt.timestamp - prev.timestamp) / 3600000;
        if (dtH > 0) {
          const distKm = haversine(prev, pt);
          if (distKm / dtH > MODE_MAX_KMH[get().trackingMode]) continue;
        }
      }
      newPoints.push(pt);
    }
    if (newPoints.length === 0) return;
    set(state => {
      const updated = [...state.currentPoints, ...newPoints];
      // 30pt以上たまるごとにAsyncStorageへ自動バックアップ（電源断対策）
      // バッチ受信で30の倍数を飛び越えても保存されるよう差分で判定
      if (state.startTime && updated.length - lastBackupLen >= 30) {
        lastBackupLen = updated.length;
        saveRecovery(updated, state.startTime, state.trackingMode);
      }
      return {
        currentPoints: updated,
        currentSpeed: newPoints[newPoints.length - 1]?.speed ?? state.currentSpeed,
      };
    });
  },

  pauseTracking: async () => {
    set({ isPaused: true, currentSpeed: 0 });
    // GPSも止めてバッテリー消費を抑える（再開時に再取得）
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  },
  resumeTracking: async () => {
    set({ isPaused: false });
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (!running) await Location.startLocationUpdatesAsync(LOCATION_TASK, LOCATION_OPTIONS).catch(() => {});
  },

  startTracking: async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') throw new Error('位置情報の許可が必要です');

    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') throw new Error('バックグラウンド位置情報の許可が必要です（設定から「常に許可」にしてください）');

    await clearRecovery(); // 前回の残存データをクリア
    lastBackupLen = 0;
    reentryRejects = 0;
    set({ isTracking: true, isPaused: false, currentPoints: [], startTime: Date.now() });

    await Location.startLocationUpdatesAsync(LOCATION_TASK, LOCATION_OPTIONS);
  },

  stopTracking: async (userId, name, tagIds) => {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (isRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    set({ isTracking: false, isPaused: false });

    const { currentPoints, startTime, trackingMode } = get();
    if (currentPoints.length < 2) return null;

    // トンネル/電波切れのギャップを道なりに補間（車のみ・オンライン時のみ有効、失敗時は直線のまま）
    const points = trackingMode === 'car'
      ? await bridgeGaps(currentPoints).catch(() => currentPoints)
      : currentPoints;

    let totalDist = 0;
    for (let i = 1; i < points.length; i++) {
      totalDist += haversine(points[i - 1], points[i]);
    }
    const speeds = points.map(p => p.speed).filter(s => s > 0);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b) / speeds.length : 0;
    const maxSpeed = speeds.length > 0 ? speeds.reduce((m, s) => s > m ? s : m, 0) : 0;
    const endTime = points[points.length - 1].timestamp;
    const route: Omit<Route, 'id'> = {
      userId,
      name: name || `ルート ${new Date(startTime!).toLocaleDateString('ja-JP')}`,
      tags: tagIds ?? [],
      startTime: startTime!,
      endTime,
      totalDistance: totalDist,
      avgSpeed,
      maxSpeed,
      points,
      source: 'recorded',
      mode: trackingMode,
      createdAt: Date.now(),
    };

    try {
      const id = await saveRoute(route);
      await clearRecovery(); // 保存完了後にバックアップを削除
      set({ currentPoints: [], startTime: null, currentSpeed: 0 }); // 記録状態をリセット
      return id;
    } catch {
      // オフライン等で保存失敗 → ローカルキューに退避（次回オンライン時に自動送信）
      await enqueuePendingRoute(route);
      await clearRecovery();
      set({ currentPoints: [], startTime: null, currentSpeed: 0 });
      return 'queued';
    }
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
