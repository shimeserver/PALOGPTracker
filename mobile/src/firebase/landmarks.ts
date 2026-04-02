import {
  collection, addDoc, getDocs, doc, updateDoc,
  query, where, Timestamp, increment, setDoc
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './config';
import { Landmark, Visit } from '../../src/types';

// ランドマーク保存
export async function saveLandmark(landmark: Omit<Landmark, 'id'>): Promise<string> {
  const docRef = await addDoc(collection(db, 'landmarks'), {
    ...landmark,
    createdAt: Timestamp.fromMillis(landmark.createdAt),
    firstVisit: landmark.firstVisit ? Timestamp.fromMillis(landmark.firstVisit) : null,
    lastVisit: landmark.lastVisit ? Timestamp.fromMillis(landmark.lastVisit) : null,
  });
  return docRef.id;
}

// ランドマーク一覧取得
export async function getUserLandmarks(userId: string): Promise<Landmark[]> {
  const q = query(collection(db, 'landmarks'), where('userId', '==', userId));
  const snapshot = await getDocs(q);
  const landmarks = snapshot.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      createdAt: data.createdAt.toMillis(),
      firstVisit: data.firstVisit?.toMillis(),
      lastVisit: data.lastVisit?.toMillis(),
    } as Landmark;
  });
  return landmarks.sort((a, b) => b.createdAt - a.createdAt);
}

// 来訪記録（visitCount を increment する）
export async function recordVisit(landmarkId: string, visit: Omit<Visit, 'id'>): Promise<string> {
  const visitRef = await addDoc(
    collection(db, 'landmarks', landmarkId, 'visits'),
    { ...visit, timestamp: Timestamp.fromMillis(visit.timestamp) }
  );
  await updateDoc(doc(db, 'landmarks', landmarkId), {
    visitCount: increment(1),
    lastVisit: Timestamp.fromMillis(visit.timestamp),
  });
  return visitRef.id;
}

// 来訪ログのみ追加（visitCount は変更しない。saveLandmark(visitCount:1)と組み合わせる用）
export async function recordVisitOnly(landmarkId: string, visit: Omit<Visit, 'id'>): Promise<string> {
  const visitRef = await addDoc(
    collection(db, 'landmarks', landmarkId, 'visits'),
    { ...visit, timestamp: Timestamp.fromMillis(visit.timestamp) }
  );
  return visitRef.id;
}

// 来訪履歴取得
export async function getVisits(landmarkId: string): Promise<Visit[]> {
  const snapshot = await getDocs(collection(db, 'landmarks', landmarkId, 'visits'));
  const visits = snapshot.docs.map(d => {
    const data = d.data();
    return { id: d.id, ...data, timestamp: data.timestamp.toMillis() } as Visit;
  });
  return visits.sort((a, b) => b.timestamp - a.timestamp);
}

// 写真アップロード
export async function uploadLandmarkPhoto(
  userId: string,
  landmarkId: string,
  localUri: string
): Promise<{ url: string; storagePath: string }> {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const filename = `${Date.now()}.jpg`;
  const storagePath = `landmarks/${userId}/${landmarkId}/${filename}`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob);
  const url = await getDownloadURL(storageRef);
  return { url, storagePath };
}

// ランドマーク更新（写真追加等）
export async function updateLandmark(landmarkId: string, data: Partial<Landmark>): Promise<void> {
  await updateDoc(doc(db, 'landmarks', landmarkId), data);
}
