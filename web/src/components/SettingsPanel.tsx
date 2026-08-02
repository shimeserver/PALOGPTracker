import { useRef, useState } from 'react';
import type { TileKey, ColorMode } from './RouteMapView';
import { deleteAllUserRoutes, deleteAllUserLandmarks, getUserLandmarks, getVisits, deleteVisit, updateLandmark, uploadLandmarkPhotoFromUrl, migrateRoutesToChunks, deleteRoute } from '../firebase/data';
import { resetDensityCache } from './DensityOverlay';
import { importRouteHistoryCsv, extractSpotsFromTimeline, saveDetectedSpots } from '../utils/csvImport';
import { exportRoutesGpx, exportRoutesCsv, downloadBlob, exportFilename } from '../utils/exportRoutes';
import type { Route } from '../firebase/data';

export interface MapSettings {
  tileKey: TileKey;
  colorMode: ColorMode;
  lineWidth: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  settings: MapSettings;
  onSettings: (s: MapSettings) => void;
  userId: string;
  routeCount: number;
  landmarkCount: number;
  onDeleteAllRoutes: () => void;
  onDeleteAllLandmarks: () => void;
  onImportDone: () => void;
  getPlacesService: () => google.maps.places.PlacesService | null;
  routes: Route[];
}

const TILE_OPTIONS: { key: TileKey; label: string; desc: string; preview: string }[] = [
  { key: 'roadmap', label: '通常地図',   desc: 'Google Maps 標準・日本語対応', preview: '🗺️' },
  { key: 'hybrid',  label: '衛星+ラベル', desc: '衛星写真＋日本語地名表示',    preview: '🛰️' },
  { key: 'terrain', label: '地形図',     desc: '標高・地形がわかる地図',       preview: '⛰️' },
];

export default function SettingsPanel({ open, onClose, settings, onSettings, userId, routeCount, landmarkCount, onDeleteAllRoutes, onDeleteAllLandmarks, onImportDone, getPlacesService, routes }: Props) {
  const [dedupProgress, setDedupProgress] = useState('');
  const [deduping, setDeduping]           = useState(false);
  const [importing, setImporting]         = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [restoring, setRestoring]         = useState(false);
  const [restoreProgress, setRestoreProgress] = useState('');
  const [migrating, setMigrating]         = useState(false);
  const [migrateProgress, setMigrateProgress] = useState('');
  const [exporting, setExporting]         = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const csvInputRef  = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const set = (patch: Partial<MapSettings>) => onSettings({ ...settings, ...patch });

  // 二重保存されたルートの検出・削除。
  // 「開始時刻が2分以内 かつ 距離がほぼ同じ」ペアを重複とみなし、点数の少ない方を消す
  // （電波不安定時の保存リトライで同一記録が2件できるケースの掃除用）
  const handleDedupeRoutes = async () => {
    const sorted = [...routes].sort((a, b) => a.startTime - b.startTime);
    const dupes: { keep: Route; drop: Route }[] = [];
    const dropped = new Set<string>();
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      if (dropped.has(a.id!)) continue;
      for (let j = i + 1; j < sorted.length && sorted[j].startTime - a.startTime < 120_000; j++) {
        const b = sorted[j];
        if (dropped.has(b.id!)) continue;
        const distOk = Math.min(a.totalDistance, b.totalDistance) / Math.max(a.totalDistance, b.totalDistance, 0.001) > 0.9;
        if (!distOk) continue;
        const aPts = a.pointCount ?? a.points.length;
        const bPts = b.pointCount ?? b.points.length;
        const [keep, drop] = aPts >= bPts ? [a, b] : [b, a];
        dupes.push({ keep, drop });
        dropped.add(drop.id!);
      }
    }
    if (dupes.length === 0) { alert('重複ルートは見つかりませんでした。'); return; }
    const list = dupes.map(d => `・「${d.drop.name || '（無名）'}」${new Date(d.drop.startTime).toLocaleString('ja-JP')}（${d.drop.pointCount ?? d.drop.points.length}pt を削除 / ${d.keep.pointCount ?? d.keep.points.length}pt を残す）`).join('\n');
    if (!confirm(`重複とみられるルートが ${dupes.length}件 見つかりました。\n点数の少ない方を削除します:\n\n${list}`)) return;
    for (const d of dupes) await deleteRoute(d.drop.id!);
    alert(`${dupes.length}件を削除しました。`);
    onImportDone(); // 一覧再読込
  };

  const handleExport = (format: 'gpx' | 'csv') => async () => {
    if (exporting) return;
    setExporting(true);
    setExportProgress('点データを読み込み中...');
    try {
      const onProgress = (done: number, total: number) => setExportProgress(`ルート ${done} / ${total} を処理中...`);
      const blob = format === 'gpx'
        ? await exportRoutesGpx(routes, onProgress)
        : await exportRoutesCsv(routes, onProgress);
      downloadBlob(blob, exportFilename(format));
    } catch (e) {
      alert(`エクスポート失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  };

  const handleMigrateChunks = async () => {
    if (!confirm('全ルートのGPS点列を軽量形式（分割保存）に移行します。\nデータは変わらず、読み込みが速くなります。実行しますか？')) return;
    setMigrating(true); setMigrateProgress('');
    try {
      const n = await migrateRoutesToChunks(userId, (done, total) => setMigrateProgress(`${done} / ${total}`));
      alert(n > 0 ? `${n}件のルートを軽量形式に移行しました。` : 'すべてのルートは移行済みです。');
      if (n > 0) onImportDone(); // 一覧を再読込
    } catch (e) {
      alert(`移行に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMigrating(false);
    }
  };

  const handleDeleteAllRoutes = async () => {
    if (!confirm(`全ルート（${routeCount}件）を削除しますか？\nこの操作は取り消せません。`)) return;
    await deleteAllUserRoutes(userId);
    onDeleteAllRoutes();
    onClose();
  };

  const handleDeleteAllLandmarks = async () => {
    if (!confirm(`全スポット（${landmarkCount}件）を削除しますか？\nこの操作は取り消せません。`)) return;
    await deleteAllUserLandmarks(userId);
    onDeleteAllLandmarks();
    onClose();
  };

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setImportProgress('ファイルを読み込み中...');
    try {
      const text = await file.text();
      const { success, failed, clusters } = await importRouteHistoryCsv(
        text, userId,
        (cur, total, phase) => setImportProgress(`${cur} / ${total} 件 ${phase}`)
      );
      let spotMsg = '';
      if (clusters.length > 0) {
        const save = confirm(`インポート完了\n成功: ${success}件　失敗: ${failed}件\n\nスポット候補 ${clusters.length}件 が検出されました。保存しますか？`);
        if (save) {
          const saved = await saveDetectedSpots(clusters, userId, (cur, total) => setImportProgress(`スポット保存中... ${cur} / ${total}`));
          spotMsg = `\nスポット ${saved}件 を保存しました`;
        }
      } else {
        alert(`インポート完了\n成功: ${success}件　失敗: ${failed}件`);
      }
      if (spotMsg) alert(`完了！${spotMsg}`);
      onImportDone();
    } catch (err: any) { alert('エラー: ' + err.message); }
    finally { setImporting(false); setImportProgress(''); e.target.value = ''; }
  };

  const handleJsonImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setImportProgress('JSONを解析中...');
    try {
      const text = await file.text();
      const { clusters, placeSpots } = extractSpotsFromTimeline(text);
      const allSpots = [...placeSpots, ...clusters];
      if (allSpots.length === 0) {
        alert('スポット候補が見つかりませんでした。');
      } else {
        const save = confirm(`スポット候補 ${placeSpots.length}件（Google判定）+ ${clusters.length}件（停車検知）見つかりました。保存しますか？`);
        if (save) {
          const saved = await saveDetectedSpots(allSpots, userId, (cur, total) => setImportProgress(`スポット保存中... ${cur} / ${total}`));
          alert(`完了！スポット ${saved}件 を保存しました`);
          onImportDone();
        }
      }
    } catch (err: any) { alert('エラー: ' + err.message); }
    finally { setImporting(false); setImportProgress(''); e.target.value = ''; }
  };

  const handleRestorePhotos = async () => {
    const service = getPlacesService();
    if (!service) { alert('地図が読み込まれていません。地図画面を開いてから再試行してください。'); return; }
    if (!confirm('期限切れの写真URLを持つスポットをPlaces APIで自動復元します。\nスポット1件あたり約¥37の費用が発生します。続けますか？')) return;
    setRestoring(true);
    const landmarks = await getUserLandmarks(userId);
    // Firebase Storage永続URL以外 = 期限切れ or 未保存 = 復元対象
    // placeIdがないスポットはAPIで復元不可なのでスキップ
    const targets = landmarks.filter(lm =>
      lm.placeId && (
        lm.photos.length === 0 ||
        lm.photos.some(p => !p.url.includes('firebasestorage.googleapis.com'))
      )
    );
    const noPlaceId = landmarks.filter(lm => !lm.placeId && (lm.photos.length === 0 || lm.photos.some(p => !p.url.includes('firebasestorage.googleapis.com'))));
    if (targets.length === 0) {
      const msg = noPlaceId.length > 0
        ? `復元対象のスポットはありません。\n（${noPlaceId.length}件はplaceIDがないため復元不可）`
        : '復元対象のスポットはありません。';
      alert(msg); setRestoring(false); return;
    }
    let fixed = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const lm = targets[i];
      setRestoreProgress(`${i + 1} / ${targets.length} — ${lm.name}`);
      try {
        await new Promise<void>((resolve, reject) => {
          service.getDetails(
            { placeId: lm.placeId!, fields: ['photos'] },
            async (result, status) => {
              if (status !== google.maps.places.PlacesServiceStatus.OK || !result?.photos?.[0]) {
                reject(new Error('no photo')); return;
              }
              const url = result.photos[0].getUrl({ maxWidth: 600 });
              const stored = await uploadLandmarkPhotoFromUrl(userId, lm.id!, url);
              if (stored) {
                await updateLandmark(lm.id!, { photos: [stored] });
                fixed++;
              }
              resolve();
            }
          );
        });
      } catch { failed++; }
    }
    setRestoring(false);
    setRestoreProgress('');
    const noPlaceIdCount = landmarks.filter(lm => !lm.placeId && (lm.photos.length === 0 || lm.photos.some(p => !p.url.includes('firebasestorage.googleapis.com')))).length;
    alert(`完了！\n復元成功: ${fixed}件　失敗: ${failed}件${noPlaceIdCount > 0 ? `\n\n※ ${noPlaceIdCount}件はplaceIDがなく復元不可（手動登録スポット）` : ''}`);
  };

  const handleDeduplicateAllVisits = async () => {
    if (!confirm('全スポットの訪問ログから重複（同日・同メモ）を一括削除します。\n続けますか？')) return;
    setDeduping(true);
    const landmarks = await getUserLandmarks(userId);
    let totalDeleted = 0;
    let affectedSpots = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      setDedupProgress(`${i + 1} / ${landmarks.length} — ${lm.name}`);
      const visits = await getVisits(lm.id!);
      const seen = new Set<string>();
      const toDelete: string[] = [];
      for (const v of visits) {
        const key = `${new Date(v.timestamp).toDateString()}__${v.notes ?? ''}`;
        if (seen.has(key)) toDelete.push(v.id!);
        else seen.add(key);
      }
      if (toDelete.length > 0) {
        for (const id of toDelete) await deleteVisit(lm.id!, id);
        const remaining = await getVisits(lm.id!);
        await updateLandmark(lm.id!, { visitCount: remaining.length });
        totalDeleted += toDelete.length;
        affectedSpots++;
      }
    }
    setDeduping(false);
    setDedupProgress('');
    alert(`完了！\n${affectedSpots}スポット / ${totalDeleted}件の重複ログを削除しました`);
  };

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <div style={s.panel}>
        <div style={s.header}>
          <span style={s.title}>⚙️ 設定</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* 地図タイル */}
        <section style={s.section}>
          <p style={s.sectionTitle}>地図の種類</p>
          <div style={s.tileGrid}>
            {TILE_OPTIONS.map(opt => (
              <button
                key={opt.key}
                style={{ ...s.tileBtn, ...(settings.tileKey === opt.key ? s.tileBtnActive : {}) }}
                onClick={() => set({ tileKey: opt.key })}
              >
                <span style={{ fontSize: 22 }}>{opt.preview}</span>
                <span style={s.tileName}>{opt.label}</span>
                <span style={s.tileDesc}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ルートライン */}
        <section style={s.section}>
          <p style={s.sectionTitle}>ルートラインの色</p>
          <div style={s.row}>
            {(['solid', 'speed'] as ColorMode[]).map(m => (
              <button
                key={m}
                style={{ ...s.toggleBtn, ...(settings.colorMode === m ? s.toggleBtnActive : {}) }}
                onClick={() => set({ colorMode: m })}
              >
                {m === 'solid' ? '単色（シアン）' : '速度カラー'}
              </button>
            ))}
          </div>
          {settings.colorMode === 'speed' && (
            <div style={s.legend}>
              {(['#2196f3','#4caf50','#ff9800','#ef4444'] as const).map((c, i) => (
                <span key={c} style={{ color: c }}>● {['低速 〜20km/h','中速 〜60km/h','高速 〜100km/h','超高速 100km/h〜'][i]}</span>
              ))}
            </div>
          )}
          <p style={s.sectionTitle}>ライン太さ</p>
          <div style={s.row}>
            {[3,5,7].map(w => (
              <button
                key={w}
                style={{ ...s.toggleBtn, ...(settings.lineWidth === w ? s.toggleBtnActive : {}) }}
                onClick={() => set({ lineWidth: w })}
              >
                {w === 3 ? '細' : w === 5 ? '中' : '太'}
              </button>
            ))}
          </div>
        </section>

        {/* インポート */}
        <section style={s.section}>
          <p style={s.sectionTitle}>インポート</p>
          <input ref={csvInputRef}  type="file" accept=".csv"  style={{ display: 'none' }} onChange={handleCsvImport} />
          <input ref={jsonInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleJsonImport} />
          <button
            style={{ ...s.importBtn, marginBottom: 8 }}
            onClick={() => csvInputRef.current?.click()} disabled={importing}
          >
            📂 CSVインポート
          </button>
          <button
            style={s.importBtn}
            onClick={() => jsonInputRef.current?.click()} disabled={importing}
          >
            🗺️ Google Timelineインポート（.json）
          </button>
          {importing && <p style={{ color: '#2563eb', fontSize: 12, marginTop: 8 }}>{importProgress}</p>}
        </section>

        {/* エクスポート */}
        <section style={s.section}>
          <p style={s.sectionTitle}>エクスポート（バックアップ）</p>
          <button
            style={{ ...s.importBtn, marginBottom: 8 }}
            onClick={handleExport('gpx')} disabled={exporting || routes.length === 0}
          >
            📤 GPX形式でエクスポート（{routes.length}件）
          </button>
          <button
            style={s.importBtn}
            onClick={handleExport('csv')} disabled={exporting || routes.length === 0}
          >
            📤 CSV形式でエクスポート（再インポート可能）
          </button>
          {exporting && <p style={{ color: '#2563eb', fontSize: 12, marginTop: 8 }}>{exportProgress}</p>}
        </section>

        {/* データ管理 */}
        <section style={s.section}>
          <p style={s.sectionTitle}>データ管理</p>
          <button
            style={{ ...s.deleteBtn, background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe', marginBottom: 8, opacity: migrating ? 0.6 : 1 }}
            onClick={handleMigrateChunks}
            disabled={migrating}
          >
            {migrating ? `📦 最適化中... ${migrateProgress}` : '📦 ストレージ最適化（ルートを軽量形式に移行）'}
          </button>
          <p style={s.deleteNote}>GPS点列をルート本体から分離して保存。一覧の読み込みが速く・安くなります（1回でOK）</p>
          <button
            style={{ ...s.deleteBtn, background: '#fff7ed', color: '#c2410c', borderColor: '#fed7aa', marginBottom: 8 }}
            onClick={handleDedupeRoutes}
            disabled={routeCount === 0}
          >
            👯 重複ルートを検出・削除
          </button>
          <p style={s.deleteNote}>電波不安定時の保存リトライ等で二重になった記録（開始時刻2分以内・距離ほぼ同一）を検出して片方を削除します</p>
          <button style={s.deleteBtn} onClick={handleDeleteAllRoutes} disabled={routeCount === 0}>
            🗑 全ルートを削除（{routeCount}件）
          </button>
          <button style={{ ...s.deleteBtn, marginTop: 8 }} onClick={handleDeleteAllLandmarks} disabled={landmarkCount === 0}>
            🗑 全スポットを削除（{landmarkCount}件）
          </button>
          <p style={s.deleteNote}>削除後にCSVを再インポートすると速度・スポット検出が正しく処理されます</p>
        </section>

        {/* デバッグ */}
        <section style={s.section}>
          <p style={s.sectionTitle}>🛠 デバッグ</p>
          <button
            style={{ ...s.deleteBtn, background: '#fff7ed', color: '#c2410c', borderColor: '#fed7aa', opacity: deduping ? 0.6 : 1 }}
            onClick={handleDeduplicateAllVisits}
            disabled={deduping}
          >
            {deduping ? `🧹 処理中... ${dedupProgress}` : '🧹 全スポットの重複訪問ログを一括削除'}
          </button>
          <p style={s.deleteNote}>同日・同メモの重複ログを全スポット一括で削除し、来訪回数を補正します</p>
          <button
            style={{ ...s.deleteBtn, background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe', marginTop: 8, opacity: restoring ? 0.6 : 1 }}
            onClick={handleRestorePhotos}
            disabled={restoring}
          >
            {restoring ? `🖼 復元中... ${restoreProgress}` : '🖼 期限切れ写真を自動復元（Places API）'}
          </button>
          <p style={s.deleteNote}>placeIdが保存されているスポットの写真をPlaces APIで取得し直してFirebase Storageに永続保存します</p>
          <button
            style={{ ...s.deleteBtn, background: '#f0fdf4', color: '#166534', borderColor: '#bbf7d0', marginTop: 8 }}
            onClick={() => {
              resetDensityCache();
              try { localStorage.removeItem('prefVisit_v1'); } catch { /* ignore */ }
              alert('全ルート表示と都道府県マップのキャッシュをリセットしました。\n次に開いた時に最新データで再構成されます。');
            }}
          >
            🔄 全ルートマージデータをリセット
          </button>
          <p style={s.deleteNote}>全ルート表示（密度マップ）と都道府県制覇の集計キャッシュを破棄し、次回表示時に最新のルートデータから作り直します。ルートを修復・削除した後に使ってください</p>
        </section>
      </div>
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay:  { position:'fixed', inset:0, background:'rgba(0,0,0,0.25)', zIndex:2000 },
  panel:    { position:'fixed', top:0, right:0, width:400, height:'100vh', background:'#fff', zIndex:2001, display:'flex', flexDirection:'column', boxShadow:'-4px 0 24px rgba(0,0,0,0.12)', overflowY:'auto', borderLeft:'1px solid #e8eaed' },
  header:   { display:'flex', justifyContent:'space-between', alignItems:'center', padding:'20px 24px', borderBottom:'1px solid #e8eaed' },
  title:    { color:'#1f2937', fontSize:17, fontWeight:700 },
  closeBtn: { background:'none', border:'none', color:'#9ca3af', fontSize:18, cursor:'pointer' },
  section:  { padding:'20px 24px', borderBottom:'1px solid #f3f4f6' },
  sectionTitle: { color:'#9ca3af', fontSize:11, textTransform:'uppercase' as const, letterSpacing:1, marginBottom:12, fontWeight:600 },
  tileGrid: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 },
  tileBtn:  { background:'#f8f9fa', border:'2px solid #e8eaed', borderRadius:10, padding:'12px 8px', cursor:'pointer', display:'flex', flexDirection:'column' as const, alignItems:'center', gap:4, color:'#6b7280', transition:'all 0.12s' },
  tileBtnActive: { borderColor:'#2563eb', background:'#eff6ff', color:'#1f2937' },
  tileName: { fontSize:11, fontWeight:600 as const, textAlign:'center' as const, color:'#374151' },
  tileDesc: { fontSize:10, color:'#9ca3af', textAlign:'center' as const },
  row:      { display:'flex', gap:8, marginBottom:12 },
  toggleBtn: { flex:1, background:'#f8f9fa', border:'2px solid #e8eaed', borderRadius:8, padding:'8px', color:'#6b7280', cursor:'pointer', fontSize:13 },
  toggleBtnActive: { borderColor:'#2563eb', background:'#eff6ff', color:'#2563eb', fontWeight:700 as const },
  legend:   { display:'flex', flexDirection:'column' as const, gap:4, fontSize:12, marginBottom:12, padding:'8px 12px', background:'#f8f9fa', borderRadius:8 },
  importBtn: { width:'100%', background:'#f8f9fa', color:'#374151', border:'1.5px solid #e8eaed', borderRadius:8, padding:'12px', cursor:'pointer', fontSize:14, textAlign:'left' as const },
  deleteBtn: { width:'100%', background:'#fef2f2', color:'#ef4444', border:'1px solid #fecaca', borderRadius:8, padding:'12px', cursor:'pointer', fontSize:14 },
  deleteNote: { color:'#9ca3af', fontSize:11, marginTop:8, lineHeight:1.6 },
};
