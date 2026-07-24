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

// GPSワープ（飛び出して戻る孤立点）を位置ベースで除去する。タイムスタンプに依存しない。
function removeGeoWarps(points: TrackPoint[], spikeKm = 0.25, returnKm = 0.25): TrackPoint[] {
  if (points.length < 3) return points;
  const out: TrackPoint[] = [points[0]];
  let removed = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (haversineKm(prev, cur) > spikeKm && haversineKm(cur, next) > spikeKm && haversineKm(prev, next) < returnKm) {
      removed++;
      continue;
    }
    out.push(cur);
  }
  out.push(points[points.length - 1]);
  // 3割超を飛びと判定＝データ破損の疑い。破壊を避けて元に戻す。
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
