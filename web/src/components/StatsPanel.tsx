import { useEffect, useMemo, useState } from 'react';
import type { Route, Car, TagDef } from '../firebase/data';
import type { HighwayGeom } from '../data/highways';

// 走行ダッシュボード:
//  1) 高速道路走破率（メジャー路線・OSMサンプル点×走行軌跡の近接判定）
//  2) カレンダー草（日別走行距離ヒートマップ・GitHub風）
//  3) 時間帯分布（何時に走っているか）
//  4) 車種別統計（距離・回数・時間帯プロファイル。色は車のタグ色=エンティティ固定色）

interface Props {
  open: boolean;
  onClose: () => void;
  routes: Route[];
  cars: Car[];
  tags: TagDef[];
}

// ---- 走破率: 走行軌跡を約250mグリッドに落とし、路線サンプル点の近傍ヒットで判定 ----
const GRID = 0.0025; // ≈250m
const gridKey = (lat: number, lng: number) =>
  (Math.round(lat / GRID) + 400000) * 3000000 + (Math.round(lng / GRID) + 800000);

function buildDrivenGrid(routes: Route[]): Set<number> {
  const s = new Set<number>();
  for (const r of routes) {
    if (r.mode && r.mode !== 'car') continue; // 高速走破は車の記録のみ対象
    for (const p of r.points) s.add(gridKey(p.lat, p.lng));
  }
  return s;
}

function coverageOf(hw: HighwayGeom, driven: Set<number>): number {
  if (hw.samples.length === 0) return 0;
  let hit = 0;
  for (const [lng, lat] of hw.samples) {
    const ci = Math.round(lat / GRID) + 400000;
    const cj = Math.round(lng / GRID) + 800000;
    let found = false;
    for (let di = -1; di <= 1 && !found; di++) {
      for (let dj = -1; dj <= 1 && !found; dj++) {
        if (driven.has((ci + di) * 3000000 + (cj + dj))) found = true;
      }
    }
    if (found) hit++;
  }
  return hit / hw.samples.length;
}

// ---- 集計ユーティリティ ----
function routeMatchesCarTag(routeTags: string[], allTags: TagDef[], carTagId?: string): boolean {
  if (!carTagId) return false;
  const carTagName = allTags.find(t => t.id === carTagId)?.name;
  return routeTags.some(id => {
    if (id === carTagId) return true;
    if (!carTagName) return false;
    return allTags.find(t => t.id === id)?.name === carTagName;
  });
}

// ルートの走行時間を1時間バケツに配分（開始〜終了の区間を時刻の壁で分割）
function addHourHistogram(hist: number[], startMs: number, endMs: number) {
  if (endMs <= startMs) return;
  let t = startMs;
  const LIMIT = 48 * 3600_000; // 異常データ保険
  if (endMs - startMs > LIMIT) return;
  while (t < endMs) {
    const d = new Date(t);
    const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const chunkEnd = Math.min(hourEnd, endMs);
    hist[d.getHours()] += (chunkEnd - t) / 3600_000;
    t = chunkEnd;
  }
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function StatsPanel({ open, onClose, routes, cars, tags }: Props) {
  const [highways, setHighways] = useState<HighwayGeom[] | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());

  // 路線データは重い(数百KB)ので初回オープン時に遅延ロード
  useEffect(() => {
    if (!open || highways) return;
    import('../data/highways').then(m => setHighways(m.HIGHWAYS)).catch(() => setHighways([]));
  }, [open, highways]);

  const drivenGrid = useMemo(() => (open ? buildDrivenGrid(routes) : new Set<number>()), [open, routes]);

  const coverage = useMemo(() => {
    if (!open || !highways) return [];
    return highways
      .map(hw => ({ ...hw, pct: coverageOf(hw, drivenGrid) }))
      .sort((a, b) => b.pct - a.pct);
  }, [open, highways, drivenGrid]);

  // カレンダー草: 日別距離
  const daily = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of routes) {
      const k = dayKey(r.startTime);
      m.set(k, (m.get(k) ?? 0) + r.totalDistance);
    }
    return m;
  }, [routes]);

  const years = useMemo(
    () => Array.from(new Set(routes.map(r => new Date(r.startTime).getFullYear()))).sort((a, b) => b - a),
    [routes]
  );

  // 時間帯分布（全体）
  const hourHist = useMemo(() => {
    const h = new Array(24).fill(0);
    for (const r of routes) addHourHistogram(h, r.startTime, r.endTime);
    return h as number[];
  }, [routes]);

  // 車種別（タグ色をエンティティ色として使用）
  const carStats = useMemo(() => {
    return cars
      .filter(c => c.tagId)
      .map(c => {
        const cr = routes.filter(r => routeMatchesCarTag(r.tags, tags, c.tagId));
        const km = cr.reduce((s, r) => s + r.totalDistance, 0);
        const hours = new Array(24).fill(0) as number[];
        for (const r of cr) addHourHistogram(hours, r.startTime, r.endTime);
        return {
          car: c,
          color: tags.find(t => t.id === c.tagId)?.color ?? '#2563eb',
          km, count: cr.length, hours,
          maxSpeed: cr.reduce((m, r) => Math.max(m, r.maxSpeed), 0),
        };
      })
      .filter(s => s.count > 0)
      .sort((a, b) => b.km - a.km);
  }, [cars, tags, routes]);

  if (!open) return null;

  // ---- カレンダー草の描画データ（year の 1/1 を含む週の日曜〜12/31）----
  const calStart = new Date(year, 0, 1);
  calStart.setDate(calStart.getDate() - calStart.getDay());
  const weeks: { key: string; km: number; inYear: boolean }[][] = [];
  const cursor = new Date(calStart);
  while (cursor.getFullYear() <= year) {
    const col: { key: string; km: number; inYear: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const k = dayKey(cursor.getTime());
      col.push({ key: k, km: daily.get(k) ?? 0, inYear: cursor.getFullYear() === year });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(col);
    if (cursor.getFullYear() > year) break;
  }
  const maxDayKm = Math.max(1, ...weeks.flat().filter(c => c.inYear).map(c => c.km));
  // 単一色相ブルーの4段階（0は極薄グレー）
  const cellColor = (km: number) =>
    km <= 0 ? '#f3f4f6'
      : km < maxDayKm * 0.15 ? '#bfdbfe'
      : km < maxDayKm * 0.4 ? '#60a5fa'
      : km < maxDayKm * 0.75 ? '#2563eb'
      : '#1e3a8a';

  const maxHour = Math.max(1, ...hourHist);
  const yearKm = weeks.flat().filter(c => c.inYear).reduce((s, c) => s + c.km, 0);
  const covered = coverage.filter(c => c.pct > 0.005);
  const uncovered = coverage.filter(c => c.pct <= 0.005);
  const pointsLoading = routes.some(r => (!r.points || r.points.length === 0) && (r.pointCount ?? 0) > 0);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.3)' }} onClick={onClose}>
      <div
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 24, width: 680, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700 }}>📊 走行ダッシュボード</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {/* ---- 高速道路走破率 ---- */}
        <section style={{ marginBottom: 24 }}>
          <p style={s.sectionTitle}>🛣️ 高速道路走破率</p>
          {pointsLoading && <p style={{ color: '#d97706', fontSize: 12, marginBottom: 8 }}>⏳ 点データ読み込み中のため走破率が低めに出ることがあります</p>}
          {!highways ? (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>路線データを読み込み中...</p>
          ) : highways.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>路線データが未生成です（node tools/gen-highways.mjs）</p>
          ) : (
            <>
              {covered.map(hw => (
                <div key={hw.name} style={{ marginBottom: 8 }} title={`${hw.name}: 全長約${hw.lenKm}kmのうち約${Math.round(hw.lenKm * hw.pct)}kmを走行`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: '#1f2937', fontWeight: 600 }}>{hw.name}</span>
                    <span style={{ color: '#6b7280' }}>{Math.round(hw.pct * 100)}%（約{Math.round(hw.lenKm * hw.pct)} / {hw.lenKm}km）</span>
                  </div>
                  <div style={{ height: 10, background: '#f3f4f6', borderRadius: 5, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(1.5, hw.pct * 100)}%`, height: '100%', background: hw.pct >= 0.995 ? '#16a34a' : '#2563eb', borderRadius: 5 }} />
                  </div>
                </div>
              ))}
              {covered.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>まだ走行した路線がありません</p>}
              {uncovered.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>未走行 {uncovered.length}路線</summary>
                  <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 6, lineHeight: 1.8 }}>
                    {uncovered.map(h => h.name).join('・')}
                  </p>
                </details>
              )}
            </>
          )}
        </section>

        {/* ---- カレンダー草 ---- */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <p style={{ ...s.sectionTitle, marginBottom: 0 }}>📅 日別走行（{year}年: {Math.round(yearKm).toLocaleString()}km）</p>
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer' }}>
              {years.map(y => <option key={y} value={y}>{y}年</option>)}
            </select>
          </div>
          <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ display: 'flex', gap: 2 }}>
              {weeks.map((col, wi) => (
                <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {col.map(c => (
                    <div
                      key={c.key}
                      title={c.inYear ? `${c.key}: ${c.km > 0 ? c.km.toFixed(1) + 'km' : '走行なし'}` : ''}
                      style={{ width: 10, height: 10, borderRadius: 2, background: c.inYear ? cellColor(c.km) : 'transparent' }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 11, color: '#9ca3af' }}>
            少 {['#f3f4f6', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'].map(c => (
              <span key={c} style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
            ))} 多
          </div>
        </section>

        {/* ---- 時間帯分布 ---- */}
        <section style={{ marginBottom: 24 }}>
          <p style={s.sectionTitle}>🕐 走行時間帯（全期間・合計{Math.round(hourHist.reduce((a, b) => a + b, 0))}時間）</p>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 64 }}>
            {hourHist.map((v, h) => (
              <div key={h} title={`${h}時台: ${v.toFixed(1)}時間`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                <div style={{ height: `${Math.max(v > 0 ? 4 : 1, (v / maxHour) * 100)}%`, background: h >= 6 && h < 18 ? '#f59e0b' : '#2563eb', borderRadius: '3px 3px 0 0' }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            <span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>23時</span>
          </div>
          <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>🟠 昼（6-18時） / 🔵 夜</p>
        </section>

        {/* ---- 車種別 ---- */}
        {carStats.length > 0 && (
          <section>
            <p style={s.sectionTitle}>🚗 車種別</p>
            {carStats.map(cs => {
              const maxKm = carStats[0].km || 1;
              const carMaxHour = Math.max(1, ...cs.hours);
              return (
                <div key={cs.car.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: cs.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', flex: 1 }}>{cs.car.nickname}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>
                      {Math.round(cs.km).toLocaleString()}km ・ {cs.count}回 ・ 最高{Math.round(cs.maxSpeed)}km/h
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ flex: 2, height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}
                      title={`走行距離 ${Math.round(cs.km).toLocaleString()}km`}>
                      <div style={{ width: `${(cs.km / maxKm) * 100}%`, height: '100%', background: cs.color, borderRadius: 4 }} />
                    </div>
                    {/* 時間帯ミニヒストグラム */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, height: 22 }}
                      title={`${cs.car.nickname} の走行時間帯（0〜23時）`}>
                      {cs.hours.map((v, h) => (
                        <div key={h} style={{ flex: 1, height: `${Math.max(v > 0 ? 12 : 4, (v / carMaxHour) * 100)}%`, background: cs.color, opacity: v > 0 ? 0.9 : 0.15, borderRadius: 1 }} />
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  sectionTitle: { color: '#9ca3af', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 10 },
};
