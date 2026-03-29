import { useRef, useState } from 'react';
import type { Route, TagDef } from '../firebase/data';
import { createTag, deleteTag, updateRouteTags, updateRouteName, getUserLandmarks, saveLandmark } from '../firebase/data';
import { detectStops, matchStopsToLandmarks, type StopCluster } from '../utils/visitDetection';

const TAG_COLORS = ['#ef4444','#f97316','#f59e0b','#22c55e','#2563eb','#8b5cf6','#ec4899','#06b6d4'];

import type { Car } from '../firebase/data';

interface Props {
  userId: string;
  routes: Route[];
  loading: boolean;
  selectedRoute: Route | null;
  showAllRoutes: boolean;
  onSelect: (route: Route) => void;
  onDelete: (route: Route) => void;
  onShowAll: () => void;
  onOpenSettings: () => void;
  onOpenCars: () => void;
  tags: TagDef[];
  onUpdateRoute: (route: Route) => void;
  onTagsChange: () => void;
  activeCar: Car | null;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}
function formatDuration(start: number, end: number) {
  const mins = Math.round((end - start) / 60000);
  return mins < 60 ? `${mins}分` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export default function RoutesPanel({
  userId, routes, loading, selectedRoute, showAllRoutes,
  onSelect, onDelete, onShowAll, onOpenSettings, onOpenCars,
  tags, onUpdateRoute, onTagsChange, activeCar,
}: Props) {
  const [search, setSearch]               = useState('');
  const [editingId, setEditingId]         = useState<string | null>(null);
  const [editingName, setEditingName]     = useState('');
  const editInputRef                      = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds]     = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [newTagName, setNewTagName]   = useState('');
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[4]);
  const [creatingTag, setCreatingTag] = useState(false);

  // スポット候補検出
  const [stopCandidates, setStopCandidates] = useState<StopCluster[]>([]);
  const [detectingRouteId, setDetectingRouteId] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [addModal, setAddModal] = useState<StopCluster | null>(null);
  const [newSpotName, setNewSpotName] = useState('');
  const [newSpotCategory, setNewSpotCategory] = useState('その他');
  const [savingSpot, setSavingSpot] = useState(false);

  const SPOT_CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', '駐車場'];

  const handleDetect = async (route: Route) => {
    setDetecting(true);
    setDetectingRouteId(route.id!);
    setStopCandidates([]);
    try {
      const stops = detectStops(route.points);
      if (stops.length === 0) { setStopCandidates([]); return; }
      const landmarks = await getUserLandmarks(userId);
      const { unmatchedStops } = matchStopsToLandmarks(stops, landmarks);
      setStopCandidates(unmatchedStops);
    } finally {
      setDetecting(false);
    }
  };

  const handleSaveSpot = async () => {
    if (!addModal || !newSpotName.trim()) return;
    setSavingSpot(true);
    try {
      const now = Date.now();
      await saveLandmark({
        userId, name: newSpotName.trim(), category: newSpotCategory,
        lat: addModal.lat, lng: addModal.lng,
        description: '', photos: [],
        visitCount: 0, firstVisit: now, lastVisit: now, createdAt: now,
      });
      setStopCandidates(prev => prev.filter(s => s !== addModal));
      setAddModal(null);
      setNewSpotName('');
      setNewSpotCategory('その他');
    } finally {
      setSavingSpot(false);
    }
  };

  const startEditName = (route: Route, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(route.id!);
    setEditingName(route.name);
    setTimeout(() => editInputRef.current?.select(), 30);
  };

  const saveEditName = async (route: Route) => {
    const name = editingName.trim();
    if (name && name !== route.name) {
      await updateRouteName(route.id!, name);
      onUpdateRoute({ ...route, name });
    }
    setEditingId(null);
  };

  const handleRouteClick = (route: Route, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+クリック：トグル選択
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(route.id!)) next.delete(route.id!);
        else next.add(route.id!);
        return next;
      });
      setLastClickedId(route.id!);
    } else if (e.shiftKey && lastClickedId) {
      // Shift+クリック：範囲選択
      const ids = filtered.map(r => r.id!);
      const a = ids.indexOf(lastClickedId);
      const b = ids.indexOf(route.id!);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        setSelectedIds(new Set(ids.slice(lo, hi + 1)));
      }
    } else {
      // 通常クリック
      setSelectedIds(new Set());
      setLastClickedId(route.id!);
      onSelect(route);
    }
  };

  const handleAssignTag = async (tag: TagDef) => {
    const targets = routes.filter(r => selectedIds.has(r.id!));
    await Promise.all(targets.map(r => {
      if (r.tags.includes(tag.id!)) return Promise.resolve();
      const newTags = [...r.tags, tag.id!];
      return updateRouteTags(r.id!, newTags).then(() => onUpdateRoute({ ...r, tags: newTags }));
    }));
    setSelectedIds(new Set());
  };

  const handleClearTags = async () => {
    if (!confirm(`${selectedIds.size}件のルートからタグをすべて削除しますか？`)) return;
    const targets = routes.filter(r => selectedIds.has(r.id!));
    await Promise.all(targets.map(r =>
      updateRouteTags(r.id!, []).then(() => onUpdateRoute({ ...r, tags: [] }))
    ));
    setSelectedIds(new Set());
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    setCreatingTag(true);
    try {
      await createTag({ userId, name: newTagName.trim(), color: newTagColor });
      setNewTagName('');
      onTagsChange();
    } finally {
      setCreatingTag(false);
    }
  };

  const handleDeleteTag = async (tag: TagDef) => {
    if (!confirm(`タグ「${tag.name}」を削除しますか？\n（ルートのタグ割り当ては別途解除が必要です）`)) return;
    await deleteTag(tag.id!);
    onTagsChange();
  };

  const filtered = routes.filter(r => {
    const nameMatch = r.name.toLowerCase().includes(search.toLowerCase());
    const tagMatch = r.tags.some(tagId => {
      const tag = tags.find(t => t.id === tagId);
      return tag?.name.toLowerCase().includes(search.toLowerCase());
    });
    return nameMatch || tagMatch;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ツールバー */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8eaed', display: 'flex', gap: 8, alignItems: 'center' }}>
        {activeCar && (
          <span style={{ flex: 1, fontSize: 12, color: '#2563eb', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🚗 {activeCar.nickname}
          </span>
        )}
        {!activeCar && <div style={{ flex: 1 }} />}
        <button style={styles.iconBtn} onClick={onOpenCars} title="愛車管理">🚗</button>
        <button style={styles.iconBtn} onClick={() => setShowTagManager(true)} title="タグ管理">🏷️</button>
        <button style={styles.iconBtn} onClick={onOpenSettings} title="設定">⚙️</button>
      </div>

      {/* 全ルート表示 */}
      <div style={{ padding: '8px 16px', borderBottom: '1px solid #e8eaed' }}>
        <button
          style={{ ...styles.allRoutesBtn, ...(showAllRoutes ? styles.allRoutesBtnActive : {}) }}
          onClick={onShowAll}
        >
          🌐 全ルートを地図に表示（{routes.length}件）
        </button>
      </div>

      {/* 複数選択アクションバー */}
      {selectedIds.size > 0 && (
        <div style={styles.actionBar}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#2563eb', fontSize: 13, fontWeight: 600 }}>{selectedIds.size}件選択中</span>
            <button onClick={() => setSelectedIds(new Set())} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>
              解除
            </button>
          </div>
          {tags.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 12 }}>🏷️ でタグを作成してから割り当てられます</p>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tags.map(tag => (
                <button
                  key={tag.id}
                  onClick={() => handleAssignTag(tag)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fff', border: `1.5px solid ${tag.color}`, borderRadius: 20, padding: '4px 10px', cursor: 'pointer', fontSize: 12, color: tag.color, fontWeight: 500 }}
                >
                  ● {tag.name}
                </button>
              ))}
              <button
                onClick={handleClearTags}
                style={{ background: '#fff', border: '1.5px solid #e8eaed', borderRadius: 20, padding: '4px 10px', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}
              >
                🗑 タグをクリア
              </button>
            </div>
          )}
        </div>
      )}

      {/* 検索 */}
      <div style={{ padding: '8px 16px 4px' }}>
        <input
          style={styles.search} placeholder="ルートやタグ名を検索..."
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <p style={styles.count}>
          {loading ? '読み込み中...' : `${filtered.length}件`}
          {selectedIds.size > 0 && <span style={{ color: '#f59e0b', marginLeft: 8 }}>{selectedIds.size}件選択</span>}
          {selectedIds.size === 0 && <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 8 }}>Ctrl+クリックで複数選択</span>}
        </p>
      </div>

      {/* スポット候補検出 */}
      {selectedRoute && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #e8eaed', background: '#f8fbff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#374151', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              🔵 {selectedRoute.name || '（無名）'}
            </span>
            <button
              style={{ ...styles.iconBtn, fontSize: 12, padding: '6px 10px', color: '#2563eb' }}
              onClick={() => handleDetect(selectedRoute)}
              disabled={detecting}
            >
              {detecting ? '検出中...' : '🔍 スポット検出'}
            </button>
          </div>
          {detectingRouteId === selectedRoute.id && !detecting && stopCandidates.length === 0 && (
            <p style={{ color: '#9ca3af', fontSize: 12, margin: '6px 0 0' }}>未登録スポット候補なし</p>
          )}
          {detectingRouteId === selectedRoute.id && stopCandidates.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ color: '#2563eb', fontSize: 11, fontWeight: 600, margin: '0 0 6px' }}>{stopCandidates.length}か所の未登録スポット候補</p>
              {stopCandidates.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid #e8eaed' }}>
                  <span style={{ fontSize: 11, color: '#6b7280', flex: 1 }}>
                    📍 {Math.round(s.durationMs / 60000)}分滞在 ({s.lat.toFixed(4)}, {s.lng.toFixed(4)})
                  </span>
                  <button
                    style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                    onClick={() => { setAddModal(s); setNewSpotName(''); setNewSpotCategory('その他'); }}
                  >
                    追加
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* スポット追加モーダル */}
      {addModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.3)' }} onClick={() => setAddModal(null)}>
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', marginBottom: 4 }}>スポットを追加</h3>
            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>{Math.round(addModal.durationMs / 60000)}分滞在したエリア</p>
            <input
              value={newSpotName}
              onChange={e => setNewSpotName(e.target.value)}
              placeholder="スポット名"
              autoFocus
              style={{ width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '10px 12px', fontSize: 14, outline: 'none', marginBottom: 12, boxSizing: 'border-box' }}
            />
            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>カテゴリ</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {SPOT_CATEGORIES.map(c => (
                <button key={c} onClick={() => setNewSpotCategory(c)}
                  style={{ padding: '4px 10px', borderRadius: 16, fontSize: 12, cursor: 'pointer', border: newSpotCategory === c ? 'none' : '1px solid #e8eaed', background: newSpotCategory === c ? '#2563eb' : '#f3f4f6', color: newSpotCategory === c ? '#fff' : '#374151', fontWeight: newSpotCategory === c ? 700 : 400 }}>
                  {c}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setAddModal(null)} style={{ flex: 1, padding: '10px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', color: '#6b7280', fontWeight: 600 }}>キャンセル</button>
              <button onClick={handleSaveSpot} disabled={!newSpotName.trim() || savingSpot}
                style={{ flex: 1, padding: '10px', background: !newSpotName.trim() || savingSpot ? '#93c5fd' : '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer', color: '#fff', fontWeight: 700 }}>
                {savingSpot ? '保存中...' : '追加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* リスト */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loading && filtered.length === 0 && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 40, fontSize: 14, lineHeight: 1.8 }}>
            ルートがありません<br />CSVをインポートしてください
          </p>
        )}
        {filtered.map(route => {
          const isSelected = selectedIds.has(route.id!);
          return (
            <div
              key={route.id}
              style={{
                ...styles.card,
                ...(selectedRoute?.id === route.id && !isSelected ? styles.cardSelected : {}),
                ...(isSelected ? styles.cardChecked : {}),
              }}
              onClick={e => handleRouteClick(route, e)}
            >
              <div style={styles.cardHeader}>
                {editingId === route.id ? (
                  <input
                    ref={editInputRef}
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={() => saveEditName(route)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEditName(route); if (e.key === 'Escape') setEditingId(null); }}
                    onClick={e => e.stopPropagation()}
                    style={{ flex: 1, background: '#f8f9fa', border: '1.5px solid #2563eb', borderRadius: 6, padding: '2px 8px', fontSize: 14, color: '#1f2937', outline: 'none', marginRight: 8 }}
                  />
                ) : (
                  <><span style={{ marginRight: 4 }}>
                    {route.mode === 'walk' ? '🚶' : '🚗'}
                  </span>
                  <span style={styles.cardName}>{route.name || '（無名）'}</span></>

                )}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  {isSelected && <span style={{ fontSize: 14 }}>✓</span>}
                  <span className={route.source === 'imported' ? 'badge-imported' : 'badge-recorded'}>
                    {route.source === 'imported' ? 'インポート' : '記録'}
                  </span>
                  <button style={styles.deleteBtn} onClick={e => startEditName(route, e)} title="名前を変更">✏️</button>
                  <button
                    style={styles.deleteBtn}
                    onClick={e => { e.stopPropagation(); onDelete(route); }}
                    title="削除"
                  >🗑</button>
                </div>
              </div>
              <div style={styles.cardDate}>{formatDate(route.startTime)}</div>
              <div style={styles.cardMetrics}>
                <span>📏 {route.totalDistance.toFixed(1)}km</span>
                <span>⚡ {route.avgSpeed.toFixed(0)}km/h</span>
                <span>⏱ {formatDuration(route.startTime, route.endTime)}</span>
              </div>
              {route.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                  {route.tags.map(tagId => {
                    const tag = tags.find(t => t.id === tagId);
                    if (!tag) return null;
                    return (
                      <span key={tagId} style={{
                        fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 20,
                        background: tag.color, color: '#fff', border: 'none',
                      }}>
                        {tag.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* タグ管理モーダル */}
      {showTagManager && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.3)' }}
          onClick={() => setShowTagManager(false)}
        >
          <div
            style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 24, width: 320, maxHeight: '75vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700 }}>🏷️ タグ管理</h3>
              <button onClick={() => setShowTagManager(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            {/* 既存タグ一覧 */}
            {tags.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>タグがありません</p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {tags.map(tag => (
                  <div key={tag.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ width: 14, height: 14, borderRadius: '50%', background: tag.color, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ flex: 1, fontSize: 14, color: '#1f2937' }}>{tag.name}</span>
                    <button
                      onClick={() => handleDeleteTag(tag)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14, padding: '2px 4px' }}
                    >🗑</button>
                  </div>
                ))}
              </div>
            )}

            {/* 新規タグ作成 */}
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 16 }}>
              <p style={{ color: '#9ca3af', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 10 }}>新規タグを作成</p>
              <input
                value={newTagName}
                onChange={e => setNewTagName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateTag(); }}
                placeholder="タグ名（例：仕事、プライベート）"
                style={{ width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '10px 12px', fontSize: 14, outline: 'none', marginBottom: 12, boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {TAG_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setNewTagColor(c)}
                    style={{
                      width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                      border: newTagColor === c ? '3px solid #1f2937' : '2px solid transparent',
                      outline: newTagColor === c ? '2px solid #fff' : 'none',
                      outlineOffset: -4,
                    }}
                  />
                ))}
              </div>
              <button
                className="btn-primary"
                style={{ width: '100%', padding: '10px' }}
                onClick={handleCreateTag}
                disabled={creatingTag || !newTagName.trim()}
              >
                {creatingTag ? '作成中...' : '作成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  search: {
    width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed',
    borderRadius: 8, padding: '8px 12px', fontSize: 14, outline: 'none', marginBottom: 4,
  },
  count: { color: '#9ca3af', fontSize: 12 },
  allRoutesBtn: {
    width: '100%', background: '#f8f9fa', color: '#6b7280',
    border: '1.5px solid #e8eaed', borderRadius: 8, padding: '8px 12px',
    cursor: 'pointer', fontSize: 13, textAlign: 'left',
  },
  allRoutesBtnActive: { background: '#eff6ff', color: '#2563eb', borderColor: '#2563eb' },
  iconBtn: {
    background: '#f8f9fa', color: '#374151',
    border: '1.5px solid #e8eaed', borderRadius: 8,
    padding: '9px 11px', cursor: 'pointer', fontSize: 15, whiteSpace: 'nowrap' as const,
  },
  actionBar: {
    padding: '10px 16px',
    background: '#eff6ff',
    borderBottom: '1px solid #bfdbfe',
  },
  card: {
    padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
    transition: 'background 0.12s',
  },
  cardSelected: { background: '#eff6ff', borderLeft: '3px solid #2563eb' },
  cardChecked:  { background: '#fefce8', borderLeft: '3px solid #f59e0b' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  cardName: { color: '#1f2937', fontSize: 14, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 },
  cardDate: { color: '#9ca3af', fontSize: 12, marginBottom: 5 },
  cardMetrics: { display: 'flex', gap: 12, color: '#6b7280', fontSize: 12, flexWrap: 'wrap' },
  deleteBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    padding: '2px 4px', borderRadius: 4, opacity: 0.5,
  },
};
