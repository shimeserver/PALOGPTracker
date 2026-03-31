import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useUiStore } from '../../src/store/uiStore';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert,
  TextInput, Modal, Switch,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useAuthStore } from '../../src/store/authStore';
import { useCarStore } from '../../src/store/carStore';
import {
  getUserCars, getUserCarsFromServer, createCar, updateCar, deleteCar, createCarTag,
  getFuelLogs, addFuelLog, deleteFuelLog,
  getMaintenanceLogs, addMaintenanceLog, deleteMaintenanceLog, updateMaintenanceLog,
  uploadCarPhoto, getRouteStatsByTag, RouteStats, getUserTags, TagDef,
} from '../../src/firebase/cars';
import { getUserRoutesMetadata, RouteMetadata } from '../../src/firebase/routes';
import { Car, FuelLog, MaintenanceLog, MaintenanceType, MAINTENANCE_LABELS } from '../../src/types';
import HelpModal from '../../src/components/HelpModal';

interface PeriodStats { km: number; calories: number; steps?: number; }
interface ActivityStats {
  today: PeriodStats; month: PeriodStats; year: PeriodStats; total: PeriodStats;
}

function calcActivityStats(routes: RouteMetadata[], mode: 'walk' | 'bicycle', kcalPerKm: number): ActivityStats {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const yearStart  = new Date(now.getFullYear(), 0, 1).getTime();
  const filtered = routes.filter(r => r.mode === mode);
  const make = (arr: RouteMetadata[]): PeriodStats => {
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

const CARS_HELP = [
  { q: '愛車の追加方法は？', a: '「＋ 愛車を追加」ボタンから車名・メーカー・タグカラーなどを入力して登録できます。' },
  { q: 'アクティブ車とは？', a: '現在記録中のルートに紐づく車です。タップで切り替えられます。' },
  { q: 'タグとは？', a: 'ルートと車を紐づけるカラータグです。記録時に自動的に選択中の車タグが付きます。' },
  { q: '燃費はどう記録する？', a: '車のカードを開き「燃料」タブから給油記録を追加できます。' },
  { q: 'メンテナンス管理は？', a: '「整備」タブからオイル交換・タイヤ交換などの記録と次回予定が管理できます。' },
];

const TAG_COLORS = ['#ef4444','#f97316','#f59e0b','#22c55e','#2563eb','#8b5cf6','#ec4899','#06b6d4'];

type DetailTab = 'stats' | 'fuel' | 'maintenance';

function elapsedSince(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 30) return `${days}日`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}ヶ月`;
  return `${Math.floor(months / 12)}年${months % 12}ヶ月`;
}

function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(msg);
    timer.current = setTimeout(() => setToast(null), 2500);
  };
  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  return { toast, show };
}

export default function CarsScreen() {
  const { user } = useAuthStore();
  const { activeCar, setActiveCar, setMaintenanceWarning } = useCarStore();
  const { toast, show: showToast } = useToast();
  const [cars, setCars] = useState<Car[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('stats');
  const [fuelLogs, setFuelLogs] = useState<Record<string, FuelLog[]>>({});
  const [maintLogs, setMaintLogs] = useState<Record<string, MaintenanceLog[]>>({});
  const [routeStats, setRouteStats] = useState<Record<string, RouteStats>>({});
  const [statsLoading, setStatsLoading] = useState<Record<string, boolean>>({});

  // アクティビティ統計
  const [allRoutes, setAllRoutes] = useState<RouteMetadata[]>([]);
  const walkStats    = calcActivityStats(allRoutes, 'walk',    60);
  const bicycleStats = calcActivityStats(allRoutes, 'bicycle', 40);
  const [walkExpanded,    setWalkExpanded]    = useState(false);
  const [bicycleExpanded, setBicycleExpanded] = useState(false);

  // Add car modal
  const [showAddCar, setShowAddCar] = useState(false);
  const [form, setForm] = useState({ nickname: '', make: '', model: '', year: '', color: '', tagColor: TAG_COLORS[4], vehicleType: 'car' as 'car' | 'bicycle' });
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Add fuel modal
  const [showAddFuel, setShowAddFuel] = useState<string | null>(null);
  const [fuelForm, setFuelForm] = useState({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '' });
  const [savingFuel, setSavingFuel] = useState(false);

  // Add maintenance modal
  const [showAddMaint, setShowAddMaint] = useState<string | null>(null);
  const [maintForm, setMaintForm] = useState<{
    type: MaintenanceType; customLabel: string; itemType: string; odometerKm: string;
    cost: string; notes: string; nextDueMonths: string; nextDueKm: string;
  }>({ type: 'oil', customLabel: '', itemType: '', odometerKm: '', cost: '', notes: '', nextDueMonths: '', nextDueKm: '' });
  const [savingMaint, setSavingMaint] = useState(false);

  // Odometer inline edit
  const [editOdometerCarId, setEditOdometerCarId] = useState<string | null>(null);
  const [editOdometerValue, setEditOdometerValue] = useState('');

  // Tag picker
  const [userTags, setUserTags] = useState<TagDef[]>([]);
  const [tagPickerCarId, setTagPickerCarId] = useState<string | null>(null);
  const { helpTarget, setHelpTarget } = useUiStore();
  const showHelp = helpTarget === 'cars';

  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    getUserCars(user.uid)
      .then(c => { if (isMounted) { setCars(c); setLoading(false); } })
      .catch(() => { if (isMounted) { setLoading(false); Alert.alert('エラー', 'データの読み込みに失敗しました'); } });
    getUserTags(user.uid).then(t => { if (isMounted) setUserTags(t); }).catch(() => {});
    getUserRoutesMetadata(user.uid).then(r => { if (isMounted) setAllRoutes(r); }).catch(() => {});
    return () => { isMounted = false; };
  }, [user?.uid]);


  // タブフォーカス時にサーバーから強制再フェッチ（30秒クールダウン）
  const lastFocusFetchRef = useRef(0);
  useFocusEffect(useCallback(() => {
    if (!user) return;
    const now = Date.now();
    if (now - lastFocusFetchRef.current < 30000) return;
    lastFocusFetchRef.current = now;
    getUserCarsFromServer(user.uid).then(c => setCars(c)).catch(() => {});
  }, [user?.uid]));

  // 整備警告をグローバルストアに同期（タブアイコンバッジ用）
  useEffect(() => {
    const anyWarning = cars.some(car => {
      const mLogs = maintLogs[car.id!] || [];
      const stats = routeStats[car.id!] as (RouteStats & { distanceAfter?: number }) | undefined;
      const distAfter = stats?.distanceAfter ?? 0;
      const kmDriven = car.odometerKm != null ? car.odometerKm + distAfter : 0;
      return mLogs.some(log => {
        const monthsElapsed = Math.floor((Date.now() - log.timestamp) / 2592000000);
        if (log.nextDueMonths && monthsElapsed >= log.nextDueMonths - 1) return true;
        if (log.nextDueKm && log.odometerKm && kmDriven > 0) {
          return (kmDriven - log.odometerKm) >= log.nextDueKm - 300;
        }
        return false;
      });
    });
    setMaintenanceWarning(anyWarning);
  }, [cars, maintLogs, setMaintenanceWarning]);

  const loadFuel = async (carId: string, force = false) => {
    if (fuelLogs[carId] && !force) return;
    const logs = await getFuelLogs(carId);
    setFuelLogs(prev => ({ ...prev, [carId]: logs }));
  };

  const loadMaint = async (carId: string, force = false) => {
    if (maintLogs[carId] && !force) return;
    const logs = await getMaintenanceLogs(carId);
    setMaintLogs(prev => ({ ...prev, [carId]: logs }));
  };

  const loadStats = async (car: Car, force = false) => {
    if (!user || !car.tagId) return;
    if (routeStats[car.id!] && !force) return;
    setStatsLoading(prev => ({ ...prev, [car.id!]: true }));
    try {
      const stats = await getRouteStatsByTag(user.uid, car.tagId);
      // odometerSetAt 以降のルートのみ加算距離として別取得
      const afterStats = car.odometerSetAt != null
        ? await getRouteStatsByTag(user.uid, car.tagId, car.odometerSetAt)
        : null;
      setRouteStats(prev => ({ ...prev, [car.id!]: { ...stats, distanceAfter: afterStats?.totalDistance } as RouteStats & { distanceAfter?: number } }));
    } finally {
      setStatsLoading(prev => ({ ...prev, [car.id!]: false }));
    }
  };

  const handleExpand = (car: Car) => {
    if (expandedId === car.id) { setExpandedId(null); return; }
    setExpandedId(car.id!);
    setDetailTab('stats');
    loadFuel(car.id!);
    loadMaint(car.id!);
    loadStats(car);
  };

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('エラー', 'カメラロールへのアクセス許可が必要です'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, allowsEditing: true, aspect: [1, 1] });
    if (!result.canceled && result.assets[0]) setPhotoUri(result.assets[0].uri);
  };

  const handleUpdateCarPhoto = async (car: Car) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('エラー', 'カメラロールへのアクセス許可が必要です'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, allowsEditing: true, aspect: [1, 1] });
    if (!result.canceled && result.assets[0] && car.id) {
      try {
        const { url } = await uploadCarPhoto(user!.uid, car.id, result.assets[0].uri);
        await updateCar(car.id, { photoUrl: url });
        setCars(prev => prev.map(c => c.id === car.id ? { ...c, photoUrl: url } : c));
        showToast('写真を更新しました');
      } catch {
        showToast('写真の更新に失敗しました');
      }
    }
  };

  const handleSaveCar = async () => {
    if (!user || !form.nickname.trim()) return;
    setSaving(true);
    try {
      const tagId = await createCarTag(user.uid, form.nickname.trim(), form.tagColor);
      const carData: Parameters<typeof createCar>[0] = {
        userId: user.uid,
        nickname: form.nickname.trim(),
        vehicleType: form.vehicleType,
        tagId,
        createdAt: Date.now(),
      };
      if (form.make.trim()) carData.make = form.make.trim();
      if (form.model.trim()) carData.model = form.model.trim();
      if (form.year) carData.year = parseInt(form.year);
      if (form.color.trim()) carData.color = form.color.trim();
      const car = await createCar(carData);
      if (photoUri && car.id) {
        try {
          const { url } = await uploadCarPhoto(user.uid, car.id, photoUri);
          await updateCar(car.id, { photoUrl: url });
          car.photoUrl = url;
        } catch {
          Alert.alert('警告', 'カーを作成しましたが、写真のアップロードに失敗しました');
        }
      }
      setCars(prev => [...prev, car]);
      setShowAddCar(false);
      setForm({ nickname: '', make: '', model: '', year: '', color: '', tagColor: TAG_COLORS[4], vehicleType: 'car' });
      setPhotoUri(null);
      showToast('愛車を追加しました');
    } finally { setSaving(false); }
  };

  const handleDeleteCar = (car: Car) => {
    Alert.alert('削除確認', `「${car.nickname}」を削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive',
        onPress: async () => {
          await deleteCar(car.id!);
          if (activeCar?.id === car.id) setActiveCar(null);
          setCars(prev => prev.filter(c => c.id !== car.id));
          if (expandedId === car.id) setExpandedId(null);
          showToast('削除しました');
        },
      },
    ]);
  };

  const handleSaveFuel = async (carId: string) => {
    if (!fuelForm.liters || savingFuel) return;
    setSavingFuel(true);
    try {
      const logData: Parameters<typeof addFuelLog>[1] = {
        timestamp: Date.now(),
        liters: parseFloat(fuelForm.liters),
        isFull: fuelForm.isFull,
      };
      if (fuelForm.pricePerLiter) logData.pricePerLiter = parseFloat(fuelForm.pricePerLiter);
      if (fuelForm.totalCost) logData.totalCost = parseFloat(fuelForm.totalCost);
      if (fuelForm.notes.trim()) logData.notes = fuelForm.notes.trim();
      const log = await addFuelLog(carId, logData);
      setFuelLogs(prev => ({ ...prev, [carId]: [log, ...(prev[carId] || [])] }));
      setShowAddFuel(null);
      setFuelForm({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '' });
      showToast('給油記録を保存しました');
    } catch {
      showToast('保存に失敗しました');
    } finally { setSavingFuel(false); }
  };

  const handleDeleteFuel = (carId: string, log: FuelLog) => {
    Alert.alert('削除', 'この給油記録を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: async () => {
        await deleteFuelLog(carId, log.id!);
        setFuelLogs(prev => ({ ...prev, [carId]: (prev[carId] || []).filter(l => l.id !== log.id) }));
        showToast('削除しました');
      }},
    ]);
  };

  const handleSaveMaint = async (carId: string) => {
    if (savingMaint) return;
    setSavingMaint(true);
    try {
      const logData: Parameters<typeof addMaintenanceLog>[1] = {
        type: maintForm.type,
        timestamp: Date.now(),
      };
      if (maintForm.type === 'other' && maintForm.customLabel.trim()) logData.customLabel = maintForm.customLabel.trim();
      if ((maintForm.type === 'oil' || maintForm.type === 'tire') && maintForm.itemType.trim()) logData.itemType = maintForm.itemType.trim();
      if (maintForm.odometerKm) logData.odometerKm = parseFloat(maintForm.odometerKm);
      if (maintForm.cost) logData.cost = parseFloat(maintForm.cost);
      if (maintForm.notes.trim()) logData.notes = maintForm.notes.trim();
      if (maintForm.nextDueMonths) logData.nextDueMonths = parseInt(maintForm.nextDueMonths);
      if (maintForm.nextDueKm) logData.nextDueKm = parseFloat(maintForm.nextDueKm);
      const log = await addMaintenanceLog(carId, logData);
      setMaintLogs(prev => ({ ...prev, [carId]: [log, ...(prev[carId] || [])] }));
      setShowAddMaint(null);
      setMaintForm({ type: 'oil', customLabel: '', itemType: '', odometerKm: '', cost: '', notes: '', nextDueMonths: '', nextDueKm: '' });
      showToast('整備記録を保存しました');
    } catch {
      showToast('保存に失敗しました');
    } finally { setSavingMaint(false); }
  };

  const handleDeleteMaint = (carId: string, log: MaintenanceLog) => {
    Alert.alert('削除', 'この整備記録を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: async () => {
        await deleteMaintenanceLog(carId, log.id!);
        setMaintLogs(prev => ({ ...prev, [carId]: (prev[carId] || []).filter(l => l.id !== log.id) }));
        showToast('削除しました');
      }},
    ]);
  };

  const handleSaveCarOdometer = async (car: Car) => {
    const val = parseFloat(editOdometerValue);
    setEditOdometerCarId(null);
    if (isNaN(val) || val < 0) return;
    const setAt = Date.now();
    await updateCar(car.id!, { odometerKm: val, odometerSetAt: setAt });
    setCars(prev => prev.map(c => c.id === car.id ? { ...c, odometerKm: val, odometerSetAt: setAt } : c));
    showToast('走行距離を保存しました');
  };

  const handleChangeCarTag = async (car: Car, newTagId: string) => {
    await updateCar(car.id!, { tagId: newTagId });
    setCars(prev => prev.map(c => c.id === car.id ? { ...c, tagId: newTagId } : c));
    setTagPickerCarId(null);
    // 統計を再読み込み
    setRouteStats(prev => { const n = { ...prev }; delete n[car.id!]; return n; });
    showToast('タグを変更しました');
  };

  return (
    <View style={styles.container}>
      <HelpModal visible={showHelp} onClose={() => setHelpTarget(null)} title="愛車画面の使い方" items={CARS_HELP} />
      <ScrollView style={styles.list}>
        {/* 歩行統計カード */}
        <TouchableOpacity
          style={[styles.actCard, { borderLeftColor: '#22c55e' }]}
          onPress={() => setWalkExpanded(e => !e)}
          activeOpacity={0.85}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: walkExpanded ? 12 : 0 }}>
            <Text style={styles.actCardTitle}>🚶 歩行</Text>
            <Text style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 12 }}>{walkExpanded ? '▲' : '▼ 詳細'}</Text>
          </View>
          {!walkExpanded ? (
            <View style={styles.actGrid}>
              <View style={styles.actCell}><Text style={styles.actVal}>{walkStats.today.km.toFixed(2)}</Text><Text style={styles.actLbl}>今日 km</Text></View>
              <View style={styles.actCell}><Text style={styles.actVal}>{walkStats.month.km.toFixed(1)}</Text><Text style={styles.actLbl}>今月 km</Text></View>
              <View style={styles.actCell}><Text style={styles.actVal}>{walkStats.year.km.toFixed(1)}</Text><Text style={styles.actLbl}>今年 km</Text></View>
              <View style={styles.actCell}><Text style={styles.actVal}>{walkStats.total.km.toFixed(1)}</Text><Text style={styles.actLbl}>累計 km</Text></View>
              <View style={styles.actCell}><Text style={styles.actVal}>{walkStats.total.calories.toLocaleString()}</Text><Text style={styles.actLbl}>累計 kcal</Text></View>
              <View style={styles.actCell}><Text style={styles.actVal}>{(walkStats.total.steps ?? 0).toLocaleString()}</Text><Text style={styles.actLbl}>累計 歩</Text></View>
            </View>
          ) : (
            <View>
              {([
                { label: '今日', p: walkStats.today },
                { label: '今月', p: walkStats.month },
                { label: '今年', p: walkStats.year },
                { label: '累計', p: walkStats.total },
              ] as const).map(({ label, p }) => (
                <View key={label} style={styles.actDetailRow}>
                  <Text style={styles.actDetailPeriod}>{label}</Text>
                  <View style={styles.actDetailCell}><Text style={styles.actDetailVal}>{p.km.toFixed(2)}</Text><Text style={styles.actDetailLbl}>km</Text></View>
                  <View style={styles.actDetailCell}><Text style={styles.actDetailVal}>{p.calories.toLocaleString()}</Text><Text style={styles.actDetailLbl}>kcal</Text></View>
                  <View style={styles.actDetailCell}><Text style={styles.actDetailVal}>{(p.steps ?? 0).toLocaleString()}</Text><Text style={styles.actDetailLbl}>歩</Text></View>
                </View>
              ))}
            </View>
          )}
        </TouchableOpacity>

        {/* 自転車統計カード */}
        {(cars.some(c => c.vehicleType === 'bicycle') || bicycleStats.total.km > 0) && (
          <TouchableOpacity
            style={[styles.actCard, { borderLeftColor: '#f59e0b' }]}
            onPress={() => setBicycleExpanded(e => !e)}
            activeOpacity={0.85}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: bicycleExpanded ? 12 : 0 }}>
              <Text style={styles.actCardTitle}>🚲 自転車</Text>
              <Text style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 12 }}>{bicycleExpanded ? '▲' : '▼ 詳細'}</Text>
            </View>
            {!bicycleExpanded ? (
              <View style={styles.actGrid}>
                <View style={styles.actCell}><Text style={styles.actVal}>{bicycleStats.today.km.toFixed(2)}</Text><Text style={styles.actLbl}>今日 km</Text></View>
                <View style={styles.actCell}><Text style={styles.actVal}>{bicycleStats.month.km.toFixed(1)}</Text><Text style={styles.actLbl}>今月 km</Text></View>
                <View style={styles.actCell}><Text style={styles.actVal}>{bicycleStats.year.km.toFixed(1)}</Text><Text style={styles.actLbl}>今年 km</Text></View>
                <View style={styles.actCell}><Text style={styles.actVal}>{bicycleStats.total.km.toFixed(1)}</Text><Text style={styles.actLbl}>累計 km</Text></View>
                <View style={styles.actCell}><Text style={styles.actVal}>{bicycleStats.total.calories.toLocaleString()}</Text><Text style={styles.actLbl}>累計 kcal</Text></View>
              </View>
            ) : (
              <View>
                {([
                  { label: '今日', p: bicycleStats.today },
                  { label: '今月', p: bicycleStats.month },
                  { label: '今年', p: bicycleStats.year },
                  { label: '累計', p: bicycleStats.total },
                ] as const).map(({ label, p }) => (
                  <View key={label} style={styles.actDetailRow}>
                    <Text style={styles.actDetailPeriod}>{label}</Text>
                    <View style={styles.actDetailCell}><Text style={styles.actDetailVal}>{p.km.toFixed(2)}</Text><Text style={styles.actDetailLbl}>km</Text></View>
                    <View style={styles.actDetailCell}><Text style={styles.actDetailVal}>{p.calories.toLocaleString()}</Text><Text style={styles.actDetailLbl}>kcal</Text></View>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        )}

        {loading && <Text style={styles.empty}>読み込み中...</Text>}
        {!loading && cars.length === 0 && (
          <Text style={styles.empty}>愛車が登録されていません{'\n'}下の「追加」から登録してください</Text>
        )}

        {cars.map(car => {
          const isExpanded = expandedId === car.id;
          const isActive = activeCar?.id === car.id;
          const fLogs = fuelLogs[car.id!] || [];
          const mLogs = maintLogs[car.id!] || [];
          const stats = routeStats[car.id!] as (RouteStats & { distanceAfter?: number }) | undefined;
          const distanceAfter = stats?.distanceAfter ?? 0;
          const kmDriven = car.odometerKm != null
            ? car.odometerKm + distanceAfter
            : (stats?.totalDistance ?? 0);

          // 警告チェック: 期限1ヶ月前 or 300km前から警告
          const hasWarning = mLogs.some(log => {
            const monthsElapsed = Math.floor((Date.now() - log.timestamp) / 2592000000);
            if (log.nextDueMonths && monthsElapsed >= log.nextDueMonths - 1) return true;
            if (log.nextDueKm && log.odometerKm && kmDriven > 0) {
              const kmSince = kmDriven - log.odometerKm;
              if (kmSince >= log.nextDueKm - 300) return true;
            }
            return false;
          });

          return (
            <View key={car.id} style={[styles.carCard, isActive && styles.carCardActive]}>
              {/* カードヘッダー */}
              <TouchableOpacity style={styles.carHeader} onPress={() => handleExpand(car)}>
                <TouchableOpacity style={styles.carIcon} onPress={() => handleUpdateCarPhoto(car)}>
                  {car.photoUrl
                    ? <Image source={{ uri: car.photoUrl }} style={{ width: 52, height: 52, borderRadius: 26 }} cachePolicy="memory-disk" />
                    : <Text style={{ fontSize: 28 }}>{car.vehicleType === 'bicycle' ? '🚲' : '🚗'}</Text>}
                  <View style={styles.carIconEditBadge}><Text style={{ color: '#fff', fontSize: 8 }}>📷</Text></View>
                </TouchableOpacity>
                <View style={styles.carInfo}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.carName}>{car.nickname}</Text>
                    {isActive && <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>記録中</Text></View>}
                    {hasWarning && <Text style={{ fontSize: 16 }}>⚠️</Text>}
                  </View>
                  <Text style={styles.carDetail}>
                    {[car.make, car.model, car.year && `${car.year}年`, car.color].filter(Boolean).join(' / ') || '車両情報未設定'}
                  </Text>
                </View>
                <View style={{ gap: 6 }}>
                  <TouchableOpacity
                    style={[styles.selectBtn, isActive && styles.selectBtnActive]}
                    onPress={() => setActiveCar(isActive ? null : car)}
                  >
                    <Text style={[styles.selectBtnText, isActive && styles.selectBtnTextActive]}>
                      {isActive ? '✓ 使用中' : '選択'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteCar(car)}>
                    <Text style={styles.deleteText}>削除</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>

              {/* フルワイド写真（展開時） */}
              {isExpanded && car.photoUrl && (
                <Image
                  source={{ uri: car.photoUrl }}
                  style={{ width: '100%', height: 180 }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              )}

              {/* 展開パネル */}
              {isExpanded && (
                <View style={styles.detailPanel}>
                  {/* タブ */}
                  <View style={styles.tabs}>
                    {(car.vehicleType === 'bicycle'
                      ? ['stats', 'maintenance'] as DetailTab[]
                      : ['stats', 'fuel', 'maintenance'] as DetailTab[]
                    ).map(tab => (
                      <TouchableOpacity
                        key={tab}
                        style={[styles.tab, detailTab === tab && styles.tabActive]}
                        onPress={() => {
                          setDetailTab(tab);
                          if (tab === 'fuel') loadFuel(car.id!);
                          if (tab === 'maintenance') loadMaint(car.id!);
                          if (tab === 'stats') loadStats(car);
                        }}
                      >
                        <Text style={[styles.tabText, detailTab === tab && styles.tabTextActive]}>
                          {tab === 'stats' ? '📊 統計' : tab === 'fuel' ? '⛽ 燃費' : '🔧 整備'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* 統計タブ */}
                  {detailTab === 'stats' && (
                    <View style={styles.tabContent}>
                      {/* 統計タグ表示・変更 */}
                      {(() => {
                        const carTag = userTags.find(t => t.id === car.tagId);
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                            <Text style={{ fontSize: 11, color: '#9ca3af' }}>統計タグ:</Text>
                            {carTag
                              ? <View style={{ backgroundColor: carTag.color, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}><Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{carTag.name}</Text></View>
                              : <Text style={{ fontSize: 11, color: '#ef4444' }}>未設定 / 削除済み</Text>
                            }
                            <TouchableOpacity
                              onPress={() => setTagPickerCarId(tagPickerCarId === car.id ? null : car.id!)}
                              style={{ borderWidth: 1, borderColor: '#bfdbfe', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}
                            >
                              <Text style={{ fontSize: 11, color: '#2563eb' }}>変更</Text>
                            </TouchableOpacity>
                            {stats && stats.count === 0 && car.tagId && (
                              <Text style={{ fontSize: 11, color: '#f59e0b' }}>⚠ ルートが見つかりません</Text>
                            )}
                          </View>
                        );
                      })()}
                      {/* タグピッカー */}
                      {tagPickerCarId === car.id && (
                        <View style={{ backgroundColor: '#f8f9fa', borderRadius: 8, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: '#e8eaed' }}>
                          <Text style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>統計に使うタグを選択:</Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {userTags.map(t => (
                              <TouchableOpacity
                                key={t.id}
                                onPress={() => { if (t.id) handleChangeCarTag(car, t.id); }}
                                style={{ backgroundColor: car.tagId === t.id ? t.color : '#fff', borderWidth: 1, borderColor: t.color, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}
                              >
                                <Text style={{ color: car.tagId === t.id ? '#fff' : '#374151', fontSize: 12, fontWeight: car.tagId === t.id ? '700' : '400' }}>{t.name}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                      )}
                      {/* 総走行距離（編集可能） */}
                      <View style={styles.statsDistCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <Text style={styles.statsDistLabel}>総走行距離</Text>
                          {car.odometerKm != null && distanceAfter > 0 && (
                            <View style={styles.manualBadge}><Text style={styles.manualBadgeText}>+{distanceAfter.toFixed(0)}km</Text></View>
                          )}
                        </View>
                        {editOdometerCarId === car.id ? (
                          <TextInput
                            style={styles.odometerInput}
                            value={editOdometerValue}
                            onChangeText={setEditOdometerValue}
                            keyboardType="decimal-pad"
                            autoFocus
                            onBlur={() => handleSaveCarOdometer(car)}
                            onSubmitEditing={() => handleSaveCarOdometer(car)}
                            placeholder="km"
                            placeholderTextColor="#9ca3af"
                          />
                        ) : (
                          <TouchableOpacity
                            onPress={() => {
                              setEditOdometerCarId(car.id!);
                              setEditOdometerValue(kmDriven > 0 ? kmDriven.toFixed(1) : '');
                            }}
                          >
                            <Text style={styles.statsDistValue}>
                              {kmDriven > 0 ? `${kmDriven.toFixed(1)} km` : '—'}
                              <Text style={styles.statsDistEdit}>  ✏ 編集</Text>
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      {/* ルート統計グリッド */}
                      {statsLoading[car.id!] ? (
                        <Text style={styles.empty}>読み込み中...</Text>
                      ) : stats ? (
                        <>
                          <View style={styles.statsGrid}>
                            <View style={styles.statCell}>
                              <Text style={styles.statValue}>{stats.count}</Text>
                              <Text style={styles.statLabel}>記録ルート数</Text>
                            </View>
                            <View style={styles.statCell}>
                              <Text style={styles.statValue}>{stats.maxSpeed > 0 ? `${stats.maxSpeed.toFixed(0)}` : '—'}</Text>
                              <Text style={styles.statLabel}>最高速度 km/h</Text>
                            </View>
                            <View style={styles.statCell}>
                              <Text style={styles.statValue}>{stats.avgSpeed > 0 ? `${stats.avgSpeed.toFixed(0)}` : '—'}</Text>
                              <Text style={styles.statLabel}>平均速度 km/h</Text>
                            </View>
                            <View style={styles.statCell}>
                              {(() => {
                                const fullLogs = fLogs.filter(l => l.isFull);
                                const totalLiters = fLogs.reduce((s, l) => s + l.liters, 0);
                                const eff = totalLiters > 0 && kmDriven > 0 ? kmDriven / totalLiters : null;
                                return (
                                  <>
                                    <Text style={styles.statValue}>{eff ? eff.toFixed(1) : '—'}</Text>
                                    <Text style={styles.statLabel}>平均燃費 km/L</Text>
                                  </>
                                );
                              })()}
                            </View>
                          </View>
                          <TouchableOpacity
                            style={styles.refreshBtn}
                            onPress={() => loadStats(car, true)}
                          >
                            <Text style={styles.refreshBtnText}>🔄 ルートから統計を更新</Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <View>
                          {!car.tagId ? (
                            <Text style={styles.empty}>タグが未設定のため統計を取得できません</Text>
                          ) : (
                            <TouchableOpacity
                              style={styles.refreshBtn}
                              onPress={() => loadStats(car, true)}
                            >
                              <Text style={styles.refreshBtnText}>🔄 ルートから統計を取得</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                    </View>
                  )}

                  {/* 燃費タブ */}
                  {detailTab === 'fuel' && (
                    <View style={styles.tabContent}>
                      <TouchableOpacity style={styles.addLogBtn} onPress={() => setShowAddFuel(car.id!)}>
                        <Text style={styles.addLogBtnText}>+ 給油を記録</Text>
                      </TouchableOpacity>
                      {fLogs.length === 0 && <Text style={styles.empty}>給油記録がありません</Text>}
                      {fLogs.map(log => (
                        <TouchableOpacity key={log.id} style={styles.logItem} onLongPress={() => handleDeleteFuel(car.id!, log)}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.logDate}>{new Date(log.timestamp).toLocaleDateString('ja-JP')}</Text>
                            <Text style={styles.logMain}>{log.liters.toFixed(2)} L{log.totalCost ? `  ¥${log.totalCost.toLocaleString()}` : ''}</Text>
                            {log.pricePerLiter && <Text style={styles.logSub}>{log.pricePerLiter.toFixed(0)}円/L</Text>}
                            {!log.isFull && <Text style={styles.notFull}>非満タン</Text>}
                          </View>
                          <Text style={styles.logDelete}>長押し削除</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  {/* 整備タブ */}
                  {detailTab === 'maintenance' && (
                    <View style={styles.tabContent}>
                      <TouchableOpacity style={styles.addLogBtn} onPress={() => setShowAddMaint(car.id!)}>
                        <Text style={styles.addLogBtnText}>+ 整備を記録</Text>
                      </TouchableOpacity>
                      {mLogs.length === 0 && <Text style={styles.empty}>整備記録がありません</Text>}
                      {mLogs.map(log => {
                        const label = log.type === 'other' ? (log.customLabel || 'その他') : MAINTENANCE_LABELS[log.type];
                        const elapsed = elapsedSince(log.timestamp);
                        const monthsElapsed = Math.floor((Date.now() - log.timestamp) / 2592000000);
                        const warnMonths = !!(log.nextDueMonths && monthsElapsed >= log.nextDueMonths - 1);
                        const warnKm = !!(log.nextDueKm && log.odometerKm && kmDriven > 0 && (kmDriven - log.odometerKm) >= log.nextDueKm - 300);
                        const isWarning = warnMonths || warnKm;
                        return (
                          <TouchableOpacity key={log.id} style={[styles.logItem, isWarning ? styles.logItemWarning : undefined]} onLongPress={() => handleDeleteMaint(car.id!, log)}>
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text style={styles.logMain}>{label}</Text>
                                {isWarning && <View style={styles.warnBadge}><Text style={styles.warnBadgeText}>要点検</Text></View>}
                              </View>
                              <Text style={styles.logDate}>{new Date(log.timestamp).toLocaleDateString('ja-JP')}</Text>
                              <Text style={styles.logSub}>経過: {elapsed}</Text>
                              {log.odometerKm && <Text style={styles.logSub}>施工時: {log.odometerKm.toLocaleString()} km</Text>}
                              {log.nextDueMonths && <Text style={[styles.logSub, warnMonths ? { color: '#ef4444' } : undefined]}>次回目安: {log.nextDueMonths}ヶ月後</Text>}
                              {log.nextDueKm && <Text style={[styles.logSub, warnKm ? { color: '#ef4444' } : undefined]}>次回目安: +{log.nextDueKm.toLocaleString()}km</Text>}
                            </View>
                            <Text style={styles.logDelete}>長押し削除</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </View>
          );
        })}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* 追加ボタン */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.addCarBtn} onPress={() => setShowAddCar(true)}>
          <Text style={styles.addCarBtnText}>+ 愛車を追加</Text>
        </TouchableOpacity>
      </View>

      {/* トースト */}
      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {/* 愛車追加モーダル */}
      <Modal visible={showAddCar} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{form.vehicleType === 'bicycle' ? '🚲' : '🚗'} 愛車を追加</Text>
            {/* 車両タイプ選択 */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
              {(['car', 'bicycle'] as const).map(vt => (
                <TouchableOpacity
                  key={vt}
                  onPress={() => setForm(f => ({ ...f, vehicleType: vt }))}
                  style={[styles.vtBtn, form.vehicleType === vt && styles.vtBtnActive]}
                >
                  <Text style={{ fontSize: 20 }}>{vt === 'car' ? '🚗' : '🚲'}</Text>
                  <Text style={[styles.vtBtnText, form.vehicleType === vt && styles.vtBtnTextActive]}>
                    {vt === 'car' ? '車' : '自転車'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={handlePickPhoto} style={styles.photoPickerBtn}>
              {photoUri
                ? <Image source={{ uri: photoUri }} style={styles.photoPreview} />
                : <Text style={styles.photoPickerText}>📷 写真を選択（任意）</Text>}
            </TouchableOpacity>
            <TextInput style={styles.input} placeholder="ニックネーム（必須）" placeholderTextColor="#9ca3af" value={form.nickname} onChangeText={v => setForm(f => ({ ...f, nickname: v }))} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="メーカー" placeholderTextColor="#9ca3af" value={form.make} onChangeText={v => setForm(f => ({ ...f, make: v }))} />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="車種" placeholderTextColor="#9ca3af" value={form.model} onChangeText={v => setForm(f => ({ ...f, model: v }))} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="年式" placeholderTextColor="#9ca3af" keyboardType="numeric" value={form.year} onChangeText={v => setForm(f => ({ ...f, year: v }))} />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="色" placeholderTextColor="#9ca3af" value={form.color} onChangeText={v => setForm(f => ({ ...f, color: v }))} />
            </View>
            <Text style={styles.sectionLabel}>タグカラー（ルート自動タグ付け用）</Text>
            <View style={styles.colorRow}>
              {TAG_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setForm(f => ({ ...f, tagColor: c }))}
                  style={[styles.colorDot, { backgroundColor: c }, form.tagColor === c && styles.colorDotActive]}
                />
              ))}
            </View>
            <TouchableOpacity style={[styles.modalButton, (!form.nickname.trim() || saving) && { opacity: 0.5 }]} onPress={handleSaveCar} disabled={!form.nickname.trim() || saving}>
              <Text style={styles.modalButtonText}>{saving ? '保存中...' : '追加する'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowAddCar(false); setForm({ nickname: '', make: '', model: '', year: '', color: '', tagColor: TAG_COLORS[4], vehicleType: 'car' }); setPhotoUri(null); }}>
              <Text style={styles.modalCancel}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 給油記録モーダル */}
      <Modal visible={!!showAddFuel} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>⛽ 給油を記録</Text>
            <TextInput style={styles.input} placeholder="給油量 (L) ※必須" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={fuelForm.liters} onChangeText={v => setFuelForm(f => ({ ...f, liters: v }))} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="単価 (円/L)" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={fuelForm.pricePerLiter} onChangeText={v => setFuelForm(f => ({ ...f, pricePerLiter: v }))} />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="合計 (円)" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={fuelForm.totalCost} onChangeText={v => setFuelForm(f => ({ ...f, totalCost: v }))} />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>満タン給油（燃費計算に使用）</Text>
              <Switch value={fuelForm.isFull} onValueChange={v => setFuelForm(f => ({ ...f, isFull: v }))} trackColor={{ true: '#2563eb' }} />
            </View>
            <TextInput style={styles.input} placeholder="メモ（任意）" placeholderTextColor="#9ca3af" value={fuelForm.notes} onChangeText={v => setFuelForm(f => ({ ...f, notes: v }))} />
            <TouchableOpacity
              style={[styles.modalButton, (!fuelForm.liters || savingFuel) && { opacity: 0.5 }]}
              onPress={() => showAddFuel && handleSaveFuel(showAddFuel)}
              disabled={!fuelForm.liters || savingFuel}
            >
              <Text style={styles.modalButtonText}>{savingFuel ? '保存中...' : '記録する'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAddFuel(null)}>
              <Text style={styles.modalCancel}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 整備記録モーダル */}
      <Modal visible={!!showAddMaint} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <ScrollView>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>🔧 整備を記録</Text>
              <View style={styles.typeGrid}>
                {(Object.keys(MAINTENANCE_LABELS) as MaintenanceType[]).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.typeBtn, maintForm.type === t && styles.typeBtnActive]}
                    onPress={() => setMaintForm(f => ({ ...f, type: t }))}
                  >
                    <Text style={[styles.typeBtnText, maintForm.type === t && styles.typeBtnTextActive]}>{MAINTENANCE_LABELS[t]}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {maintForm.type === 'other' && (
                <TextInput style={styles.input} placeholder="内容を入力" placeholderTextColor="#9ca3af" value={maintForm.customLabel} onChangeText={v => setMaintForm(f => ({ ...f, customLabel: v }))} />
              )}
              {(maintForm.type === 'oil' || maintForm.type === 'tire') && (
                <TextInput style={styles.input} placeholder={maintForm.type === 'oil' ? 'オイル銘柄（例: Mobil 5W-30）任意' : 'タイヤ銘柄（例: MICHELIN Pilot Sport）任意'} placeholderTextColor="#9ca3af" value={maintForm.itemType} onChangeText={v => setMaintForm(f => ({ ...f, itemType: v }))} />
              )}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput style={[styles.input, { flex: 1 }]} placeholder="走行距離 (km)" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={maintForm.odometerKm} onChangeText={v => setMaintForm(f => ({ ...f, odometerKm: v }))} />
                <TextInput style={[styles.input, { flex: 1 }]} placeholder="費用 (円)" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={maintForm.cost} onChangeText={v => setMaintForm(f => ({ ...f, cost: v }))} />
              </View>
              <Text style={styles.switchLabel}>次回目安</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput style={[styles.input, { flex: 1 }]} placeholder="○ヶ月後" placeholderTextColor="#9ca3af" keyboardType="number-pad" value={maintForm.nextDueMonths} onChangeText={v => setMaintForm(f => ({ ...f, nextDueMonths: v }))} />
                <TextInput style={[styles.input, { flex: 1 }]} placeholder="○km後" placeholderTextColor="#9ca3af" keyboardType="decimal-pad" value={maintForm.nextDueKm} onChangeText={v => setMaintForm(f => ({ ...f, nextDueKm: v }))} />
              </View>
              <TextInput style={styles.input} placeholder="メモ（任意）" placeholderTextColor="#9ca3af" value={maintForm.notes} onChangeText={v => setMaintForm(f => ({ ...f, notes: v }))} />
              <TouchableOpacity
                style={[styles.modalButton, savingMaint && { opacity: 0.5 }]}
                onPress={() => showAddMaint && handleSaveMaint(showAddMaint)}
                disabled={savingMaint}
              >
                <Text style={styles.modalButtonText}>{savingMaint ? '保存中...' : '記録する'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowAddMaint(null)}>
                <Text style={styles.modalCancel}>キャンセル</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  helpBtn: { position: 'absolute', top: 12, right: 16, zIndex: 10, width: 24, height: 24, borderRadius: 12, backgroundColor: '#e5e7eb', justifyContent: 'center', alignItems: 'center' },
  helpBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '700', lineHeight: 16 },
  list: { flex: 1 },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 40, fontSize: 14, lineHeight: 22 },
  carCard: { backgroundColor: '#fff', marginHorizontal: 12, marginTop: 12, borderRadius: 14, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  carCardActive: { borderLeftWidth: 4, borderLeftColor: '#2563eb' },
  carHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  carIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center', position: 'relative', borderWidth: 2, borderColor: '#e8eaed', overflow: 'hidden' },
  carIconEditBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#2563eb', borderRadius: 8, width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  carInfo: { flex: 1, gap: 3 },
  carName: { fontSize: 16, fontWeight: '700', color: '#1f2937' },
  carDetail: { fontSize: 12, color: '#9ca3af' },
  activeBadge: { backgroundColor: '#22c55e', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  activeBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  selectBtn: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e8eaed', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignItems: 'center' },
  selectBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  selectBtnText: { color: '#374151', fontSize: 11, fontWeight: '600' },
  selectBtnTextActive: { color: '#fff' },
  deleteText: { color: '#ef4444', fontSize: 11, textAlign: 'center', marginTop: 2 },
  detailPanel: { borderTopWidth: 1, borderTopColor: '#e8eaed' },
  tabs: { flexDirection: 'row', backgroundColor: '#f8f9fa' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#2563eb' },
  tabText: { fontSize: 12, color: '#6b7280', fontWeight: '500' },
  tabTextActive: { color: '#2563eb', fontWeight: '700' },
  tabContent: { padding: 12 },
  // Stats tab
  statsDistCard: { backgroundColor: '#eff6ff', borderRadius: 10, padding: 14, marginBottom: 12 },
  statsDistLabel: { fontSize: 11, color: '#2563eb', fontWeight: '700', letterSpacing: 0.5 },
  statsDistValue: { fontSize: 24, fontWeight: '800', color: '#1e3a5f', marginTop: 2 },
  statsDistEdit: { fontSize: 12, color: '#2563eb', fontWeight: '400' },
  manualBadge: { backgroundColor: '#dbeafe', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  manualBadgeText: { color: '#2563eb', fontSize: 10, fontWeight: '700' },
  odometerInput: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#2563eb', borderRadius: 8, padding: 10, fontSize: 20, fontWeight: '700', color: '#1f2937', marginTop: 4 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  statCell: { flex: 1, minWidth: '45%', backgroundColor: '#f8f9fa', borderRadius: 10, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', color: '#1f2937' },
  statLabel: { fontSize: 10, color: '#9ca3af', marginTop: 2, textAlign: 'center' },
  refreshBtn: { borderWidth: 1.5, borderColor: '#2563eb', borderStyle: 'dashed', borderRadius: 8, padding: 10, alignItems: 'center', marginTop: 4 },
  refreshBtnText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  // Fuel/Maint tabs
  addLogBtn: { borderWidth: 1.5, borderColor: '#2563eb', borderStyle: 'dashed', borderRadius: 8, padding: 10, alignItems: 'center', marginBottom: 10 },
  addLogBtnText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  logItem: { backgroundColor: '#f8f9fa', borderRadius: 8, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  logItemWarning: { backgroundColor: '#fff5f5', borderWidth: 1, borderColor: '#fca5a5' },
  logDate: { color: '#9ca3af', fontSize: 11, marginBottom: 2 },
  logMain: { color: '#1f2937', fontSize: 14, fontWeight: '600' },
  logSub: { color: '#6b7280', fontSize: 12, marginTop: 1 },
  notFull: { color: '#f59e0b', fontSize: 10, marginTop: 2 },
  logDelete: { color: '#d1d5db', fontSize: 10 },
  warnBadge: { backgroundColor: '#ef4444', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  warnBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  // Activity stats cards
  actCard: { backgroundColor: '#fff', marginHorizontal: 12, marginTop: 12, borderRadius: 14, padding: 14, borderLeftWidth: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  actCardTitle: { fontSize: 14, fontWeight: '700', color: '#1f2937' },
  actGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actCell: { width: '30%', backgroundColor: '#f8f9fa', borderRadius: 8, padding: 8, alignItems: 'center' },
  actVal: { fontSize: 16, fontWeight: '800', color: '#1f2937' },
  actLbl: { fontSize: 9, color: '#9ca3af', marginTop: 2, textAlign: 'center' },
  actDetailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  actDetailPeriod: { width: 36, fontSize: 12, fontWeight: '700', color: '#6b7280' },
  actDetailCell: { flex: 1, alignItems: 'center' },
  actDetailVal: { fontSize: 15, fontWeight: '800', color: '#1f2937' },
  actDetailLbl: { fontSize: 9, color: '#9ca3af', marginTop: 1 },
  // Vehicle type selector
  vtBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderColor: '#e8eaed', borderRadius: 10, paddingVertical: 10, backgroundColor: '#f8f9fa' },
  vtBtnActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  vtBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  vtBtnTextActive: { color: '#2563eb', fontWeight: '700' },
  // Toast
  toast: { position: 'absolute', bottom: 90, left: 24, right: 24, backgroundColor: 'rgba(31,41,55,0.92)', borderRadius: 12, padding: 14, alignItems: 'center' },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  // Footer
  footer: { padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e8eaed' },
  addCarBtn: { backgroundColor: '#2563eb', borderRadius: 12, padding: 16, alignItems: 'center' },
  addCarBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1f2937', marginBottom: 16 },
  input: { backgroundColor: '#f8f9fa', color: '#1f2937', borderRadius: 10, padding: 12, marginBottom: 10, fontSize: 14, borderWidth: 1.5, borderColor: '#e8eaed' },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  switchLabel: { color: '#374151', fontSize: 13, flex: 1 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  typeBtn: { borderWidth: 1.5, borderColor: '#e8eaed', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#f8f9fa' },
  typeBtnActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  typeBtnText: { color: '#6b7280', fontSize: 12 },
  typeBtnTextActive: { color: '#2563eb', fontWeight: '700' },
  modalButton: { backgroundColor: '#2563eb', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 12, marginTop: 4 },
  modalButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  modalCancel: { color: '#9ca3af', textAlign: 'center', fontSize: 14 },
  sectionLabel: { color: '#9ca3af', fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  colorRow: { flexDirection: 'row', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  colorDotActive: { borderColor: '#1f2937', transform: [{ scale: 1.15 }] },
  photoPickerBtn: { backgroundColor: '#f8f9fa', borderWidth: 1.5, borderColor: '#e8eaed', borderRadius: 10, height: 80, alignItems: 'center', justifyContent: 'center', marginBottom: 12, overflow: 'hidden' },
  photoPickerText: { color: '#6b7280', fontSize: 14 },
  photoPreview: { width: '100%', height: '100%' },
});
