import {
  collection, addDoc, getDocs, doc, getDoc,
  query, where, Timestamp, deleteDoc
} from 'firebase/firestore';
import { db } from './config';
import { Route, TrackPoint } from '../../src/types';

// ルート保存
export async function saveRoute(route: Omit<Route, 'id'>): Promise<string> {
  const docRef = await addDoc(collection(db, 'routes'), {
    ...route,
    startTime: Timestamp.fromMillis(route.startTime),
    endTime: Timestamp.fromMillis(route.endTime),
    createdAt: Timestamp.fromMillis(route.createdAt),
  });
  return docRef.id;
}

// ユーザーのルート一覧取得
export async function getUserRoutes(userId: string): Promise<Route[]> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snapshot = await getDocs(q);
  const routes = snapshot.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      startTime: data.startTime.toMillis(),
      endTime: data.endTime.toMillis(),
      createdAt: data.createdAt.toMillis(),
    } as Route;
  });
  return routes.sort((a, b) => b.startTime - a.startTime);
}

// ルート1件取得
export async function getRoute(routeId: string): Promise<Route | null> {
  const snap = await getDoc(doc(db, 'routes', routeId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    startTime: data.startTime.toMillis(),
    endTime: data.endTime.toMillis(),
    createdAt: data.createdAt.toMillis(),
  } as Route;
}

// ルート削除
export async function deleteRoute(routeId: string): Promise<void> {
  await deleteDoc(doc(db, 'routes', routeId));
}

// 全ルート削除
export async function deleteAllUserRoutes(userId: string): Promise<number> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  return snap.docs.length;
}
