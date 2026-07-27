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
  const complete = coverage.filter(c => c.pct >= 0.995);           // 完全走破 → バッジ表示
  const partial = coverage.filter(c => c.pct > 0.005 && c.pct < 0.995); // 走行中 → バー表示
  const uncovered = coverage.filter(c => c.pct <= 0.005);
  const pointsLoading = routes.some(r => (!r.points || r.points.length === 0) && (r.pointCount ?? 0) > 0);

  // サマリータイル用
  const totalKm = routes.reduce((s2, r) => s2 + r.totalDistance, 0);
  const totalHours = hourHist.reduce((a, b) => a + b, 0);

  return (
    <>
      <div style={s.overlay} onClick={e => { if (e.clientX < 360) onClose(); }} />
      <div style={s.panel}>
        <div style={s.header}>
          <h3 style={{ color: '#1f2937', fontSize: 17, fontWeight: 700 }}>📊 走行ダッシュボード</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={s.body}>
          <div style={{ maxWidth: 1040, margin: '0 auto' }}>

            {/* サマリータイル */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
              <div style={s.tile}>
                <div style={s.tileValue}>{Math.round(totalKm).toLocaleString()}<span style={s.tileUnit}> km</span></div>
                <div style={s.tileLabel}>総走行距離</div>
              </div>
              <div style={s.tile}>
                <div style={s.tileValue}>{routes.length.toLocaleString()}<span style={s.tileUnit}> 回</span></div>
                <div style={s.tileLabel}>記録数</div>
              </div>
              <div style={s.tile}>
                <div style={s.tileValue}>{Math.round(totalHours).toLocaleString()}<span style={s.tileUnit}> 時間</span></div>
                <div style={s.tileLabel}>総走行時間</div>
              </div>
              <div style={s.tile}>
                <div style={s.tileValue}>{complete.length}<span style={s.tileUnit}> / {coverage.length}路線</span></div>
                <div style={s.tileLabel}>高速 完全走破</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) minmax(400px, 1.1fr)', gap: 16, alignItems: 'start' }}>

              {/* 左: 高速道路走破率 */}
              <div style={s.card}>
                <p style={s.sectionTitle}>🛣️ 高速道路走破率</p>
                {pointsLoading && <p style={{ color: '#d97706', fontSize: 12, marginBottom: 8 }}>⏳ 点データ読み込み中のため低めに出ることがあります</p>}
                {!highways ? (
                  <p style={{ color: '#9ca3af', fontSize: 13 }}>路線データを読み込み中...</p>
                ) : highways.length === 0 ? (
                  <p style={{ color: '#9ca3af', fontSize: 13 }}>路線データが未生成です（node tools/gen-highways.mjs）</p>
                ) : (
                  <>
                    {/* 完全走破はバッジで畳む（同じ100%バーを並べない） */}
                    {complete.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: partial.length > 0 ? 14 : 0 }}>
                        {complete.map(hw => (
                          <span key={hw.name} title={`${hw.name} 全線走破（約${hw.lenKm}km）`}
                            style={{ fontSize: 11.5, fontWeight: 600, color: '#15803d', background: '#dcfce7', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
                            ✓ {hw.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {partial.map(hw => (
                        <div key={hw.name} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                          title={`${hw.name}: 全長約${hw.lenKm}kmのうち約${Math.round(hw.lenKm * hw.pct)}kmを走行`}>
                          <span style={{ fontSize: 12, color: '#1f2937', fontWeight: 600, width: 128, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{hw.name}</span>
                          <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(1.5, hw.pct * 100)}%`, height: '100%', background: '#2563eb', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: '#9ca3af', width: 96, textAlign: 'right', flexShrink: 0 }}>
                            <span style={{ color: '#2563eb', fontWeight: 700, fontSize: 12 }}>{Math.round(hw.pct * 100)}%</span>
                            {' '}{Math.round(hw.lenKm * hw.pct)}/{hw.lenKm}km
                          </span>
                        </div>
                      ))}
                    </div>
                    {complete.length === 0 && partial.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>まだ走行した路線がありません</p>}
                    {uncovered.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12 }}>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>未走行</span>
                        {uncovered.map(hw => (
                          <span key={hw.name} title={`${hw.name}（約${hw.lenKm}km）`}
                            style={{ fontSize: 11.5, color: '#9ca3af', background: '#f3f4f6', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
                            {hw.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 右: カレンダー草・時間帯・車種別 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                <div style={s.card}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <p style={{ ...s.sectionTitle, marginBottom: 0 }}>📅 日別走行 — {year}年 {Math.round(yearKm).toLocaleString()}km</p>
                    <select value={year} onChange={e => setYear(Number(e.target.value))}
                      style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '3px 8px', fontSize: 12, cursor: 'pointer', color: '#374151' }}>
                      {years.map(y => <option key={y} value={y}>{y}年</option>)}
                    </select>
                  </div>
                  {/* 上半期/下半期の2段組み（横スクロールを出さずセルも大きく） */}
                  {[weeks.slice(0, Math.ceil(weeks.length / 2)), weeks.slice(Math.ceil(weeks.length / 2))].map((half, hi) => (
                    <div key={hi} style={{ marginBottom: hi === 0 ? 10 : 0 }}>
                      <div style={{ fontSize: 10, color: '#c4c9d1', fontWeight: 600, marginBottom: 3 }}>{hi === 0 ? '1月〜6月' : '7月〜12月'}</div>
                      <div style={{ display: 'flex', gap: 3 }}>
                        {half.map((col, wi) => (
                          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {col.map(c => (
                              <div
                                key={c.key}
                                title={c.inYear ? `${c.key}: ${c.km > 0 ? c.km.toFixed(1) + 'km' : '走行なし'}` : ''}
                                style={{ width: 12, height: 12, borderRadius: 3, background: c.inYear ? cellColor(c.km) : 'transparent' }}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
                    少 {['#f3f4f6', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'].map(c => (
                      <span key={c} style={{ width: 9, height: 9, borderRadius: 2, background: c, display: 'inline-block' }} />
                    ))} 多
                  </div>
                </div>

                <div style={s.card}>
                  <p style={s.sectionTitle}>🕐 走行時間帯 — 合計{Math.round(totalHours).toLocaleString()}時間</p>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 52 }}>
                    {hourHist.map((v, h) => (
                      <div key={h} title={`${h}時台: ${v.toFixed(1)}時間`}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                        <div style={{ height: `${Math.max(v > 0 ? 5 : 2, (v / maxHour) * 100)}%`, background: h >= 6 && h < 18 ? '#60a5fa' : '#1e3a8a', borderRadius: 2 }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
                    <span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>23時</span>
                  </div>
                  <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#60a5fa', marginRight: 4 }} />昼（6-18時）
                    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#1e3a8a', margin: '0 4px 0 12px' }} />夜
                  </p>
                </div>

                {carStats.length > 0 && (
                  <div style={s.card}>
                    <p style={s.sectionTitle}>🚗 車種別</p>
                    {carStats.map((cs, i) => {
                      const maxKm = carStats[0].km || 1;
                      const carMaxHour = Math.max(1, ...cs.hours);
                      return (
                        <div key={cs.car.id} style={{ marginBottom: i < carStats.length - 1 ? 16 : 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', background: cs.color, flexShrink: 0 }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', flex: 1 }}>{cs.car.nickname}</span>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                              {Math.round(cs.km).toLocaleString()}km ・ {cs.count}回 ・ 最高{Math.round(cs.maxSpeed)}km/h
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <div style={{ flex: 2, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}
                              title={`走行距離 ${Math.round(cs.km).toLocaleString()}km`}>
                              <div style={{ width: `${(cs.km / maxKm) * 100}%`, height: '100%', background: cs.color, borderRadius: 3 }} />
                            </div>
                            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 20 }}
                              title={`${cs.car.nickname} の走行時間帯（0〜23時）`}>
                              {cs.hours.map((v, h) => (
                                <div key={h} style={{ flex: 1, height: `${Math.max(v > 0 ? 12 : 4, (v / carMaxHour) * 100)}%`, background: cs.color, opacity: v > 0 ? 0.85 : 0.15, borderRadius: 1 }} />
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000 },
  panel: { position: 'fixed', top: 0, left: 360, right: 0, height: '100vh', background: '#f4f6f9', zIndex: 2001, display: 'flex', flexDirection: 'column', boxShadow: '0 4px 32px rgba(0,0,0,0.18)', borderLeft: '1px solid #e8eaed' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e8eaed', flexShrink: 0, background: '#fff' },
  body: { flex: 1, overflowY: 'auto', padding: 20 },
  card: { background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid #e8eaed' },
  tile: { background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #e8eaed' },
  tileValue: { color: '#1f2937', fontSize: 24, fontWeight: 800, lineHeight: 1.2 },
  tileUnit: { fontSize: 13, fontWeight: 600, color: '#6b7280' },
  tileLabel: { color: '#9ca3af', fontSize: 11, fontWeight: 600, marginTop: 2 },
  sectionTitle: { color: '#9ca3af', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 10 },
};
