import type { TrackPoint } from '../firebase/data';

// GPSギャップ（トンネル・電波切れ）を道なりに補間する。
// 判定は「距離」ベース（タイムスタンプが壊れたルートでも機能する）。
// 記録済みの点はそのまま保持し、離れた区間（ギャップ）だけを OSRM の道路経路で埋める。
// ワープ（飛び出して戻る誤点）は事前に位置ベースで除去する。

const OSRM = 'https://router.project-osrm.org/route/v1/';
const GAP_MIN_DIST_KM = 0.3;  // 連続点がこれ以上離れていればギャップ（GPS喪失）とみなす
const MAX_GAPS = 30;
const CALL_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 25000;
const MAX_FAILS = 3;
const MAX_DETOUR_RATIO = 1.5; // OSRM経路が直線のこれ倍超＝回り道になるので不採用（直線のまま残す方がマシ）

type LL = { lat: number; lng: number };

function haversineKm(a: LL, b: LL): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// p1→p2→p3 の進行方向変化のcos（-1に近いほど鋭い折り返し）
function turnCos(p1: LL, p2: LL, p3: LL): number {
  const ax = p2.lng - p1.lng, ay = p2.lat - p1.lat;
  const bx = p3.lng - p2.lng, by = p3.lat - p2.lat;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 1;
  return (ax * bx + ay * by) / (la * lb);
}

// GPSノイズ除去（単発スパイク＋複数点のジグザグ暴れの両対応）。
// 判定: ①直前点から150m以上飛んで始まり ②少ない直行距離に対し道のりが2.5倍超の寄り道で
// ③鋭い折り返し（ほぼ反転）を含む —— 3条件が揃った塊だけ除去する。
// 「鋭い折り返し」条件により、JCTの本物のループランプ（緩やかな旋回）は誤爆しない（検証済み）。
// タイムスタンプ非依存なので速度データが壊れたルートでも効く。
export function removeGeoWarps(points: TrackPoint[]): { points: TrackPoint[]; removed: number } {
  const MAX_WINDOW = 8;      // 除去する塊の最大点数
  const DETOUR_RATIO = 2.5;  // 道のり/直行 がこれ超なら寄り道
  const MIN_PATH_KM = 0.15;
  const MAX_DIRECT_KM = 0.5; // 始点終点がこれ以上離れていたら実走とみなす
  const REVERSAL_COS = -0.3; // 約107°超の折り返しをノイズの証拠とする
  const JUMP_MIN_KM = 0.15;  // 異常の開始条件（直前点からの飛び）

  if (points.length < 3) return { points, removed: 0 };
  const out: TrackPoint[] = [points[0]];
  let removed = 0;
  let i = 1;
  while (i < points.length - 1) {
    const prev = out[out.length - 1];
    let cut = 0;
    if (haversineKm(prev, points[i]) >= JUMP_MIN_KM) {
      for (let w = 1; w <= MAX_WINDOW && i + w < points.length; w++) {
        const next = points[i + w];
        const direct = haversineKm(prev, next);
        if (direct > MAX_DIRECT_KM) continue;
        let path = haversineKm(prev, points[i]);
        for (let k = i; k < i + w - 1; k++) path += haversineKm(points[k], points[k + 1]);
        path += haversineKm(points[i + w - 1], next);
        if (path < Math.max(MIN_PATH_KM, direct * DETOUR_RATIO)) continue;
        const seq: LL[] = [prev, ...points.slice(i, i + w), next];
        let rev = false;
        for (let k = 1; k < seq.length - 1; k++) {
          if (turnCos(seq[k - 1], seq[k], seq[k + 1]) < REVERSAL_COS) { rev = true; break; }
        }
        if (!rev) continue;
        cut = w;
        break;
      }
    }
    if (cut > 0) { removed += cut; i += cut; }
    else { out.push(points[i]); i++; }
  }
  out.push(points[points.length - 1]);
  // 3割超を除去と判定した場合はデータ自体が壊れている可能性が高いので、破壊を避けて元に戻す。
  if (removed > points.length * 0.3) return { points, removed: 0 };
  return { points: out, removed };
}

async function osrmRoute(profile: string, a: TrackPoint, b: TrackPoint): Promise<[number, number][] | null> {
  const url = `${OSRM}${profile}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const coords = json?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return coords as [number, number][];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 距離間隔でwaypointを間引く（滑らかに追従しつつOSRMの点数制限に収める）
function sampleByDistance(points: TrackPoint[], stepKm: number): TrackPoint[] {
  if (points.length < 2) return points;
  const out: TrackPoint[] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += haversineKm(points[i - 1], points[i]);
    if (acc >= stepKm) { out.push(points[i]); acc = 0; }
  }
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

async function osrmRouteChunk(profile: string, chunk: TrackPoint[]): Promise<[number, number][] | null> {
  const coords = chunk.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `${OSRM}${profile}/${coords}?overview=full&geometries=geojson`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const coordsOut = json?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coordsOut) || coordsOut.length < 2) return null;
    return coordsOut as [number, number][];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SnapResult { points: TrackPoint[]; ok: boolean; failedChunks: number; }

// ルート全体を道路にスナップする。~120m間隔でwaypointを取り、90点ずつOSRM route し連結。
// 失敗チャンクは元の点を使う。タイムスタンプは距離比例で再配分（速度は後段で再計算）。
export async function snapWholeRoute(points: TrackPoint[], mode?: string): Promise<SnapResult> {
  if (points.length < 2) return { points, ok: false, failedChunks: 0 };
  const profile = mode === 'walk' ? 'foot' : mode === 'bicycle' ? 'cycling' : 'driving';
  const wps = sampleByDistance(points, 0.12);
  const CHUNK = 90;
  const snapped: LL[] = [];
  let failedChunks = 0;
  for (let start = 0; start < wps.length - 1; start += CHUNK - 1) {
    const chunk = wps.slice(start, start + CHUNK);
    if (chunk.length < 2) break;
    const geom = await osrmRouteChunk(profile, chunk);
    let seg: LL[];
    if (geom) {
      seg = geom.map(([lng, lat]) => ({ lat, lng }));
    } else {
      failedChunks++;
      seg = chunk.map(p => ({ lat: p.lat, lng: p.lng })); // 失敗時は元waypoint
    }
    if (snapped.length > 0) seg.shift(); // チャンク境界の重複を除去
    snapped.push(...seg);
  }
  if (snapped.length < 2) return { points, ok: false, failedChunks };
  // タイムスタンプを距離比例で再配分
  const t0 = points[0].timestamp;
  const t1 = points[points.length - 1].timestamp;
  const segDist: number[] = [];
  let total = 0;
  for (let i = 1; i < snapped.length; i++) { const d = haversineKm(snapped[i - 1], snapped[i]); segDist.push(d); total += d; }
  let cum = 0;
  const result: TrackPoint[] = snapped.map((p, i) => {
    if (i > 0) cum += segDist[i - 1];
    const frac = total > 0 ? cum / total : 0;
    return { lat: p.lat, lng: p.lng, timestamp: Math.round(t0 + frac * (t1 - t0)), speed: 0 };
  });
  return { points: result, ok: true, failedChunks };
}

export interface BridgeResult {
  points: TrackPoint[];
  bridged: number;      // 実際に補間したギャップ数
  detected: number;     // 検出したギャップ数
  rejectedDetour: number; // 妥当な経路なし(直線の2.5倍超)で除外した数
  failed: number;       // OSRM取得失敗（オフライン等）した数
}

export async function bridgeGaps(points: TrackPoint[], mode?: string): Promise<BridgeResult> {
  if (points.length < 2) return { points, bridged: 0, detected: 0, rejectedDetour: 0, failed: 0 };
  const profile = mode === 'walk' ? 'foot' : mode === 'bicycle' ? 'cycling' : 'driving';
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const out: TrackPoint[] = [points[0]];
  let bridged = 0, fails = 0, detected = 0, rejectedDetour = 0, failed = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const distKm = haversineKm(prev, cur);
    // ギャップ = 距離が離れた区間（時間には依存しない）
    const isGap = distKm >= GAP_MIN_DIST_KM;
    if (isGap) detected++;
    const canBridge = isGap && bridged < MAX_GAPS && fails < MAX_FAILS && Date.now() < deadline;
    if (canBridge) {
      const coords = await osrmRoute(profile, prev, cur);
      if (!coords) { fails++; failed++; }
      if (coords && coords.length >= 2) {
        fails = 0;
        const path = coords.map(([lng, lat]) => ({ lat, lng }));
        const segDist: number[] = [];
        let total = 0;
        for (let k = 1; k < path.length; k++) { const d = haversineKm(path[k - 1], path[k]); segDist.push(d); total += d; }
        const detourRatio = distKm > 0 ? total / distKm : 1;
        const implausible = detourRatio > MAX_DETOUR_RATIO;
        if (implausible) rejectedDetour++;
        if (total >= distKm * 0.9 && !implausible) {
          bridged++;
          // 端点を除く中間点を距離比例のタイムスタンプで挿入（速度は後段で再計算）
          let cum = 0;
          for (let k = 1; k < path.length - 1; k++) {
            cum += segDist[k - 1];
            const frac = total > 0 ? cum / total : 0;
            const ts = Math.round(prev.timestamp + frac * (cur.timestamp - prev.timestamp));
            out.push({ lat: path[k].lat, lng: path[k].lng, timestamp: ts, speed: 0 });
          }
        }
      }
    }
    out.push(cur);
  }
  return { points: out, bridged, detected, rejectedDetour, failed };
}
