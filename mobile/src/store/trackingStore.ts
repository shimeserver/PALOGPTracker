import { create } from 'zustand';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TrackPoint, Route, TrackingMode } from '../types';
import { enqueuePendingRoute, flushPendingRoutes, hasPendingRoute } from '../utils/uploadQueue';
import { bridgeGaps } from '../utils/gapBridge';
import type { RaceBoxFix } from '../utils/raceboxParser';
import { storageOperation, readPointData, writePointData, removePointData } from '../utils/pointStorage';

const RECOVERY_KEY = 'route_recovery';
const RECOVERY_V2_KEY = 'route_recovery_v2';

export interface RecoveryData {
  points: TrackPoint[];
  startTime: number;
  mode: TrackingMode;
  savedAt: number;
}

export async function loadRecovery(): Promise<RecoveryData | null> {
  return storageOperation(async () => {
    const saved = await readPointData<RecoveryData>(RECOVERY_V2_KEY);
    if (saved) return saved;
    const raw = await AsyncStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const legacy = JSON.parse(raw) as RecoveryData;
    if (!Array.isArray(legacy.points)) throw new Error('バックアップを読み込めません');
    await writePointData(RECOVERY_V2_KEY, legacy);
    await AsyncStorage.removeItem(RECOVERY_KEY);
    return legacy;
  });
}

export async function clearRecovery(): Promise<void> {
  return storageOperation(async () => {
    await AsyncStorage.removeItem(RECOVERY_KEY);
    await removePointData(RECOVERY_V2_KEY);
  });
}

async function saveRecovery(points: TrackPoint[], startTime: number, mode: TrackingMode) {
  return storageOperation(async () => {
    const data: RecoveryData = { points, startTime, mode, savedAt: Date.now() };
    await writePointData(RECOVERY_V2_KEY, data, true);
    await AsyncStorage.removeItem(RECOVERY_KEY);
  });
}

function backup(points: TrackPoint[], startTime: number, mode: TrackingMode) {
  void saveRecovery(points, startTime, mode).then(() => {
    useTrackingStore.setState({ storageError: null });
  }).catch(() => {
    lastBackupLen = 0;
    useTrackingStore.setState({ storageError: '端末へのバックアップに失敗しました。空き容量を確認してください。' });
  });
}

export const LOCATION_TASK = 'gps-background-tracking';

// 前回リカバリー保存時のポイント数（バッチ受信で30の倍数を跨いでも確実に保存するため）
let lastBackupLen = 0;
// 前回リカバリー保存時刻。小分けの追記でも書き込み頻度は30秒以上あける
let lastBackupAt = 0;
const BACKUP_MIN_INTERVAL_MS = 30000;

// 外部GPS（RaceBox等）の最後の有効測位時刻（GNSS時刻）。
// この時刻+EXTERNAL_PRIORITY_MS までのスマホGPS点は捨てる（外部GPS優先）。
// 外部GPSが途切れれば自動的にスマホGPSの点が採用される。
let lastExternalFixTs = 0;
const EXTERNAL_PRIORITY_MS = 3000;

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
// car はサーキット走行（世界的には300km/h超もあり得る）を巻き込まないよう400に設定。
// walk は公共交通（新幹線=最高320km/h）を含むため高め。
const MODE_MAX_KMH: Record<TrackingMode, number> = { car: 400, walk: 360, bicycle: 120 };

// GPS復帰直後（60秒以上受信が途切れた後）の最初のfixは精度が悪いことが多い。
// その場合は精度30m以下を要求する。ただし連続3点まで＝それ以降は通常基準(50m)に
// 戻して受け入れる（トンネル出口などで精度が回復しない環境でのデータ全損を防ぐ）。
const REENTRY_GAP_MS = 60000;
const REENTRY_MAX_ACC_M = 30;
let reentryRejects = 0;

// 1点遅延スパイク除去: 「特定の地点に飛んで戻る」ワープ点だけを、次の点の到着時に
// 幾何形状（鋭い折り返し）で判定して記録前に破棄する。速度ベースの判定は
// サーキット走行等の速い実走を巻き込むリスクがあるため意図的に使わない。
// 判定条件はWeb修復の removeSpikeVertices と同一（実データでヘアピン誤爆なし検証済み）。
let pendingPt: TrackPoint | null = null;
let bufferedPoints: TrackPoint[] = [];
let publishTimer: ReturnType<typeof setTimeout> | null = null;

function publishPoints() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = null;
  if (!bufferedPoints.length) return;
  const batch = bufferedPoints;
  bufferedPoints = [];
  const state = useTrackingStore.getState();
  let distance = state.currentDistance;
  let previous = state.currentPoints[state.currentPoints.length - 1];
  for (const point of batch) {
    if (previous) distance += haversine(previous, point);
    previous = point;
  }
  const updated = [...state.currentPoints, ...batch];
  useTrackingStore.setState({ currentPoints: updated, currentDistance: distance,
    currentSpeed: (pendingPt ?? batch[batch.length - 1]).speed });
  if (state.startTime && updated.length - lastBackupLen >= 30
    && Date.now() - lastBackupAt >= BACKUP_MIN_INTERVAL_MS) {
    lastBackupLen = updated.length;
    lastBackupAt = Date.now();
    backup(updated, state.startTime, state.trackingMode);
  }
}

function resetBuffer() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = null;
  bufferedPoints = [];
  pendingPt = null;
}

function isSpike(a: TrackPoint, b: TrackPoint, c: TrackPoint): boolean {
  const ax = b.lng - a.lng, ay = b.lat - a.lat;
  const bx = c.lng - b.lng, by = c.lat - b.lat;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return false;
  const tc = (ax * bx + ay * by) / (la * lb);
  const arm = Math.min(haversine(a, b), haversine(b, c));
  return (tc < -0.5 && arm > 0.04) || (tc < 0 && arm > 0.1);
}

interface TrackingState {
  storageError: string | null;
  isSaving: boolean;
  isTracking: boolean;
  isPaused: boolean;
  currentPoints: TrackPoint[];
  currentSpeed: number;
  currentDistance: number;
  startTime: number | null;
  trackingMode: TrackingMode;
  setTrackingMode: (mode: TrackingMode) => void;
  addPoints: (locations: Location.LocationObject[], source?: 'phone' | 'external') => void;
  startTracking: () => Promise<void>;
  resumeFromRecovery: (data: RecoveryData) => Promise<void>;
  backupNow: () => void;
  pauseTracking: () => Promise<void>;
  resumeTracking: () => Promise<void>;
  stopTracking: (userId: string, name?: string, tagIds?: string[]) => Promise<string | 'queued' | null>;
  clearTrack: () => void;
}

export const useTrackingStore = create<TrackingState>((set, get) => ({
  storageError: null,
  isSaving: false,
  isTracking: false,
  isPaused: false,
  currentPoints: [],
  currentSpeed: 0,
  currentDistance: 0,
  startTime: null,
  trackingMode: 'car',
  setTrackingMode: (mode) => set({ trackingMode: mode }),

  addPoints: (locations, source = 'phone') => {
    if (!get().isTracking || get().isPaused) return;
    if (source === 'phone' && lastExternalFixTs > 0) {
      // 外部GPSが生きている時間帯のスマホ点は捨てる（バックグラウンドの遅延バッチも時刻で判定）
      locations = locations.filter(l => l.timestamp > lastExternalFixTs + EXTERNAL_PRIORITY_MS);
      if (locations.length === 0) return;
    }
    const existing = get().currentPoints;
    const mode = get().trackingMode;
    const newPoints: TrackPoint[] = []; // 確定した点（pendingPt はまだ含まない）
    const lastCommitted = () => newPoints[newPoints.length - 1] ?? bufferedPoints[bufferedPoints.length - 1] ?? existing[existing.length - 1];
    for (const loc of locations) {
      // 精度が50m超の場合はスキップ（GPSが安定していない）
      if (loc.coords.accuracy != null && loc.coords.accuracy > 50) continue;
      // 直前の採用点 = 保留中の点があればそれ、なければ確定済みの末尾
      const chainPrev = pendingPt ?? lastCommitted();
      // GPS復帰直後の低精度fixを破棄（最大3点まで）
      if (chainPrev && loc.timestamp - chainPrev.timestamp > REENTRY_GAP_MS
        && loc.coords.accuracy != null && loc.coords.accuracy > REENTRY_MAX_ACC_M
        && reentryRejects < 3) {
        reentryRejects++;
        continue;
      }
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
      // 時刻が戻る/重複する点は捨てる（外部GPS⇔スマホGPS切替時の遅延バッチ対策）
      if (chainPrev && pt.timestamp <= chainPrev.timestamp) continue;
      if (chainPrev) {
        const dtSec = (pt.timestamp - chainPrev.timestamp) / 1000;
        if (dtSec > 0) {
          // モード別の絶対上限のみ（速度ベースの複雑な判定は実走を巻き込むため行わない。
          // 「飛んで戻る」ワープは後段の幾何スパイク判定が受け持つ）
          const impliedKmh = haversine(chainPrev, pt) / (dtSec / 3600);
          if (impliedKmh > MODE_MAX_KMH[mode]) continue;
        }
      }
      reentryRejects = 0; // 採用が確定した点のみカウンタをリセット（ジャンプ棄却点では再武装しない）
      // 1点遅延スパイク判定: (確定末尾, 保留中, 新着) が「飛んで戻る」形なら保留中を破棄
      const anchor = lastCommitted();
      if (pendingPt && anchor && isSpike(anchor, pendingPt, pt)) {
        pendingPt = pt; // スパイクだった保留点を捨て、新着を保留に
        continue;
      }
      if (pendingPt) newPoints.push(pendingPt); // 保留点をスパイクでないと確定
      pendingPt = pt;
    }
    bufferedPoints.push(...newPoints);
    // Keep all accepted fixes; only publish the UI snapshot once a second.
    if (!publishTimer && bufferedPoints.length) publishTimer = setTimeout(publishPoints, 1000);
  },

  // 任意タイミングの即時バックアップ（アプリのバックグラウンド遷移時などに呼ぶ）
  backupNow: () => {
    flushPendingPoint();
    const { isTracking, currentPoints, startTime, trackingMode } = get();
    if (!isTracking || !startTime || currentPoints.length < 2) return;
    if (currentPoints.length === lastBackupLen) return; // 前回から変化なし
    lastBackupLen = currentPoints.length;
    backup(currentPoints, startTime, trackingMode);
  },

  pauseTracking: async () => {
    flushPendingPoint();
    set({ isPaused: true, currentSpeed: 0 });
    // 一時停止のタイミングでも必ずバックアップ（電源断に備える）
    const { currentPoints, startTime, trackingMode } = get();
    if (startTime && currentPoints.length >= 2) {
      lastBackupLen = currentPoints.length;
      backup(currentPoints, startTime, trackingMode);
    }
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
    if (get().isSaving) throw new Error('保存完了までお待ちください');
    // Fail closed on an unreadable backup instead of replacing it with a new trip.
    const previous = await loadRecovery();
    if (previous && previous.points.length >= 2) throw new Error('前回の記録を保存・再開、または破棄してから開始してください');
    if (get().currentPoints.length >= 2) throw new Error('未保存の記録があります。保存を再試行してください');
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') throw new Error('位置情報の許可が必要です');

    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') throw new Error('バックグラウンド位置情報の許可が必要です（設定から「常に許可」にしてください）');

    await clearRecovery(); // 前回の残存データをクリア
    lastBackupLen = 0;
    lastBackupAt = 0;
    lastExternalFixTs = 0;
    reentryRejects = 0;
    resetBuffer();
    set({ isTracking: true, isPaused: false, currentPoints: [], currentDistance: 0, storageError: null, startTime: Date.now() });

    await Location.startLocationUpdatesAsync(LOCATION_TASK, LOCATION_OPTIONS);
  },

  // 電源断・強制終了で失われた記録を「続きから」再開する。
  // バックアップ点列を復元して記録状態に戻す（中断区間のギャップは保存時のbridgeGapsが道なりに補間）
  resumeFromRecovery: async (data) => {
    if (get().isSaving) throw new Error('保存完了までお待ちください');
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') throw new Error('位置情報の許可が必要です');
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') throw new Error('バックグラウンド位置情報の許可が必要です');
    resetBuffer();
    lastBackupLen = data.points.length;
    lastBackupAt = 0;
    lastExternalFixTs = 0;
    reentryRejects = 0;
    pendingPt = null;
    set({
      isTracking: true, isPaused: false,
      currentPoints: data.points,
      currentDistance: data.points.reduce((sum, point, i) => i ? sum + haversine(data.points[i - 1], point) : sum, 0),
      startTime: data.startTime,
      trackingMode: data.mode,
      currentSpeed: 0,
    });
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (!running) await Location.startLocationUpdatesAsync(LOCATION_TASK, LOCATION_OPTIONS);
  },

  stopTracking: async (userId, name, tagIds) => {
    if (get().isSaving) throw new Error('保存中です');
    set({ isSaving: true });
    try {
      const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      if (isRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      flushPendingPoint();
      set({ isTracking: false, isPaused: false });

      const { currentPoints, startTime, trackingMode } = get();
      if (currentPoints.length < 2) return null;

      // Persist the final point before any network operation can be interrupted.
      await saveRecovery(currentPoints, startTime!, trackingMode);

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

      // Queue first: a process exit during upload leaves a durable, retriable route.
      await enqueuePendingRoute(route);
      await clearRecovery();
      set({ currentPoints: [], startTime: null, currentSpeed: 0, currentDistance: 0 });
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          flushPendingRoutes().catch(() => {}),
          new Promise<void>(resolve => { waitTimer = setTimeout(resolve, 10000); }),
        ]);
      } finally { if (waitTimer) clearTimeout(waitTimer); }
      return await hasPendingRoute(route.userId, route.startTime)
        ? 'queued' : route.userId + '_' + route.startTime;
    } finally { set({ isSaving: false }); }
  },

  clearTrack: () => {
    resetBuffer();
    set({ currentPoints: [], startTime: null, currentDistance: 0, currentSpeed: 0 });
  },
}));

// 保留中の1点（スパイク判定待ち）を確定して点列へ流す。
// 一時停止・停止・バックアップ等、点列を読む直前に必ず呼ぶ
function flushPendingPoint() {
  if (pendingPt) bufferedPoints.push(pendingPt);
  pendingPt = null;
  publishPoints();
}

// 外部GPS（RaceBox等）の測位を記録に流す。間引きは呼び出し側（externalGpsStore）で済ませる。
// スマホGPSと同じフィルタ（精度・ジャンプ・スパイク）を通す。
export function addExternalFix(fix: RaceBoxFix) {
  if (!fix.validFix || fix.hAcc > 50) return;
  lastExternalFixTs = Math.max(lastExternalFixTs, fix.timestamp);
  const loc: Location.LocationObject = {
    timestamp: fix.timestamp,
    coords: {
      latitude: fix.lat,
      longitude: fix.lng,
      altitude: fix.altitude,
      accuracy: fix.hAcc,
      altitudeAccuracy: null,
      heading: fix.heading,
      speed: fix.speed,
    },
  };
  useTrackingStore.getState().addPoints([loc], 'external');
}

// バックグラウンドタスク定義（モジュールのトップレベルで必須）
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
  if (error) { console.error('[GPS Task]', error); return; }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    useTrackingStore.getState().addPoints(locations);
    publishPoints();
    await storageOperation(async () => {});
  }
});
