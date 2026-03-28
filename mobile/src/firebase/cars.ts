import {
  collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, where
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './config';
import { Car, FuelLog, MaintenanceLog } from '../types';

// タグ作成（愛車と紐付けるため）
export async function createCarTag(userId: string, name: string, color: string): Promise<string> {
  const docRef = await addDoc(collection(db, 'tags'), { userId, name, color });
  return docRef.id;
}

// --- 愛車 ---
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

export async function uploadCarPhoto(userId: string, carId: string, uri: string): Promise<{ url: string; storagePath: string }> {
  const response = await fetch(uri);
  const blob = await response.blob();
  const storagePath = `cars/${userId}/${carId}/photo_${Date.now()}.jpg`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob);
  const url = await getDownloadURL(storageRef);
  return { url, storagePath };
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

export interface TagDef { id: string; userId: string; name: string; color: string; }

export async function getUserTags(userId: string): Promise<TagDef[]> {
  const q = query(collection(db, 'tags'), where('userId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as TagDef));
}

export interface RouteStats { totalDistance: number; maxSpeed: number; avgSpeed: number; count: number; }

export async function getRouteStatsByTag(userId: string, tagId: string): Promise<RouteStats> {
  // 同名タグを全部取得して array-contains-any で検索
  const allTags = await getUserTags(userId);
  const thisTag = allTags.find(t => t.id === tagId);
  const tagIds = thisTag
    ? allTags.filter(t => t.name === thisTag.name).map(t => t.id).filter((id): id is string => !!id)
    : [tagId];

  // array-contains-any は最大10件
  const ids = tagIds.slice(0, 10);
  const q = ids.length === 1
    ? query(collection(db, 'routes'), where('userId', '==', userId), where('tags', 'array-contains', ids[0]))
    : query(collection(db, 'routes'), where('userId', '==', userId), where('tags', 'array-contains-any', ids));
  const snap = await getDocs(q);
  const docs = snap.docs.map(d => d.data());
  if (docs.length === 0) return { totalDistance: 0, maxSpeed: 0, avgSpeed: 0, count: 0 };
  return {
    totalDistance: docs.reduce((s, r) => s + (r.totalDistance || 0), 0),
    maxSpeed: Math.max(...docs.map(r => r.maxSpeed || 0)),
    avgSpeed: docs.reduce((s, r) => s + (r.avgSpeed || 0), 0) / docs.length,
    count: docs.length,
  };
}
