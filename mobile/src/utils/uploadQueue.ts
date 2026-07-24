import AsyncStorage from '@react-native-async-storage/async-storage';
import { Route } from '../types';
import { saveRoute } from '../firebase/routes';

const QUEUE_KEY = 'pending_routes';
const MAX_ATTEMPTS = 5; // これを超えて失敗し続けるルートはキューから外す（毒データ対策）

// クライアント側で採番する一意ID（保存の冪等性・重複排除用）
type PendingRoute = Omit<Route, 'id'> & { _qid?: string; _attempts?: number };
export type { PendingRoute };

// enqueue と flush の read-modify-write を直列化する簡易ミューテックス
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => {});
  return run;
}

let flushing = false;

async function readQueue(): Promise<PendingRoute[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function writeQueue(queue: PendingRoute[]): Promise<void> {
  if (queue.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
  else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function getPendingRoutes(): Promise<PendingRoute[]> {
  return readQueue();
}

export async function enqueuePendingRoute(route: Omit<Route, 'id'>): Promise<void> {
  await serialize(async () => {
    const queue = await readQueue();
    // 一意ID（時刻+ポイント数+開始/終了）で重複enqueueを防ぐ
    const qid = `${route.startTime}_${route.endTime}_${route.points.length}`;
    if (queue.some(r => r._qid === qid)) return;
    queue.push({ ...route, _qid: qid, _attempts: 0 });
    await writeQueue(queue);
  });
}

// キュー内のルートを順に送信。成功分は除去、失敗はattemptsを増やし、上限超過分は破棄。
export async function flushPendingRoutes(): Promise<{ uploaded: number; remaining: number; dropped: number }> {
  if (flushing) return { uploaded: 0, remaining: (await readQueue()).length, dropped: 0 };
  flushing = true;
  try {
    return await serialize(async () => {
      const queue = await readQueue();
      if (queue.length === 0) return { uploaded: 0, remaining: 0, dropped: 0 };

      const keep: PendingRoute[] = [];
      let uploaded = 0, dropped = 0;
      for (const item of queue) {
        try {
          const { _qid, _attempts, ...route } = item;
          void _qid; void _attempts;
          await saveRoute(route);
          uploaded++;
        } catch {
          const attempts = (item._attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) { dropped++; continue; } // 破棄
          keep.push({ ...item, _attempts: attempts });
        }
      }
      await writeQueue(keep);
      return { uploaded, remaining: keep.length, dropped };
    });
  } finally {
    flushing = false;
  }
}
