import AsyncStorage from '@react-native-async-storage/async-storage';
import { Route } from '../types';
import { saveRoute } from '../firebase/routes';

const QUEUE_KEY = 'pending_routes';

export type PendingRoute = Omit<Route, 'id'>;

export async function getPendingRoutes(): Promise<PendingRoute[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function enqueuePendingRoute(route: PendingRoute): Promise<void> {
  const queue = await getPendingRoutes();
  queue.push(route);
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// キュー内のルートを順に送信。成功した分だけキューから除去。
export async function flushPendingRoutes(): Promise<{ uploaded: number; remaining: number }> {
  const queue = await getPendingRoutes();
  if (queue.length === 0) return { uploaded: 0, remaining: 0 };

  const failed: PendingRoute[] = [];
  let uploaded = 0;
  for (const route of queue) {
    try {
      await saveRoute(route);
      uploaded++;
    } catch {
      failed.push(route);
    }
  }
  if (failed.length > 0) {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(failed));
  } else {
    await AsyncStorage.removeItem(QUEUE_KEY);
  }
  return { uploaded, remaining: failed.length };
}
