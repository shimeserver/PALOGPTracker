import { useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../firebase/data';

// 全ルートの「通過回数」密度オーバーレイ（1回=青 → 回数増で赤へ）。
//
// 描画は「タイルオーバーレイ」(map.overlayMapTypes) 方式。
// タイルはベースマップと同じ仕組みでGoogleマップ本体が管理するため、
// パン・ズームアニメーションに完全同期する（交通状況レイヤーと同じ挙動）。
// 各タイルは必要な区間だけをフル解像度で描くので、間引きによるカクつきも無い。
//
// 前処理（座標変換・セル集計・色ラン構築）はルート単位でキャッシュし、
// 新しいルートだけ差分処理される。

const CELL = 0.00040; // ≈45m
const COUNT_SAMPLE = 300;
const TILE = 256;

const COLORS = [220, 180, 140, 100, 60, 30, 0].map(h => `hsl(${h}, 85%, 50%)`);
const colorIdx = (n: number) => Math.min(COLORS.length - 1, n - 1);

// Webメルカトル: latLng → ワールド座標(zoom0で256px四方)
function project(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: TILE * (0.5 + lng / 360),
    y: TILE * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

// セルキーは数値（文字列よりメモリ・速度で有利）
const cellKey = (lat: number, lng: number) =>
  (Math.round(lat / CELL) + 500000) * 4000000 + (Math.round(lng / CELL) + 1000000);

interface WPt { x: number; y: number }
interface RouteCache { pts: WPt[]; ptCells: Float64Array; cellList: number[] }

const routeCache = new Map<string, RouteCache>();
const cellRoutes = new Map<number, Set<string>>();

function processRoute(key: string, r: Route): RouteCache {
  const pts = r.points;
  // 通過セル集計（間引き＋補間で列挙。カウント精度用）
  const cells = new Set<number>();
  const cStep = Math.max(1, Math.floor(pts.length / COUNT_SAMPLE));
  let prev: { lat: number; lng: number } | null = null;
  for (let i = 0; i < pts.length; i += cStep) {
    const p = pts[i];
    cells.add(cellKey(p.lat, p.lng));
    if (prev) {
      const steps = Math.min(20, Math.floor(Math.max(
        Math.abs(p.lat - prev.lat) / CELL, Math.abs(p.lng - prev.lng) / CELL)));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        cells.add(cellKey(prev.lat + (p.lat - prev.lat) * f, prev.lng + (p.lng - prev.lng) * f));
      }
    }
    prev = p;
  }
  // 描画はフル解像度: 全点のワールド座標と所属セルを保持
  const w: WPt[] = new Array(pts.length);
  const ptCells = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    w[i] = project(pts[i].lat, pts[i].lng);
    ptCells[i] = cellKey(pts[i].lat, pts[i].lng);
  }
  const cache: RouteCache = { pts: w, ptCells, cellList: [...cells] };
  routeCache.set(key, cache);
  for (const ck of cache.cellList) {
    let s = cellRoutes.get(ck);
    if (!s) { s = new Set(); cellRoutes.set(ck, s); }
    s.add(key);
  }
  return cache;
}

// 色ごとのポリライン集合（フル解像度・bbox付き）
interface Line { pts: WPt[]; minX: number; maxX: number; minY: number; maxY: number }
type Buckets = Line[][]; // [colorIdx] -> lines

function buildBuckets(routes: Route[]): Buckets {
  const active = routes.filter(r => r.id && r.points?.length > 1);
  const activeKeys = new Set(active.map(r => `${r.id}_${r.points.length}`));
  for (const r of active) {
    const key = `${r.id}_${r.points.length}`;
    if (!routeCache.has(key)) processRoute(key, r);
  }
  // セル→現在アクティブなルート数 を一括計算（点ごとのSet走査を避ける）
  const countOfCell = new Map<number, number>();
  for (const [ck, set] of cellRoutes) {
    let n = 0;
    for (const k of set) if (activeKeys.has(k)) n++;
    if (n > 0) countOfCell.set(ck, n);
  }

  const buckets: Buckets = COLORS.map(() => []);
  for (const r of active) {
    const cache = routeCache.get(`${r.id}_${r.points.length}`)!;
    const { pts, ptCells } = cache;
    let curIdx = -1;
    let curPts: WPt[] = [];
    let lastPt: WPt | null = null; // 直前の点（色替わり目の橋渡し用）
    const flush = () => {
      if (curIdx >= 0 && curPts.length > 1) {
        let minX = curPts[0].x, maxX = curPts[0].x, minY = curPts[0].y, maxY = curPts[0].y;
        for (const q of curPts) {
          if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
          if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
        }
        buckets[curIdx].push({ pts: curPts, minX, maxX, minY, maxY });
      }
    };
    for (let i = 0; i < pts.length; i++) {
      const idx = colorIdx(countOfCell.get(ptCells[i]) ?? 1);
      const p = pts[i];
      if (idx !== curIdx) {
        flush();
        curIdx = idx;
        curPts = lastPt ? [lastPt, p] : [p]; // 前ランの終点から繋ぐ（隙間防止）
      } else {
        curPts.push(p);
      }
      lastPt = p;
    }
    flush();
  }
  return buckets;
}

interface Props { map: google.maps.Map | null; routes: Route[]; }

export default function DensityOverlay({ map, routes }: Props) {
  // ハイドレーション中の連続更新は250msデバウンスで1回に
  const [debounced, setDebounced] = useState<Route[]>(routes);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebounced(routes), 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [routes]);

  const buckets = useMemo(() => buildBuckets(debounced), [debounced]);

  useEffect(() => {
    if (!map) return;
    if (!buckets.some(b => b.length > 0)) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const mapType: google.maps.MapType = {
      tileSize: new google.maps.Size(TILE, TILE),
      maxZoom: 22,
      minZoom: 0,
      name: 'density',
      alt: 'density',
      radius: 6378137,
      projection: null as unknown as google.maps.Projection,
      getTile(coord: google.maps.Point, zoom: number, ownerDocument: Document): Element {
        const canvas = ownerDocument.createElement('canvas');
        canvas.width = TILE * dpr;
        canvas.height = TILE * dpr;
        canvas.style.width = `${TILE}px`;
        canvas.style.height = `${TILE}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return canvas;

        const scale = Math.pow(2, zoom);
        const n = scale; // タイル数
        const tx = ((coord.x % n) + n) % n; // 経度方向のラップ対応
        const ty = coord.y;
        if (ty < 0 || ty >= n) return canvas;

        // このタイルのワールド範囲
        const ws = TILE / scale;            // タイル1枚のワールド幅
        const wx0 = tx * ws, wy0 = ty * ws;
        const lw = zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3;
        const pad = (lw + 2) / scale;       // 線幅ぶん外側も描く（タイル境界の欠け防止）
        const wxMin = wx0 - pad, wxMax = wx0 + ws + pad;
        const wyMin = wy0 - pad, wyMax = wy0 + ws + pad;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = lw;
        ctx.globalAlpha = 0.9;

        // 低ズームでは点間隔がサブピクセルになるため間引く（見た目は不変・描画量削減）
        const stride = zoom >= 13 ? 1 : zoom >= 11 ? 2 : zoom >= 9 ? 4 : 8;

        // 青(1回)→赤(多数)の順に重ねる
        for (let ci = 0; ci < buckets.length; ci++) {
          const lines = buckets[ci];
          if (lines.length === 0) continue;
          ctx.strokeStyle = COLORS[ci];
          ctx.beginPath();
          let drew = false;
          for (const line of lines) {
            if (line.maxX < wxMin || line.minX > wxMax || line.maxY < wyMin || line.minY > wyMax) continue;
            const pts = line.pts;
            let penDown = false;
            let prevIn = false;
            for (let i = 0; i < pts.length; i += (i + stride < pts.length ? stride : 1)) {
              const p = pts[i];
              const inside = p.x >= wxMin && p.x <= wxMax && p.y >= wyMin && p.y <= wyMax;
              if (!inside && !prevIn) { penDown = false; prevIn = false; continue; }
              const x = (p.x - wx0) * scale, y = (p.y - wy0) * scale;
              if (!penDown) {
                // 範囲外→内に入った場合は直前点から線を引く（切れ目防止）
                if (i > 0 && !prevIn) {
                  const q = pts[i - 1];
                  ctx.moveTo((q.x - wx0) * scale, (q.y - wy0) * scale);
                  ctx.lineTo(x, y);
                } else {
                  ctx.moveTo(x, y);
                }
                penDown = true;
              } else {
                ctx.lineTo(x, y);
              }
              drew = true;
              prevIn = inside;
              if (!inside) penDown = false; // 内→外に出たら一旦切る（外側の点までは引いた）
            }
          }
          if (drew) ctx.stroke();
        }
        return canvas;
      },
      releaseTile() { /* GCに任せる */ },
    };

    map.overlayMapTypes.push(mapType);
    return () => {
      const arr = map.overlayMapTypes;
      for (let i = arr.getLength() - 1; i >= 0; i--) {
        if (arr.getAt(i) === mapType) arr.removeAt(i);
      }
    };
  }, [map, buckets]);

  return null;
}
