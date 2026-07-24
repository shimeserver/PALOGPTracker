import { useEffect, useMemo, useState } from 'react';
import type { Route } from '../firebase/data';
import prefData from '../assets/japan_prefs.json';

// 都道府県制覇マップ: 走行ルートの点から訪問済み都道府県を判定して塗りつぶす。
// 境界データは簡略化ポリゴン（誤差~1km）。判定結果はルートごとにlocalStorageへキャッシュ。

interface Pref { n: string; p: [number, number][][] }
const PREFS = prefData as Pref[];

const CACHE_KEY = 'prefVisit_v1';

// 各県のbbox（初回に計算）
const BBOXES = PREFS.map(pref => {
  let minX = 180, maxX = 0, minY = 90, maxY = 0;
  for (const poly of pref.p) for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
});

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function prefsForRoute(route: Route): string[] {
  const found = new Set<string>();
  const pts = route.points ?? [];
  const step = Math.max(1, Math.floor(pts.length / 150)); // 1ルート最大~150点サンプル
  for (let i = 0; i < pts.length; i += step) {
    const { lat, lng } = pts[i];
    for (let k = 0; k < PREFS.length; k++) {
      if (found.has(PREFS[k].n)) continue;
      const bb = BBOXES[k];
      if (lng < bb.minX || lng > bb.maxX || lat < bb.minY || lat > bb.maxY) continue;
      if (PREFS[k].p.some(poly => pointInPoly(lng, lat, poly))) { found.add(PREFS[k].n); break; }
    }
  }
  return [...found];
}

interface Props {
  open: boolean;
  onClose: () => void;
  routes: Route[];
}

export default function PrefectureMapPanel({ open, onClose, routes }: Props) {
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [computing, setComputing] = useState(false);
  const [hoverPref, setHoverPref] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setComputing(true);
    // 重い計算を1フレーム逃してから実行（モーダル表示を先に）
    const t = setTimeout(() => {
      let cache: Record<string, string[]> = {};
      try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { /* ignore */ }
      const all = new Set<string>();
      let dirty = false;
      for (const r of routes) {
        if (!r.id) continue;
        const key = `${r.id}_${r.points?.length ?? 0}`;
        let prefs = cache[key];
        if (!prefs) {
          prefs = prefsForRoute(r);
          cache[key] = prefs;
          dirty = true;
        }
        prefs.forEach(p => all.add(p));
      }
      if (dirty) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ } }
      setVisited(all);
      setComputing(false);
    }, 50);
    return () => clearTimeout(t);
  }, [open, routes]);

  // 日本全体のSVGパス（正距円筒: lngはcos(38°)≈0.79で縮尺）
  const { paths, viewBox } = useMemo(() => {
    const KX = 0.79;
    let minX = 999, maxX = -999, minY = 999, maxY = -999;
    for (const bb of BBOXES) {
      minX = Math.min(minX, bb.minX * KX); maxX = Math.max(maxX, bb.maxX * KX);
      minY = Math.min(minY, -bb.maxY); maxY = Math.max(maxY, -bb.minY);
    }
    const paths = PREFS.map(pref => ({
      name: pref.n,
      d: pref.p.map(poly =>
        poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(x * KX).toFixed(2)},${(-y).toFixed(2)}`).join('') + 'Z'
      ).join(''),
    }));
    const pad = 0.3;
    return { paths, viewBox: `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${(maxX - minX + pad * 2).toFixed(2)} ${(maxY - minY + pad * 2).toFixed(2)}` };
  }, []);

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', width: 'min(720px, 94vw)', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1f2937' }}>🗾 都道府県制覇</h3>
          <span style={{ fontSize: 22, fontWeight: 800, color: '#2563eb' }}>{visited.size}<span style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}> / 47</span></span>
          {hoverPref && <span style={{ fontSize: 13, color: visited.has(hoverPref) ? '#2563eb' : '#9ca3af', fontWeight: 600 }}>{hoverPref}{visited.has(hoverPref) ? ' ✓' : ''}</span>}
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 18, color: '#9ca3af', cursor: 'pointer' }}>✕</button>
        </div>
        {computing ? (
          <p style={{ color: '#9ca3af', textAlign: 'center', padding: '60px 0' }}>ルートを解析中...</p>
        ) : (
          <>
            <svg viewBox={viewBox} style={{ width: '100%', height: 'auto', display: 'block' }}>
              {paths.map(p => (
                <path
                  key={p.name} d={p.d}
                  fill={visited.has(p.name) ? '#2563eb' : '#eef0f2'}
                  fillOpacity={visited.has(p.name) ? (hoverPref === p.name ? 1 : 0.82) : (hoverPref === p.name ? 0.7 : 1)}
                  stroke="#fff" strokeWidth={0.02}
                  onMouseEnter={() => setHoverPref(p.name)}
                  onMouseLeave={() => setHoverPref(null)}
                  style={{ cursor: 'default' }}
                />
              ))}
            </svg>
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {PREFS.filter(p => visited.has(p.n)).map(p => (
                <span key={p.n} style={{ fontSize: 11, background: '#eff6ff', color: '#2563eb', borderRadius: 10, padding: '2px 8px', fontWeight: 600 }}>{p.n}</span>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, marginBottom: 0 }}>
              記録済みルートのGPS点から自動判定（境界は簡略化のため県境付近は誤差あり）
            </p>
          </>
        )}
      </div>
    </div>
  );
}
