import type { Route } from '../firebase/data';

interface Props {
  open: boolean;
  onClose: () => void;
  routes: Route[];
}

interface PeriodStats {
  km: number;
  calories: number;
  steps?: number;
}

interface ActivityStats {
  today: PeriodStats;
  month: PeriodStats;
  year: PeriodStats;
  total: PeriodStats;
}

function calcStats(routes: Route[], mode: 'walk' | 'bicycle', kcalPerKm: number): ActivityStats {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const yearStart  = new Date(now.getFullYear(), 0, 1).getTime();
  const filtered = routes.filter(r => r.mode === mode);
  const make = (arr: Route[]): PeriodStats => {
    const km = arr.reduce((s, r) => s + r.totalDistance, 0);
    return {
      km,
      calories: Math.round(km * kcalPerKm),
      steps: mode === 'walk' ? Math.round(km * 1300) : undefined,
    };
  };
  return {
    today: make(filtered.filter(r => r.startTime >= todayStart)),
    month: make(filtered.filter(r => r.startTime >= monthStart)),
    year:  make(filtered.filter(r => r.startTime >= yearStart)),
    total: make(filtered),
  };
}

const PERIODS: { key: keyof ActivityStats; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'month', label: '今月' },
  { key: 'year',  label: '今年' },
  { key: 'total', label: '累計' },
];

function StatSection({
  icon, title, color, stats, showSteps,
}: {
  icon: string; title: string; color: string;
  stats: ActivityStats; showSteps: boolean;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{title}</span>
        <span style={{ fontSize: 11, background: color + '22', color, borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
          {stats.total.km.toFixed(1)} km 累計
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {PERIODS.map(({ key, label }) => {
          const p = stats[key];
          return (
            <div key={key} style={{ background: '#fff', borderRadius: 10, padding: '12px 10px', border: '1px solid #e8eaed', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color, marginBottom: 2 }}>{p.km.toFixed(1)}</div>
              <div style={{ fontSize: 10, color: '#9ca3af' }}>km</div>
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#6b7280' }}>{p.calories.toLocaleString()}</div>
                <div style={{ fontSize: 10, color: '#9ca3af' }}>kcal</div>
              </div>
              {showSteps && p.steps != null && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#6b7280' }}>{p.steps.toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>歩</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 詳細テーブル */}
      <div style={{ marginTop: 12, background: '#fff', borderRadius: 10, border: '1px solid #e8eaed', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f8f9fa' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#9ca3af', fontWeight: 600 }}>期間</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af', fontWeight: 600 }}>距離</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af', fontWeight: 600 }}>消費</th>
              {showSteps && <th style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af', fontWeight: 600 }}>歩数</th>}
            </tr>
          </thead>
          <tbody>
            {PERIODS.map(({ key, label }, i) => {
              const p = stats[key];
              return (
                <tr key={key} style={{ borderTop: i === 0 ? 'none' : '1px solid #f3f4f6' }}>
                  <td style={{ padding: '9px 12px', color: '#374151', fontWeight: 600 }}>{label}</td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', color, fontWeight: 700 }}>{p.km.toFixed(2)} km</td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', color: '#6b7280' }}>{p.calories.toLocaleString()} kcal</td>
                  {showSteps && <td style={{ padding: '9px 10px', textAlign: 'right', color: '#6b7280' }}>{(p.steps ?? 0).toLocaleString()} 歩</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ActivityPanel({ open, onClose, routes }: Props) {
  if (!open) return null;

  const walkStats    = calcStats(routes, 'walk',    60);
  const cycleStats   = calcStats(routes, 'bicycle', 40);

  const walkCount    = routes.filter(r => r.mode === 'walk').length;
  const cycleCount   = routes.filter(r => r.mode === 'bicycle').length;

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <div style={s.panel}>
        <div style={s.header}>
          <span style={s.title}>🏃 活動統計</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '10px 20px', background: '#f8f9fa', borderBottom: '1px solid #e8eaed', display: 'flex', gap: 16 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>🚶 徒歩記録: <strong style={{ color: '#22c55e' }}>{walkCount}件</strong></span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>🚲 自転車記録: <strong style={{ color: '#3b82f6' }}>{cycleCount}件</strong></span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px' }}>
          <StatSection
            icon="🚶"
            title="徒歩"
            color="#22c55e"
            stats={walkStats}
            showSteps={true}
          />
          <StatSection
            icon="🚲"
            title="自転車"
            color="#3b82f6"
            stats={cycleStats}
            showSteps={false}
          />

          <div style={{ marginTop: 8, padding: '12px 14px', background: '#f8f9fa', borderRadius: 10, border: '1px solid #e8eaed' }}>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, lineHeight: 1.7 }}>
              ※ スマホアプリの記録タブで「徒歩」「自転車」モードを選んで記録すると集計されます。<br />
              ※ カロリー: 徒歩 60 kcal/km、自転車 40 kcal/km（推定値）<br />
              ※ 歩数: 1.3km/1000歩（推定値）
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 2000 },
  panel:    { position: 'fixed', top: 0, right: 0, width: 460, height: '100vh', background: '#fff', zIndex: 2001, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', overflowY: 'hidden', borderLeft: '1px solid #e8eaed' },
  header:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 20px', borderBottom: '1px solid #e8eaed', flexShrink: 0 },
  title:    { color: '#1f2937', fontSize: 17, fontWeight: 700 },
  closeBtn: { background: 'none', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer' },
};
