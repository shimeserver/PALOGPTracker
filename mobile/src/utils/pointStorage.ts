import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TrackPoint } from '../types';
import * as FileSystem from 'expo-file-system/legacy';

// Commit a small manifest last. Until it succeeds, the previous snapshot remains readable.
const CHUNK_SIZE = 500;
const chunkDirectory = () => {
  if (!FileSystem.documentDirectory) throw new Error('端末内の保存先を利用できません');
  return FileSystem.documentDirectory + 'gps-point-chunks/';
};
// Do not use %2F in a file URI: Android decodes it into a directory separator.
// Escape the escape character too, so different keys cannot share a filename.
const chunkPath = (key: string) => chunkDirectory()
  + key.replace(/[^a-zA-Z0-9-]/g, char => '_' + char.charCodeAt(0).toString(16) + '_') + '.json';
async function deleteChunks(keys: string[]) {
  for (const key of keys) await FileSystem.deleteAsync(chunkPath(key), { idempotent: true });
}
type PointData = { points: TrackPoint[] };
type Manifest = { version: 1; meta: Record<string, unknown>; chunks: string[]; tail: TrackPoint[]; count: number };
let chain: Promise<unknown> = Promise.resolve();
export function storageOperation<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function manifest(key: string): Promise<Manifest | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as Manifest;
  if (value.version !== 1 || !Array.isArray(value.chunks) || !Array.isArray(value.tail)
    || value.count !== value.chunks.length * CHUNK_SIZE + value.tail.length) {
    throw new Error('端末内の記録情報を読み込めません。データは削除していません。');
  }
  return value;
}

export async function readPointData<T extends PointData>(key: string): Promise<T | null> {
  const saved = await manifest(key);
  if (!saved) return null;
  const points: TrackPoint[] = [];
  // Bound transient memory rather than loading every JSON string simultaneously.
  for (const chunk of saved.chunks) {
    const raw = await FileSystem.readAsStringAsync(chunkPath(chunk));
    if (!raw) throw new Error('記録の一部を読み込めません。データは削除していません。');
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length !== CHUNK_SIZE) throw new Error('記録データが不完全です');
    points.push(...data);
  }
  points.push(...saved.tail);
  return { ...saved.meta, points } as T;
}

// append=true is only for an append-only recording with the same startTime.
export async function writePointData<T extends PointData>(key: string, data: T, append = false): Promise<void> {
  const previous = await manifest(key);
  const { points, ...meta } = data;
  const reuse = append && previous && previous.meta.startTime === (meta as Record<string, unknown>).startTime
    && previous.count <= points.length;
  const chunks = reuse ? [...previous.chunks] : [];
  const created: string[] = [];
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await FileSystem.makeDirectoryAsync(chunkDirectory(), { intermediates: true });
  try {
    for (let offset = chunks.length * CHUNK_SIZE; offset + CHUNK_SIZE <= points.length; offset += CHUNK_SIZE) {
      const chunk = `${key}/points/${generation}/${offset}`;
      created.push(chunk);
      await FileSystem.writeAsStringAsync(chunkPath(chunk), JSON.stringify(points.slice(offset, offset + CHUNK_SIZE)));
      chunks.push(chunk);
    }
    const next: Manifest = { version: 1, meta, chunks, tail: points.slice(chunks.length * CHUNK_SIZE), count: points.length };
    await AsyncStorage.setItem(key, JSON.stringify(next));
  } catch (error) {
    // A failed write must never remove chunks belonging to the last committed manifest.
    if (created.length) await deleteChunks(created).catch(() => {});
    throw error;
  }
  if (previous && !reuse && previous.chunks.length) {
    await deleteChunks(previous.chunks).catch(() => {});
  }
}

export async function removePointData(key: string): Promise<void> {
  const saved = await manifest(key);
  await AsyncStorage.removeItem(key);
  if (saved?.chunks.length) await deleteChunks(saved.chunks).catch(() => {});
}
