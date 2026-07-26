import type { TrackPoint, Route } from '../firebase/data';

// ルート点列の IndexedDB キャッシュ。
// Webパネルは開くたびに全ルートの点列チャンクをFirestoreから読み直していたため、
// 起動が遅く読み取り課金も毎回発生していた。点列は「修復・区間修正した時」しか
// 変わらないので、フィンガープリント（点数・終了時刻・総距離）が一致する限り
// ローカルキャッシュを使い、変わったルートだけ再フェッチする。

const DB_NAME = 'palogp-cache';
const STORE = 'routePts';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // 失敗したPromiseを保持し続けると全セッションでキャッシュ不能になるため、次回は再試行する
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// メタデータから点列の同一性を判定するキー。
// updateRoutePoints は pointCount / endTime / totalDistance を必ず更新するため、
// 点列が変わればフィンガープリントも必ず変わる。
export function routeFingerprint(r: Pick<Route, 'endTime' | 'totalDistance'> & { pointCount?: number; points?: TrackPoint[] }): string {
  const count = r.pointCount ?? r.points?.length ?? 0;
  return `${count}|${r.endTime}|${Math.round(r.totalDistance * 1000)}`;
}

interface CacheEntry { fp: string; points: TrackPoint[]; }

export async function getCachedPoints(routeId: string, fp: string): Promise<TrackPoint[] | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(routeId);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        resolve(entry && entry.fp === fp && entry.points.length > 0 ? entry.points : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCachedPoints(routeId: string, fp: string, points: TrackPoint[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ fp, points } satisfies CacheEntry, routeId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* キャッシュ失敗は無害 */ }
}

export async function deleteCachedPoints(routeId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(routeId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* noop */ }
}

export async function clearPointsCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* noop */ }
}
