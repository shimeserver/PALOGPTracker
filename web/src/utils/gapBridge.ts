import type { TrackPoint } from '../firebase/data';

// GPSギャップ（トンネル・電波切れ）を道なりに補間する（モバイル版と同じ仕様）。
// 「時間が空き かつ 距離が離れている」区間だけを OSRM で道路経路に置き換える。
// 停止・渋滞（時間は空くが距離が近い）は対象外。地下高速トンネルは地上迂回を弾く。
// 既存の記録済み点はそのまま保持し、ギャップだけを埋める。

const OSRM = 'https://router.project-osrm.org/route/v1/';
const GAP_MIN_DIST_KM = 0.2;
const GAP_MIN_DT_S = 15;
const MAX_GAP_KMH = 120; // これ超の離れ=GPSワープなので補間しない（往復ループ・異常速度防止）
const MAX_GAPS = 20;
const CALL_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 20000;
const MAX_FAILS = 3;

type LL = { lat: number; lng: number };

function haversineKm(a: LL, b: LL): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// 点pから線分ab への概算垂直距離(km)
function perpKm(p: LL, a: LL, b: LL): number {
  const kx = 111.32 * Math.cos((a.lat * Math.PI) / 180);
  const ky = 110.57;
  const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
  const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
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

function speedKmh(a: TrackPoint, b: TrackPoint): number {
  const dt = (b.timestamp - a.timestamp) / 3600000;
  if (dt <= 0) return Infinity;
  return haversineKm(a, b) / dt;
}

// GPSワープ（一瞬で遠くへ飛んで戻る孤立点）を除去する。
// 前後どちらの区間も非現実的な高速（maxKmh超）なら、その点は飛びとみなして削除。
export function removeSpeedWarps(points: TrackPoint[], maxKmh = 150): { points: TrackPoint[]; removed: number } {
  if (points.length < 3) return { points, removed: 0 };
  const out: TrackPoint[] = [points[0]];
  let removed = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (speedKmh(prev, cur) > maxKmh && speedKmh(cur, next) > maxKmh) { removed++; continue; }
    out.push(cur);
  }
  out.push(points[points.length - 1]);
  // 3割超を飛びと判定した場合はタイムスタンプ自体が壊れている可能性が高い。
  // ルートを破壊しないよう、その場合は除去せず元に戻す。
  if (removed > points.length * 0.3) return { points, removed: 0 };
  return { points: out, removed };
}

export interface BridgeResult {
  points: TrackPoint[];
  bridged: number;      // 実際に補間したギャップ数
  detected: number;     // 検出したギャップ数
  rejectedDetour: number; // 地上迂回とみなして除外した数
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
    const dtS = (cur.timestamp - prev.timestamp) / 1000;
    const distKm = haversineKm(prev, cur);
    const impliedKmh = dtS > 0 ? distKm / (dtS / 3600) : Infinity;
    // ギャップ = 距離が離れ・時間も空き・実速度が現実的（ワープでない）区間のみ
    const isGap = distKm >= GAP_MIN_DIST_KM && dtS >= GAP_MIN_DT_S && impliedKmh <= MAX_GAP_KMH;
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
        let maxDev = 0;
        for (const pt of path) { const d = perpKm(pt, prev, cur); if (d > maxDev) maxDev = d; }
        const detourRatio = distKm > 0 ? total / distKm : 1;
        // 地下高速トンネル対策: 「回りくどい迂回」は経路長が直線より大幅に長い（比率大）。
        // トンネル/高速はコリドーが湾曲しても経路自体は直線的（比率≈1.1）なので、横ずれではなく比率で判定。
        // 比率1.4超（40%以上遠回り）＝地上迂回とみなし不採用。maxDevは極端時のみの保険。
        const surfaceDetour = profile === 'driving' && (detourRatio > 1.4 || maxDev > 2.0);
        if (surfaceDetour) rejectedDetour++;
        if (total >= distKm * 0.9 && !surfaceDetour) {
          bridged++;
          const gapSpeed = dtS > 0 ? Math.min(MAX_GAP_KMH, Math.round((total / (dtS / 3600)) * 10) / 10) : 0;
          let cum = 0;
          for (let k = 1; k < path.length - 1; k++) {
            cum += segDist[k - 1];
            const frac = total > 0 ? cum / total : 0;
            const ts = Math.round(prev.timestamp + frac * (cur.timestamp - prev.timestamp));
            out.push({ lat: path[k].lat, lng: path[k].lng, timestamp: ts, speed: gapSpeed });
          }
        }
      }
    }
    out.push(cur);
  }
  return { points: out, bridged, detected, rejectedDetour, failed };
}
