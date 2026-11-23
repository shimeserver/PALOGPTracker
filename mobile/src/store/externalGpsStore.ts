// 外部GPSレシーバー（RaceBox Mini / Mini S / Micro）の BLE 接続管理。
// 受信した測位を間引いて trackingStore に流す。外部GPSが有効な測位を出している間は
// スマホ内蔵GPSの点は trackingStore 側で捨てられ、途切れたら自動で内蔵GPSに戻る。
import { create } from 'zustand';
import { PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BleManager as BleManagerType, Device, Subscription } from 'react-native-ble-plx';
import { RaceBoxFix, RaceBoxStreamParser, base64ToBytes } from '../utils/raceboxParser';
import { useTrackingStore, addExternalFix } from './trackingStore';

const SETTINGS_KEY = 'external_gps_settings';

// RaceBox は Nordic UART Service で測位を通知する
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // デバイス→スマホ (notify)

const RECONNECT_DELAY_MS = 3000;
const UI_UPDATE_INTERVAL_MS = 250; // 25Hz全部で再描画しないよう UI 反映は 4Hz に間引く
const SCAN_DURATION_MS = 10000;

export type RecordHz = 1 | 2 | 5;
export type ExternalGpsStatus = 'off' | 'scanning' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ScanResult { id: string; name: string; rssi: number | null }

interface Settings {
  enabled: boolean;
  deviceId: string | null;
  deviceName: string | null;
  recordHz: RecordHz;
}

interface ExternalGpsState extends Settings {
  loaded: boolean;
  status: ExternalGpsStatus;
  error: string | null;
  lastFix: RaceBoxFix | null;
  lastFixAt: number;      // 最後にパケットを受信した端末時刻
  measuredHz: number;     // 実測の受信レート
  scanResults: ScanResult[];
  init: () => Promise<void>;
  startScan: () => Promise<void>;
  stopScan: () => void;
  selectDevice: (d: ScanResult) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  forgetDevice: () => Promise<void>;
  setEnabled: (v: boolean) => Promise<void>;
  setRecordHz: (hz: RecordHz) => Promise<void>;
}

// ── モジュール内の接続状態（UI に出さないもの） ─────────────────────
let manager: BleManagerType | null = null;
let device: Device | null = null;
let notifySub: Subscription | null = null;
let disconnectSub: Subscription | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let manualDisconnect = false;
let connecting = false;
const parser = new RaceBoxStreamParser();
let lastUiUpdate = 0;
let lastRecordedTs = 0;
let hzWindowStart = 0;
let hzCount = 0;

function getManager(): BleManagerType {
  if (!manager) {
    // ネイティブモジュールの無いビルドでも他機能が落ちないよう遅延 require
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BleManager } = require('react-native-ble-plx') as typeof import('react-native-ble-plx');
    manager = new BleManager();
  }
  return manager;
}

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

async function ensureBluetoothOn(): Promise<void> {
  const state = await getManager().state();
  if (state === 'PoweredOn') return;
  // Unknown/Resetting は起動直後に一瞬出るので少し待つ
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { sub.remove(); reject(new Error('Bluetoothをオンにしてください')); }, 3000);
    const sub = getManager().onStateChange(s => {
      if (s === 'PoweredOn') { clearTimeout(t); sub.remove(); resolve(); }
    }, true);
  });
}

function isRaceBoxName(name: string | null | undefined): boolean {
  return !!name && /racebox/i.test(name);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function teardownLink() {
  notifySub?.remove(); notifySub = null;
  disconnectSub?.remove(); disconnectSub = null;
  device = null;
  parser.reset();
}

function handleFix(fix: RaceBoxFix) {
  const now = Date.now();
  // 受信レート実測（2秒窓）
  hzCount++;
  if (now - hzWindowStart >= 2000) {
    const hz = (hzCount * 1000) / (now - hzWindowStart);
    hzWindowStart = now; hzCount = 0;
    useExternalGpsStore.setState({ measuredHz: Math.round(hz) });
  }
  if (now - lastUiUpdate >= UI_UPDATE_INTERVAL_MS) {
    lastUiUpdate = now;
    useExternalGpsStore.setState({ lastFix: fix, lastFixAt: now });
  }

  if (!fix.validFix) return;
  const tracking = useTrackingStore.getState();
  if (!tracking.isTracking || tracking.isPaused) return;
  const interval = 1000 / useExternalGpsStore.getState().recordHz;
  // 少しの揺らぎで 1 点落ちないよう 10% のマージン
  if (fix.timestamp - lastRecordedTs < interval * 0.9 && fix.timestamp >= lastRecordedTs) return;
  lastRecordedTs = fix.timestamp;
  addExternalFix(fix);
}

function scheduleReconnect() {
  clearReconnect();
  const s = useExternalGpsStore.getState();
  if (!s.enabled || !s.deviceId || manualDisconnect) {
    useExternalGpsStore.setState({ status: manualDisconnect ? 'off' : 'error' });
    return;
  }
  useExternalGpsStore.setState({ status: 'reconnecting' });
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectInternal(); }, RECONNECT_DELAY_MS);
}

async function connectInternal(): Promise<void> {
  const s = useExternalGpsStore.getState();
  if (!s.deviceId || connecting) return;
  connecting = true;
  manualDisconnect = false;
  clearReconnect();
  if (s.status !== 'reconnecting') useExternalGpsStore.setState({ status: 'connecting', error: null });
  try {
    if (!(await requestBlePermissions())) throw new Error('Bluetoothの許可が必要です');
    await ensureBluetoothOn();
    const m = getManager();
    teardownLink();
    let d = await m.connectToDevice(s.deviceId, { timeout: 10000 });
    // 25Hz × 88byte を1通知で受けられるよう MTU を広げる（失敗しても分割受信で動く）
    d = await d.requestMTU(247).catch(() => d);
    if (Platform.OS === 'android') {
      // 1 = CONNECTION_PRIORITY_HIGH（25Hz 受信の取りこぼし防止）
      await m.requestConnectionPriorityForDevice(d.id, 1 as unknown as import('react-native-ble-plx').ConnectionPriority).catch(() => {});
    }
    await d.discoverAllServicesAndCharacteristics();
    device = d;
    hzWindowStart = Date.now(); hzCount = 0;
    disconnectSub = m.onDeviceDisconnected(d.id, () => {
      teardownLink();
      useExternalGpsStore.setState({ measuredHz: 0 });
      if (manualDisconnect) useExternalGpsStore.setState({ status: 'off' });
      else scheduleReconnect();
    });
    notifySub = d.monitorCharacteristicForService(UART_SERVICE, UART_TX_CHAR, (err, ch) => {
      if (err || !ch?.value) return; // 切断時のエラーは onDeviceDisconnected 側で処理
      for (const fix of parser.push(base64ToBytes(ch.value))) handleFix(fix);
    });
    useExternalGpsStore.setState({ status: 'connected', error: null });
  } catch (e) {
    teardownLink();
    const msg = e instanceof Error ? e.message : String(e);
    // 権限・BT OFF は自動再試行しても無駄なのでエラーで止める
    const fatal = /許可|Bluetoothをオン/.test(msg);
    useExternalGpsStore.setState({ error: msg, status: fatal ? 'error' : useExternalGpsStore.getState().status });
    if (!fatal) scheduleReconnect();
  } finally {
    connecting = false;
  }
}

async function saveSettings() {
  const { enabled, deviceId, deviceName, recordHz } = useExternalGpsStore.getState();
  const data: Settings = { enabled, deviceId, deviceName, recordHz };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(data)).catch(() => {});
}

export const useExternalGpsStore = create<ExternalGpsState>((set, get) => ({
  enabled: false,
  deviceId: null,
  deviceName: null,
  recordHz: 1,
  loaded: false,
  status: 'off',
  error: null,
  lastFix: null,
  lastFixAt: 0,
  measuredHz: 0,
  scanResults: [],

  // アプリ起動時に1回呼ぶ: 設定を読み込み、有効なら自動接続
  init: async () => {
    if (get().loaded) return;
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Settings>;
        set({
          enabled: !!s.enabled,
          deviceId: s.deviceId ?? null,
          deviceName: s.deviceName ?? null,
          recordHz: s.recordHz === 2 || s.recordHz === 5 ? s.recordHz : 1,
        });
      }
    } catch {}
    set({ loaded: true });
    if (get().enabled && get().deviceId) void connectInternal();
  },

  startScan: async () => {
    if (!(await requestBlePermissions())) {
      set({ status: 'error', error: 'Bluetoothの許可が必要です' });
      return;
    }
    try { await ensureBluetoothOn(); } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const m = getManager();
    m.stopDeviceScan();
    const prevStatus = get().status;
    set({ scanResults: [], error: null, status: prevStatus === 'connected' ? 'connected' : 'scanning' });
    m.startDeviceScan(null, { allowDuplicates: false }, (err, d) => {
      if (err) { set({ status: 'error', error: err.message }); return; }
      if (!d || !isRaceBoxName(d.name ?? d.localName)) return;
      const name = (d.name ?? d.localName)!;
      const list = get().scanResults;
      if (list.some(r => r.id === d.id)) return;
      set({ scanResults: [...list, { id: d.id, name, rssi: d.rssi }] });
    });
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => get().stopScan(), SCAN_DURATION_MS);
  },

  stopScan: () => {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    manager?.stopDeviceScan();
    if (get().status === 'scanning') set({ status: 'off' });
  },

  selectDevice: async (d) => {
    get().stopScan();
    if (device && device.id !== d.id) await get().disconnect();
    set({ deviceId: d.id, deviceName: d.name, enabled: true, scanResults: [] });
    await saveSettings();
    await connectInternal();
  },

  connect: async () => { await connectInternal(); },

  disconnect: async () => {
    manualDisconnect = true;
    clearReconnect();
    const d = device;
    teardownLink();
    if (d) await getManager().cancelDeviceConnection(d.id).catch(() => {});
    set({ status: 'off', measuredHz: 0, lastFix: null });
  },

  forgetDevice: async () => {
    await get().disconnect();
    set({ deviceId: null, deviceName: null, enabled: false, error: null });
    await saveSettings();
  },

  setEnabled: async (v) => {
    set({ enabled: v });
    await saveSettings();
    if (v) { if (get().deviceId) await connectInternal(); }
    else await get().disconnect();
  },

  setRecordHz: async (hz) => {
    set({ recordHz: hz });
    await saveSettings();
  },
}));

/** 外部GPSが「今まさに有効な測位を出している」か（UI表示用） */
export function isExternalGpsLive(s: Pick<ExternalGpsState, 'status' | 'lastFix' | 'lastFixAt'>): boolean {
  return s.status === 'connected' && !!s.lastFix?.validFix && Date.now() - s.lastFixAt < 3000;
}
