import {
  collection, addDoc, getDocs, doc, getDoc,
  query, where, Timestamp, deleteDoc, orderBy, writeBatch
} from 'firebase/firestore';
import { db, auth } from './config';
import { Route, TrackPoint } from '../../src/types';

export type RouteMetadata = Omit<Route, 'points'>;

// points はルート本体から分離し routes/{id}/pts/{i} に分割保存する（軽量形式）。
// 本体が軽くなり一覧・統計クエリが高速/低コストになる。読み込みは両形式に対応。
const PTS_CHUNK = 1500;

// 1コミットあたりのチャンク数上限。Firestoreはコミット1回10MiB制限があり、
// 長距離ルートを1バッチで送ると超過して保存が丸ごと失敗する。
const CHUNKS_PER_COMMIT = 15;

async function writePointChunks(routeId: string, points: TrackPoint[]): Promise<void> {
  const chunkCount = Math.ceil(points.length / PTS_CHUNK);
  for (let start = 0; start < chunkCount; start += CHUNKS_PER_COMMIT) {
    const batch = writeBatch(db);
    for (let i = start; i < Math.min(start + CHUNKS_PER_COMMIT, chunkCount); i++) {
      batch.set(doc(db, 'routes', routeId, 'pts', String(i).padStart(4, '0')),
        { i, points: points.slice(i * PTS_CHUNK, (i + 1) * PTS_CHUNK) });
    }
    await batch.commit();
  }
}

async function loadPointChunks(routeId: string): Promise<TrackPoint[]> {
  const snap = await getDocs(query(collection(db, 'routes', routeId, 'pts'), orderBy('i')));
  return snap.docs.flatMap(d => (d.data().points ?? []) as TrackPoint[]);
}

async function deletePointChunks(routeId: string): Promise<void> {
  const snap = await getDocs(collection(db, 'routes', routeId, 'pts'));
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ルート保存（軽量形式: 本体メタデータ + pts チャンク）
export async function saveRoute(route: Omit<Route, 'id'>): Promise<string> {
  const { points, ...meta } = route;
  const docRef = await addDoc(collection(db, 'routes'), {
    ...meta,
    startTime: Timestamp.fromMillis(route.startTime),
    endTime: Timestamp.fromMillis(route.endTime),
    createdAt: Timestamp.fromMillis(route.createdAt),
    ptsChunked: true,
    pointCount: points.length,
  });
  await writePointChunks(docRef.id, points);
  return docRef.id;
}

// Firestore REST API のフィールド値をデシリアライズ
function parseFirestoreValue(v: Record<string, unknown>): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return new Date(v.timestampValue as string).getTime();
  if (v.arrayValue) {
    const av = v.arrayValue as { values?: Record<string, unknown>[] };
    return (av.values ?? []).map(parseFirestoreValue);
  }
  return undefined;
}

// ユーザーのルート一覧取得（メタデータのみ — REST API select で points[] をネットワーク転送から除外）
export async function getUserRoutesMetadata(userId: string): Promise<RouteMetadata[]> {
  return _fetchRoutesMetadata(userId, null);
}

// since(ms) 以降に記録されたルートのみ取得（差分フェッチ用）
export async function getUserRoutesMetadataSince(userId: string, since: number): Promise<RouteMetadata[]> {
  return _fetchRoutesMetadata(userId, since);
}

async function _fetchRoutesMetadata(userId: string, since: number | null): Promise<RouteMetadata[]> {
  const projectId = (db.app.options as { projectId: string }).projectId;
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');

  const selectFields = [
    'userId', 'name', 'tags', 'startTime', 'endTime',
    'totalDistance', 'avgSpeed', 'maxSpeed', 'source', 'mode', 'createdAt',
  ].map(f => ({ fieldPath: f }));

  const userFilter = {
    fieldFilter: {
      field: { fieldPath: 'userId' },
      op: 'EQUAL',
      value: { stringValue: userId },
    },
  };

  const whereClause = since != null
    ? {
        compositeFilter: {
          op: 'AND',
          filters: [
            userFilter,
            {
              fieldFilter: {
                field: { fieldPath: 'startTime' },
                op: 'GREATER_THAN',
                value: { timestampValue: new Date(since).toISOString() },
              },
            },
          ],
        },
      }
    : userFilter;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        select: { fields: selectFields },
        from: [{ collectionId: 'routes' }],
        where: whereClause,
      },
    }),
  });

  if (!res.ok) throw new Error(`Firestore REST error: ${res.status}`);
  const results: Array<{ document?: { name: string; fields: Record<string, Record<string, unknown>> } }> = await res.json();

  return results
    .filter(r => r.document)
    .map(r => {
      const id = r.document!.name.split('/').pop()!;
      const parsed: Record<string, unknown> = { id };
      for (const [k, v] of Object.entries(r.document!.fields)) {
        parsed[k] = parseFirestoreValue(v);
      }
      return parsed as unknown as RouteMetadata;
    })
    .sort((a, b) => b.startTime - a.startTime);
}

// ユーザーのルート一覧取得（全データ — points[] 含む）
export async function getUserRoutes(userId: string): Promise<Route[]> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snapshot = await getDocs(q);
  const routes = snapshot.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      points: data.points || [], // 軽量形式は空（詳細は getRoute で取得）
      startTime: data.startTime.toMillis(),
      endTime: data.endTime.toMillis(),
      createdAt: data.createdAt.toMillis(),
    } as Route;
  });
  return routes.sort((a, b) => b.startTime - a.startTime);
}

// ルート1件取得（旧形式=本体内蔵 / 軽量形式=ptsチャンク の両対応）
export async function getRoute(routeId: string): Promise<Route | null> {
  const snap = await getDoc(doc(db, 'routes', routeId));
  if (!snap.exists()) return null;
  const data = snap.data();
  const points = Array.isArray(data.points) && data.points.length > 0
    ? data.points
    : await loadPointChunks(routeId);
  return {
    id: snap.id,
    ...data,
    points,
    startTime: data.startTime.toMillis(),
    endTime: data.endTime.toMillis(),
    createdAt: data.createdAt.toMillis(),
  } as Route;
}

// ルートのメタデータ更新（mode / tags / name）
export async function updateRoute(routeId: string, patch: { mode?: string; tags?: string[]; name?: string }): Promise<void> {
  const { updateDoc } = await import('firebase/firestore');
  await updateDoc(doc(db, 'routes', routeId), patch);
}

// ルート削除（ptsチャンクも削除）
export async function deleteRoute(routeId: string): Promise<void> {
  await deletePointChunks(routeId);
  await deleteDoc(doc(db, 'routes', routeId));
}

// 全ルート削除
export async function deleteAllUserRoutes(userId: string): Promise<number> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snap = await getDocs(q);
  for (const d of snap.docs) {
    await deletePointChunks(d.id);
    await deleteDoc(d.ref);
  }
  return snap.docs.length;
}
