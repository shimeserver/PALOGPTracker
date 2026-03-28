import {
  collection, getDocs, query, where, Timestamp, doc, getDoc, deleteDoc, updateDoc, addDoc
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './config';

// --- 愛車 ---
export interface Car {
  id?: string;
  userId: string;
  nickname: string;
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  photoUrl?: string;
  photoStoragePath?: string;
  tagId?: string;
  odometerKm?: number;
  createdAt: number;
}

export interface FuelLog {
  id?: string;
  carId: string;
  timestamp: number;
  liters: number;
  pricePerLiter?: number;
  totalCost?: number;
  isFull: boolean;
  notes?: string;
}

export type MaintenanceType = 'oil' | 'tire' | 'brake' | 'battery' | 'inspection' | 'other';

export const MAINTENANCE_LABELS: Record<MaintenanceType, string> = {
  oil: 'オイル交換',
  tire: 'タイヤ交換/ローテーション',
  brake: 'ブレーキ',
  battery: 'バッテリー',
  inspection: '車検',
  other: 'その他',
};

export interface MaintenanceLog {
  id?: string;
  carId: string;
  type: MaintenanceType;
  customLabel?: string;
  timestamp: number;
  odometerKm?: number;
  cost?: number;
  notes?: string;
  nextDueMonths?: number;
  nextDueKm?: number;
}

export interface TrackPoint { lat: number; lng: number; timestamp: number; speed: number; }
export interface Route {
  id?: string; userId: string; name: string; tags: string[];
  startTime: number; endTime: number; totalDistance: number;
  avgSpeed: number; maxSpeed: number; points: TrackPoint[];
  source: 'recorded' | 'imported'; createdAt: number;
}
export interface TagDef {
  id?: string; userId: string; name: string; color: string;
}
export interface LandmarkPhoto { url: string; storagePath: string; takenAt: number; }
export interface Landmark {
  id?: string; userId: string; name: string; category: string;
  lat: number; lng: number; description: string; photos: LandmarkPhoto[];
  visitCount: number; firstVisit?: number; lastVisit?: number; createdAt: number;
  placeId?: string;
}
export interface Visit {
  id?: string; landmarkId: string; userId: string;
  timestamp: number; routeId?: string; notes?: string;
}

export async function getUserRoutes(userId: string): Promise<Route[]> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snap = await getDocs(q);
  const routes = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id, ...data,
      tags: data.tags || [],
      startTime: data.startTime.toMillis(),
      endTime: data.endTime.toMillis(),
      createdAt: data.createdAt.toMillis(),
    } as Route;
  });
  return routes.sort((a, b) => b.startTime - a.startTime);
}

export async function getRoute(routeId: string): Promise<Route | null> {
  const snap = await getDoc(doc(db, 'routes', routeId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id, ...data,
    tags: data.tags || [],
    startTime: data.startTime.toMillis(),
    endTime: data.endTime.toMillis(),
    createdAt: data.createdAt.toMillis(),
  } as Route;
}

export async function getUserLandmarks(userId: string): Promise<Landmark[]> {
  const q = query(collection(db, 'landmarks'), where('userId', '==', userId));
  const snap = await getDocs(q);
  const landmarks = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id, ...data,
      createdAt: data.createdAt.toMillis(),
      firstVisit: data.firstVisit?.toMillis(),
      lastVisit: data.lastVisit?.toMillis(),
    } as Landmark;
  });
  return landmarks.sort((a, b) => b.visitCount - a.visitCount);
}

export async function deleteRoute(routeId: string): Promise<void> {
  await deleteDoc(doc(db, 'routes', routeId));
}

export async function deleteAllUserLandmarks(userId: string): Promise<number> {
  const q = query(collection(db, 'landmarks'), where('userId', '==', userId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  return snap.docs.length;
}

export async function updateLandmark(
  landmarkId: string,
  patch: {
    name?: string; description?: string; category?: string;
    photos?: LandmarkPhoto[]; lat?: number; lng?: number;
    placeId?: string; visitCount?: number; firstVisit?: number; lastVisit?: number;
  }
): Promise<void> {
  const data: Record<string, unknown> = { ...patch };
  if (patch.firstVisit !== undefined) data.firstVisit = Timestamp.fromMillis(patch.firstVisit);
  if (patch.lastVisit  !== undefined) data.lastVisit  = Timestamp.fromMillis(patch.lastVisit);
  await updateDoc(doc(db, 'landmarks', landmarkId), data);
}

export async function mergeLandmarks(keepId: string, deleteId: string, merged: {
  visitCount: number; firstVisit: number; lastVisit: number;
}): Promise<void> {
  // visits を転送
  const visitsSnap = await getDocs(collection(db, 'landmarks', deleteId, 'visits'));
  await Promise.all(visitsSnap.docs.map(d =>
    addDoc(collection(db, 'landmarks', keepId, 'visits'), d.data())
  ));
  await Promise.all(visitsSnap.docs.map(d => deleteDoc(d.ref)));
  await deleteDoc(doc(db, 'landmarks', deleteId));
  await updateDoc(doc(db, 'landmarks', keepId), {
    visitCount: merged.visitCount,
    firstVisit: Timestamp.fromMillis(merged.firstVisit),
    lastVisit:  Timestamp.fromMillis(merged.lastVisit),
  });
}

export async function deleteLandmark(landmarkId: string): Promise<void> {
  await deleteDoc(doc(db, 'landmarks', landmarkId));
}

export async function deleteAllUserRoutes(userId: string): Promise<number> {
  const q = query(collection(db, 'routes'), where('userId', '==', userId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  return snap.docs.length;
}

export async function deleteVisit(landmarkId: string, visitId: string): Promise<void> {
  await deleteDoc(doc(db, 'landmarks', landmarkId, 'visits', visitId));
}

export async function getVisits(landmarkId: string): Promise<Visit[]> {
  const snap = await getDocs(collection(db, 'landmarks', landmarkId, 'visits'));
  const visits = snap.docs.map(d => ({
    id: d.id, ...d.data(),
    timestamp: (d.data().timestamp as Timestamp).toMillis(),
  } as Visit));
  return visits.sort((a, b) => b.timestamp - a.timestamp);
}

// --- タグ ---
export async function getUserTags(userId: string): Promise<TagDef[]> {
  const q = query(collection(db, 'tags'), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as TagDef));
}

export async function createTag(tag: Omit<TagDef, 'id'>): Promise<TagDef> {
  const docRef = await addDoc(collection(db, 'tags'), tag);
  return { ...tag, id: docRef.id };
}

export async function deleteTag(tagId: string): Promise<void> {
  await deleteDoc(doc(db, 'tags', tagId));
}

export async function updateRouteTags(routeId: string, tagIds: string[]): Promise<void> {
  await updateDoc(doc(db, 'routes', routeId), { tags: tagIds });
}

export async function updateRouteName(routeId: string, name: string): Promise<void> {
  await updateDoc(doc(db, 'routes', routeId), { name });
}

// --- 写真アップロード（Web） ---
export async function uploadLandmarkPhoto(
  userId: string, landmarkId: string, file: File
): Promise<LandmarkPhoto> {
  const path = `landmarks/${userId}/${landmarkId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { url, storagePath: path, takenAt: Date.now() };
}

// --- 愛車 CRUD ---
export async function getUserCars(userId: string): Promise<Car[]> {
  const q = query(collection(db, 'cars'), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Car))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function createCar(car: Omit<Car, 'id'>): Promise<Car> {
  const docRef = await addDoc(collection(db, 'cars'), car);
  return { ...car, id: docRef.id };
}

export async function updateCar(carId: string, patch: Partial<Omit<Car, 'id' | 'userId'>>): Promise<void> {
  await updateDoc(doc(db, 'cars', carId), patch as Record<string, unknown>);
}

export async function deleteCar(carId: string): Promise<void> {
  await deleteDoc(doc(db, 'cars', carId));
}

// --- 給油ログ ---
export async function getFuelLogs(carId: string): Promise<FuelLog[]> {
  const snap = await getDocs(collection(db, 'cars', carId, 'fuelLogs'));
  return snap.docs
    .map(d => ({ id: d.id, carId, ...d.data() } as FuelLog))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function addFuelLog(carId: string, log: Omit<FuelLog, 'id' | 'carId'>): Promise<FuelLog> {
  const docRef = await addDoc(collection(db, 'cars', carId, 'fuelLogs'), log);
  return { ...log, id: docRef.id, carId };
}

export async function deleteFuelLog(carId: string, logId: string): Promise<void> {
  await deleteDoc(doc(db, 'cars', carId, 'fuelLogs', logId));
}

// --- 整備ログ ---
export async function getMaintenanceLogs(carId: string): Promise<MaintenanceLog[]> {
  const snap = await getDocs(collection(db, 'cars', carId, 'maintenanceLogs'));
  return snap.docs
    .map(d => ({ id: d.id, carId, ...d.data() } as MaintenanceLog))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function addMaintenanceLog(carId: string, log: Omit<MaintenanceLog, 'id' | 'carId'>): Promise<MaintenanceLog> {
  const docRef = await addDoc(collection(db, 'cars', carId, 'maintenanceLogs'), log);
  return { ...log, id: docRef.id, carId };
}

export async function updateMaintenanceLog(carId: string, logId: string, patch: Partial<Omit<MaintenanceLog, 'id' | 'carId'>>): Promise<void> {
  await updateDoc(doc(db, 'cars', carId, 'maintenanceLogs', logId), patch as Record<string, unknown>);
}

export async function deleteMaintenanceLog(carId: string, logId: string): Promise<void> {
  await deleteDoc(doc(db, 'cars', carId, 'maintenanceLogs', logId));
}

export async function uploadCarPhoto(userId: string, carId: string, file: File): Promise<{ url: string; storagePath: string }> {
  const path = `cars/${userId}/${carId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { url, storagePath: path };
}
