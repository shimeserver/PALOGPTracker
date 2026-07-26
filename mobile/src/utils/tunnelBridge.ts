import { TUNNELS } from '../data/tunnels';

// 既知の長大トンネル（山手・アクア・湾岸線・関越等）のGPS喪失ギャップを
// 同梱の実ジオメトリで決定論的に補間する。ネットワーク不要・オフラインでも動く。
// OSRM（有料道路回避）やコリドー探索（Overpass負荷・不確実）より先に試す。

interface LL { lat: number; lng: number }

function haversineKm(a: LL, b: LL): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const MATCH_KM = 0.6;   // ギャップ端点がトンネル線形からこの距離以内なら「トンネル上」とみなす
const MIN_SUB_KM = 0.5; // これ未満の切り出しは通常のギャップ処理に任せる

export interface TunnelMatch { name: string; path: LL[]; lenKm: number }

// ギャップ（prev→cur）が既知トンネルの線形に沿うなら、その区間の実ジオメトリを返す。
// 途中でGPSが切れた/復帰したケースにも対応するため、端点を線形上に射影して部分区間を使う。
// 上下線は別線形として収録されているため、全候補から「進行方向が順方向」を優先し、
// 同着なら端点距離の小さい方（=正しい車線）を選ぶ。配列順で決めると反対車線に化ける。
export function findTunnelPath(prev: LL, cur: LL, gapKm: number): TunnelMatch | null {
  let best: (TunnelMatch & { forward: boolean; endDist: number }) | null = null;
  for (const t of TUNNELS) {
    // 粗いバウンディングボックスで即除外（全国データでも高速）
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lng, lat] of t.path) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    }
    const pad = 0.01; // ≈1km
    if (prev.lat < minLat - pad || prev.lat > maxLat + pad || prev.lng < minLng - pad || prev.lng > maxLng + pad) continue;
    if (cur.lat < minLat - pad || cur.lat > maxLat + pad || cur.lng < minLng - pad || cur.lng > maxLng + pad) continue;

    // 端点に最も近い頂点を探す（片方向データなので i < j が進行方向一致の条件）
    let iBest = -1, iDist = Infinity, jBest = -1, jDist = Infinity;
    for (let k = 0; k < t.path.length; k++) {
      const v = { lng: t.path[k][0], lat: t.path[k][1] };
      const dp = haversineKm(prev, v);
      const dc = haversineKm(cur, v);
      if (dp < iDist) { iDist = dp; iBest = k; }
      if (dc < jDist) { jDist = dc; jBest = k; }
    }
    if (iDist > MATCH_KM || jDist > MATCH_KM) continue;
    // 順方向はそのまま、逆方向は反転して使う（対面通行トンネル=飛騨等への対応）
    let sub: LL[];
    let forward: boolean;
    if (jBest > iBest) {
      sub = t.path.slice(iBest, jBest + 1).map(([lng, lat]) => ({ lat, lng }));
      forward = true;
    } else if (iBest > jBest) {
      sub = t.path.slice(jBest, iBest + 1).map(([lng, lat]) => ({ lat, lng })).reverse();
      forward = false;
    } else {
      continue; // 同一頂点
    }
    let len = 0;
    for (let k = 1; k < sub.length; k++) len += haversineKm(sub[k - 1], sub[k]);
    if (len < MIN_SUB_KM) continue;
    // トンネルはほぼ直線なので、ギャップ直線距離と大きく乖離する切り出しは誤マッチとして棄却
    if (len > gapKm * 1.6 + 1) continue;
    const endDist = iDist + jDist;
    const cand = { name: t.name, path: sub, lenKm: len, forward, endDist };
    if (!best
      || (cand.forward && !best.forward)
      || (cand.forward === best.forward && cand.endDist < best.endDist)) {
      best = cand;
    }
  }
  return best ? { name: best.name, path: best.path, lenKm: best.lenKm } : null;
}
