import { useEffect, useRef, useState, useCallback } from 'react';
import ReactCrop, { type Crop, centerCrop, makeAspectCrop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
  getUserCars, createCar, updateCar, deleteCar,
  getFuelLogs, addFuelLog, deleteFuelLog,
  getMaintenanceLogs, addMaintenanceLog, updateMaintenanceLog, deleteMaintenanceLog,
  uploadCarPhotoBlob, createTag,
  MAINTENANCE_LABELS,
} from '../firebase/data';
import type { Car, FuelLog, MaintenanceLog, MaintenanceType, Route, TagDef } from '../firebase/data';

const TAG_COLORS = ['#ef4444','#f97316','#f59e0b','#22c55e','#2563eb','#8b5cf6','#ec4899','#06b6d4'];

// モジュールレベルで保持（コンポーネントのアンマウント/再マウントに影響されない）
const _carPhotoBlobUrls: Record<string, string> = {};

async function resizeImage(file: File, maxPx = 800, quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
        else { width = Math.round(width * maxPx / height); height = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas toBlob failed')), 'image/jpeg', quality);
    };
    img.onerror = reject;
    img.src = url;
  });
}

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string;
  routes: Route[];
  tags: TagDef[];
  activeCar: Car | null;
  onSetActiveCar: (car: Car | null) => void;
  onTagsChange: () => void;
  onCarsChange: (cars: Car[]) => void;
  onRefreshRoutes?: () => Promise<void>;
  onWarningChange?: (hasWarning: boolean) => void;
}

type DetailTab = 'stats' | 'fuel' | 'maintenance';

// ルートのタグがcarTagIdと「同名」かどうかを判定（ID直接一致 + 名前一致の両方）
function routeMatchesCarTag(routeTags: string[], allTags: TagDef[], carTagId: string): boolean {
  const carTagName = allTags.find(t => t.id === carTagId)?.name;
  return routeTags.some(id => {
    if (id === carTagId) return true; // 削除済みtagIdがルートに残っている場合も対応
    if (!carTagName) return false;
    return allTags.find(t => t.id === id)?.name === carTagName; // 同名タグ対応
  });
}

function calcCarStats(routes: Route[], allTags: TagDef[], carTagId?: string) {
  if (!carTagId) return { totalDistance: 0, maxSpeed: 0, avgSpeed: 0, routeCount: 0 };
  const cr = routes.filter(r => routeMatchesCarTag(r.tags, allTags, carTagId));
  if (cr.length === 0) return { totalDistance: 0, maxSpeed: 0, avgSpeed: 0, routeCount: 0 };
  return {
    totalDistance: cr.reduce((s, r) => s + r.totalDistance, 0),
    maxSpeed: Math.max(...cr.map(r => r.maxSpeed)),
    avgSpeed: cr.reduce((s, r) => s + r.avgSpeed, 0) / cr.length,
    routeCount: cr.length,
  };
}

type FuelLogEnriched = FuelLog & { distanceSince?: number; efficiency?: number };

function enrichFuelLogs(logs: FuelLog[], routes: Route[], allTags: TagDef[], carTagId?: string): FuelLogEnriched[] {
  const asc = [...logs].sort((a, b) => a.timestamp - b.timestamp);
  return asc.map((log, i) => {
    if (i === 0 || !log.isFull || !carTagId) return log;
    const prevFull = asc.slice(0, i).reverse().find(l => l.isFull);
    if (!prevFull) return log;
    const distanceSince = routes
      .filter(r => routeMatchesCarTag(r.tags, allTags, carTagId) && r.startTime >= prevFull.timestamp && r.startTime <= log.timestamp)
      .reduce((s, r) => s + r.totalDistance, 0);
    const efficiency = distanceSince > 0 ? distanceSince / log.liters : undefined;
    return { ...log, distanceSince, efficiency };
  }).reverse();
}

function elapsedSince(ts: number) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 30) return `${days}日`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}ヶ月`;
  return `${Math.floor(months / 12)}年${months % 12}ヶ月`;
}

function distanceSince(ts: number, routes: Route[], allTags: TagDef[], carTagId?: string) {
  if (!carTagId) return 0;
  return routes
    .filter(r => routeMatchesCarTag(r.tags, allTags, carTagId) && r.startTime >= ts)
    .reduce((s, r) => s + r.totalDistance, 0);
}

export default function CarsPanel({ open, onClose, userId, routes, tags, activeCar, onSetActiveCar, onTagsChange, onCarsChange, onRefreshRoutes, onWarningChange }: Props) {
  const [cars, setCars] = useState<Car[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setPhotoRefresh] = useState(0); // triggers re-render after blob prefetch
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('stats');
  const [fuelLogs, setFuelLogs] = useState<Record<string, FuelLog[]>>({});
  const [maintLogs, setMaintLogs] = useState<Record<string, MaintenanceLog[]>>({});
  const [loadedFuel, setLoadedFuel] = useState<Set<string>>(new Set());
  const [loadedMaint, setLoadedMaint] = useState<Set<string>>(new Set());

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Saving states
  const [savingFuel, setSavingFuel] = useState(false);
  const [savingMaint, setSavingMaint] = useState(false);

  // Inline odometer edit (maintenance log)
  const [editOdometer, setEditOdometer] = useState<{ carId: string; logId: string; value: string } | null>(null);

  // 整備記録編集モーダル
  const [editMaintModal, setEditMaintModal] = useState<{ carId: string; log: MaintenanceLog } | null>(null);
  const [editMaintForm, setEditMaintForm] = useState<{ itemType: string; nextDueMonths: string; nextDueKm: string; notes: string }>({ itemType: '', nextDueMonths: '', nextDueKm: '', notes: '' });

  // Car total odometer edit
  const [editCarOdometer, setEditCarOdometer] = useState<{ carId: string; value: string } | null>(null);

  // Tag reassignment picker
  const [tagPickerCarId, setTagPickerCarId] = useState<string | null>(null);

  // Add car form
  const [showAddCar, setShowAddCar] = useState(false);
  const [form, setForm] = useState({ nickname: '', make: '', model: '', year: '', color: '', createTag: true, tagColor: TAG_COLORS[4], vehicleType: 'car' as 'car' | 'bicycle' });
  const [saving, setSaving] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // 既存車への写真アップロード
  const [uploadingPhotoCarId, setUploadingPhotoCarId] = useState<string | null>(null);

  // トリミングモーダル
  const [cropModal, setCropModal] = useState<{ src: string; file: File; carId: string | null } | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const cropImgRef = useRef<HTMLImageElement>(null);

  // Add fuel log form
  const [showAddFuel, setShowAddFuel] = useState<string | null>(null);
  const [fuelForm, setFuelForm] = useState({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '', date: new Date().toISOString().slice(0, 10) });

  // Add maintenance form
  const [showAddMaint, setShowAddMaint] = useState<string | null>(null);
  const [maintForm, setMaintForm] = useState<{ type: MaintenanceType; customLabel: string; itemType: string; date: string; odometerKm: string; cost: string; notes: string; nextDueMonths: string; nextDueKm: string }>({
    type: 'oil', customLabel: '', itemType: '', date: new Date().toISOString().slice(0, 10), odometerKm: '', cost: '', notes: '', nextDueMonths: '', nextDueKm: '',
  });

  useEffect(() => {
    if (!onWarningChange) return;
    const anyWarning = cars.some(car => {
      const mLogs = maintLogs[car.id!] || [];
      return mLogs.some(log => {
        const km = distanceSince(log.timestamp, routes, tags, car.tagId);
        const months = Math.floor((Date.now() - log.timestamp) / 2592000000);
        return (log.nextDueKm != null && km >= log.nextDueKm - 300) || (log.nextDueMonths != null && months >= log.nextDueMonths - 1);
      });
    });
    onWarningChange(anyWarning);
  }, [cars, maintLogs, routes, tags, onWarningChange]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let isMounted = true;
    getUserCars(userId).then(c => {
      if (!isMounted) return;
      setCars(c); onCarsChange(c); setLoading(false);
      // Firebase URLをblobに変換してキャッシュ（Electronでのimg読み込み安定化）
      c.forEach(car => {
        if (car.photoUrl && !_carPhotoBlobUrls[car.id!]) {
          fetch(car.photoUrl).then(r => r.blob()).then(b => {
            if (!isMounted) return;
            _carPhotoBlobUrls[car.id!] = URL.createObjectURL(b);
            setPhotoRefresh(n => n + 1);
          }).catch(() => {});
        }
      });
    }).catch(() => { if (isMounted) setLoading(false); });
    return () => { isMounted = false; };
  }, [open, userId]);

  const loadFuel = async (carId: string) => {
    if (loadedFuel.has(carId)) return;
    const logs = await getFuelLogs(carId);
    setFuelLogs(prev => ({ ...prev, [carId]: logs }));
    setLoadedFuel(prev => new Set([...prev, carId]));
  };

  const loadMaint = async (carId: string) => {
    if (loadedMaint.has(carId)) return;
    const logs = await getMaintenanceLogs(carId);
    setMaintLogs(prev => ({ ...prev, [carId]: logs }));
    setLoadedMaint(prev => new Set([...prev, carId]));
  };

  const handleExpand = (car: Car) => {
    if (expandedId === car.id) { setExpandedId(null); return; }
    setExpandedId(car.id!);
    setDetailTab('stats');
    loadFuel(car.id!);
    loadMaint(car.id!);
  };

  const handleSwitchTab = (tab: DetailTab, car: Car) => {
    setDetailTab(tab);
    if (tab === 'fuel') loadFuel(car.id!);
    if (tab === 'maintenance') loadMaint(car.id!);
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // 新規追加フォームの写真はトリミングモーダルへ
    const src = URL.createObjectURL(f);
    setCrop(undefined);
    setCompletedCrop(null);
    setCropModal({ src, file: f, carId: null });
  };

  const handleSaveCar = async () => {
    if (!form.nickname.trim()) return;
    setSaving(true);
    try {
      let tagId: string | undefined;
      if (form.createTag) {
        const tag = await createTag({ userId, name: form.nickname.trim(), color: form.tagColor });
        tagId = tag.id;
        onTagsChange();
      }
      const newCar = await createCar({
        userId, nickname: form.nickname.trim(),
        vehicleType: form.vehicleType,
        make: form.make.trim() || undefined,
        model: form.model.trim() || undefined,
        year: form.year ? parseInt(form.year) : undefined,
        color: form.color.trim() || undefined,
        tagId, createdAt: Date.now(),
      });
      if (photoFile) {
        const blob = await resizeImage(photoFile);
        const localUrl = URL.createObjectURL(blob);
        _carPhotoBlobUrls[newCar.id!] = localUrl;
        newCar.photoUrl = localUrl;
        const { url, storagePath } = await uploadCarPhotoBlob(userId, newCar.id!, blob);
        await updateCar(newCar.id!, { photoUrl: url, photoStoragePath: storagePath });
      }
      const updated = [...cars, newCar];
      setCars(updated);
      onCarsChange(updated);
      setShowAddCar(false);
      setForm({ nickname: '', make: '', model: '', year: '', color: '', createTag: true, tagColor: TAG_COLORS[4], vehicleType: 'car' });
      setPhotoFile(null); setPhotoPreview(null);
      showToast('愛車を追加しました');
    } finally { setSaving(false); }
  };

  const handleDeleteCar = async (car: Car) => {
    if (!confirm(`愛車「${car.nickname}」を削除しますか？\n（タグや記録されたルートは残ります）`)) return;
    await deleteCar(car.id!);
    if (car.id && _carPhotoBlobUrls[car.id]) {
      URL.revokeObjectURL(_carPhotoBlobUrls[car.id]);
      delete _carPhotoBlobUrls[car.id];
    }
    if (activeCar?.id === car.id) onSetActiveCar(null);
    const updated = cars.filter(c => c.id !== car.id);
    setCars(updated);
    onCarsChange(updated);
    if (expandedId === car.id) setExpandedId(null);
  };

  const handleSaveFuel = async (carId: string) => {
    if (!fuelForm.liters) return;
    setSavingFuel(true);
    try {
      const fuelData: Parameters<typeof addFuelLog>[1] = {
        timestamp: new Date(fuelForm.date).getTime(),
        liters: parseFloat(fuelForm.liters),
        isFull: fuelForm.isFull,
      };
      if (fuelForm.pricePerLiter) fuelData.pricePerLiter = parseFloat(fuelForm.pricePerLiter);
      if (fuelForm.totalCost) fuelData.totalCost = parseFloat(fuelForm.totalCost);
      if (fuelForm.notes.trim()) fuelData.notes = fuelForm.notes.trim();
      const log = await addFuelLog(carId, fuelData);
      setFuelLogs(prev => ({ ...prev, [carId]: [log, ...(prev[carId] || [])] }));
      setShowAddFuel(null);
      setFuelForm({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '', date: new Date().toISOString().slice(0, 10) });
      showToast('給油記録を保存しました');
    } catch {
      showToast('保存に失敗しました', 'error');
    } finally {
      setSavingFuel(false);
    }
  };

  const handleDeleteFuel = async (carId: string, logId: string) => {
    if (!confirm('この給油記録を削除しますか？')) return;
    await deleteFuelLog(carId, logId);
    setFuelLogs(prev => ({ ...prev, [carId]: (prev[carId] || []).filter(l => l.id !== logId) }));
    showToast('削除しました');
  };

  const handleSaveMaint = async (carId: string) => {
    setSavingMaint(true);
    try {
      // YYYY-MM-DD → ローカル時刻として解釈
      const [y, m, d] = maintForm.date.split('-').map(Number);
      const maintData: Parameters<typeof addMaintenanceLog>[1] = {
        type: maintForm.type,
        timestamp: new Date(y, m - 1, d).getTime(),
      };
      if (maintForm.type === 'other' && maintForm.customLabel.trim()) maintData.customLabel = maintForm.customLabel.trim();
      if ((maintForm.type === 'oil' || maintForm.type === 'tire') && maintForm.itemType.trim()) maintData.itemType = maintForm.itemType.trim();
      if (maintForm.odometerKm) maintData.odometerKm = parseFloat(maintForm.odometerKm);
      if (maintForm.cost) maintData.cost = parseFloat(maintForm.cost);
      if (maintForm.notes.trim()) maintData.notes = maintForm.notes.trim();
      if (maintForm.nextDueMonths) maintData.nextDueMonths = parseInt(maintForm.nextDueMonths);
      if (maintForm.nextDueKm) maintData.nextDueKm = parseFloat(maintForm.nextDueKm);
      const log = await addMaintenanceLog(carId, maintData);
      setMaintLogs(prev => ({ ...prev, [carId]: [log, ...(prev[carId] || [])] }));
      setShowAddMaint(null);
      setMaintForm({ type: 'oil', customLabel: '', itemType: '', date: new Date().toISOString().slice(0, 10), odometerKm: '', cost: '', notes: '', nextDueMonths: '', nextDueKm: '' });
      showToast('整備記録を保存しました');
    } catch (err) {
      console.error('addMaintenanceLog error:', err);
      showToast('保存に失敗しました', 'error');
    } finally {
      setSavingMaint(false);
    }
  };

  const handleDeleteMaint = async (carId: string, logId: string) => {
    if (!confirm('この整備記録を削除しますか？')) return;
    await deleteMaintenanceLog(carId, logId);
    setMaintLogs(prev => ({ ...prev, [carId]: (prev[carId] || []).filter(l => l.id !== logId) }));
    showToast('削除しました');
  };

  const openEditMaint = (carId: string, log: MaintenanceLog) => {
    setEditMaintModal({ carId, log });
    setEditMaintForm({
      itemType: log.itemType || '',
      nextDueMonths: log.nextDueMonths?.toString() || '',
      nextDueKm: log.nextDueKm?.toString() || '',
      notes: log.notes || '',
    });
  };

  const handleUpdateMaint = async () => {
    if (!editMaintModal) return;
    const { carId, log } = editMaintModal;
    // Firestoreはundefinedを拒否するので、値があるフィールドのみセット
    const patch: Record<string, unknown> = {};
    if (editMaintForm.itemType.trim()) patch.itemType = editMaintForm.itemType.trim();
    if (editMaintForm.nextDueMonths) patch.nextDueMonths = parseInt(editMaintForm.nextDueMonths);
    if (editMaintForm.nextDueKm) patch.nextDueKm = parseFloat(editMaintForm.nextDueKm);
    if (editMaintForm.notes.trim()) patch.notes = editMaintForm.notes.trim();
    await updateMaintenanceLog(carId, log.id!, patch as Parameters<typeof updateMaintenanceLog>[2]);
    setMaintLogs(prev => ({
      ...prev,
      [carId]: (prev[carId] || []).map(l => l.id === log.id ? { ...l, ...patch } : l),
    }));
    setEditMaintModal(null);
    showToast('整備記録を更新しました');
  };

  const handleCarPhotoChange = (e: React.ChangeEvent<HTMLInputElement>, carId: string) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    const src = URL.createObjectURL(f);
    setCrop(undefined);
    setCompletedCrop(null);
    setCropModal({ src, file: f, carId });
  };

  const getCroppedBlob = useCallback(async (): Promise<Blob> => {
    const img = cropImgRef.current;
    if (!img || !completedCrop) throw new Error('no crop');
    const canvas = document.createElement('canvas');
    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;
    const c = completedCrop as PixelCrop;
    canvas.width = c.width;
    canvas.height = c.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, c.x * scaleX, c.y * scaleY, c.width * scaleX, c.height * scaleY, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.9));
  }, [completedCrop]);

  const handleCropConfirm = async () => {
    if (!cropModal) return;
    const { carId } = cropModal;
    try {
      const rawBlob = completedCrop ? await getCroppedBlob() : await resizeImage(cropModal.file);
      const blob = completedCrop ? rawBlob : rawBlob;
      const resized = await resizeImage(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      const localUrl = URL.createObjectURL(resized);

      if (carId) {
        // 既存車の写真更新
        if (_carPhotoBlobUrls[carId]) URL.revokeObjectURL(_carPhotoBlobUrls[carId]);
        _carPhotoBlobUrls[carId] = localUrl;
        setCars(prev => prev.map(c => c.id === carId ? { ...c, photoUrl: localUrl } : c));
        setCropModal(null);
        setUploadingPhotoCarId(carId);
        try {
          const { url, storagePath } = await uploadCarPhotoBlob(userId, carId, resized);
          await updateCar(carId, { photoUrl: url, photoStoragePath: storagePath });
          showToast('写真を更新しました');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`アップロード失敗: ${msg.slice(0, 60)}`, 'error');
        } finally {
          setUploadingPhotoCarId(null);
        }
      } else {
        // 新規追加フォームの写真
        setPhotoFile(new File([resized], 'photo.jpg', { type: 'image/jpeg' }));
        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoPreview(localUrl);
        setCropModal(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`処理失敗: ${msg.slice(0, 60)}`, 'error');
      setCropModal(null);
    }
  };

  const handleSaveCarOdometer = async (carId: string, value: string) => {
    const km = parseFloat(value);
    if (isNaN(km) || km < 0) { setEditCarOdometer(null); return; }
    await updateCar(carId, { odometerKm: km });
    setCars(prev => prev.map(c => c.id === carId ? { ...c, odometerKm: km } : c));
    setEditCarOdometer(null);
    showToast('走行距離を更新しました');
  };

  const handleChangeCarTag = async (carId: string, newTagId: string) => {
    await updateCar(carId, { tagId: newTagId });
    setCars(prev => prev.map(c => c.id === carId ? { ...c, tagId: newTagId } : c));
    setTagPickerCarId(null);
    showToast('タグを更新しました');
  };

  const handleSaveOdometer = async (carId: string, logId: string, value: string) => {
    const km = parseFloat(value);
    if (isNaN(km) || km < 0) { setEditOdometer(null); return; }
    await updateMaintenanceLog(carId, logId, { odometerKm: km });
    setMaintLogs(prev => ({
      ...prev,
      [carId]: (prev[carId] || []).map(l => l.id === logId ? { ...l, odometerKm: km } : l),
    }));
    setEditOdometer(null);
    showToast('走行距離を更新しました');
  };

  // トリミングモーダル（open状態に関係なく表示）
  if (cropModal) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ color: '#fff', fontSize: 15, fontWeight: 600 }}>トリミング範囲を選択</div>
        <ReactCrop
          crop={crop}
          onChange={c => setCrop(c)}
          onComplete={c => setCompletedCrop(c)}
        >
          <img
            ref={cropImgRef}
            src={cropModal.src}
            style={{ maxWidth: '80vw', maxHeight: '60vh', borderRadius: 8 }}
            onLoad={e => {
              const { width, height } = e.currentTarget;
              const c = centerCrop(makeAspectCrop({ unit: '%', width: 80 }, 1, width, height), width, height);
              setCrop(c);
            }}
          />
        </ReactCrop>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={handleCropConfirm} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>確定</button>
          <button onClick={() => { URL.revokeObjectURL(cropModal.src); setCropModal(null); }} style={{ background: '#fff', color: '#374151', border: '1px solid #e8eaed', borderRadius: 8, padding: '10px 24px', fontSize: 14, cursor: 'pointer' }}>キャンセル</button>
        </div>
      </div>
    );
  }

  if (!open) return null;

  return (
    <>
      <div style={s.overlay} onClick={e => { if (e.clientX < 360) onClose(); }} />
      {/* トースト */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, background: toast.type === 'error' ? '#ef4444' : '#1f2937',
          color: '#fff', borderRadius: 10, padding: '10px 20px', fontSize: 14,
          fontWeight: 600, boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
          animation: 'fadeInUp 0.2s ease',
        }}>
          {toast.type === 'error' ? '✕' : '✓'} {toast.msg}
        </div>
      )}
      <div style={s.panel}>
        {/* ヘッダー */}
        <div style={s.header}>
          <span style={s.title}>🚗 愛車管理</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* アクティブ車 */}
        <div style={{ padding: '10px 20px', background: '#f8f9fa', borderBottom: '1px solid #e8eaed' }}>
          {activeCar ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>記録中の愛車:</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#2563eb' }}>{activeCar.nickname}</span>
              <button onClick={() => onSetActiveCar(null)} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #e8eaed', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 11, color: '#9ca3af' }}>解除</button>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>愛車を選択すると記録時に自動タグ付けされます</span>
          )}
        </div>

        {/* 愛車一覧 */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32, fontSize: 14 }}>読み込み中...</p>}

          {!loading && cars.length === 0 && !showAddCar && (
            <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 40, fontSize: 14, lineHeight: 1.8 }}>
              愛車がまだ登録されていません<br />下の「愛車を追加」から登録してください
            </p>
          )}

          {cars.map(car => {
            const isExpanded = expandedId === car.id;
            const isActive = activeCar?.id === car.id;
            const stats = calcCarStats(routes, tags, car.tagId);
            const tag = tags.find(t => t.id === car.tagId);
            const fLogs = fuelLogs[car.id!] || [];
            const enriched = enrichFuelLogs(fLogs, routes, tags, car.tagId);
            const avgEfficiency = enriched.filter(l => l.efficiency != null).map(l => l.efficiency!);
            const avgEff = avgEfficiency.length > 0 ? avgEfficiency.reduce((a, b) => a + b) / avgEfficiency.length : null;
            const mLogs = maintLogs[car.id!] || [];
            const hasWarning = mLogs.some(log => {
              const km = distanceSince(log.timestamp, routes, tags, car.tagId);
              const months = Math.floor((Date.now() - log.timestamp) / 2592000000);
              return (log.nextDueKm != null && km >= log.nextDueKm - 300) || (log.nextDueMonths != null && months >= log.nextDueMonths - 1);
            });

            return (
              <div key={car.id} style={{ borderBottom: '1px solid #e8eaed' }}>
                {/* カードヘッダー */}
                <div style={{ padding: '14px 18px', cursor: 'pointer', background: isActive ? '#eff6ff' : isExpanded ? '#f8faff' : '#fff', borderLeft: isActive ? '4px solid #2563eb' : '4px solid transparent', transition: 'background 0.15s, border-color 0.15s' }} onClick={() => handleExpand(car)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    {/* 写真 */}
                    <label
                      htmlFor={`car-photo-${car.id}`}
                      style={{ width: 52, height: 52, borderRadius: '50%', background: '#f3f4f6', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative', border: '2px solid #e8eaed' }}
                      onClick={e => e.stopPropagation()}
                      title="写真を変更"
                    >
                      {uploadingPhotoCarId === car.id
                        ? <span style={{ fontSize: 12, color: '#9ca3af' }}>...</span>
                        : (_carPhotoBlobUrls[car.id!] || car.photoUrl)
                          ? <img src={_carPhotoBlobUrls[car.id!] || car.photoUrl} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ fontSize: 26 }}>{car.vehicleType === 'bicycle' ? '🚲' : '🚗'}</span>}
                      <div style={{ position: 'absolute', bottom: 0, right: 0, width: 18, height: 18, background: '#2563eb', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #fff', fontSize: 9 }}>📷</div>
                      <input
                        id={`car-photo-${car.id}`}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={e => handleCarPhotoChange(e, car.id!)}
                      />
                    </label>
                    {/* 情報 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{car.nickname}</span>
                        {isActive && <span style={{ fontSize: 10, background: '#22c55e', color: '#fff', borderRadius: 10, padding: '2px 7px', fontWeight: 600 }}>記録中</span>}
                        {tag && <span style={{ fontSize: 10, background: tag.color, color: '#fff', borderRadius: 10, padding: '2px 7px' }}>{tag.name}</span>}
                        {hasWarning && (
                          <span title="整備サイクル超過" style={{ fontSize: 15, lineHeight: 1 }}>⚠️</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {[car.make, car.model, car.year && `${car.year}年`, car.color].filter(Boolean).join(' / ')}
                      </div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                        <span>📏 {stats.totalDistance.toFixed(0)}km</span>
                        {stats.routeCount > 0 && <span>⚡ 最高{stats.maxSpeed.toFixed(0)}km/h</span>}
                        {avgEff && <span>⛽ {avgEff.toFixed(1)}km/L</span>}
                        <span>{stats.routeCount}ルート</span>
                      </div>
                    </div>
                    {/* アクション */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                      <button
                        style={{ ...s.smallBtn, ...(isActive ? { background: '#2563eb', color: '#fff', borderColor: '#2563eb', fontWeight: 700 } : { background: '#f8f9fa', color: '#374151' }) }}
                        onClick={e => { e.stopPropagation(); onSetActiveCar(isActive ? null : car); }}
                      >
                        {isActive ? '✓ 使用中' : '選択する'}
                      </button>
                      <button style={{ ...s.smallBtn, color: '#ef4444', borderColor: '#fecaca' }} onClick={e => { e.stopPropagation(); handleDeleteCar(car); }}>削除</button>
                    </div>
                  </div>
                </div>

                {/* 展開パネル */}
                {isExpanded && (
                  <div style={{ background: '#f8faff', borderTop: '1px solid #e8eaed' }}>
                    {/* フルワイド写真 */}
                    {(_carPhotoBlobUrls[car.id!] || car.photoUrl) && (
                      <div style={{ position: 'relative' }}>
                        <img
                          src={_carPhotoBlobUrls[car.id!] || car.photoUrl}
                          style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }}
                        />
                        <button
                          onClick={async e => {
                            e.stopPropagation();
                            const src = _carPhotoBlobUrls[car.id!] || car.photoUrl!;
                            // URLからBlobを取得してFileに変換
                            const res = await fetch(src);
                            const blob = await res.blob();
                            const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
                            setCrop(undefined);
                            setCompletedCrop(null);
                            setCropModal({ src: URL.createObjectURL(blob), file, carId: car.id! });
                          }}
                          style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(0,0,0,0.45)', color: '#fff', border: 'none', borderRadius: '50%', width: 28, height: 28, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          title="トリミング"
                        >
                          ✂️
                        </button>
                      </div>
                    )}
                    {/* タブ */}
                    <div style={{ display: 'flex', borderBottom: '1px solid #e8eaed' }}>
                      {(['stats', ...(car.vehicleType !== 'bicycle' ? ['fuel'] : []), 'maintenance'] as DetailTab[]).map(tab => (
                        <button
                          key={tab}
                          onClick={() => handleSwitchTab(tab, car)}
                          style={{ flex: 1, padding: '10px 4px', background: 'none', border: 'none', borderBottom: detailTab === tab ? '2px solid #2563eb' : '2px solid transparent', color: detailTab === tab ? '#2563eb' : '#6b7280', cursor: 'pointer', fontSize: 12, fontWeight: detailTab === tab ? 700 : 400 }}
                        >
                          {tab === 'stats' ? '📊 統計' : tab === 'fuel' ? '⛽ 燃費' : (
                            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              🔧 整備
                              {hasWarning && <span style={{ width: 7, height: 7, background: '#ef4444', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>

                    {/* 統計タブ */}
                    {detailTab === 'stats' && (
                      <div style={{ padding: '16px 18px' }}>
                        {/* タグ表示と変更 */}
                        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>統計タグ:</span>
                          {tag
                            ? <span style={{ fontSize: 11, background: tag.color, color: '#fff', borderRadius: 10, padding: '2px 8px', fontWeight: 600 }}>{tag.name}</span>
                            : <span style={{ fontSize: 11, color: '#ef4444' }}>未設定 / 削除済み</span>
                          }
                          <button
                            onClick={() => setTagPickerCarId(tagPickerCarId === car.id ? null : car.id!)}
                            style={{ fontSize: 11, color: '#2563eb', background: 'none', border: '1px solid #bfdbfe', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}
                          >
                            変更
                          </button>
                          {stats.routeCount === 0 && car.tagId && (
                            <span style={{ fontSize: 11, color: '#f59e0b' }}>⚠ ルートが見つかりません</span>
                          )}
                        </div>
                        {/* タグピッカー */}
                        {tagPickerCarId === car.id && (
                          <div style={{ background: '#f8f9fa', border: '1px solid #e8eaed', borderRadius: 8, padding: 10, marginBottom: 12 }}>
                            <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>統計に使うタグを選択:</p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {tags.map(t => (
                                <button
                                  key={t.id}
                                  onClick={() => { if (car.id && t.id) handleChangeCarTag(car.id, t.id); }}
                                  style={{ fontSize: 11, background: car.tagId === t.id ? t.color : '#fff', color: car.tagId === t.id ? '#fff' : '#374151', border: `1px solid ${t.color}`, borderRadius: 10, padding: '3px 10px', cursor: 'pointer', fontWeight: car.tagId === t.id ? 700 : 400 }}
                                >
                                  {t.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {onRefreshRoutes && (
                          <button
                            onClick={async () => { await onRefreshRoutes(); showToast('統計を更新しました'); }}
                            style={{ width: '100%', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '7px', color: '#0369a1', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 12 }}
                          >
                            🔄 ルートを再読み込みして統計を更新
                          </button>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          {/* 総走行距離（編集可能） */}
                          <div
                            style={{ background: '#fff', borderRadius: 10, padding: '12px 14px', border: '1px solid #e8eaed', cursor: 'pointer' }}
                            title="クリックして編集"
                            onClick={() => setEditCarOdometer({ carId: car.id!, value: (car.odometerKm ?? stats.totalDistance).toFixed(0) })}
                          >
                            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                              総走行距離
                              <span style={{ fontSize: 10, color: '#2563eb' }}>✏ 編集</span>
                            </div>
                            {editCarOdometer?.carId === car.id ? (
                              <input
                                autoFocus
                                type="number"
                                value={editCarOdometer.value}
                                onChange={e => setEditCarOdometer(prev => prev ? { ...prev, value: e.target.value } : null)}
                                onBlur={() => handleSaveCarOdometer(car.id!, editCarOdometer.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSaveCarOdometer(car.id!, editCarOdometer.value); if (e.key === 'Escape') setEditCarOdometer(null); }}
                                style={{ width: '100%', fontSize: 16, fontWeight: 700, border: '1.5px solid #2563eb', borderRadius: 6, padding: '2px 6px', outline: 'none', boxSizing: 'border-box' }}
                                onClick={e => e.stopPropagation()}
                              />
                            ) : (
                              <div style={{ fontSize: 18, fontWeight: 700, color: '#1f2937' }}>
                                {(car.odometerKm ?? stats.totalDistance).toFixed(1)} km
                                {car.odometerKm != null && <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400, marginLeft: 4 }}>手動</span>}
                              </div>
                            )}
                          </div>
                          {[
                            { label: '最高速度', value: `${stats.maxSpeed.toFixed(0)} km/h` },
                            { label: '平均速度', value: `${stats.avgSpeed.toFixed(0)} km/h` },
                            { label: '走行記録', value: `${stats.routeCount} 件` },
                            { label: '平均燃費', value: avgEff ? `${avgEff.toFixed(1)} km/L` : '—', sub: avgEff ? `${avgEfficiency.length}回分` : '燃費タブで記録' },
                          ].map(item => (
                            <div key={item.label} style={{ background: '#fff', borderRadius: 10, padding: '12px 14px', border: '1px solid #e8eaed' }}>
                              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{item.label}</div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: '#1f2937' }}>{item.value}</div>
                              {'sub' in item && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{item.sub}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 燃費タブ */}
                    {detailTab === 'fuel' && (
                      <div style={{ padding: '12px 18px' }}>
                        <button
                          onClick={() => setShowAddFuel(car.id!)}
                          style={{ width: '100%', background: '#fff', border: '1.5px dashed #2563eb', borderRadius: 8, padding: '8px', color: '#2563eb', cursor: 'pointer', fontSize: 13, marginBottom: 10 }}
                        >
                          + 給油を記録
                        </button>
                        {enriched.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>給油記録がありません</p>}
                        {enriched.map(log => (
                          <div key={log.id} style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', marginBottom: 8, border: '1px solid #e8eaed' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <div>
                                <div style={{ fontSize: 12, color: '#9ca3af' }}>{new Date(log.timestamp).toLocaleDateString('ja-JP')}</div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', marginTop: 2 }}>
                                  {log.liters.toFixed(2)} L
                                  {log.totalCost && <span style={{ color: '#6b7280', fontWeight: 400, fontSize: 12 }}> ／ ¥{log.totalCost.toLocaleString()}</span>}
                                  {log.pricePerLiter && <span style={{ color: '#6b7280', fontWeight: 400, fontSize: 12 }}> ({log.pricePerLiter.toFixed(0)}円/L)</span>}
                                </div>
                                {log.distanceSince != null && (
                                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                                    走行: {log.distanceSince.toFixed(1)} km
                                    {log.efficiency && <span style={{ color: '#2563eb', fontWeight: 600, marginLeft: 8 }}> → {log.efficiency.toFixed(1)} km/L</span>}
                                  </div>
                                )}
                                {!log.isFull && <span style={{ fontSize: 10, color: '#f59e0b', background: '#fef3c7', borderRadius: 4, padding: '1px 5px' }}>非満タン</span>}
                              </div>
                              <button onClick={() => handleDeleteFuel(car.id!, log.id!)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>🗑</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 整備タブ */}
                    {detailTab === 'maintenance' && (
                      <div style={{ padding: '12px 18px' }}>
                        <button
                          onClick={() => setShowAddMaint(car.id!)}
                          style={{ width: '100%', background: '#fff', border: '1.5px dashed #2563eb', borderRadius: 8, padding: '8px', color: '#2563eb', cursor: 'pointer', fontSize: 13, marginBottom: 10 }}
                        >
                          + 整備を記録
                        </button>
                        {mLogs.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>整備記録がありません</p>}
                        {mLogs.map(log => {
                          const elapsed = elapsedSince(log.timestamp);
                          const kmDriven = distanceSince(log.timestamp, routes, tags, car.tagId);
                          const label = log.type === 'other' ? (log.customLabel || 'その他') : MAINTENANCE_LABELS[log.type];
                          const nextMonthsOk = log.nextDueMonths ? Math.floor((Date.now() - log.timestamp) / 2592000000) < log.nextDueMonths - 1 : true;
                          const nextKmOk = log.nextDueKm ? kmDriven < log.nextDueKm - 300 : true;
                          const isWarning = !nextMonthsOk || !nextKmOk;
                          return (
                            <div key={log.id} style={{ borderRadius: 8, padding: '10px 12px', marginBottom: 8, border: `1px solid ${isWarning ? '#fca5a5' : '#e8eaed'}`, background: isWarning ? '#fff5f5' : '#fff' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: '#1f2937' }}>{label}</span>
                                    {isWarning && <span style={{ fontSize: 10, background: '#ef4444', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>要点検</span>}
                                  </div>
                                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{new Date(log.timestamp).toLocaleDateString('ja-JP')}</div>
                                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                                    経過: <strong>{elapsed}</strong> / {kmDriven.toFixed(0)} km
                                  </div>
                                  {(log.nextDueMonths || log.nextDueKm) && (
                                    <div style={{ fontSize: 11, color: isWarning ? '#ef4444' : '#9ca3af', marginTop: 2 }}>
                                      次回目安: {log.nextDueMonths && `${log.nextDueMonths}ヶ月`} {log.nextDueKm && `/ ${log.nextDueKm.toLocaleString()}km`}
                                    </div>
                                  )}
                                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    施工時:&nbsp;
                                    {editOdometer?.logId === log.id ? (
                                      <input
                                        autoFocus
                                        type="number"
                                        value={editOdometer?.value ?? ''}
                                        onChange={e => setEditOdometer(prev => prev ? { ...prev, value: e.target.value } : null)}
                                        onBlur={() => editOdometer && handleSaveOdometer(car.id!, log.id!, editOdometer.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && editOdometer) handleSaveOdometer(car.id!, log.id!, editOdometer.value); if (e.key === 'Escape') setEditOdometer(null); }}
                                        style={{ width: 80, fontSize: 11, padding: '1px 4px', border: '1px solid #2563eb', borderRadius: 4, outline: 'none' }}
                                        onClick={e => e.stopPropagation()}
                                      />
                                    ) : (
                                      <span
                                        style={{ cursor: 'pointer', borderBottom: '1px dashed #d1d5db', color: log.odometerKm ? '#6b7280' : '#d1d5db' }}
                                        title="クリックして編集"
                                        onClick={e => { e.stopPropagation(); setEditOdometer({ carId: car.id!, logId: log.id!, value: log.odometerKm?.toString() ?? '' }); }}
                                      >
                                        {log.odometerKm ? `${log.odometerKm.toLocaleString()} km` : '-- km (タップして入力)'}
                                      </span>
                                    )}
                                  </div>
                                  {log.itemType && <div style={{ fontSize: 11, color: '#6b7280' }}>種類: {log.itemType}</div>}
                                  {log.cost && <div style={{ fontSize: 11, color: '#9ca3af' }}>¥{log.cost.toLocaleString()}</div>}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <button onClick={() => openEditMaint(car.id!, log)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', fontSize: 13 }}>✏️</button>
                                  <button onClick={() => handleDeleteMaint(car.id!, log.id!)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>🗑</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 愛車追加フォーム */}
          {showAddCar && (
            <div style={{ padding: '16px 18px', background: '#f8faff', borderBottom: '1px solid #e8eaed' }}>
              <p style={s.sectionTitle}>新しい愛車を追加</p>

              {/* 写真 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div
                  style={{ width: 64, height: 64, borderRadius: 12, background: '#f3f4f6', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '2px dashed #e8eaed' }}
                  onClick={() => photoInputRef.current?.click()}
                >
                  {photoPreview ? <img src={photoPreview} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 32 }}>📷</span>}
                </div>
                <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>写真をタップして選択</span>
              </div>

              {/* 種別トグル */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {(['car', 'bicycle'] as const).map(vt => (
                  <button
                    key={vt}
                    onClick={() => setForm(f => ({ ...f, vehicleType: vt }))}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1.5px solid ${form.vehicleType === vt ? '#2563eb' : '#e8eaed'}`, background: form.vehicleType === vt ? '#eff6ff' : '#f8f9fa', color: form.vehicleType === vt ? '#2563eb' : '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: form.vehicleType === vt ? 700 : 400 }}
                  >
                    {vt === 'car' ? '🚗 車' : '🚲 自転車'}
                  </button>
                ))}
              </div>

              <input style={s.input} placeholder="ニックネーム（必須）例: 俺のプリウス" value={form.nickname} onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <input style={s.input} placeholder="メーカー（例: Toyota）" value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
                <input style={s.input} placeholder="車種（例: Prius）" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
                <input style={s.input} placeholder="年式（例: 2022）" type="number" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
                <input style={s.input} placeholder="色（例: ホワイト）" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
              </div>

              {/* タグ自動作成 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                  <input type="checkbox" checked={form.createTag} onChange={e => setForm(f => ({ ...f, createTag: e.target.checked }))} />
                  タグを自動作成（ルート紐付け用）
                </label>
              </div>
              {form.createTag && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  {TAG_COLORS.map(c => (
                    <button key={c} onClick={() => setForm(f => ({ ...f, tagColor: c }))} style={{ width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer', border: form.tagColor === c ? '3px solid #1f2937' : '2px solid transparent', outline: form.tagColor === c ? '2px solid #fff' : 'none', outlineOffset: -3 }} />
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleSaveCar} disabled={saving || !form.nickname.trim()} style={{ flex: 1, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px', cursor: 'pointer', fontSize: 14, fontWeight: 600, opacity: saving || !form.nickname.trim() ? 0.6 : 1 }}>
                  {saving ? '保存中...' : '追加'}
                </button>
                <button onClick={() => { setShowAddCar(false); setForm({ nickname: '', make: '', model: '', year: '', color: '', createTag: true, tagColor: TAG_COLORS[4], vehicleType: 'car' }); setPhotoFile(null); setPhotoPreview(null); }} style={{ flex: 1, background: '#f8f9fa', color: '#374151', border: '1px solid #e8eaed', borderRadius: 8, padding: '10px', cursor: 'pointer', fontSize: 14 }}>
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 追加ボタン */}
        {!showAddCar && (
          <div style={{ padding: '12px 18px', borderTop: '1px solid #e8eaed' }}>
            <button onClick={() => setShowAddCar(true)} style={{ width: '100%', background: '#f8f9fa', border: '1.5px dashed #2563eb', borderRadius: 10, padding: '12px', color: '#2563eb', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              + 愛車を追加
            </button>
          </div>
        )}
      </div>

      {/* 給油記録モーダル */}
      {/* 整備記録編集モーダル */}
      {editMaintModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setEditMaintModal(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700, marginBottom: 4 }}>✏️ 整備記録を編集</h3>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>{MAINTENANCE_LABELS[editMaintModal.log.type]} — {new Date(editMaintModal.log.timestamp).toLocaleDateString('ja-JP')}</div>
            {(editMaintModal.log.type === 'oil' || editMaintModal.log.type === 'tire') && (
              <input style={s.input} placeholder={editMaintModal.log.type === 'oil' ? 'オイル銘柄（任意）' : 'タイヤ銘柄（任意）'} value={editMaintForm.itemType} onChange={e => setEditMaintForm(f => ({ ...f, itemType: e.target.value }))} />
            )}
            <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>次回目安</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={s.input} placeholder="〇ヶ月後" type="number" value={editMaintForm.nextDueMonths} onChange={e => setEditMaintForm(f => ({ ...f, nextDueMonths: e.target.value }))} />
              <input style={s.input} placeholder="〇km後" type="number" value={editMaintForm.nextDueKm} onChange={e => setEditMaintForm(f => ({ ...f, nextDueKm: e.target.value }))} />
            </div>
            <input style={s.input} placeholder="メモ（任意）" value={editMaintForm.notes} onChange={e => setEditMaintForm(f => ({ ...f, notes: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleUpdateMaint} style={{ flex: 1, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>保存</button>
              <button onClick={() => setEditMaintModal(null)} style={{ flex: 1, background: '#f8f9fa', color: '#374151', border: '1px solid #e8eaed', borderRadius: 8, padding: '10px', cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {showAddFuel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowAddFuel(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700, marginBottom: 16 }}>⛽ 給油を記録</h3>
            <input style={s.input} type="date" value={fuelForm.date} onChange={e => setFuelForm(f => ({ ...f, date: e.target.value }))} />
            <input style={s.input} placeholder="給油量 (L) ※必須" type="number" step="0.01" value={fuelForm.liters} onChange={e => setFuelForm(f => ({ ...f, liters: e.target.value }))} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={s.input} placeholder="単価 (円/L)" type="number" value={fuelForm.pricePerLiter} onChange={e => setFuelForm(f => ({ ...f, pricePerLiter: e.target.value }))} />
              <input style={s.input} placeholder="合計金額 (円)" type="number" value={fuelForm.totalCost} onChange={e => setFuelForm(f => ({ ...f, totalCost: e.target.value }))} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={fuelForm.isFull} onChange={e => setFuelForm(f => ({ ...f, isFull: e.target.checked }))} />
              満タン給油（燃費計算に使用）
            </label>
            <input style={s.input} placeholder="メモ（任意）" value={fuelForm.notes} onChange={e => setFuelForm(f => ({ ...f, notes: e.target.value }))} />
            <button onClick={() => handleSaveFuel(showAddFuel)} disabled={!fuelForm.liters || savingFuel} style={{ width: '100%', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '11px', cursor: 'pointer', fontSize: 14, fontWeight: 600, opacity: !fuelForm.liters || savingFuel ? 0.6 : 1 }}>
              {savingFuel ? '保存中...' : '記録する'}
            </button>
          </div>
        </div>
      )}

      {/* 整備記録モーダル */}
      {showAddMaint && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowAddMaint(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.2)', maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: '#1f2937', fontSize: 16, fontWeight: 700, marginBottom: 16 }}>🔧 整備を記録</h3>
            <select style={{ ...s.input, background: '#f8f9fa' }} value={maintForm.type} onChange={e => setMaintForm(f => ({ ...f, type: e.target.value as MaintenanceType }))}>
              {(Object.keys(MAINTENANCE_LABELS) as MaintenanceType[]).map(t => (
                <option key={t} value={t}>{MAINTENANCE_LABELS[t]}</option>
              ))}
            </select>
            {maintForm.type === 'other' && (
              <input style={s.input} placeholder="内容を入力" value={maintForm.customLabel} onChange={e => setMaintForm(f => ({ ...f, customLabel: e.target.value }))} />
            )}
            {(maintForm.type === 'oil' || maintForm.type === 'tire') && (
              <input style={s.input} placeholder={maintForm.type === 'oil' ? 'オイル銘柄（例: Mobil 5W-30）任意' : 'タイヤ銘柄（例: MICHELIN Pilot Sport）任意'} value={maintForm.itemType} onChange={e => setMaintForm(f => ({ ...f, itemType: e.target.value }))} />
            )}
            <input style={s.input} type="date" value={maintForm.date} onChange={e => setMaintForm(f => ({ ...f, date: e.target.value }))} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={s.input} placeholder="施工時走行距離 (km)" type="number" value={maintForm.odometerKm} onChange={e => setMaintForm(f => ({ ...f, odometerKm: e.target.value }))} />
              <input style={s.input} placeholder="費用 (円)" type="number" value={maintForm.cost} onChange={e => setMaintForm(f => ({ ...f, cost: e.target.value }))} />
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>次回目安（どちらか or 両方）</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={s.input} placeholder="〇ヶ月後" type="number" value={maintForm.nextDueMonths} onChange={e => setMaintForm(f => ({ ...f, nextDueMonths: e.target.value }))} />
              <input style={s.input} placeholder="〇km後" type="number" value={maintForm.nextDueKm} onChange={e => setMaintForm(f => ({ ...f, nextDueKm: e.target.value }))} />
            </div>
            <input style={s.input} placeholder="メモ（任意）" value={maintForm.notes} onChange={e => setMaintForm(f => ({ ...f, notes: e.target.value }))} />
            <button onClick={() => handleSaveMaint(showAddMaint)} disabled={savingMaint} style={{ width: '100%', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '11px', cursor: 'pointer', fontSize: 14, fontWeight: 600, opacity: savingMaint ? 0.6 : 1 }}>
              {savingMaint ? '保存中...' : '記録する'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000 },
  panel:        { position: 'fixed', top: 0, left: 360, right: 0, height: '100vh', background: '#fff', zIndex: 2001, display: 'flex', flexDirection: 'column', boxShadow: '0 4px 32px rgba(0,0,0,0.18)', overflowY: 'hidden', borderLeft: '1px solid #e8eaed' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 20px', borderBottom: '1px solid #e8eaed', flexShrink: 0 },
  title:        { color: '#1f2937', fontSize: 17, fontWeight: 700 },
  closeBtn:     { background: 'none', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer' },
  sectionTitle: { color: '#9ca3af', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 10, fontWeight: 600 },
  smallBtn:     { background: '#f8f9fa', border: '1px solid #e8eaed', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 500, color: '#374151', whiteSpace: 'nowrap' as const },
  input:        { width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '9px 12px', fontSize: 13, outline: 'none', marginBottom: 8, boxSizing: 'border-box' as const },
};
