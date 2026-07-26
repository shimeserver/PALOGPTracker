import type { TrackPoint } from '../firebase/data';
import { corridorRoute } from './osmCorridor';
import { findTunnelPath } from './tunnelBridge';

// GPSギャップ（トンネル・電波切れ）を道なりに補間する。
// 判定は「距離」ベース（タイムスタンプが壊れたルートでも機能する）。
// 記録済みの点はそのまま保持し、離れた区間（ギャップ）だけを OSRM の道路経路で埋める。
// ワープ（飛び出して戻る誤点）は事前に位置ベースで除去する。

const OSRM = 'https://router.project-osrm.org/route/v1/';
export const GAP_MIN_DIST_KM = 0.3;  // 連続点がこれ以上離れていればギャップ（GPS喪失）とみなす
const DEFAULT_MAX_GAPS = 100;
const CALL_TIMEOUT_MS = 6000;
const DEFAULT_BUDGET_MS = 60000;
const MAX_FAILS = 3;
const MAX_DETOUR_RATIO = 1.5; // OSRM経路が直線のこれ倍超＝回り道になるので不採用（直線のまま残す方がマシ）
const SEA_MIN_KM = 5;         // これ以上のギャップで経路が大回りになる場合＝海上・航路とみなす
const SEA_DETOUR_RATIO = 3;   // 道路経路が直線の3倍超＝湾・海峡を回り込んでいる＝航路の可能性大
const AUTO_BRIDGE_MAX_KM = 50; // これ超のギャップはフェリー等の可能性が高く自動補間しない（手動✂️区間修正で対応）

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

// 直線チェーン圧縮: 「140m超の点間隔がほぼ無折れ（5°以下）で1km以上続く」区間の中間点を削除する。
// 正常な3秒間隔の記録は時速100kmでも点間約83mなので、この形は「記録が死んでいた区間に
// まばらな点が直線状に残った」アーティファクト（山手トンネルの斜め直線等）。
// 中間点を消して1本の大ギャップにすれば、後段のOSRM補間が道なりに埋める。
// 本物の直線高速道路（湾岸線等）は点間隔が正常なので対象外（検証済み）。
function collapseStraightChords(pts: TrackPoint[]): { points: TrackPoint[]; removed: number } {
  const SEG_MIN_KM = 0.14, TURN_MAX_COS = Math.cos(5 * Math.PI / 180), RUN_MIN_KM = 1.0;
  const remove: boolean[] = new Array(pts.length).fill(false);
  let removed = 0;
  let i = 0;
  while (i < pts.length - 1) {
    if (haversineKm(pts[i], pts[i + 1]) >= SEG_MIN_KM) {
      let j = i + 1;
      let run = haversineKm(pts[i], pts[i + 1]);
      while (j < pts.length - 1
        && haversineKm(pts[j], pts[j + 1]) >= SEG_MIN_KM
        && turnCos(pts[j - 1], pts[j], pts[j + 1]) >= TURN_MAX_COS) {
        run += haversineKm(pts[j], pts[j + 1]);
        j++;
      }
      if (run >= RUN_MIN_KM && j - i >= 2) {
        for (let k = i + 1; k < j; k++) {
          if (!remove[k]) { remove[k] = true; removed++; }
        }
      }
      i = j;
    } else i++;
  }
  if (removed === 0) return { points: pts, removed: 0 };
  return { points: pts.filter((_, k) => !remove[k]), removed };
}

// 密集反転クラスタの除去（トンネル付近等の「毛玉」状GPS暴れ）。
// 100°超の反転が3点以内の間隔で3回以上連続する帯は、実走行では発生しない
// （ヘアピンは反転1回ごとに長い直線が挟まる／市街地の90°転回は100°未満）。
// 浮島JCT付近の実データ5ルートで23〜137点の暴れを除去し、
// ヘアピン・市街地グリッドの合成データでは誤爆ゼロを確認済み。
function removeReversalClusters(pts: TrackPoint[]): { points: TrackPoint[]; removed: number } {
  const n = pts.length;
  if (n < 5) return { points: pts, removed: 0 };
  const rev: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    if (turnCos(pts[i - 1], pts[i], pts[i + 1]) < -0.17) rev[i] = true; // >100°
  }
  const keep: boolean[] = new Array(n).fill(true);
  let removed = 0;
  let i = 1;
  while (i < n - 1) {
    if (rev[i]) {
      // 3点以内の間隔で続く反転を1クラスタにまとめる
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
    } else {
      i++;
    }
  }
  if (removed === 0) return { points: pts, removed: 0 };
  return { points: pts.filter((_, k) => keep[k]), removed };
}

// 孤立した鋭い折り返し頂点の反復除去（移動しながらの単発スパイク用）。
// 閾値は浮島JCT付近の実データに合わせて調整: 「120°超＋両腕40m超」or「90°超＋両腕100m超」。
// ヘアピン（腕〜25m）・市街地グリッドで誤爆ゼロを確認済み。
function removeSpikeVertices(pts: TrackPoint[]): { points: TrackPoint[]; removed: number } {
  let cur = pts;
  let totalRemoved = 0;
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
    totalRemoved += removed;
    cur = out;
    if (removed === 0) break;
  }
  return { points: cur, removed: totalRemoved };
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
  const original = points;
  const origLen = points.length;
  // 1) 反転クラスタ 2) 孤立スパイク 3) 直線チェーン圧縮（まばら間隔のみ） 4) 窓検出
  // 注: バックトラック切除と完全直線圧縮は、湾岸線・アクアライン・海ほたるPA等の
  // 実走行データを破壊することが12/16の実ルート検証で判明したため自動処理から撤去した。
  // （合成直線アーティファクトは幾何だけでは実在の直線高速と区別不能 → 手動の✂️区間修正で対応）
  const clusterPass = removeReversalClusters(points);
  const vertexPass = removeSpikeVertices(clusterPass.points);
  const chordPass = collapseStraightChords(vertexPass.points);
  points = chordPass.points;
  const out: TrackPoint[] = [points[0]];
  let noiseRemoved = clusterPass.removed + vertexPass.removed;
  let removed = noiseRemoved + chordPass.removed;
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
    if (cut > 0) { removed += cut; noiseRemoved += cut; i += cut; }
    else { out.push(points[i]); i++; }
  }
  out.push(points[points.length - 1]);
  // ノイズ扱いの除去が元の3割超＝誤判定の暴走とみなし、破壊を避けて元データを返す。
  if (noiseRemoved > origLen * 0.3) return { points: original, removed: 0 };
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

// 修復できずに残ったギャップ（地図上での可視化・レポート用）
export interface UnresolvedGap {
  lat: number; lng: number;    // ギャップ始点
  lat2: number; lng2: number;  // ギャップ終点
  distKm: number;
  reason: 'sea' | 'detour' | 'failed' | 'limit';
  // sea    = 海上・フェリー航路とみなし直線のまま（正常）
  // detour = 道路経路が遠回りになるため不採用（直線のまま）
  // failed = 経路取得失敗（オフライン・OSRMエラー等）
  // limit  = ギャップ数/時間の上限で未処理（再実行で続きから直せる）
}

export interface BridgeResult {
  points: TrackPoint[];
  bridged: number;      // 実際に補間したギャップ数（コリドー含む）
  corridorBridged: number; // うち高速コリドー(OSM直読み)で補間した数
  detected: number;     // 検出したギャップ数
  tunnelBridged: number; // うち既知トンネルジオメトリで補間した数（オフライン可・決定論的）
  rejectedDetour: number; // 妥当な経路なし(遠回り)で除外した数
  failed: number;       // 経路取得失敗（オフライン等）した数
  sea: number;          // 海上・航路とみなして残した数
  unresolved: UnresolvedGap[]; // 直線のまま残った全ギャップの位置と理由
}

export interface BridgeOptions {
  maxGaps?: number;   // 1回の実行で補間するギャップ数の上限
  budgetMs?: number;  // 実行全体の時間予算
  onProgress?: (done: number, total: number) => void; // ギャップ処理の進捗
}

// スキャン用: 補間なしでギャップ統計だけを返す（ネットワーク不使用・軽量）
export interface GapStats { count: number; maxKm: number; totalKm: number; }
export function routeGapStats(points: TrackPoint[]): GapStats {
  let count = 0, maxKm = 0, totalKm = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineKm(points[i - 1], points[i]);
    if (d >= GAP_MIN_DIST_KM) { count++; totalKm += d; if (d > maxKm) maxKm = d; }
  }
  return { count, maxKm, totalKm };
}

// OSRM出力（speed=0）の点に速度を補完し、外れ値を除去する（保存前の共通後処理）
export function recalcSpeeds(points: TrackPoint[]): TrackPoint[] {
  if (points.length < 2) return points;
  const MAX_KMH = 300;
  const result = points.map(p => ({ ...p }));
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].speed === 0) {
      const dt = (result[i + 1].timestamp - result[i].timestamp) / 3600000;
      const v = dt > 0 ? haversineKm(result[i], result[i + 1]) / dt : 0;
      result[i].speed = v > MAX_KMH ? 0 : v;
    }
  }
  if (result[result.length - 1].speed === 0)
    result[result.length - 1].speed = result[result.length - 2].speed;
  for (let i = 0; i < result.length; i++) {
    const s = result[i].speed;
    if (s > MAX_KMH) { result[i].speed = 0; continue; }
    if (i === 0 || i === result.length - 1 || s <= 0) continue;
    const neighborMax = Math.max(result[i - 1].speed, result[i + 1].speed);
    if (neighborMax > 0 && s > neighborMax * 3) result[i].speed = (result[i - 1].speed + result[i + 1].speed) / 2;
  }
  return result;
}

const MAX_CORRIDOR_CALLS = 5; // Overpass負荷を抑えるため1回のクリーンアップでの上限

export async function bridgeGaps(points: TrackPoint[], mode?: string, opts?: BridgeOptions): Promise<BridgeResult> {
  const empty: BridgeResult = { points, bridged: 0, corridorBridged: 0, detected: 0, tunnelBridged: 0, rejectedDetour: 0, failed: 0, sea: 0, unresolved: [] };
  if (points.length < 2) return empty;
  const profile = mode === 'walk' ? 'foot' : mode === 'bicycle' ? 'cycling' : 'driving';
  const maxGaps = opts?.maxGaps ?? DEFAULT_MAX_GAPS;
  const deadline = Date.now() + (opts?.budgetMs ?? DEFAULT_BUDGET_MS);
  const totalGaps = routeGapStats(points).count;
  const out: TrackPoint[] = [points[0]];
  const unresolved: UnresolvedGap[] = [];
  let bridged = 0, corridorBridged = 0, fails = 0, detected = 0, tunnelBridged = 0, rejectedDetour = 0, failed = 0, sea = 0;
  let corridorCalls = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const distKm = haversineKm(prev, cur);
    // ギャップ = 距離が離れた区間（時間には依存しない）
    const isGap = distKm >= GAP_MIN_DIST_KM;
    if (isGap) detected++;
    const markUnresolved = (reason: UnresolvedGap['reason']) =>
      unresolved.push({ lat: prev.lat, lng: prev.lng, lat2: cur.lat, lng2: cur.lng, distKm, reason });
    if (isGap && distKm > AUTO_BRIDGE_MAX_KM) {
      // 超長距離ギャップ＝フェリー等の可能性が高い。誤って偽の陸路を描かないよう自動補間しない。
      sea++;
      markUnresolved('sea');
    } else if (isGap && (bridged >= maxGaps || fails >= MAX_FAILS || Date.now() >= deadline)) {
      markUnresolved('limit');
    } else if (isGap) {
      // 0) まず既知トンネル（山手・アクア・湾岸線・関越等）: 同梱ジオメトリで
      //    決定論的に補間。オフラインでも動き、OSRMの有料道路回避問題も受けない。
      let path: LL[] | null = null;
      let viaCorridor = false;
      let viaTunnel = false;
      let detourTotal = 0;
      let coords: [number, number][] | null = null;
      const tm = findTunnelPath(prev, cur, distKm);
      if (tm) {
        path = tm.path;
        viaTunnel = true;
      } else {
        // 1) OSRM。公開OSRMは有料道路を使わないため、拒否/遠回りになった1km以上のギャップは
        //    高速コリドー（OSM直読み・osmCorridor）にフォールバックする。
        coords = await osrmRoute(profile, prev, cur);
        if (coords && coords.length >= 2) {
          fails = 0;
          const p = coords.map(([lng, lat]) => ({ lat, lng }));
          let total = 0;
          for (let k = 1; k < p.length; k++) total += haversineKm(p[k - 1], p[k]);
          detourTotal = total;
          if (total >= distKm * 0.9 && total <= distKm * MAX_DETOUR_RATIO) path = p;
        } else {
          fails++;
        }
      }
      // 海上判定: 一定以上のギャップで道路経路が直線の3倍超＝湾・海峡を回り込む＝航路とみなす
      const isSea = !path && coords != null && distKm >= SEA_MIN_KM && detourTotal > distKm * SEA_DETOUR_RATIO;
      if (!path && !isSea && profile === 'driving' && distKm >= 1 && corridorCalls < MAX_CORRIDOR_CALLS) {
        corridorCalls++;
        const cc = await corridorRoute(prev, cur).catch(() => null);
        if (cc && cc.length >= 2) { path = cc.map(([lng, lat]) => ({ lat, lng })); viaCorridor = true; }
      }
      if (path) {
        const segDist: number[] = [];
        let total = 0;
        for (let k = 1; k < path.length; k++) { const d = haversineKm(path[k - 1], path[k]); segDist.push(d); total += d; }
        bridged++;
        if (viaCorridor) corridorBridged++;
        if (viaTunnel) tunnelBridged++;
        // 端点を除く中間点を距離比例のタイムスタンプで挿入（速度は後段で再計算）
        let cum = 0;
        for (let k = 1; k < path.length - 1; k++) {
          cum += segDist[k - 1];
          const frac = total > 0 ? cum / total : 0;
          const ts = Math.round(prev.timestamp + frac * (cur.timestamp - prev.timestamp));
          out.push({ lat: path[k].lat, lng: path[k].lng, timestamp: ts, speed: 0 });
        }
      } else if (isSea) {
        sea++;
        markUnresolved('sea');
      } else if (coords) {
        rejectedDetour++; // OSRMは返したが遠回り、コリドーも不成立
        markUnresolved('detour');
      } else {
        failed++;
        markUnresolved('failed');
      }
    }
    if (isGap) opts?.onProgress?.(detected, totalGaps);
    out.push(cur);
  }
  return { points: out, bridged, corridorBridged, detected, tunnelBridged, rejectedDetour, failed, sea, unresolved };
}
