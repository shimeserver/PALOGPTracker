import { TrackPoint, Route } from '../types';
import { saveRoute } from '../firebase/routes';

interface ParsedLog {
  name: string;
  tags: string[];
  points: TrackPoint[];
}

// ルートヒストリーCSVをパース
export function parseRouteHistoryCsv(csvText: string): ParsedLog[] {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const logs: ParsedLog[] = [];
  let current: ParsedLog | null = null;

  for (const line of lines) {
    if (line.startsWith('LogHeader,')) {
      // 前のログを確定
      if (current && current.points.length > 0) {
        logs.push(current);
      }
      // 例: LogHeader,"ルート名","",1
      const parts = parseCsvLine(line);
      const name = parts[1] || '';
      current = { name, tags: [], points: [] };
    } else if (line.startsWith('LogTag,')) {
      if (current) {
        const parts = parseCsvLine(line);
        current.tags = parts.slice(1).filter(Boolean);
      }
    } else if (line.startsWith('tp,')) {
      if (current) {
        const parts = line.split(',');
        // tp,lat,lng,timestamp,speed
        const lat = parseFloat(parts[1]);
        const lng = parseFloat(parts[2]);
        const timestamp = new Date(parts[3]).getTime();
        const speed = parseFloat(parts[4]) || 0;
        if (!isNaN(lat) && !isNaN(lng) && !isNaN(timestamp)) {
          current.points.push({ lat, lng, timestamp, speed });
        }
      }
    } else if (line === 'LogEnd') {
      if (current && current.points.length > 0) {
        logs.push(current);
        current = null;
      }
    }
  }
  // 最後のログ（LogEndなしの場合）
  if (current && current.points.length > 0) {
    logs.push(current);
  }

  return logs;
}

// CSV行をパース（クォート対応）
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ハバーサイン距離計算
function haversine(p1: TrackPoint, p2: TrackPoint): number {
  const R = 6371;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// パースしたログをFirebaseに保存
export async function importRouteHistoryCsv(
  csvText: string,
  userId: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: number; failed: number }> {
  const logs = parseRouteHistoryCsv(csvText);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    onProgress?.(i + 1, logs.length);
    try {
      const pts = log.points;
      let totalDist = 0;
      for (let j = 1; j < pts.length; j++) {
        totalDist += haversine(pts[j - 1], pts[j]);
      }
      const speeds = pts.map(p => p.speed).filter(s => s > 0);
      const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b) / speeds.length : 0;
      const maxSpeed = speeds.length ? Math.max(...speeds) : 0;

      const route: Omit<Route, 'id'> = {
        userId,
        name: log.name || `インポート ${new Date(pts[0].timestamp).toLocaleDateString('ja-JP')}`,
        tags: log.tags,
        startTime: pts[0].timestamp,
        endTime: pts[pts.length - 1].timestamp,
        totalDistance: totalDist,
        avgSpeed,
        maxSpeed,
        points: pts,
        source: 'imported',
        createdAt: Date.now(),
      };
      await saveRoute(route);
      success++;
    } catch {
      failed++;
    }
  }
  return { success, failed };
}
