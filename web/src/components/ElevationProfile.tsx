import { useMemo, useRef, useState } from 'react';
import type { TrackPoint } from '../firebase/data';

// ルートの標高プロファイル（x=走行距離km, y=標高m）。
// 高度データ(alt)を持つ点が十分ある場合のみ表示する。

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function hasElevationData(points: TrackPoint[]): boolean {
  if (points.length < 10) return false;
  const withAlt = points.filter(p => p.alt != null).length;
  return withAlt >= points.length * 0.5 && withAlt >= 10;
}

interface Props {
  points: TrackPoint[];
  onHoverPoint?: (index: number | null) => void; // 地図側で位置ハイライトする用（任意）
}

const W = 560, H = 150, PAD_L = 44, PAD_R = 10, PAD_T = 12, PAD_B = 22;

export default function ElevationProfile({ points, onHoverPoint }: Props) {
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // 累積距離と標高の系列（altのある点のみ、軽く間引き）
  const series = useMemo(() => {
    const out: { km: number; alt: number; idx: number }[] = [];
    let cum = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) cum += haversineKm(points[i - 1], points[i]);
      const alt = points[i].alt;
      if (alt != null) out.push({ km: cum, alt, idx: i });
    }
    // 600点程度まで間引き（描画負荷対策）
    const step = Math.max(1, Math.floor(out.length / 600));
    return out.filter((_, i) => i % step === 0 || i === out.length - 1);
  }, [points]);

  if (series.length < 2) return null;

  const kmMax = series[series.length - 1].km;
  const altMin = Math.min(...series.map(s => s.alt));
  const altMax = Math.max(...series.map(s => s.alt));
  const altPad = Math.max(5, (altMax - altMin) * 0.1);
  const y0 = altMin - altPad, y1 = altMax + altPad;

  const sx = (km: number) => PAD_L + (km / kmMax) * (W - PAD_L - PAD_R);
  const sy = (alt: number) => PAD_T + (1 - (alt - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);

  const linePath = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(s.km).toFixed(1)},${sy(s.alt).toFixed(1)}`).join('');
  const areaPath = `${linePath}L${sx(kmMax).toFixed(1)},${H - PAD_B}L${PAD_L},${H - PAD_B}Z`;

  // 横グリッド: 3本（min/mid/max 付近の丸めた値）
  const gridVals = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y0 + (y1 - y0) * 0.85]
    .map(v => Math.round(v / 10) * 10);

  // x軸目盛: 0, 1/4, 1/2, 3/4, max
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => kmMax * f);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const km = ((px - PAD_L) / (W - PAD_L - PAD_R)) * kmMax;
    // 最近傍の系列点を二分探索
    let lo = 0, hi = series.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid].km < km) lo = mid; else hi = mid; }
    const i = (km - series[lo].km) < (series[hi].km - km) ? lo : hi;
    setHover({ x: sx(series[i].km), i });
    onHoverPoint?.(series[i].idx);
  };
  const handleLeave = () => { setHover(null); onHoverPoint?.(null); };

  const hv = hover ? series[hover.i] : null;
  const gain = useMemo(() => {
    let up = 0;
    for (let i = 1; i < series.length; i++) { const d = series[i].alt - series[i - 1].alt; if (d > 0) up += d; }
    return Math.round(up);
  }, [series]);

  return (
    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e8eaed', padding: '10px 12px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1f2937' }}>⛰ 標高プロファイル</span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          最高 {Math.round(altMax)}m ・ 最低 {Math.round(altMin)}m ・ 獲得標高 +{gain}m
        </span>
      </div>
      <svg
        ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMove} onMouseLeave={handleLeave}
      >
        {/* グリッド（控えめ） */}
        {gridVals.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={sy(v)} y2={sy(v)} stroke="#eef0f2" strokeWidth={1} />
            <text x={PAD_L - 6} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill="#9ca3af">{v}m</text>
          </g>
        ))}
        {/* x軸目盛 */}
        {xTicks.map((km, i) => (
          <text key={i} x={sx(km)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize={10} fill="#9ca3af">
            {km.toFixed(km >= 10 ? 0 : 1)}km
          </text>
        ))}
        {/* 面＋線 */}
        <path d={areaPath} fill="#2563eb" fillOpacity={0.12} />
        <path d={linePath} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" />
        {/* ホバー: クロスヘア＋マーカー＋ツールチップ */}
        {hv && hover && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={PAD_T} y2={H - PAD_B} stroke="#9ca3af" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={hover.x} cy={sy(hv.alt)} r={4} fill="#2563eb" stroke="#fff" strokeWidth={2} />
            {(() => {
              const label = `${hv.km.toFixed(1)}km ・ ${Math.round(hv.alt)}m`;
              const tw = label.length * 6.2 + 12;
              const tx = Math.min(Math.max(hover.x - tw / 2, PAD_L), W - PAD_R - tw);
              const ty = Math.max(sy(hv.alt) - 30, 2);
              return (
                <g>
                  <rect x={tx} y={ty} width={tw} height={20} rx={5} fill="#1f2937" fillOpacity={0.92} />
                  <text x={tx + tw / 2} y={ty + 13.5} textAnchor="middle" fontSize={11} fill="#fff">{label}</text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}
