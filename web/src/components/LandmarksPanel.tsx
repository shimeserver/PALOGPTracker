import { useEffect, useRef, useState } from 'react';
import { getUserLandmarks, getVisits, deleteLandmark, updateLandmark, mergeLandmarks, deleteVisit, uploadLandmarkPhotoFromUrl } from '../firebase/data';
import type { Landmark, Visit } from '../firebase/data';

const NO_PHOTO_PLACEHOLDER = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90' viewBox='0 0 120 90'%3E%3Crect width='120' height='90' fill='%23f3f4f6'/%3E%3Ccircle cx='60' cy='34' r='14' fill='%23d1d5db'/%3E%3Cellipse cx='60' cy='68' rx='24' ry='14' fill='%23d1d5db'/%3E%3C/svg%3E`;

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function placeTypeToCategory(types: string[]): string {
  if (types.includes('restaurant') || types.includes('food') || types.includes('bakery') || types.includes('meal_takeaway')) return 'グルメ';
  if (types.includes('cafe')) return 'カフェ';
  if (types.includes('convenience_store')) return 'コンビニ';
  if (types.includes('tourist_attraction') || types.includes('museum') || types.includes('amusement_park') || types.includes('shrine') || types.includes('temple')) return '観光';
  if (types.includes('park') || types.includes('campground')) return '公園';
  if (types.includes('shopping_mall') || types.includes('store') || types.includes('clothing_store') || types.includes('department_store')) return 'ショッピング';
  if (types.includes('gas_station')) return 'ガソリンスタンド';
  if (types.includes('parking')) return '駐車場';
  return 'その他';
}


interface Props {
  userId: string;
  active: boolean;
  onFocus: (lm: Landmark) => void;
  onCountChange: (n: number) => void;
  getPlacesService: () => google.maps.places.PlacesService | null;
  startMapPickMode: (cb: (lat: number, lng: number, placeId?: string) => void) => void;
  stopMapPickMode: () => void;
  startPinDragMode: (id: string, originalLat: number, originalLng: number, onDragEnd: (lat: number, lng: number) => void) => void;
  stopPinDragMode: () => void;
  revertLandmarkPosition: (id: string, lat: number, lng: number) => void;
  activePinDragId: string | null;
}

const CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', '駐車場'];

export default function LandmarksPanel({ userId, active, onFocus, onCountChange, getPlacesService, startMapPickMode, stopMapPickMode, startPinDragMode, stopPinDragMode, revertLandmarkPosition, activePinDragId }: Props) {
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [selected, setSelected]   = useState<Landmark | null>(null);
  const [visits, setVisits]       = useState<Visit[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [sortKey, setSortKey]       = useState<'visitCount' | 'category' | 'year'>('visitCount');
  const [sortAsc, setSortAsc]       = useState(false);
  const [filterYear, setFilterYear] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName]   = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // 詳細編集
  const [detailEditing, setDetailEditing]   = useState(false);
  const [detailName, setDetailName]         = useState('');
  const [detailDesc, setDetailDesc]         = useState('');
  const [detailCategory, setDetailCategory] = useState('');

  // 来訪回数編集
  const [editingCount, setEditingCount]     = useState(false);
  const [editCountVal, setEditCountVal]     = useState(0);

  // ピン位置ドラッグ編集
  const [pinDragActive, setPinDragActive] = useState(false);
  const [pinDragNewPos, setPinDragNewPos] = useState<{ lat: number; lng: number } | null>(null);
  const [pinDragSaving, setPinDragSaving] = useState(false);

  // タブ切替など外部からドラッグモードが解除されたときにパネル状態をリセット
  useEffect(() => {
    if (!activePinDragId && pinDragActive) {
      setPinDragActive(false);
      setPinDragNewPos(null);
    }
  }, [activePinDragId]);

  // 地図で確定
  const [pickModeActive, setPickModeActive] = useState(false);
  const [pendingPlace, setPendingPlace]     = useState<google.maps.places.PlaceResult | null>(null);
  const [pendingPhotoUrl, setPendingPhotoUrl] = useState<string | null>(null);
  const [confirming, setConfirming]         = useState(false);
  const [pickHint, setPickHint]             = useState(false); // POI以外クリック時のヒント
  const [mergeCandidate, setMergeCandidate] = useState<Landmark | null>(null);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    getUserLandmarks(userId).then(l => { setLandmarks(l); setLoading(false); onCountChange(l.length); });
  }, [userId, active]);

  // 詳細から離れたらピックモード・ドラッグモード解除
  useEffect(() => {
    if (!selected) {
      setPickModeActive(false);
      { setPendingPlace(null); setPendingPhotoUrl(null); };
      stopMapPickMode();
      setPinDragActive(false);
      setPinDragNewPos(null);
      stopPinDragMode();
    }
  }, [selected]);

  // ========== 地図で確定 ==========
  const handleEnterPickMode = () => {
    const service = getPlacesService();
    if (!service) { alert('地図タブを一度開いてから試してください'); return; }
    setPickModeActive(true);
    { setPendingPlace(null); setPendingPhotoUrl(null); };
    startMapPickMode((_lat, _lng, placeId) => {
      if (!placeId) {
        // POI以外の場所をクリック — ヒントを表示してピックモード継続
        setPickHint(true);
        setTimeout(() => setPickHint(false), 3000);
        return;
      }
      setPickModeActive(false);
      stopMapPickMode();
      service.getDetails(
        { placeId, fields: ['name', 'place_id', 'geometry', 'photos', 'types', 'vicinity', 'rating'] },
        (result, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && result) {
            setPendingPlace(result);
            setPendingPhotoUrl(result.photos?.[0]?.getUrl({ maxWidth: 600 }) ?? null);
          }
        }
      );
    });
  };

  const handleConfirmPlace = async (forceMerge = false) => {
    if (!selected || !pendingPlace) return;

    // 同じ placeId の別ランドマークを検索
    const pid = pendingPlace.place_id;
    if (pid && !forceMerge) {
      const dup = landmarks.find(lm => lm.id !== selected.id && lm.placeId === pid);
      if (dup) { setMergeCandidate(dup); return; }
    }

    setConfirming(true);
    const googlePhotoUrl = pendingPhotoUrl;
    const newLat = pendingPlace.geometry?.location?.lat();
    const newLng = pendingPlace.geometry?.location?.lng();
    const patch: Parameters<typeof updateLandmark>[1] = {
      name: pendingPlace.name || selected.name,
      category: placeTypeToCategory(pendingPlace.types || []),
      placeId: pid,
    };
    // Google Places の一時URLをFirebase Storageに永続保存
    if (googlePhotoUrl && selected.id) {
      const stored = await uploadLandmarkPhotoFromUrl(userId, selected.id, googlePhotoUrl);
      if (stored) patch.photos = [stored];
    }
    if (newLat !== undefined && newLng !== undefined) { patch.lat = newLat; patch.lng = newLng; }

    if (forceMerge && mergeCandidate) {
      const merged = {
        visitCount: selected.visitCount + mergeCandidate.visitCount,
        firstVisit: Math.min(selected.firstVisit ?? Infinity, mergeCandidate.firstVisit ?? Infinity),
        lastVisit:  Math.max(selected.lastVisit  ?? 0,        mergeCandidate.lastVisit  ?? 0),
      };
      patch.visitCount = merged.visitCount;
      if (merged.firstVisit !== Infinity) patch.firstVisit = merged.firstVisit;
      if (merged.lastVisit  !== 0)        patch.lastVisit  = merged.lastVisit;
      await mergeLandmarks(selected.id!, mergeCandidate.id!, merged);
      setLandmarks(prev => prev.filter(x => x.id !== mergeCandidate.id));
      setMergeCandidate(null);
    } else {
      await updateLandmark(selected.id!, patch);
    }

    const updated = { ...selected, ...patch };
    setSelected(updated);
    setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
    { setPendingPlace(null); setPendingPhotoUrl(null); };
    setConfirming(false);
  };


  // ========== 近接マージウィザード ==========
  const [proxGroups, setProxGroups]     = useState<Landmark[][] | null>(null);
  const [proxIdx, setProxIdx]           = useState(0);
  const [proxMerging, setProxMerging]   = useState(false);
  const [proxDone, setProxDone]         = useState(0);
  const [proxSelected, setProxSelected] = useState<Set<string>>(new Set());
  const [proxKeepId, setProxKeepId]     = useState<string | null>(null);

  const PROX_KM = 0.1;
  function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  }

  const openProximityWizard = () => {
    // 100m以内のランドマークをグループ化（greedy clustering）
    const remaining = [...landmarks];
    const groups: Landmark[][] = [];
    while (remaining.length > 0) {
      const seed = remaining.shift()!;
      const group = [seed];
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (haversineKm(seed, remaining[i]) < PROX_KM) {
          group.push(remaining.splice(i, 1)[0]);
        }
      }
      if (group.length > 1) {
        groups.push(group.sort((a, b) => b.visitCount - a.visitCount));
      }
    }
    if (groups.length === 0) { alert('100m以内に複数のスポットは見つかりませんでした'); return; }
    setProxGroups(groups);
    setProxIdx(0);
    setProxDone(0);
    setProxKeepId(groups[0][0].id!);
    setProxSelected(new Set(groups[0].slice(1).map(x => x.id!)));
  };

  const advanceProx = (groups: Landmark[][], nextIdx: number) => {
    if (nextIdx >= groups.length) { setProxGroups(null); return; }
    setProxIdx(nextIdx);
    setProxKeepId(groups[nextIdx][0].id!);
    setProxSelected(new Set(groups[nextIdx].slice(1).map(x => x.id!)));
  };

  const handleProxMerge = async () => {
    if (!proxGroups) return;
    const group = proxGroups[proxIdx];
    const keep = group.find(x => x.id === proxKeepId) ?? group[0];
    const toMerge = group.filter(x => x.id !== keep.id && proxSelected.has(x.id!));
    if (toMerge.length === 0) { advanceProx(proxGroups, proxIdx + 1); return; }

    setProxMerging(true);
    const mergeGroup = [keep, ...toMerge];
    const visitCount = mergeGroup.reduce((s, x) => s + x.visitCount, 0);
    const firstVisit = mergeGroup.map(x => x.firstVisit).filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), keep.firstVisit ?? Date.now());
    const lastVisit  = mergeGroup.map(x => x.lastVisit ).filter((v): v is number => v != null).reduce((a, b) => Math.max(a, b), keep.lastVisit  ?? Date.now());
    for (const dup of toMerge) {
      await mergeLandmarks(keep.id!, dup.id!, { visitCount, firstVisit, lastVisit });
    }
    await updateLandmark(keep.id!, { visitCount, firstVisit, lastVisit });
    setLandmarks(prev => {
      const deleteIds = new Set(toMerge.map(x => x.id!));
      return prev
        .filter(x => !deleteIds.has(x.id!))
        .map(x => x.id === keep.id ? { ...x, visitCount, firstVisit, lastVisit } : x);
    });
    setProxDone(d => d + 1);
    setProxMerging(false);
    advanceProx(proxGroups, proxIdx + 1);
  };

  const handleProxSkip = () => {
    if (!proxGroups) return;
    advanceProx(proxGroups, proxIdx + 1);
  };

  // ========== 一括マージ ==========
  const [bulkMerging, setBulkMerging] = useState(false);
  const [mergePreview, setMergePreview] = useState<Landmark[][] | null>(null);

  const openMergePreview = () => {
    const groups = new Map<string, Landmark[]>();
    for (const lm of landmarks) {
      if (!lm.placeId) continue;
      const g = groups.get(lm.placeId) ?? [];
      g.push(lm);
      groups.set(lm.placeId, g);
    }
    const targets = [...groups.values()]
      .filter(g => g.length > 1)
      .map(g => [...g].sort((a, b) => b.visitCount - a.visitCount));
    if (targets.length === 0) { alert('マージできる重複スポットはありません\n（「地図で場所を確定」済みのスポット同士のみ対象）'); return; }
    setMergePreview(targets);
  };

  const executeBulkMerge = async () => {
    if (!mergePreview) return;
    setBulkMerging(true);
    let mergedCount = 0;
    for (const group of mergePreview) {
      const keep = group[0];
      const rest = group.slice(1);
      const visitCount = group.reduce((s, x) => s + x.visitCount, 0);
      const firstVisit = group.map(x => x.firstVisit).filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), keep.firstVisit ?? Date.now());
      const lastVisit  = group.map(x => x.lastVisit ).filter((v): v is number => v != null).reduce((a, b) => Math.max(a, b), keep.lastVisit  ?? Date.now());
      for (const dup of rest) {
        await mergeLandmarks(keep.id!, dup.id!, { visitCount, firstVisit, lastVisit });
        mergedCount++;
      }
      await updateLandmark(keep.id!, { visitCount, firstVisit, lastVisit });
    }
    setLandmarks(prev => {
      const deleteIds = new Set(mergePreview.flatMap(g => g.slice(1).map(x => x.id!)));
      const updateMap = new Map(mergePreview.map(g => {
        const keep = g[0];
        const visitCount = g.reduce((s, x) => s + x.visitCount, 0);
        const firstVisit = g.map(x => x.firstVisit).filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), keep.firstVisit ?? Date.now());
        const lastVisit  = g.map(x => x.lastVisit ).filter((v): v is number => v != null).reduce((a, b) => Math.max(a, b), keep.lastVisit  ?? Date.now());
        return [keep.id!, { ...keep, visitCount, firstVisit, lastVisit }];
      }));
      return prev.filter(x => !deleteIds.has(x.id!)).map(x => updateMap.get(x.id!) ?? x);
    });
    setBulkMerging(false);
    setMergePreview(null);
    alert(`完了！${mergedCount}件の重複スポットをマージしました`);
  };

  // ========== ピン位置ドラッグ ==========
  const handleStartPinDrag = () => {
    if (!selected) return;
    onFocus(selected);
    setPinDragActive(true);
    setPinDragNewPos(null);
    startPinDragMode(selected.id!, selected.lat, selected.lng, (lat, lng) => {
      setPinDragNewPos({ lat, lng });
    });
  };

  const handleConfirmPinDrag = async () => {
    if (!selected || !pinDragNewPos) return;
    setPinDragSaving(true);
    // 保存開始直後に drag mode を解除してタブ切替による意図しないリバートを防ぐ
    stopPinDragMode();
    const originalLat = selected.lat;
    const originalLng = selected.lng;
    try {
      await updateLandmark(selected.id!, { lat: pinDragNewPos.lat, lng: pinDragNewPos.lng });
      const updated = { ...selected, lat: pinDragNewPos.lat, lng: pinDragNewPos.lng };
      setSelected(updated);
      setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
      setPinDragActive(false);
      setPinDragNewPos(null);
    } catch (e: any) {
      // 保存失敗時はマップのマーカーも元の位置に戻す
      revertLandmarkPosition(selected.id!, originalLat, originalLng);
      alert(`保存に失敗しました: ${e.message}`);
    } finally {
      setPinDragSaving(false);
    }
  };

  const handleCancelPinDrag = () => {
    // ドラッグ後にキャンセルした場合はマーカーを元の座標に戻す
    if (selected && pinDragNewPos) {
      revertLandmarkPosition(selected.id!, selected.lat, selected.lng);
    }
    setPinDragActive(false);
    setPinDragNewPos(null);
    stopPinDragMode();
  };

  // ========== 共通操作 ==========
  const handleSelect = async (lm: Landmark) => {
    setSelected(lm); setDetailEditing(false); { setPendingPlace(null); setPendingPhotoUrl(null); }; onFocus(lm);
    const v = await getVisits(lm.id!); setVisits(v);
  };

  const handleDelete = async (lm: Landmark, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!confirm(`「${lm.name}」を削除しますか？`)) return;
    await deleteLandmark(lm.id!);
    setLandmarks(prev => { const next = prev.filter(x => x.id !== lm.id); onCountChange(next.length); return next; });
    if (selected?.id === lm.id) setSelected(null);
  };

  const startInlineEdit = (lm: Landmark, e: React.MouseEvent) => {
    e.stopPropagation(); setEditingId(lm.id!); setEditName(lm.name);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const saveInlineEdit = async (lm: Landmark) => {
    const name = editName.trim();
    if (name && name !== lm.name) {
      await updateLandmark(lm.id!, { name });
      setLandmarks(prev => prev.map(x => x.id === lm.id ? { ...x, name } : x));
      if (selected?.id === lm.id) setSelected(s => s ? { ...s, name } : s);
    }
    setEditingId(null);
  };

  const startDetailEdit = () => {
    if (!selected) return;
    setDetailName(selected.name); setDetailDesc(selected.description || '');
    setDetailCategory(selected.category || 'その他'); setDetailEditing(true);
  };

  const saveDetailEdit = async () => {
    if (!selected) return;
    const patch = { name: detailName.trim() || selected.name, description: detailDesc, category: detailCategory };
    await updateLandmark(selected.id!, patch);
    const updated = { ...selected, ...patch };
    setSelected(updated); setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
    setDetailEditing(false);
  };

  const saveVisitCount = async () => {
    if (!selected) return;
    const count = Math.max(0, editCountVal);
    await updateLandmark(selected.id!, { visitCount: count });
    const updated = { ...selected, visitCount: count };
    setSelected(updated); setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
    setEditingCount(false);
  };

  const handleDeleteVisit = async (visitId: string) => {
    if (!selected) return;
    await deleteVisit(selected.id!, visitId);
    setVisits(prev => prev.filter(v => v.id !== visitId));
    const newCount = Math.max(0, selected.visitCount - 1);
    await updateLandmark(selected.id!, { visitCount: newCount });
    const updated = { ...selected, visitCount: newCount };
    setSelected(updated); setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
  };

  const handleDeduplicateVisits = async () => {
    if (!selected) return;
    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const v of visits) {
      const day = new Date(v.timestamp).toDateString();
      const key = `${day}__${v.notes ?? ''}`;
      if (seen.has(key)) toDelete.push(v.id!);
      else seen.add(key);
    }
    if (toDelete.length === 0) { alert('重複はありませんでした'); return; }
    if (!confirm(`${toDelete.length}件の重複訪問ログを削除しますか？`)) return;
    for (const id of toDelete) await deleteVisit(selected.id!, id);
    const newVisits = visits.filter(v => !toDelete.includes(v.id!));
    setVisits(newVisits);
    const newCount = Math.max(0, selected.visitCount - toDelete.length);
    await updateLandmark(selected.id!, { visitCount: newCount });
    const updated = { ...selected, visitCount: newCount };
    setSelected(updated); setLandmarks(prev => prev.map(x => x.id === selected.id ? updated : x));
  };

  const years = Array.from(new Set(
    landmarks.filter(l => l.lastVisit).map(l => new Date(l.lastVisit!).getFullYear())
  )).sort((a, b) => b - a);

  const filtered = landmarks
    .filter(l =>
      (l.name.toLowerCase().includes(search.toLowerCase()) ||
       l.category.toLowerCase().includes(search.toLowerCase())) &&
      (filterYear === null || (l.lastVisit ? new Date(l.lastVisit).getFullYear() === filterYear : false))
    )
    .slice()
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === 'visitCount') return dir * (a.visitCount - b.visitCount);
      if (sortKey === 'category')   return dir * a.category.localeCompare(b.category, 'ja');
      if (sortKey === 'year')       return dir * ((a.lastVisit ?? 0) - (b.lastVisit ?? 0));
      return 0;
    });

  // ========== 詳細画面 ==========
  if (selected) {
    const coverUrl = selected.photos.length > 0
      ? selected.photos[0].url
      : NO_PHOTO_PLACEHOLDER;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* ヘッダー */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8eaed', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={() => {
            if (pinDragActive && pinDragNewPos) revertLandmarkPosition(selected.id!, selected.lat, selected.lng);
            setSelected(null);
          }} disabled={pinDragSaving} style={{ ...s.linkBtn, opacity: pinDragSaving ? 0.4 : 1 }}>← 一覧に戻る</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onFocus(selected)} style={{ ...s.linkBtn, color: '#2563eb' }}>📍 地図</button>
            {!detailEditing && !pinDragActive && <button onClick={startDetailEdit} style={{ ...s.linkBtn, color: '#6b7280' }}>✏️ 編集</button>}
            {!pinDragActive && <button onClick={handleStartPinDrag} style={{ ...s.linkBtn, color: '#f97316' }}>✥ 位置修正</button>}
            <button onClick={e => handleDelete(selected, e)} style={{ ...s.linkBtn, color: '#ef4444' }}>🗑</button>
          </div>
        </div>

        {/* ピン位置ドラッグモード */}
        {pinDragActive && (
          <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '10px 16px' }}>
            {pinDragNewPos ? (
              <>
                <p style={{ color: '#c2410c', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  新しい位置: {pinDragNewPos.lat.toFixed(6)}, {pinDragNewPos.lng.toFixed(6)}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleConfirmPinDrag} disabled={pinDragSaving}
                    style={{ flex: 1, background: '#f97316', color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: pinDragSaving ? 0.6 : 1 }}
                  >
                    {pinDragSaving ? '保存中...' : '✓ この位置で保存'}
                  </button>
                  <button onClick={handleCancelPinDrag} disabled={pinDragSaving} style={{ background: '#f8f9fa', color: '#6b7280', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '9px 14px', cursor: pinDragSaving ? 'not-allowed' : 'pointer', fontSize: 13, opacity: pinDragSaving ? 0.4 : 1 }}>
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#c2410c', fontSize: 13, fontWeight: 600 }}>✥ 地図上の赤いピンをドラッグして移動</span>
                <button onClick={handleCancelPinDrag} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
              </div>
            )}
          </div>
        )}

        {/* ピックモード：待機中 */}
        {pickModeActive && (
          <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '10px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#2563eb', fontSize: 13, fontWeight: 600 }}>👆 地図上のスポット（店舗・施設）をクリック</span>
              <button onClick={() => { setPickModeActive(false); setPickHint(false); stopMapPickMode(); }} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
            </div>
            {pickHint && (
              <p style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>店舗・施設などのアイコン（ピンマーク）をクリックしてください</p>
            )}
          </div>
        )}

        {/* ピックモード：確定待ち */}
        {pendingPlace && !mergeCandidate && (
          <div style={{ background: '#f0fdf4', borderBottom: '1px solid #86efac', padding: '12px 16px' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
              {pendingPhotoUrl && (
                <img src={pendingPhotoUrl} style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
              )}
              <div>
                <p style={{ color: '#15803d', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{pendingPlace.name}</p>
                {pendingPlace.vicinity && <p style={{ color: '#6b7280', fontSize: 12 }}>{pendingPlace.vicinity}</p>}
                {pendingPlace.geometry?.location && (
                  <p style={{ color: '#9ca3af', fontSize: 11 }}>
                    {distanceM(selected.lat, selected.lng, pendingPlace.geometry.location.lat(), pendingPlace.geometry.location.lng())}m 離れた場所
                  </p>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleConfirmPlace(false)} disabled={confirming}
                style={{ flex: 1, background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: confirming ? 0.6 : 1 }}
              >
                {confirming ? '保存中...' : 'このスポットで確定！'}
              </button>
              <button onClick={() => { setPendingPlace(null); setPendingPhotoUrl(null); }} style={{ background: '#f8f9fa', color: '#6b7280', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '9px 14px', cursor: 'pointer', fontSize: 13 }}>
                別の場所
              </button>
            </div>
          </div>
        )}

        {/* マージ確認 */}
        {pendingPlace && mergeCandidate && (
          <div style={{ background: '#fffbeb', borderBottom: '1px solid #fcd34d', padding: '12px 16px' }}>
            <p style={{ color: '#92400e', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
              ⚠️ 「{mergeCandidate.name}」と同じスポットです
            </p>
            <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 10 }}>
              来訪 {selected.visitCount}回 + {mergeCandidate.visitCount}回 = {selected.visitCount + mergeCandidate.visitCount}回 にマージできます
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleConfirmPlace(true)} disabled={confirming}
                style={{ flex: 1, background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: confirming ? 0.6 : 1 }}
              >
                {confirming ? 'マージ中...' : 'マージして確定'}
              </button>
              <button
                onClick={() => { setMergeCandidate(null); handleConfirmPlace(false); }}
                disabled={confirming}
                style={{ flex: 1, background: '#f8f9fa', color: '#6b7280', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '9px', cursor: 'pointer', fontSize: 13 }}
              >
                マージせず確定
              </button>
            </div>
            <button onClick={() => { setMergeCandidate(null); { setPendingPlace(null); setPendingPhotoUrl(null); }; }} style={{ width: '100%', marginTop: 6, background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>
              キャンセル
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ position: 'relative' }}>
            <img src={coverUrl} loading="lazy"
              style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            {selected.photos.length === 0 && (
              <span style={{ position: 'absolute', bottom: 6, right: 8, background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>Street View</span>
            )}
          </div>

          <div style={{ padding: 16 }}>
            {/* 地図で確定ボタン */}
            {!pickModeActive && !pendingPlace && !detailEditing && (
              <button
                onClick={handleEnterPickMode}
                style={{ width: '100%', background: '#f8faff', color: '#2563eb', border: '1.5px dashed #bfdbfe', borderRadius: 8, padding: '9px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}
              >
                🗺 地図で場所を確定する
              </button>
            )}

            {detailEditing ? (
              <div style={{ marginBottom: 16 }} onClick={e => e.stopPropagation()}>
                <input value={detailName} onChange={e => setDetailName(e.target.value)} style={s.editInput} placeholder="スポット名" autoFocus />
                <select value={detailCategory} onChange={e => setDetailCategory(e.target.value)} style={{ ...s.editInput, marginTop: 8 }}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <textarea value={detailDesc} onChange={e => setDetailDesc(e.target.value)}
                  style={{ ...s.editInput, marginTop: 8, minHeight: 80, resize: 'vertical' }} placeholder="メモ・説明" />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn-primary" style={{ flex: 1, padding: '9px' }} onClick={saveDetailEdit}>保存</button>
                  <button onClick={() => setDetailEditing(false)} style={s.cancelBtn}>キャンセル</button>
                </div>
              </div>
            ) : (
              <>
                <h2 style={{ color: '#1f2937', fontSize: 18, marginBottom: 6 }}>{selected.name}</h2>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#2563eb', fontSize: 12, background: '#eff6ff', borderRadius: 4, padding: '2px 10px', fontWeight: 500 }}>{selected.category}</span>
                  {editingCount ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number" min={0} value={editCountVal}
                        onChange={e => setEditCountVal(Number(e.target.value))}
                        onKeyDown={e => { if (e.key === 'Enter') saveVisitCount(); if (e.key === 'Escape') setEditingCount(false); }}
                        style={{ width: 64, background: '#f8f9fa', border: '1.5px solid #f59e0b', borderRadius: 6, padding: '3px 8px', fontSize: 14, color: '#1f2937', outline: 'none' }}
                        autoFocus
                      />
                      <span style={{ color: '#6b7280', fontSize: 13 }}>回</span>
                      <button onClick={saveVisitCount} style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>保存</button>
                      <button onClick={() => setEditingCount(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditCountVal(selected.visitCount); setEditingCount(true); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      title="来訪回数を編集"
                    >
                      <span style={{ color: '#f59e0b', fontSize: 14, fontWeight: 700 }}>来訪 {selected.visitCount}回 ✏️</span>
                    </button>
                  )}
                </div>
                {selected.description && <p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>{selected.description}</p>}
              </>
            )}

            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <p style={{ color: '#9ca3af', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>来訪履歴 ({visits.length}件)</p>
                {visits.length > 1 && (
                  <button
                    onClick={handleDeduplicateVisits}
                    style={{ background: '#fff7ed', color: '#c2410c', border: '1.5px solid #fed7aa', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                  >
                    🧹 重複削除
                  </button>
                )}
              </div>
              {visits.length === 0 && <p style={{ color: '#9ca3af', fontSize: 14 }}>履歴なし</p>}
              {visits.slice(0, 50).map(v => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ color: '#374151', fontSize: 14 }}>
                      {new Date(v.timestamp).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })}
                    </span>
                    {v.notes && <p style={{ color: '#9ca3af', fontSize: 13, marginTop: 2 }}>{v.notes}</p>}
                  </div>
                  <button
                    onClick={() => handleDeleteVisit(v.id!)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', fontSize: 14, padding: '2px 4px', flexShrink: 0 }}
                    title="この訪問を削除"
                  >🗑</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== 一覧画面 ==========
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8eaed' }}>
        <input style={s.search} placeholder="スポットを検索..." value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600 }}>並順:</span>
          {(['visitCount', 'category', 'year'] as const).map(key => (
            <button key={key} onClick={() => {
              if (sortKey === key) setSortAsc(a => !a);
              else { setSortKey(key); setSortAsc(false); }
            }} style={{
              background: sortKey === key ? '#2563eb' : '#f3f4f6',
              color: sortKey === key ? '#fff' : '#6b7280',
              border: 'none', borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}>
              {key === 'visitCount' ? '来訪回数' : key === 'category' ? 'カテゴリ' : '最終訪問'}
              {sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600 }}>絞込:</span>
          {years.length > 0 && (
            <select
              value={filterYear ?? ''}
              onChange={e => setFilterYear(e.target.value ? Number(e.target.value) : null)}
              style={{ background: filterYear ? '#fef3c7' : '#f3f4f6', color: filterYear ? '#92400e' : '#6b7280', border: 'none', borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
            >
              <option value=''>全年</option>
              {years.map(y => <option key={y} value={y}>{y}年</option>)}
            </select>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
          <p style={{ color: '#9ca3af', fontSize: 12 }}>{filtered.length}件のスポット</p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={openMergePreview}
              style={{ background: '#fff7ed', color: '#c2410c', border: '1.5px solid #fed7aa', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}
            >
              🔀 重複マージ
            </button>
            <button
              onClick={openProximityWizard}
              style={{ background: '#f0fdf4', color: '#15803d', border: '1.5px solid #86efac', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}
            >
              📍 近接マージ
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 20, color: '#9ca3af' }}>読み込み中...</div>}
        {!loading && filtered.length === 0 && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 40, fontSize: 14 }}>
            スポットがありません<br />CSVをインポートしてください
          </p>
        )}
        {filtered.map(lm => {
          const thumbUrl = lm.photos.length > 0
            ? lm.photos[0].url
            : NO_PHOTO_PLACEHOLDER;
          return (
            <div key={lm.id} style={s.card} onClick={() => handleSelect(lm)}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <img src={thumbUrl} loading="lazy"
                  style={{ width: 60, height: 60, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    {editingId === lm.id ? (
                      <input ref={editInputRef} value={editName} onChange={e => setEditName(e.target.value)}
                        onBlur={() => saveInlineEdit(lm)}
                        onKeyDown={e => { if (e.key === 'Enter') saveInlineEdit(lm); if (e.key === 'Escape') setEditingId(null); }}
                        onClick={e => e.stopPropagation()} style={s.inlineInput} />
                    ) : (
                      <span style={{ color: '#1f2937', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 4 }}>{lm.name}</span>
                    )}
                    <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
                      <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700 }}>{lm.visitCount}回</span>
                      <button onClick={e => startInlineEdit(lm, e)} style={s.iconBtn} title="名前を編集">✏️</button>
                      <button onClick={e => handleDelete(lm, e)} style={s.iconBtn} title="削除">🗑</button>
                    </div>
                  </div>
                  <span style={{ color: '#2563eb', fontSize: 11, background: '#eff6ff', borderRadius: 4, padding: '1px 6px', fontWeight: 500 }}>{lm.category}</span>
                  {lm.description && (
                    <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lm.description}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 一括マージ プレビューモーダル */}
      {mergePreview && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.4)' }} onClick={() => !bulkMerging && setMergePreview(null)}>
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 20, width: 340, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ color: '#1f2937', fontSize: 15, fontWeight: 700 }}>🔀 重複マージの確認</h3>
              <button onClick={() => setMergePreview(null)} disabled={bulkMerging} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 12 }}>
              以下 {mergePreview.length} グループをマージします（各グループの最上位に統合）
            </p>
            <div style={{ overflowY: 'auto', flex: 1, marginBottom: 16 }}>
              {mergePreview.map((group, i) => (
                <div key={i} style={{ marginBottom: 12, padding: 10, background: '#f8f9fa', borderRadius: 8, border: '1px solid #e8eaed' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ color: '#22c55e', fontSize: 13, fontWeight: 700 }}>✓ {group[0].name}</span>
                    <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700 }}>→ {group.reduce((s, x) => s + x.visitCount, 0)}回</span>
                  </div>
                  {group.slice(1).map(dup => (
                    <div key={dup.id} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
                      <span style={{ color: '#ef4444', fontSize: 12 }}>🗑 {dup.name}</span>
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>({dup.visitCount}回)</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <button
              onClick={executeBulkMerge} disabled={bulkMerging}
              style={{ width: '100%', background: bulkMerging ? '#f3f4f6' : '#f59e0b', color: bulkMerging ? '#9ca3af' : '#fff', border: 'none', borderRadius: 8, padding: '11px', fontWeight: 700, fontSize: 14, cursor: bulkMerging ? 'not-allowed' : 'pointer' }}
            >
              {bulkMerging ? 'マージ中...' : `${mergePreview.reduce((s, g) => s + g.length - 1, 0)}件を削除してマージ実行`}
            </button>
          </div>
        </div>
      )}
      {/* 近接マージ ウィザード */}
      {proxGroups && (() => {
        const group = proxGroups[proxIdx];
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.4)' }}>
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 14, padding: 20, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h3 style={{ color: '#1f2937', fontSize: 15, fontWeight: 700 }}>📍 近接マージ</h3>
                <span style={{ color: '#9ca3af', fontSize: 12 }}>{proxIdx + 1} / {proxGroups.length}グループ</span>
              </div>
              <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 12 }}>100m以内に複数のスポットがあります</p>

              <p style={{ color: '#9ca3af', fontSize: 11, marginBottom: 8 }}>★をタップで主スポットを変更 · チェックでマージ対象を選択</p>
              {/* グループ内スポット一覧 */}
              <div style={{ marginBottom: 14 }}>
                {group.map(lm => {
                  const isKeep    = lm.id === proxKeepId;
                  const isChecked = !isKeep && proxSelected.has(lm.id!);
                  return (
                    <div key={lm.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: isKeep ? '#f0fdf4' : isChecked ? '#fff1f2' : '#f8f9fa', borderRadius: 8, marginBottom: 6, border: isKeep ? '1.5px solid #86efac' : isChecked ? '1.5px solid #fca5a5' : '1.5px solid #e8eaed' }}>
                      {/* 主スポット選択ボタン */}
                      <button
                        onClick={() => {
                          if (isKeep) return;
                          // 今のkeepをselectedに追加、このlmをkeepに
                          setProxSelected(prev => { const s = new Set(prev); s.add(proxKeepId!); s.delete(lm.id!); return s; });
                          setProxKeepId(lm.id!);
                        }}
                        title="主スポットにする"
                        style={{ background: 'none', border: 'none', cursor: isKeep ? 'default' : 'pointer', fontSize: 16, padding: '0 2px', flexShrink: 0, opacity: isKeep ? 1 : 0.3 }}
                      >★</button>
                      {lm.photos[0] && <img src={lm.photos[0].url} style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: '#1f2937', fontSize: 13, fontWeight: isKeep ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lm.name}</p>
                        <p style={{ color: '#9ca3af', fontSize: 11 }}>{lm.visitCount}回{!isKeep && ` · ${Math.round(haversineKm(group[0], lm) * 1000)}m`}</p>
                      </div>
                      {isKeep ? (
                        <span style={{ color: '#15803d', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>主</span>
                      ) : (
                        <input
                          type="checkbox" checked={isChecked}
                          onChange={() => setProxSelected(prev => { const s = new Set(prev); isChecked ? s.delete(lm.id!) : s.add(lm.id!); return s; })}
                          onClick={e => e.stopPropagation()}
                          style={{ flexShrink: 0, width: 16, height: 16, cursor: 'pointer' }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 12, textAlign: 'center' }}>
                マージ後: <strong>{group.find(x => x.id === proxKeepId)?.name}</strong> — 来訪 {[...group.filter(x => x.id === proxKeepId || proxSelected.has(x.id!))].reduce((s, x) => s + x.visitCount, 0)}回
              </p>
              {proxDone > 0 && <p style={{ color: '#22c55e', fontSize: 11, textAlign: 'center', marginBottom: 8 }}>{proxDone}グループ処理済み</p>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleProxMerge} disabled={proxMerging}
                  style={{ flex: 2, background: proxMerging ? '#f3f4f6' : '#22c55e', color: proxMerging ? '#9ca3af' : '#fff', border: 'none', borderRadius: 8, padding: '10px', fontWeight: 700, fontSize: 13, cursor: proxMerging ? 'not-allowed' : 'pointer' }}
                >
                  {proxMerging ? 'マージ中...' : 'マージ'}
                </button>
                <button
                  onClick={handleProxSkip} disabled={proxMerging}
                  style={{ flex: 1, background: '#f8f9fa', color: '#6b7280', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '10px', cursor: 'pointer', fontSize: 13 }}
                >
                  スキップ
                </button>
              </div>
              <button onClick={() => setProxGroups(null)} disabled={proxMerging} style={{ width: '100%', marginTop: 8, background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>
                終了
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  search: { width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '8px 12px', fontSize: 14, outline: 'none', marginBottom: 8 },
  card: { padding: '14px 16px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', transition: 'background 0.12s' },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: '1px 3px', opacity: 0.6 },
  linkBtn: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  editInput: { width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '10px 12px', fontSize: 14, outline: 'none', display: 'block' },
  inlineInput: { flex: 1, background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #2563eb', borderRadius: 6, padding: '2px 8px', fontSize: 14, outline: 'none', marginRight: 4 },
  cancelBtn: { flex: 1, background: '#f8f9fa', color: '#6b7280', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '9px', cursor: 'pointer', fontSize: 14 },
};
