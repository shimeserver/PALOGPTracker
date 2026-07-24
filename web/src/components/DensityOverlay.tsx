import { useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../firebase/data';

// 全ルートの「通過回数」密度オーバーレイ。
// - ルートごとの前処理（間引き・メルカトル座標化・セルマーク）は一度だけ実行し、
//   モジュールレベルのキャッシュに蓄積。新しいルートは差分だけ処理される。
// - 描画はワールド座標の純計算（LatLngオブジェクト生成なし）で高速。
// - canvasは OverlayView のペイン内にあり、パン中はマップと一緒に動く。

const CELL = 0.00040; // ≈45m相当（メルカトルy側もこのスケール感で十分）
const COUNT_SAMPLE = 300;
const DRAW_MAX_PTS = 1000;

function countColor(n: number): string {
  const hue = Math.max(0, 220 - (n - 1) * 40); // 1:220(青) → 7+:0(赤)
  return `hsl(${hue}, 85%, 50%)`;
}

// Webメルカトル: latLng → ワールド座標(zoom0で256px)
function project(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: 256 * (0.5 + lng / 360),
    y: 256 * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

interface WPt { x: number; y: number; lat: number; lng: number }
interface RouteCache {
  drawPts: WPt[];          // 描画用（高解像度間引き済み・ワールド座標）
  cellKeys: string[];      // このルートが通ったセル
}
interface Run { color: string; pts: WPt[]; minX: number; maxX: number; minY: number; maxY: number }

// ルートごとの前処理キャッシュ（セッション中は蓄積され、再オープンでも再計算しない）
const routeCache = new Map<string, RouteCache>();
const cellRoutes = new Map<string, Set<string>>(); // cellKey -> 通ったルートkeyの集合

function cellKeyOf(lat: number, lng: number): string {
  return `${Math.round(lat / CELL)}_${Math.round(lng / CELL)}`;
}

function processRoute(key: string, r: Route): RouteCache {
  const pts = r.points;
  // 回数集計用マーク（補間つき）
  const cells = new Set<string>();
  const cStep = Math.max(1, Math.floor(pts.length / COUNT_SAMPLE));
  let prev: { lat: number; lng: number } | null = null;
  for (let i = 0; i < pts.length; i += cStep) {
    const p = pts[i];
    cells.add(cellKeyOf(p.lat, p.lng));
    if (prev) {
      const steps = Math.min(20, Math.floor(Math.max(
        Math.abs(p.lat - prev.lat) / CELL, Math.abs(p.lng - prev.lng) / CELL)));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        cells.add(cellKeyOf(prev.lat + (p.lat - prev.lat) * f, prev.lng + (p.lng - prev.lng) * f));
      }
    }
    prev = p;
  }
  // 描画用の高解像度点列（ワールド座標を先に計算しておく）
  const dStep = Math.max(1, Math.floor(pts.length / DRAW_MAX_PTS));
  const drawPts: WPt[] = [];
  for (let i = 0; i < pts.length; i += dStep) {
    const p = pts[i];
    const w = project(p.lat, p.lng);
    drawPts.push({ x: w.x, y: w.y, lat: p.lat, lng: p.lng });
  }
  const last = pts[pts.length - 1];
  if (drawPts[drawPts.length - 1]?.lat !== last.lat) {
    const w = project(last.lat, last.lng);
    drawPts.push({ x: w.x, y: w.y, lat: last.lat, lng: last.lng });
  }
  const cache: RouteCache = { drawPts, cellKeys: [...cells] };
  routeCache.set(key, cache);
  for (const ck of cache.cellKeys) {
    let s = cellRoutes.get(ck);
    if (!s) { s = new Set(); cellRoutes.set(ck, s); }
    s.add(key);
  }
  return cache;
}

// 現在のルート集合からランを構築（前処理はキャッシュ利用、色付けと連結のみ実施）
function buildRuns(routes: Route[]): Run[] {
  const active = routes.filter(r => r.id && r.points?.length > 1);
  const activeKeys = new Set(active.map(r => `${r.id}_${r.points.length}`));

  // 新規ルートだけ前処理（蓄積）
  for (const r of active) {
    const key = `${r.id}_${r.points.length}`;
    if (!routeCache.has(key)) processRoute(key, r);
  }

  const countAt = (lat: number, lng: number): number => {
    const s = cellRoutes.get(cellKeyOf(lat, lng));
    if (!s) return 1;
    // 削除済みルートが混ざらないよう、現在表示中のルートに限定して数える
    let n = 0;
    for (const k of s) if (activeKeys.has(k)) n++;
    return Math.max(1, n);
  };

  const runs: Run[] = [];
  for (const r of active) {
    const cache = routeCache.get(`${r.id}_${r.points.length}`)!;
    let cur: Run | null = null;
    for (const p of cache.drawPts) {
      const color = countColor(countAt(p.lat, p.lng));
      if (!cur || cur.color !== color) {
        const bridge: WPt[] = cur ? [cur.pts[cur.pts.length - 1]] : [];
        if (cur && cur.pts.length > 1) runs.push(cur);
        cur = { color, pts: [...bridge, p], minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
        for (const b of bridge) {
          cur.minX = Math.min(cur.minX, b.x); cur.maxX = Math.max(cur.maxX, b.x);
          cur.minY = Math.min(cur.minY, b.y); cur.maxY = Math.max(cur.maxY, b.y);
        }
      } else {
        cur.pts.push(p);
        cur.minX = Math.min(cur.minX, p.x); cur.maxX = Math.max(cur.maxX, p.x);
        cur.minY = Math.min(cur.minY, p.y); cur.maxY = Math.max(cur.maxY, p.y);
      }
    }
    if (cur && cur.pts.length > 1) runs.push(cur);
  }
  const hueOf = (c: string) => parseInt(c.slice(4), 10);
  runs.sort((a, b) => hueOf(b.color) - hueOf(a.color)); // 回数の多い色を後（上）に
  return runs;
}

interface Props { map: google.maps.Map | null; routes: Route[]; }

export default function DensityOverlay({ map, routes }: Props) {
  // ハイドレーション中の連続更新でも再構築が1回で済むようデバウンス
  const [debounced, setDebounced] = useState<Route[]>(routes);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebounced(routes), 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [routes]);

  const runs = useMemo(() => buildRuns(debounced), [debounced]);

  useEffect(() => {
    if (!map || runs.length === 0) return;

    class DensityView extends google.maps.OverlayView {
      canvas: HTMLCanvasElement | null = null;
      onAdd() {
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.getPanes()!.overlayLayer.appendChild(this.canvas);
      }
      onRemove() { this.canvas?.remove(); this.canvas = null; }
      draw() {
        const proj = this.getProjection();
        const canvas = this.canvas;
        if (!proj || !canvas) return;
        const div = map!.getDiv() as HTMLElement;
        const w = div.clientWidth, h = div.clientHeight;
        const bounds = map!.getBounds();
        const zoom = map!.getZoom();
        if (!bounds || w === 0 || zoom == null) return;

        const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        const nwLatLng = new google.maps.LatLng(ne.lat(), sw.lng());
        const nwPx = proj.fromLatLngToDivPixel(nwLatLng)!; // ペイン座標のアンカー
        const nwW = project(ne.lat(), sw.lng());            // 同地点のワールド座標
        const scale = Math.pow(2, zoom);

        const M = Math.round(Math.max(w, h) / 2); // パン余白
        canvas.style.left = `${nwPx.x - M}px`;
        canvas.style.top = `${nwPx.y - M}px`;
        const cw = w + M * 2, ch = h + M * 2;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = cw * dpr; canvas.height = ch * dpr;
        canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // ワールド座標での可視範囲（余白込み）— ランのbboxカリング用
        const wxMin = nwW.x - M / scale, wxMax = nwW.x + (w + M) / scale;
        const wyMin = nwW.y - M / scale, wyMax = nwW.y + (h + M) / scale;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3;
        ctx.globalAlpha = 0.92;

        let lastColor = '';
        for (const run of runs) {
          if (run.maxX < wxMin || run.minX > wxMax || run.maxY < wyMin || run.minY > wyMax) continue;
          if (run.color !== lastColor) { ctx.strokeStyle = run.color; lastColor = run.color; }
          ctx.beginPath();
          const pts = run.pts;
          ctx.moveTo((pts[0].x - nwW.x) * scale + M, (pts[0].y - nwW.y) * scale + M);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo((pts[i].x - nwW.x) * scale + M, (pts[i].y - nwW.y) * scale + M);
          }
          ctx.stroke();
        }
      }
    }

    const overlay = new DensityView();
    overlay.setMap(map);
    const ro = new ResizeObserver(() => overlay.draw());
    ro.observe(map.getDiv());

    return () => {
      ro.disconnect();
      overlay.setMap(null);
    };
  }, [map, runs]);

  return null;
}
