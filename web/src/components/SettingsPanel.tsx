import { useRef, useState } from 'react';
import type { TileKey, ColorMode } from './RouteMapView';
import { deleteAllUserRoutes, deleteAllUserLandmarks, getUserLandmarks, getVisits, deleteVisit, updateLandmark, uploadLandmarkPhotoFromUrl } from '../firebase/data';
import { importRouteHistoryCsv, extractSpotsFromTimeline, saveDetectedSpots } from '../utils/csvImport';

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
}

const TILE_OPTIONS: { key: TileKey; label: string; desc: string; preview: string }[] = [
  { key: 'roadmap', label: '通常地図',   desc: 'Google Maps 標準・日本語対応', preview: '🗺️' },
  { key: 'hybrid',  label: '衛星+ラベル', desc: '衛星写真＋日本語地名表示',    preview: '🛰️' },
  { key: 'terrain', label: '地形図',     desc: '標高・地形がわかる地図',       preview: '⛰️' },
];

export default function SettingsPanel({ open, onClose, settings, onSettings, userId, routeCount, landmarkCount, onDeleteAllRoutes, onDeleteAllLandmarks, onImportDone, getPlacesService }: Props) {
  const [dedupProgress, setDedupProgress] = useState('');
  const [deduping, setDeduping]           = useState(false);
  const [importing, setImporting]         = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [restoring, setRestoring]         = useState(false);
  const [restoreProgress, setRestoreProgress] = useState('');
  const csvInputRef  = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const set = (patch: Partial<MapSettings>) => onSettings({ ...settings, ...patch });

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
        const newCount = Math.max(0, lm.visitCount - toDelete.length);
        await updateLandmark(lm.id!, { visitCount: newCount });
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

        {/* データ管理 */}
        <section style={s.section}>
          <p style={s.sectionTitle}>データ管理</p>
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
