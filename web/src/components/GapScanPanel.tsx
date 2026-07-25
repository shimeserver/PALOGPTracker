import { useMemo, useState } from 'react';
import type { Route } from '../firebase/data';
import { updateRoutePoints, updateRouteGapsOk } from '../firebase/data';
import { routeGapStats, bridgeGaps, removeGeoWarps, recalcSpeeds } from '../utils/gapBridge';
import type { GapStats } from '../utils/gapBridge';

// 全ルートを走査して「飛び（ギャップ）が残っているルート」を一覧化し、
// 個別/一括の自動修復・「直線でOK」マークができる点検パネル。
// スキャンは手元の点列の幾何計算のみ（ネットワーク不使用）。修復時のみOSRM/Overpassを呼ぶ。

interface Props {
  open: boolean;
  onClose: () => void;
  routes: Route[];
  onSelectRoute: (route: Route) => void;
  onUpdateRoute: (route: Route) => void;
}

interface ScanRow { route: Route; stats: GapStats; }

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function GapScanPanel({ open, onClose, routes, onSelectRoute, onUpdateRoute }: Props) {
  const [showOkRoutes, setShowOkRoutes] = useState(false);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState('');
  const [lastResult, setLastResult] = useState<Record<string, string>>({});

  // points 未ロード（チャンク補充中）のルート数
  const loadingCount = useMemo(
    () => routes.filter(r => (!r.points || r.points.length === 0)).length,
    [routes]
  );

  const rows: ScanRow[] = useMemo(() => {
    if (!open) return [];
    return routes
      .filter(r => r.points && r.points.length >= 2)
      .map(r => ({ route: r, stats: routeGapStats(r.points) }))
      .filter(x => x.stats.count > 0)
      .sort((a, b) => b.stats.maxKm - a.stats.maxKm);
  }, [open, routes]);

  const visibleRows = rows.filter(x => showOkRoutes || !x.route.gapsOk);
  const okCount = rows.length - rows.filter(x => !x.route.gapsOk).length;
  const repairTargets = rows.filter(x => !x.route.gapsOk);

  // 1ルートの自動修復: ワープ除去 → ギャップ補間 → 速度再計算 → 保存
  const repairRoute = async (route: Route, statusPrefix = ''): Promise<string> => {
    const cleaned = removeGeoWarps(route.points);
    const r = await bridgeGaps(cleaned.points, route.mode, {
      onProgress: (done, total) => setBatchStatus(`${statusPrefix}「${route.name || '（無名）'}」ギャップ ${done}/${total} 処理中...`),
    });
    if (r.bridged === 0 && cleaned.removed === 0) {
      const seaCount = r.unresolved.filter(g => g.reason === 'sea').length;
      return seaCount === r.unresolved.length && seaCount > 0
        ? '残りはすべて海上・航路（直線が正解）'
        : '自動修復できる箇所なし（✂️区間修正で手動対応可）';
    }
    const fixed = recalcSpeeds(r.points);
    await updateRoutePoints(route.id!, fixed);
    // ローカル状態も更新（stats は updateRoutePoints と同じ計算）
    let totalDist = 0;
    for (let i = 1; i < fixed.length; i++) {
      const R = 6371, a = fixed[i - 1], b = fixed[i];
      const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      totalDist += R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }
    const speeds = fixed.map(p => p.speed).filter(s => s > 0 && s <= 300);
    onUpdateRoute({
      ...route, points: fixed, totalDistance: totalDist,
      avgSpeed: speeds.length ? speeds.reduce((s, v) => s + v) / speeds.length : 0,
      maxSpeed: speeds.reduce((m, s) => s > m ? s : m, 0),
    });
    const parts: string[] = [];
    if (cleaned.removed > 0) parts.push(`飛び${cleaned.removed}点除去`);
    if (r.bridged > 0) parts.push(`${r.bridged}か所補間`);
    if (r.sea > 0) parts.push(`海上${r.sea}か所は直線のまま`);
    if (r.rejectedDetour > 0) parts.push(`遠回り不採用${r.rejectedDetour}`);
    if (r.failed > 0) parts.push(`失敗${r.failed}`);
    return parts.join(' / ');
  };

  const handleRepairOne = async (route: Route) => {
    if (repairingId || batchRunning) return;
    setRepairingId(route.id!);
    setBatchStatus('');
    try {
      const msg = await repairRoute(route);
      setLastResult(prev => ({ ...prev, [route.id!]: msg }));
    } catch (e) {
      setLastResult(prev => ({ ...prev, [route.id!]: `エラー: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setRepairingId(null);
      setBatchStatus('');
    }
  };

  const handleRepairAll = async () => {
    if (repairingId || batchRunning || repairTargets.length === 0) return;
    if (!confirm(`${repairTargets.length}件のルートを順番に自動修復します。\n（1件ごとに保存されます。時間がかかる場合があります）`)) return;
    setBatchRunning(true);
    try {
      for (let i = 0; i < repairTargets.length; i++) {
        const { route } = repairTargets[i];
        const prefix = `[${i + 1}/${repairTargets.length}] `;
        setBatchStatus(`${prefix}「${route.name || '（無名）'}」修復中...`);
        try {
          const msg = await repairRoute(route, prefix);
          setLastResult(prev => ({ ...prev, [route.id!]: msg }));
        } catch (e) {
          setLastResult(prev => ({ ...prev, [route.id!]: `エラー: ${e instanceof Error ? e.message : String(e)}` }));
        }
      }
      setBatchStatus('一括修復が完了しました');
    } finally {
      setBatchRunning(false);
    }
  };

  const handleToggleOk = async (route: Route) => {
    const next = !route.gapsOk;
    await updateRouteGapsOk(route.id!, next);
    onUpdateRoute({ ...route, gapsOk: next });
  };

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.3)' }} onClick={onClose}>
      <div
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 24, width: 560, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700 }}>🩹 ギャップ点検 — 飛びが残っているルート</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {loadingCount > 0 && (
          <p style={{ color: '#d97706', fontSize: 12, marginBottom: 8 }}>
            ⏳ {loadingCount}件のルートの点データを読み込み中です。しばらくすると一覧が増えることがあります。
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            onClick={handleRepairAll}
            disabled={batchRunning || repairingId != null || repairTargets.length === 0}
            style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, background: repairTargets.length > 0 ? '#2563eb' : '#e5e7eb', color: repairTargets.length > 0 ? '#fff' : '#9ca3af', border: 'none', borderRadius: 8, cursor: repairTargets.length > 0 ? 'pointer' : 'default' }}
          >
            {batchRunning ? '修復中...' : `⚡ 一括自動修復（${repairTargets.length}件）`}
          </button>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={showOkRoutes} onChange={e => setShowOkRoutes(e.target.checked)} />
            「直線でOK」済みも表示（{okCount}件）
          </label>
        </div>

        {batchStatus && <p style={{ color: '#2563eb', fontSize: 12, marginBottom: 8 }}>{batchStatus}</p>}

        <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #f3f4f6' }}>
          {visibleRows.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
              {rows.length === 0 ? '🎉 ギャップが残っているルートはありません' : 'すべて「直線でOK」にマーク済みです'}
            </p>
          ) : visibleRows.map(({ route, stats }) => (
            <div key={route.id} style={{ padding: '10px 4px', borderBottom: '1px solid #f3f4f6', opacity: route.gapsOk ? 0.55 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {route.gapsOk && <span title="直線でOKとしてマーク済み">✓ </span>}
                    {route.name || '（無名）'}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    {formatDate(route.startTime)} ・ ギャップ{stats.count}か所 ・ 最大{stats.maxKm.toFixed(1)}km ・ 計{stats.totalKm.toFixed(1)}km
                  </div>
                  {lastResult[route.id!] && (
                    <div style={{ fontSize: 11, color: '#16a34a', marginTop: 2 }}>{lastResult[route.id!]}</div>
                  )}
                </div>
                <button
                  onClick={() => handleRepairOne(route)}
                  disabled={batchRunning || repairingId != null || !!route.gapsOk}
                  title="ワープ除去＋道なり補間して保存"
                  style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: route.gapsOk ? 0.4 : 1 }}
                >
                  {repairingId === route.id ? '修復中...' : '🔧 修復'}
                </button>
                <button
                  onClick={() => { onSelectRoute(route); onClose(); }}
                  title="地図で開く"
                  style={{ padding: '5px 10px', fontSize: 12, background: '#f3f4f6', color: '#374151', border: '1.5px solid #e8eaed', borderRadius: 6, cursor: 'pointer' }}
                >
                  🗺 開く
                </button>
                <button
                  onClick={() => handleToggleOk(route)}
                  title={route.gapsOk ? '「直線でOK」を解除' : 'フェリー等の意図的な直線として点検対象から外す'}
                  style={{ padding: '5px 10px', fontSize: 12, background: route.gapsOk ? '#eff6ff' : '#f3f4f6', color: route.gapsOk ? '#2563eb' : '#374151', border: '1.5px solid #e8eaed', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  {route.gapsOk ? '↩ 解除' : '✓ 直線でOK'}
                </button>
              </div>
            </div>
          ))}
        </div>

        <p style={{ color: '#9ca3af', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          0.3km以上離れた連続点を「ギャップ」として検出します。海上・フェリー航路は自動判定で直線のまま残ります（正常）。
          修復しても残る箇所は「🗺 開く」→「🛣️ 記録クリーンアップ」で⚠位置を確認し、「✂️ 区間修正」で手動修復できます。
        </p>
      </div>
    </div>
  );
}
