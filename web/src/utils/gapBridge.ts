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
const MAX_DETOUR_RATIO = 2.5; // OSRM経路が直線のこれ倍超＝直通路なし/誤ルーティングとして不採用

type LL = { lat: number; lng: number };

function haversineKm(a: LL, b: LL): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// GPSワープ（飛び出して戻る孤立点）を位置ベースで除去する。
// cur が prev/next 双方から大きく離れ、かつ prev と next は近い（実際は移動していない）なら飛びとみなす。
// タイムスタンプに依存しないので、速度が壊れているルートでも効く。
export function removeGeoWarps(points: TrackPoint[], spikeKm = 0.25, returnKm = 0.25): { points: TrackPoint[]; removed: number } {
  if (points.length < 3) return { points, removed: 0 };
  const out: TrackPoint[] = [points[0]];
  let removed = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dOut = haversineKm(prev, cur);
    const dBack = haversineKm(cur, next);
    const dSkip = haversineKm(prev, next);
    if (dOut > spikeKm && dBack > spikeKm && dSkip < returnKm) { removed++; continue; }
    out.push(cur);
  }
  out.push(points[points.length - 1]);
  // 3割超を飛びと判定した場合はデータ自体が壊れている可能性が高いので、破壊を避けて元に戻す。
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
