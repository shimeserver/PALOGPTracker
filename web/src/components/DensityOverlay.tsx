import { useEffect, useMemo, useRef } from 'react';
import type { Route } from '../firebase/data';

// 全ルートの「通過回数」密度オーバーレイ。
// 約40mグリッドで各セルを通ったルート数を数え、1回=青 → 回数が増えるほど色相を赤へ回す。
// 大量セグメントでも軽いよう Canvas に直接描画する（Polyline数千本はMapsが重くなるため）。

const CELL_LAT = 0.00036; // ≈40m
const CELL_LNG = 0.00045; // ≈40m（東京緯度）
const MAX_PTS_PER_ROUTE = 300;

// 通過回数 → 色。1回=青(220°) から回数ごとに色相環を赤(0°)へ。
function countColor(n: number): string {
  const hue = Math.max(0, 220 - (n - 1) * 40); // 1:220 2:180 3:140 4:100 5:60 6:20 7+:0
  return `hsl(${hue}, 85%, ${hue > 60 ? 48 : 50}%)`;
}

interface Seg { lat1: number; lng1: number; lat2: number; lng2: number; n: number; }

function buildSegments(routes: Route[]): { segs: Seg[]; maxN: number } {
  // 各ルートを間引き
  const sampled = routes
    .filter(r => r.points?.length > 1)
    .map(r => {
      const step = Math.max(1, Math.floor(r.points.length / MAX_PTS_PER_ROUTE));
      return r.points.filter((_, i) => i % step === 0 || i === r.points.length - 1);
    });

  // セルごとに「通った別ルート数」をカウント（同一ルートの重複はSetで排除）
  const cellRoutes = new Map<string, Set<number>>();
  const mark = (lat: number, lng: number, ri: number) => {
    const key = `${Math.round(lat / CELL_LAT)}_${Math.round(lng / CELL_LNG)}`;
    let s = cellRoutes.get(key);
    if (!s) { s = new Set(); cellRoutes.set(key, s); }
    s.add(ri);
  };
  sampled.forEach((pts, ri) => {
    for (let i = 0; i < pts.length; i++) {
      mark(pts[i].lat, pts[i].lng, ri);
      // 点間が離れている場合はセル抜けを防ぐため補間してマーク
      if (i > 0) {
        const a = pts[i - 1], b = pts[i];
        const dLat = Math.abs(b.lat - a.lat) / CELL_LAT;
        const dLng = Math.abs(b.lng - a.lng) / CELL_LNG;
        const steps = Math.min(20, Math.floor(Math.max(dLat, dLng)));
        for (let k = 1; k < steps; k++) {
          const f = k / steps;
          mark(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f, ri);
        }
      }
    }
  });

  const countAt = (lat: number, lng: number): number =>
    cellRoutes.get(`${Math.round(lat / CELL_LAT)}_${Math.round(lng / CELL_LNG)}`)?.size ?? 1;

  const segs: Seg[] = [];
  let maxN = 1;
  sampled.forEach(pts => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = countAt((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      if (n > maxN) maxN = n;
      segs.push({ lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng, n });
    }
  });
  // 回数の少ない順に描く（よく通る道が上に来る）
  segs.sort((x, y) => x.n - y.n);
  return { segs, maxN };
}

// Webメルカトル: latLng → ワールドpx(zoom0で256px)
function project(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: 256 * (0.5 + lng / 360),
    y: 256 * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

interface Props { map: google.maps.Map | null; routes: Route[]; }

export default function DensityOverlay({ map, routes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { segs } = useMemo(() => buildSegments(routes), [routes]);
  const segsRef = useRef(segs);
  useEffect(() => { segsRef.current = segs; }, [segs]);

  useEffect(() => {
    if (!map) return;
    const div = map.getDiv() as HTMLElement;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
    div.appendChild(canvas);
    canvasRef.current = canvas;

    let raf = 0;
    const draw = () => {
      raf = 0;
      const ctx = canvas.getContext('2d');
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      if (!ctx || !bounds || zoom == null) return;
      const w = div.clientWidth, h = div.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const scale = Math.pow(2, zoom);
      const c = map.getCenter()!;
      const cp = project(c.lat(), c.lng());
      const toPx = (lat: number, lng: number) => {
        const p = project(lat, lng);
        return { x: (p.x - cp.x) * scale + w / 2, y: (p.y - cp.y) * scale + h / 2 };
      };

      // 画面外セグメントを間引くための可視範囲（少し余白）
      const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
      const latPad = (ne.lat() - sw.lat()) * 0.05, lngPad = (ne.lng() - sw.lng()) * 0.05;
      const latMin = sw.lat() - latPad, latMax = ne.lat() + latPad;
      const lngMin = sw.lng() - lngPad, lngMax = ne.lng() + lngPad;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.9;
      const lw = zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3;
      let lastColor = '';
      for (const s of segsRef.current) {
        if ((s.lat1 < latMin && s.lat2 < latMin) || (s.lat1 > latMax && s.lat2 > latMax)) continue;
        if ((s.lng1 < lngMin && s.lng2 < lngMin) || (s.lng1 > lngMax && s.lng2 > lngMax)) continue;
        const col = countColor(s.n);
        if (col !== lastColor) { ctx.strokeStyle = col; lastColor = col; }
        const p1 = toPx(s.lat1, s.lng1), p2 = toPx(s.lat2, s.lng2);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineWidth = lw;
        ctx.stroke();
      }
    };

    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const listeners = [
      map.addListener('bounds_changed', schedule),
      map.addListener('idle', schedule),
    ];
    schedule();

    return () => {
      listeners.forEach(l => google.maps.event.removeListener(l));
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, segs]);

  return null;
}
