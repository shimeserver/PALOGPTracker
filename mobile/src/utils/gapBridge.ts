import { TrackPoint } from '../types';

// GPSギャップ（トンネル・電波切れ）を道なりに補間する。
// 判定は「距離」ベース（タイムスタンプが壊れていても機能する）。
// 記録済みの点はそのまま保持し、離れた区間だけを OSRM の道路経路で埋める。
// ワープ（飛び出して戻る誤点）は事前に位置ベースで除去する。
// オフライン/失敗時は元の直線のまま（保存をブロックしない）。

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const GAP_MIN_DIST_KM = 0.3;  // 連続点がこれ以上離れていればギャップ（GPS喪失）とみなす
const MAX_GAPS = 15;          // 1ルートで補間するギャップ数の上限（時間/負荷の保険）
const CALL_TIMEOUT_MS = 6000; // OSRM1回あたりのタイムアウト
const TOTAL_BUDGET_MS = 15000; // 補間全体の時間予算（保存がハングしないよう）
const MAX_FAILS = 2;          // 連続失敗（=オフライン想定）でそれ以降の補間を諦める
const MAX_DETOUR_RATIO = 1.5; // OSRM経路が直線のこれ倍超＝回り道になるので不採用（直線のまま残す方がマシ）

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// p1→p2→p3 の進行方向変化のcos（-1に近いほど鋭い折り返し）
function turnCos(p1: { lat: number; lng: number }, p2: { lat: number; lng: number }, p3: { lat: number; lng: number }): number {
  const ax = p2.lng - p1.lng, ay = p2.lat - p1.lat;
  const bx = p3.lng - p2.lng, by = p3.lat - p2.lat;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 1;
  return (ax * bx + ay * by) / (la * lb);
}

// バックトラック切除（密な“行って戻り”・Web版と同一、検証済み）。
function removeBacktracks(pts: TrackPoint[]): TrackPoint[] {
  const RETURN_KM = 0.08, MIN_PATH_KM = 0.3, MAX_PATH_KM = 5, MIN_TURN_COS = Math.cos(80 * Math.PI / 180), HEADING_COS = 0.5;
  const heading = (i: number): { x: number; y: number } => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    return { x: b.lng - a.lng, y: b.lat - a.lat };
  };
  const out: TrackPoint[] = [];
  let i = 0;
  while (i < pts.length) {
    let cut = -1;
    let path = 0;
    for (let j = i + 1; j < pts.length; j++) {
      path += haversineKm(pts[j - 1], pts[j]);
      if (path > MAX_PATH_KM) break;
      if (path > MIN_PATH_KM && haversineKm(pts[i], pts[j]) < RETURN_KM) {
        let sharp = false;
        for (let k = i + 1; k < j; k++) {
          if (turnCos(pts[k - 1], pts[k], pts[k + 1]) < MIN_TURN_COS) { sharp = true; break; }
        }
        if (!sharp) continue;
        const h1 = heading(i), h2 = heading(j);
        const l1 = Math.hypot(h1.x, h1.y), l2 = Math.hypot(h2.x, h2.y);
        if (l1 === 0 || l2 === 0) continue;
        if ((h1.x * h2.x + h1.y * h2.y) / (l1 * l2) >= HEADING_COS) { cut = j; break; }
      }
    }
    out.push(pts[i]);
    if (cut > 0) i = cut; else i++;
  }
  return out;
}

// 密集反転クラスタの除去（トンネル付近等の毛玉状GPS暴れ・Web版と同一、実データ検証済み）。
function removeReversalClusters(pts: TrackPoint[]): TrackPoint[] {
  const n = pts.length;
  if (n < 5) return pts;
  const rev: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    if (turnCos(pts[i - 1], pts[i], pts[i + 1]) < -0.17) rev[i] = true; // >100°
  }
  const keep: boolean[] = new Array(n).fill(true);
  let removed = 0;
  let i = 1;
  while (i < n - 1) {
    if (rev[i]) {
      const cluster: number[] = [i];
      let j = i;
      for (;;) {
        let next = -1;
        for (let k = j + 1; k < Math.min(j + 4, n - 1); k++) {
          if (rev[k]) { next = k; break; }
        }
        if (next < 0) break;
        cluster.push(next);
        j = next;
      }
      if (cluster.length >= 3) {
        for (let k = cluster[0]; k <= cluster[cluster.length - 1]; k++) {
          if (keep[k]) { keep[k] = false; removed++; }
        }
      }
      i = j + 1;
    } else i++;
  }
  if (removed === 0) return pts;
  return pts.filter((_, k) => keep[k]);
}

// 孤立した鋭い折り返し頂点の反復除去（実データに合わせた閾値・Web版と同一）。
function removeSpikeVertices(pts: TrackPoint[]): TrackPoint[] {
  let cur = pts;
  for (let pass = 0; pass < 10; pass++) {
    const out: TrackPoint[] = [cur[0]];
    let removed = 0;
    for (let i = 1; i < cur.length - 1; i++) {
      const a = out[out.length - 1], b = cur[i], c = cur[i + 1];
      const arm = Math.min(haversineKm(a, b), haversineKm(b, c));
      const tc = turnCos(a, b, c);
      if ((tc < -0.5 && arm > 0.04) || (tc < 0 && arm > 0.1)) { removed++; continue; }
      out.push(b);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
    if (removed === 0) break;
  }
  return cur;
}

// GPSノイズ除去（単発スパイク＋複数点ジグザグ両対応・Web版と同一ロジック）。
// 「①150m以上の飛びで始まり ②直行距離の2.5倍超の寄り道で ③鋭い折り返しを含む」塊だけ除去。
// 鋭い折り返し条件により、JCTの本物のループランプは誤爆しない（検証済み）。
function removeGeoWarps(points: TrackPoint[]): TrackPoint[] {
  const MAX_WINDOW = 8, DETOUR_RATIO = 2.5, MIN_PATH_KM = 0.15, MAX_DIRECT_KM = 0.5, REVERSAL_COS = -0.3, JUMP_MIN_KM = 0.15;
  if (points.length < 3) return points;
  points = removeSpikeVertices(removeReversalClusters(removeBacktracks(points))); // 行って戻り→毛玉→孤立スパイクの順
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
        const seq = [prev, ...points.slice(i, i + w), next];
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
  if (removed > points.length * 0.3) return points;
  return out;
}

// OSRM で2点間の道路経路の座標列 [lng,lat][] を返す。失敗時 null。
async function osrmRoute(a: TrackPoint, b: TrackPoint): Promise<[number, number][] | null> {
  const url = `${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
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

export async function bridgeGaps(rawPoints: TrackPoint[]): Promise<TrackPoint[]> {
  if (rawPoints.length < 2) return rawPoints;
  const points = removeGeoWarps(rawPoints); // 先にワープ（飛び）を除去
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const out: TrackPoint[] = [points[0]];
  let bridged = 0;
  let fails = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const distKm = haversineKm(prev, cur);
    // ギャップ = 距離が離れた区間（時間には依存しない）
    const isGap = distKm >= GAP_MIN_DIST_KM;

    const canBridge = isGap && bridged < MAX_GAPS && fails < MAX_FAILS && Date.now() < deadline;
    if (canBridge) {
      const coords = await osrmRoute(prev, cur);
      if (!coords) { fails++; }
      if (coords && coords.length >= 2) {
        fails = 0;
        const path = coords.map(([lng, lat]) => ({ lat, lng }));
        const segDist: number[] = [];
        let total = 0;
        for (let k = 1; k < path.length; k++) {
          const d = haversineKm(path[k - 1], path[k]);
          segDist.push(d);
          total += d;
        }
        const detourRatio = distKm > 0 ? total / distKm : 1;
        if (detourRatio <= MAX_DETOUR_RATIO && total >= distKm * 0.9) {
          bridged++;
          // 端点を除く中間点を距離比例のタイムスタンプで挿入（速度は0=実測点のみで平均/最高を算出）
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
  return out;
}
