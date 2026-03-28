import { collection, addDoc, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '../firebase/config';
import type { TrackPoint } from '../firebase/data';

export interface DetectedStop {
  lat: number;
  lng: number;
  arrivalTime: number;
  departureTime: number;
  durationMinutes: number;
  routeName: string;
}

export interface ClusteredSpot {
  lat: number;
  lng: number;
  visitCount: number;
  firstVisit: number;
  lastVisit: number;
  totalMinutes: number;
  visits: { routeName: string; arrivalTime: number; durationMinutes: number }[];
  placeId?: string; // Google Places ID（placeAggregatesから）
}

interface ParsedLog {
  name: string;
  tags: string[];
  points: TrackPoint[];
  altitudes: number[];
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function haversineKm(p1: { lat: number; lng: number }, p2: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) * Math.cos((p2.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcSpeed(p1: TrackPoint, p2: TrackPoint): number {
  const distKm = haversineKm(p1, p2);
  const dtHours = (p2.timestamp - p1.timestamp) / 3_600_000;
  if (dtHours <= 0) return 0;
  const speed = distKm / dtHours;
  return speed > 300 ? 0 : speed;
}

function detectStops(points: TrackPoint[], routeName: string): DetectedStop[] {
  const MIN_STOP_MINUTES = 3;
  const RADIUS_KM = 0.05;
  const stops: DetectedStop[] = [];
  let i = 0;
  while (i < points.length) {
    let j = i + 1;
    while (j < points.length && haversineKm(points[i], points[j]) < RADIUS_KM) j++;
    const durationMs = points[Math.min(j, points.length - 1)].timestamp - points[i].timestamp;
    const durationMinutes = durationMs / 60000;
    if (durationMinutes >= MIN_STOP_MINUTES && j > i + 1) {
      const cluster = points.slice(i, j);
      const lat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
      const lng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
      stops.push({ lat, lng, arrivalTime: points[i].timestamp, departureTime: points[Math.min(j, points.length - 1)].timestamp, durationMinutes, routeName });
      i = j;
    } else {
      i++;
    }
  }
  return stops;
}

// 同一ルート内の重複停車を除去：前回の停車から2km以上離脱しなければ同一訪問とみなす
function deduplicateRouteStops(stops: DetectedStop[], points: TrackPoint[]): DetectedStop[] {
  const CLUSTER_KM  = 0.1;   // 100m以内は同じスポット
  const DEPARTURE_KM = 2.0;  // 2km以上離脱したら別訪問
  const result: DetectedStop[] = [];

  for (const stop of stops) {
    const existing = result.find(s => haversineKm(s, stop) < CLUSTER_KM);
    if (!existing) { result.push(stop); continue; }

    // 前回停車の出発後から今回到着までのGPS点を抽出
    const fromTs = existing.departureTime;
    const toTs   = stop.arrivalTime;
    const between = points.filter(p => p.timestamp > fromTs && p.timestamp < toTs);

    // その区間でスポットから2km以上離れたか確認
    const center = { lat: existing.lat, lng: existing.lng };
    const departed = between.some(p => haversineKm(center, p) >= DEPARTURE_KM);
    if (departed) result.push(stop); // 十分離れたので別訪問
  }
  return result;
}

// 全ルートの停車地点を半径100m以内でクラスタリング → 来訪回数を集計
export function clusterStops(allStops: DetectedStop[]): ClusteredSpot[] {
  const CLUSTER_KM = 0.1; // 100m
  const clusters: ClusteredSpot[] = [];

  for (const stop of allStops) {
    const existing = clusters.find(c => haversineKm(c, stop) < CLUSTER_KM);
    if (existing) {
      // 重心を更新
      const n = existing.visitCount;
      existing.lat = (existing.lat * n + stop.lat) / (n + 1);
      existing.lng = (existing.lng * n + stop.lng) / (n + 1);
      existing.visitCount++;
      existing.totalMinutes += stop.durationMinutes;
      existing.firstVisit = Math.min(existing.firstVisit, stop.arrivalTime);
      existing.lastVisit  = Math.max(existing.lastVisit,  stop.arrivalTime);
      existing.visits.push({ routeName: stop.routeName, arrivalTime: stop.arrivalTime, durationMinutes: stop.durationMinutes });
    } else {
      clusters.push({
        lat: stop.lat, lng: stop.lng,
        visitCount: 1,
        firstVisit: stop.arrivalTime,
        lastVisit:  stop.arrivalTime,
        totalMinutes: stop.durationMinutes,
        visits: [{ routeName: stop.routeName, arrivalTime: stop.arrivalTime, durationMinutes: stop.durationMinutes }],
      });
    }
  }

  return clusters.filter(c => c.visitCount >= 1).sort((a, b) => b.visitCount - a.visitCount);
}

async function fetchPlaceName(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
      { headers: { 'User-Agent': 'PALOGPTracker/1.0' } }
    );
    const data = await res.json();
    const a = data.address || {};
    return (
      a.shop || a.amenity || a.tourism || a.leisure || a.building ||
      a.road || a.neighbourhood || a.suburb || a.city_district ||
      data.name || 'スポット候補'
    );
  } catch {
    return 'スポット候補';
  }
}

// クラスタリングされたスポットをFirestoreのlandmarksに保存（即時）
// 名前はバックグラウンドで逐次取得・更新する
export async function saveDetectedSpots(
  spots: ClusteredSpot[],
  userId: string,
  onProgress?: (cur: number, total: number) => void
): Promise<number> {
  // 既存ランドマークの placeId を取得（確定済みスポットを保護）
  const existingSnap = await getDocs(query(collection(db, 'landmarks'), where('userId', '==', userId)));
  const existingPlaceIds = new Set<string>(
    existingSnap.docs.map(d => d.data().placeId).filter(Boolean)
  );

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  let saved = 0;

  for (let idx = 0; idx < spots.length; idx++) {
    const spot = spots[idx];
    onProgress?.(idx + 1, spots.length);

    // 既に同じ placeId のランドマークがあればスキップ
    if (spot.placeId && existingPlaceIds.has(spot.placeId)) continue;

    try {
      const name = await fetchPlaceName(spot.lat, spot.lng);
      await delay(1100); // Nominatim: 1 req/sec
      const landmarkRef = await addDoc(collection(db, 'landmarks'), {
        userId,
        name,
        category: 'その他',
        lat: spot.lat,
        lng: spot.lng,
        description: `平均滞在 ${Math.round(spot.totalMinutes / spot.visitCount)}分`,
        photos: [],
        visitCount: spot.visitCount,
        firstVisit: Timestamp.fromMillis(spot.firstVisit),
        lastVisit:  Timestamp.fromMillis(spot.lastVisit),
        createdAt:  Timestamp.fromMillis(Date.now()),
        detectedFromImport: true,
      });
      for (const v of spot.visits) {
        await addDoc(collection(db, 'landmarks', landmarkRef.id, 'visits'), {
          landmarkId: landmarkRef.id,
          userId,
          timestamp: Timestamp.fromMillis(v.arrivalTime),
          notes: `${v.routeName}（${Math.round(v.durationMinutes)}分滞在）`,
        });
      }
      saved++;
    } catch { /* skip */ }
  }

  return saved;
}

// ---- Google Timeline JSON ----

interface TimelinePosition {
  point: { latE7: number; lngE7: number };
  timestamp: string;
  speedMetersPerSecond?: number;
}

interface TimelinePlaceInfo {
  score: number;
  point: { latE7: number; lngE7: number };
  placeId?: string;
}

export function parseGoogleTimelineJson(json: string): {
  routes: { name: string; points: TrackPoint[] }[];
  placeSpots: ClusteredSpot[];
} {
  const data = JSON.parse(json) as { timelineEdits: any[] };
  const entries: any[] = data.timelineEdits || [];

  const positions: TrackPoint[] = [];
  const seenPlaceIds = new Set<string>();
  const placeSpots: ClusteredSpot[] = [];

  for (const entry of entries) {
    const pos: TimelinePosition | undefined = entry.rawSignal?.signal?.position;
    if (pos) {
      const lat = pos.point.latE7 / 1e7;
      const lng = pos.point.lngE7 / 1e7;
      const timestamp = new Date(pos.timestamp).getTime();
      const speed = (pos.speedMetersPerSecond ?? 0) * 3.6;
      if (!isNaN(lat) && !isNaN(lng) && !isNaN(timestamp)) {
        positions.push({ lat, lng, timestamp, speed });
      }
    }

    const infos: TimelinePlaceInfo[] | undefined = entry.placeAggregates?.placeAggregateInfo;
    if (infos) {
      const window = entry.placeAggregates.processWindow;
      const firstVisit = window ? new Date(window.startTime).getTime() : Date.now();
      const lastVisit  = window ? new Date(window.endTime).getTime()   : Date.now();
      for (const info of infos) {
        const key = info.placeId || `${info.point.latE7}_${info.point.lngE7}`;
        if (seenPlaceIds.has(key)) continue;
        seenPlaceIds.add(key);
        placeSpots.push({
          lat: info.point.latE7 / 1e7,
          lng: info.point.lngE7 / 1e7,
          visitCount: 1,
          firstVisit,
          lastVisit,
          totalMinutes: 0,
          visits: [],
          placeId: info.placeId,
        });
      }
    }
  }

  positions.sort((a, b) => a.timestamp - b.timestamp);

  // 30分以上ギャップで別セッション（=別ルート）に分割
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const MIN_POINTS = 5;
  const sessions: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  for (const p of positions) {
    if (cur.length > 0 && p.timestamp - cur[cur.length - 1].timestamp > SESSION_GAP_MS) {
      if (cur.length >= MIN_POINTS) sessions.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length >= MIN_POINTS) sessions.push(cur);

  const routes = sessions.map(pts => {
    for (let i = 1; i < pts.length; i++) pts[i].speed = calcSpeed(pts[i - 1], pts[i]);
    const d = new Date(pts[0].timestamp);
    const name = `Timeline ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
    return { name, points: pts };
  });

  return { routes, placeSpots };
}

export function extractSpotsFromTimeline(json: string): {
  clusters: ClusteredSpot[];
  placeSpots: ClusteredSpot[];
} {
  const { routes, placeSpots } = parseGoogleTimelineJson(json);
  const allStops: DetectedStop[] = [];
  for (const route of routes) {
    allStops.push(...deduplicateRouteStops(detectStops(route.points, route.name), route.points));
  }
  return { clusters: clusterStops(allStops), placeSpots };
}

// ---- CSV ----

export function parseRouteHistoryCsv(csvText: string): ParsedLog[] {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const logs: ParsedLog[] = [];
  let current: ParsedLog | null = null;

  for (const line of lines) {
    if (line.startsWith('LogHeader,')) {
      if (current && current.points.length > 0) logs.push(current);
      const parts = parseCsvLine(line);
      current = { name: parts[1] || '', tags: [], points: [], altitudes: [] };
    } else if (line.startsWith('LogTag,')) {
      if (current) {
        const parts = parseCsvLine(line);
        current.tags = parts.slice(1).filter(Boolean);
      }
    } else if (line.startsWith('tp,')) {
      if (current) {
        const parts = line.split(',');
        const lat = parseFloat(parts[1]);
        const lng = parseFloat(parts[2]);
        const timestamp = new Date(parts[3]).getTime();
        const altitude = parseFloat(parts[4]) || 0;
        if (!isNaN(lat) && !isNaN(lng) && !isNaN(timestamp)) {
          current.points.push({ lat, lng, timestamp, speed: 0 });
          current.altitudes.push(altitude);
        }
      }
    } else if (line === 'LogEnd') {
      if (current && current.points.length > 0) { logs.push(current); current = null; }
    }
  }
  if (current && current.points.length > 0) logs.push(current);

  for (const log of logs) {
    for (let i = 1; i < log.points.length; i++) {
      log.points[i].speed = calcSpeed(log.points[i - 1], log.points[i]);
    }
  }
  return logs;
}

export async function importRouteHistoryCsv(
  csvText: string,
  userId: string,
  onProgress?: (current: number, total: number, phase: string) => void
): Promise<{ success: number; failed: number; stops: DetectedStop[]; clusters: ClusteredSpot[] }> {
  const logs = parseRouteHistoryCsv(csvText);
  let success = 0;
  let failed = 0;
  const allStops: DetectedStop[] = [];
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < logs.length; i++) {
    onProgress?.(i + 1, logs.length, 'ルートをインポート中');
    const log = logs[i];
    try {
      const pts = log.points;
      const maxPts = 3000;
      const sampledPts = pts.length > maxPts
        ? pts.filter((_, idx) => idx % Math.ceil(pts.length / maxPts) === 0)
        : pts;

      let totalDist = 0;
      for (let j = 1; j < sampledPts.length; j++) totalDist += haversineKm(sampledPts[j - 1], sampledPts[j]);
      const speeds = sampledPts.map(p => p.speed).filter(s => s > 0);
      const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b) / speeds.length : 0;
      const maxSpeed = speeds.length ? speeds.reduce((m, s) => s > m ? s : m, 0) : 0;

      await addDoc(collection(db, 'routes'), {
        userId,
        name: log.name || `インポート ${new Date(pts[0].timestamp).toLocaleDateString('ja-JP')}`,
        tags: log.tags,
        startTime: Timestamp.fromMillis(pts[0].timestamp),
        endTime:   Timestamp.fromMillis(pts[pts.length - 1].timestamp),
        totalDistance: totalDist,
        avgSpeed,
        maxSpeed,
        points: sampledPts,
        source: 'imported',
        createdAt: Timestamp.fromMillis(Date.now()),
      });
      success++;
      const routeStops = detectStops(pts, log.name || `ルート${i + 1}`);
      allStops.push(...deduplicateRouteStops(routeStops, pts));
      await delay(200);
    } catch {
      failed++;
      await delay(500);
    }
  }

  const clusters = clusterStops(allStops);
  return { success, failed, stops: allStops, clusters };
}
