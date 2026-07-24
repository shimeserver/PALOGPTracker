import { TrackPoint } from '../types';

// GPSギャップ（トンネル・電波切れ）を道なりに補間する。
// 「時間が空き かつ 距離が離れている」区間だけを OSRM で道路経路に置き換え、
// 直線アーティファクトを解消して距離を実走に近づける。
// 停止・渋滞（時間は空くが距離が近い）は対象外なので誤補正しない。
// オフライン/失敗時は元の直線のまま（保存をブロックしない）。

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const GAP_MIN_DIST_KM = 0.2;  // これ未満の離れなら停止/渋滞とみなし補間しない
const GAP_MIN_DT_S = 15;      // これ未満で大きく離れる=GPSワープ（誤データ）とみなし対象外
const MAX_GAP_KMH = 150;      // 想定走行速度の上限。これ超の離れ=ワープなので補間しない（往復ループ防止）
const MAX_GAPS = 12;          // 1ルートで補間するギャップ数の上限（時間/負荷の保険）
const CALL_TIMEOUT_MS = 6000; // OSRM1回あたりのタイムアウト
const TOTAL_BUDGET_MS = 15000; // 補間全体の時間予算（保存がハングしないよう）
const MAX_FAILS = 2;          // 連続失敗（=オフライン想定）でそれ以降の補間を諦める

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
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

export async function bridgeGaps(points: TrackPoint[]): Promise<TrackPoint[]> {
  if (points.length < 2) return points;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const out: TrackPoint[] = [points[0]];
  let bridged = 0;
  let fails = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const dtS = (cur.timestamp - prev.timestamp) / 1000;
    const distKm = haversineKm(prev, cur);
    const impliedKmh = dtS > 0 ? distKm / (dtS / 3600) : Infinity;
    // ギャップ = 距離が離れ、時間も空き、かつ実速度が現実的（ワープでない）区間のみ
    const isGap = distKm >= GAP_MIN_DIST_KM && dtS >= GAP_MIN_DT_S && impliedKmh <= MAX_GAP_KMH;

    // 予算超過・連続失敗（オフライン想定）なら以降は補間せず直線のまま
    const canBridge = isGap && bridged < MAX_GAPS && fails < MAX_FAILS && Date.now() < deadline;
    if (canBridge) {
      const coords = await osrmRoute(prev, cur);
      if (!coords) { fails++; }
      if (coords && coords.length >= 2) {
        fails = 0;
        const path = coords.map(([lng, lat]) => ({ lat, lng }));
        // 経路上の累積距離
        const segDist: number[] = [];
        let total = 0;
        for (let k = 1; k < path.length; k++) {
          const d = haversineKm(path[k - 1], path[k]);
          segDist.push(d);
          total += d;
        }
        // 明らかに壊れた経路（直線の2.5倍超＝直通路が無い/誤ルーティング）だけ除外し、
        // それ以外は補間する。短いギャップは道路をたどると比率が上がるのが普通なので許容する。
        const detourRatio = distKm > 0 ? total / distKm : 1;
        if (detourRatio <= 2.5 && total >= distKm * 0.9) {
          bridged++;
          // このギャップの平均速度（補間点に付与）。異常値にならないよう上限で丸める。
          const gapSpeed = dtS > 0 ? Math.min(MAX_GAP_KMH, Math.round((total / (dtS / 3600)) * 10) / 10) : 0;
          // 端点(prev/cur)を除く中間点を時間比例で挿入
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
  return out;
}
