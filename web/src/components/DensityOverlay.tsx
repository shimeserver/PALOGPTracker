import { useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../firebase/data';

// 全ルートの「通過回数」密度オーバーレイ（1回=青 → 回数増で赤へ）。
// 設計:
// - ルートごとの前処理（間引き2段階LOD・メルカトル座標化・セルマーク）は一度だけ実行し
//   モジュールキャッシュに蓄積（新ルートは差分処理）。
// - draw()はパン中も頻繁に呼ばれるため「位置合わせだけ」を行い、
//   実際の再描画はズーム変更 or 描画済み範囲から出た時だけ実施。
// - 描画は色ごとに1パスへ統合（stroke呼び出し〜7回）で高速。

const CELL = 0.00040; // ≈45m
const COUNT_SAMPLE = 300;
const LOD_FINE = 1000;   // zoom>=13 用
const LOD_COARSE = 250;  // zoom<13 用

const COLORS = [220, 180, 140, 100, 60, 30, 0].map(h => `hsl(${h}, 85%, 50%)`);
function colorIdx(n: number): number { return Math.min(COLORS.length - 1, n - 1); }

function project(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: 256 * (0.5 + lng / 360),
    y: 256 * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}
function unproject(x: number, y: number): { lat: number; lng: number } {
  const lng = (x / 256 - 0.5) * 360;
  const t = Math.exp((0.5 - y / 256) * 4 * Math.PI);
  const lat = (Math.asin((t - 1) / (t + 1)) * 180) / Math.PI;
  return { lat, lng };
}

interface WPt { x: number; y: number }
interface RouteCache { fine: WPt[]; coarse: WPt[]; cellOfFine: number[]; cellOfCoarse: number[]; cellKeys: string[] }

const routeCache = new Map<string, RouteCache>();
const cellRoutes = new Map<string, Set<string>>();

function cellKeyOf(lat: number, lng: number): string {
  return `${Math.round(lat / CELL)}_${Math.round(lng / CELL)}`;
}

function decimate(pts: Route['points'], maxN: number): { w: WPt[]; keys: string[] } {
  const step = Math.max(1, Math.floor(pts.length / maxN));
  const w: WPt[] = []; const keys: string[] = [];
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    w.push(project(p.lat, p.lng));
    keys.push(cellKeyOf(p.lat, p.lng));
  }
  const last = pts[pts.length - 1];
  w.push(project(last.lat, last.lng));
  keys.push(cellKeyOf(last.lat, last.lng));
  return { w, keys };
}

function processRoute(key: string, r: Route): RouteCache {
  const pts = r.points;
  // 回数集計用セルマーク（補間つき）
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
  const fine = decimate(pts, LOD_FINE);
  const coarse = decimate(pts, LOD_COARSE);
  const cache: RouteCache = {
    fine: fine.w, coarse: coarse.w,
    cellOfFine: [], cellOfCoarse: [],
    cellKeys: [...cells],
  };
  // セルキー→インデックスは後段（色決定）で毎回引くので、キー列だけ保持
  (cache as any).fineKeys = fine.keys;
  (cache as any).coarseKeys = coarse.keys;
  routeCache.set(key, cache);
  for (const ck of cache.cellKeys) {
    let s = cellRoutes.get(ck);
    if (!s) { s = new Set(); cellRoutes.set(ck, s); }
    s.add(key);
  }
  return cache;
}

// 色ごとにセグメントをまとめた描画データ（LOD別）
interface ColorBucket { pts: WPt[][]; minX: number; maxX: number; minY: number; maxY: number }
interface DrawData { fine: ColorBucket[]; coarse: ColorBucket[] }

function buildDrawData(routes: Route[]): DrawData {
  const active = routes.filter(r => r.id && r.points?.length > 1);
  const activeKeys = new Set(active.map(r => `${r.id}_${r.points.length}`));
  for (const r of active) {
    const key = `${r.id}_${r.points.length}`;
    if (!routeCache.has(key)) processRoute(key, r);
  }
  const countOfCell = (ck: string): number => {
    const s = cellRoutes.get(ck);
    if (!s) return 1;
    let n = 0;
    for (const k of s) if (activeKeys.has(k)) n++;
    return Math.max(1, n);
  };

  const make = (lod: 'fine' | 'coarse'): ColorBucket[] => {
    const buckets: ColorBucket[] = COLORS.map(() => ({ pts: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
    for (const r of active) {
      const cache = routeCache.get(`${r.id}_${r.points.length}`)! as any;
      const w: WPt[] = lod === 'fine' ? cache.fine : cache.coarse;
      const keys: string[] = lod === 'fine' ? cache.fineKeys : cache.coarseKeys;
      let curIdx = -1; let curLine: WPt[] = [];
      const flush = () => {
        if (curIdx >= 0 && curLine.length > 1) {
          const b = buckets[curIdx];
          b.pts.push(curLine);
          for (const p of curLine) {
            if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x;
            if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y;
          }
        }
      };
      for (let i = 0; i < w.length; i++) {
        const idx = colorIdx(countOfCell(keys[i]));
        if (idx !== curIdx) {
          const bridge = curLine.length > 0 ? curLine[curLine.length - 1] : null;
          flush();
          curIdx = idx; curLine = bridge ? [bridge, w[i]] : [w[i]];
        } else {
          curLine.push(w[i]);
        }
      }
      flush();
    }
    return buckets;
  };
  return { fine: make('fine'), coarse: make('coarse') };
}

interface Props { map: google.maps.Map | null; routes: Route[]; }

export default function DensityOverlay({ map, routes }: Props) {
  const [debounced, setDebounced] = useState<Route[]>(routes);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebounced(routes), 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [routes]);

  const drawData = useMemo(() => buildDrawData(debounced), [debounced]);

  useEffect(() => {
    if (!map) return;
    const hasData = drawData.fine.some(b => b.pts.length > 0);
    if (!hasData) return;

    class DensityView extends google.maps.OverlayView {
      canvas: HTMLCanvasElement | null = null;
      // 描画済み領域（ワールド座標）とズーム。範囲内のパンは位置合わせのみ。
      rendered: { zoom: number; wx0: number; wy0: number; wx1: number; wy1: number; anchor: google.maps.LatLng } | null = null;

      onAdd() {
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.getPanes()!.overlayLayer.appendChild(this.canvas);
      }
      onRemove() { this.canvas?.remove(); this.canvas = null; this.rendered = null; }

      draw() {
        const proj = this.getProjection();
        const canvas = this.canvas;
        if (!proj || !canvas) return;
        const zoom = map!.getZoom();
        const bounds = map!.getBounds();
        const div = map!.getDiv() as HTMLElement;
        if (zoom == null || !bounds || div.clientWidth === 0) return;

        // 既存レンダリングが同ズームで、現在のビューがカバー範囲内なら位置合わせのみ（パン時はここで即return）
        if (this.rendered && this.rendered.zoom === zoom) {
          const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
          const vNW = project(ne.lat(), sw.lng());
          const vSE = project(sw.lat(), ne.lng());
          const r = this.rendered;
          if (vNW.x >= r.wx0 && vSE.x <= r.wx1 && vNW.y >= r.wy0 && vSE.y <= r.wy1) {
            const px = proj.fromLatLngToDivPixel(r.anchor)!;
            canvas.style.left = `${px.x}px`;
            canvas.style.top = `${px.y}px`;
            return;
          }
        }
        this.repaint(proj, zoom, bounds, div);
      }

      repaint(proj: google.maps.MapCanvasProjection, zoom: number, bounds: google.maps.LatLngBounds, div: HTMLElement) {
        const canvas = this.canvas!;
        const w = div.clientWidth, h = div.clientHeight;
        const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        const nwW = project(ne.lat(), sw.lng());
        const scale = Math.pow(2, zoom);
        const M = Math.round(Math.max(w, h) * 0.75); // パン余白（広め）

        const cw = w + M * 2, ch = h + M * 2;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
          canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
          canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
        }
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // キャンバス左上のワールド座標と位置
        const wx0 = nwW.x - M / scale, wy0 = nwW.y - M / scale;
        const wx1 = nwW.x + (w + M) / scale, wy1 = nwW.y + (h + M) / scale;
        const anchorLL = unproject(wx0, wy0);
        const anchor = new google.maps.LatLng(anchorLL.lat, anchorLL.lng);
        const aPx = proj.fromLatLngToDivPixel(anchor)!;
        canvas.style.left = `${aPx.x}px`;
        canvas.style.top = `${aPx.y}px`;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3;
        ctx.globalAlpha = 0.92;

        const buckets = zoom >= 13 ? drawData.fine : drawData.coarse;
        // 青(回数少)→赤(回数多)の順に描く＝ホットな道が上
        for (let ci = 0; ci < buckets.length; ci++) {
          const b = buckets[ci];
          if (b.pts.length === 0) continue;
          if (b.maxX < wx0 || b.minX > wx1 || b.maxY < wy0 || b.minY > wy1) continue;
          ctx.strokeStyle = COLORS[ci];
          ctx.beginPath();
          for (const line of b.pts) {
            // 線単位の簡易カリング
            let visible = false;
            for (const p of line) { if (p.x >= wx0 && p.x <= wx1 && p.y >= wy0 && p.y <= wy1) { visible = true; break; } }
            if (!visible) continue;
            ctx.moveTo((line[0].x - wx0) * scale, (line[0].y - wy0) * scale);
            for (let i = 1; i < line.length; i++) {
              ctx.lineTo((line[i].x - wx0) * scale, (line[i].y - wy0) * scale);
            }
          }
          ctx.stroke();
        }

        this.rendered = { zoom, wx0, wy0, wx1, wy1, anchor };
      }
    }

    const overlay = new DensityView();
    overlay.setMap(map);
    const ro = new ResizeObserver(() => { (overlay as any).rendered = null; overlay.draw(); });
    ro.observe(map.getDiv());

    return () => {
      ro.disconnect();
      overlay.setMap(null);
    };
  }, [map, drawData]);

  return null;
}
