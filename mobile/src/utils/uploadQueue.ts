import AsyncStorage from '@react-native-async-storage/async-storage';
import { Route } from '../types';
import { saveRoute } from '../firebase/routes';
import { storageOperation, readPointData, writePointData, removePointData } from './pointStorage';

const LEGACY_KEY = 'pending_routes';
const INDEX_KEY = 'pending_routes_v2';
type PendingRoute = Omit<Route, 'id'> & { _qid?: string; _attempts?: number; _revision?: string };
export type { PendingRoute };
const routeKey = (id: string) => INDEX_KEY + '/' + id;
const routeId = (route: Omit<Route, 'id'>) => route.userId + '_' + route.startTime;
const revision = () => Date.now() + '-' + Math.random().toString(36).slice(2);
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// Called under storageOperation. Failed reads must never become an empty queue.
async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('未送信一覧を読み込めません');
  const legacyRaw = await AsyncStorage.getItem(LEGACY_KEY);
  if (legacyRaw) {
    const legacy: PendingRoute[] = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy)) throw new Error('以前の未送信記録を読み込めません');
    for (const route of legacy) {
      const id = routeId(route);
      if (ids.includes(id)) continue;
      await writePointData(routeKey(id), { ...route, _qid: id, _revision: revision() });
      ids.push(id);
    }
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids));
    await AsyncStorage.removeItem(LEGACY_KEY);
  }
  return ids;
}

export async function getPendingRoutes(): Promise<PendingRoute[]> {
  return serialize(() => storageOperation(async () => {
    const routes: PendingRoute[] = [];
    for (const id of await readIndex()) {
      const route = await readPointData<PendingRoute>(routeKey(id));
      if (!route) throw new Error('未送信記録を読み込めません。データは削除していません。');
      routes.push(route);
    }
    return routes;
  }));
}

export async function getPendingRouteCount(): Promise<number> {
  return serialize(() => storageOperation(async () => (await readIndex()).length));
}

export async function enqueuePendingRoute(route: Omit<Route, 'id'>): Promise<void> {
  await serialize(() => storageOperation(async () => {
    const ids = await readIndex();
    const id = routeId(route);
    const exists = ids.includes(id);
    if (exists) {
      const saved = await readPointData<PendingRoute>(routeKey(id));
      if (!saved) throw new Error('未送信記録を読み込めません');
      // A recovery may coexist with its queued snapshot after an interrupted stop.
      // Keep the resumed extension, but never replace it with an older backup.
      if (route.endTime < saved.endTime
        || (route.endTime === saved.endTime && route.points.length <= saved.points.length)) return;
    }
    await writePointData(routeKey(id), { ...route, _qid: id, _revision: revision() });
    if (!exists) await AsyncStorage.setItem(INDEX_KEY, JSON.stringify([...ids, id]));
  }));
}

export async function hasPendingRoute(userId: string, startTime: number): Promise<boolean> {
  return serialize(() => storageOperation(async () => (await readIndex()).includes(userId + '_' + startTime)));
}

let inFlight: Promise<{ uploaded: number; remaining: number; dropped: number }> | null = null;
export function flushPendingRoutes(): Promise<{ uploaded: number; remaining: number; dropped: number }> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const ids = await serialize(() => storageOperation(readIndex));
    let uploaded = 0;
    let remaining = [...ids];
    for (const id of ids) {
      const item = await serialize(() => storageOperation(() => readPointData<PendingRoute>(routeKey(id))));
      if (!item) throw new Error('未送信記録を読み込めません');
      const { _qid, _attempts, _revision, ...route } = item;
      try {
        await saveRoute(route);
      } catch {
        // Keep the durable copy regardless of failure count or cause.
        continue;
      }
      await serialize(() => storageOperation(async () => {
        const current = await readPointData<PendingRoute>(routeKey(id));
        if (!current) throw new Error('未送信記録を読み込めません');
        // An older upload must not delete a newer snapshot enqueued while it waited.
        if (current._revision !== _revision) return;
        const next = (await readIndex()).filter(value => value !== id);
        await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next));
        await removePointData(routeKey(id)).catch(() => {});
        remaining = next;
      }));
      uploaded++;
    }
    remaining = await serialize(() => storageOperation(readIndex));
    return { uploaded, remaining: remaining.length, dropped: 0 };
  })().finally(() => { inFlight = null; });
  return inFlight;
}
