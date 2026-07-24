import { useEffect, useMemo } from 'react';
import type { Route } from '../firebase/data';

// 全ルートの「通過回数」密度オーバーレイ。
// 約40mグリッドで各セルを通った別ルート数を数え、1回=青 → 回数が増えるほど色相を赤へ。
// 描画は google.maps.OverlayView のペイン内 canvas — ペインはマップと一緒に
// 平行移動されるため、パン中も完全に追随する（ズーム/アイドルで再描画）。

const CELL_LAT = 0.00036; // ≈40m
const CELL_LNG = 0.00045;
const COUNT_SAMPLE = 300;   // 回数集計用の間引き
const DRAW_MAX_PTS = 1000;  // 描画用の間引き（高解像度＝滑らか）

function countColor(n: number): string {
  const hue = Math.max(0, 220 - (n - 1) * 40); // 1:220(青) → 7+:0(赤)
  return `hsl(${hue}, 85%, 50%)`;
}

interface Run { color: string; pts: { lat: number; lng: number }[]; minLat: number; maxLat: number; minLng: number; maxLng: number; }

function buildRuns(routes: Route[]): Run[] {
  const valid = routes.filter(r => r.points?.length > 1);

  // --- 回数集計（40mグリッド、同一ルートはSetで1回だけ） ---
  const cellRoutes = new Map<string, Set<number>>();
  const mark = (lat: number, lng: number, ri: number) => {
    const key = `${Math.round(lat / CELL_LAT)}_${Math.round(lng / CELL_LNG)}`;
    let s = cellRoutes.get(key);
    if (!s) { s = new Set(); cellRoutes.set(key, s); }
    s.add(ri);
  };
  valid.forEach((r, ri) => {
    const step = Math.max(1, Math.floor(r.points.length / COUNT_SAMPLE));
    let prev: { lat: number; lng: number } | null = null;
    for (let i = 0; i < r.points.length; i += step) {
      const p = r.points[i];
      mark(p.lat, p.lng, ri);
      if (prev) {
        const dLat = Math.abs(p.lat - prev.lat) / CELL_LAT;
        const dLng = Math.abs(p.lng - prev.lng) / CELL_LNG;
        const steps = Math.min(20, Math.floor(Math.max(dLat, dLng)));
        for (let k = 1; k < steps; k++) {
          const f = k / steps;
          mark(prev.lat + (p.lat - prev.lat) * f, prev.lng + (p.lng - prev.lng) * f, ri);
        }
      }
      prev = p;
    }
  });
  const countAt = (lat: number, lng: number): number =>
    cellRoutes.get(`${Math.round(lat / CELL_LAT)}_${Math.round(lng / CELL_LNG)}`)?.size ?? 1;

  // --- 描画ラン（同色の連続区間ごとに1本のポリライン） ---
  const runs: Run[] = [];
  for (const r of valid) {
    const step = Math.max(1, Math.floor(r.points.length / DRAW_MAX_PTS));
    const pts = r.points.filter((_, i) => i % step === 0 || i === r.points.length - 1);
    let cur: Run | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const color = countColor(countAt(p.lat, p.lng));
      if (!cur || cur.color !== color) {
        // 前のランの終点と繋げる（色替わり目の隙間を防ぐ）
        const prevRun: Run | null = cur;
        const startPts: { lat: number; lng: number }[] = prevRun ? [prevRun.pts[prevRun.pts.length - 1]] : [];
        if (prevRun && prevRun.pts.length > 1) runs.push(prevRun);
        cur = { color, pts: [...startPts, { lat: p.lat, lng: p.lng }], minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng };
        for (const sp of startPts) {
          cur.minLat = Math.min(cur.minLat, sp.lat); cur.maxLat = Math.max(cur.maxLat, sp.lat);
          cur.minLng = Math.min(cur.minLng, sp.lng); cur.maxLng = Math.max(cur.maxLng, sp.lng);
        }
      } else {
        cur.pts.push({ lat: p.lat, lng: p.lng });
        cur.minLat = Math.min(cur.minLat, p.lat); cur.maxLat = Math.max(cur.maxLat, p.lat);
        cur.minLng = Math.min(cur.minLng, p.lng); cur.maxLng = Math.max(cur.maxLng, p.lng);
      }
    }
    if (cur && cur.pts.length > 1) runs.push(cur);
  }
  // 回数の少ない色を先に描く（ホットな道が上）— 色相が小さいほど回数多
  const hueOf = (c: string) => parseInt(c.slice(4), 10);
  runs.sort((a, b) => hueOf(b.color) - hueOf(a.color));
  return runs;
}

interface Props { map: google.maps.Map | null; routes: Route[]; }

export default function DensityOverlay({ map, routes }: Props) {
  const runs = useMemo(() => buildRuns(routes), [routes]);

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
      onRemove() {
        this.canvas?.remove();
        this.canvas = null;
      }
      draw() {
        const proj = this.getProjection();
        const canvas = this.canvas;
        if (!proj || !canvas) return;
        const div = map!.getDiv() as HTMLElement;
        const w = div.clientWidth, h = div.clientHeight;
        const bounds = map!.getBounds();
        if (!bounds || w === 0) return;

        // ビューポート左上（NW）をアンカーにキャンバスを配置
        const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        const nwPx = proj.fromLatLngToDivPixel(new google.maps.LatLng(ne.lat(), sw.lng()))!;
        // パン余白: 周囲に半画面ぶん広く描いておく（パン中も切れない）
        const M = Math.round(Math.max(w, h) / 2);
        canvas.style.left = `${nwPx.x - M}px`;
        canvas.style.top = `${nwPx.y - M}px`;
        const cw = w + M * 2, ch = h + M * 2;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = cw * dpr; canvas.height = ch * dpr;
        canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // 可視範囲（余白込み）でランをカリング
        const latPad = (ne.lat() - sw.lat()) * (M / h);
        const lngPad = (ne.lng() - sw.lng()) * (M / w);
        const latMin = sw.lat() - latPad, latMax = ne.lat() + latPad;
        const lngMin = sw.lng() - lngPad, lngMax = ne.lng() + lngPad;

        const zoom = map!.getZoom() ?? 12;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3;
        ctx.globalAlpha = 0.92;

        let lastColor = '';
        for (const run of runs) {
          if (run.maxLat < latMin || run.minLat > latMax || run.maxLng < lngMin || run.minLng > lngMax) continue;
          if (run.color !== lastColor) { ctx.strokeStyle = run.color; lastColor = run.color; }
          ctx.beginPath();
          for (let i = 0; i < run.pts.length; i++) {
            const px = proj.fromLatLngToDivPixel(new google.maps.LatLng(run.pts[i].lat, run.pts[i].lng))!;
            const x = px.x - nwPx.x + M, y = px.y - nwPx.y + M;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
    }

    const overlay = new DensityView();
    overlay.setMap(map);
    // コンテナリサイズにも追随
    const ro = new ResizeObserver(() => overlay.draw());
    ro.observe(map.getDiv());

    return () => {
      ro.disconnect();
      overlay.setMap(null);
    };
  }, [map, runs]);

  return null;
}
