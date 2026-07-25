import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { GoogleMap, Polyline, Marker, InfoWindow } from '@react-google-maps/api';
import { getUserLandmarks, saveLandmark, updateRoutePoints, addFuelLog, getUserCars } from '../firebase/data';
import type { Route, Landmark, TagDef, TrackPoint, Car } from '../firebase/data';
import type { MapSettings } from './SettingsPanel';
import { detectStops, matchStopsToLandmarks } from '../utils/visitDetection';
import type { StopCluster } from '../utils/visitDetection';
import { bridgeGaps, removeGeoWarps } from '../utils/gapBridge';
import ElevationProfile, { hasElevationData } from './ElevationProfile';
import DensityOverlay from './DensityOverlay';

function haversineKm(a: TrackPoint, b: TrackPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

const MAX_REALISTIC_KMH = 300; // これ超は物理的にありえない＝異常値としてクリップ

// 前後1点と比較して3倍超なら外れ値（例: 40→300→40はNG、40→100→180はOK）
// 加えて、絶対値300km/h超はすべて0に落とす（連続スパイクや端点も救済）。
function filterSpeedOutliers(points: TrackPoint[]): TrackPoint[] {
  if (points.length < 3) return points;
  const result = points.map(p => ({ ...p }));
  const s = points.map(p => p.speed);
  for (let i = 0; i < s.length; i++) {
    if (s[i] > MAX_REALISTIC_KMH) { result[i].speed = 0; continue; } // 絶対上限
    if (i === 0 || i === s.length - 1 || s[i] <= 0) continue;
    const neighborMax = Math.max(s[i-1], s[i+1]);
    if (neighborMax > 0 && s[i] > neighborMax * 3) {
      result[i].speed = (s[i-1] + s[i+1]) / 2;
    }
  }
  return result;
}

// OSRM出力（speed=0）の点にタイムスタンプから速度を計算して付与
function calcSpeedsForSegment(seg: TrackPoint[]): TrackPoint[] {
  if (seg.length < 2) return seg;
  const result = seg.map(p => ({ ...p }));
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].speed === 0) {
      const dt = (result[i+1].timestamp - result[i].timestamp) / 3600000;
      const v = dt > 0 ? haversineKm(result[i], result[i+1]) / dt : 0;
      result[i].speed = v > MAX_REALISTIC_KMH ? 0 : v; // 微小dtによる異常値をクリップ
    }
  }
  if (result[result.length - 1].speed === 0)
    result[result.length - 1].speed = result[result.length - 2].speed;
  return filterSpeedOutliers(result);
}


export type MapTypeId = 'roadmap' | 'hybrid' | 'terrain';
export type ColorMode = 'solid' | 'speed';
export type TileKey = MapTypeId;

export interface RouteMapViewHandle {
  focusLandmark: (lat: number, lng: number, id: string) => void;
  getMap: () => google.maps.Map | null;
  revertLandmarkPosition: (id: string, lat: number, lng: number) => void;
}

const DEFAULT_CENTER = { lat: 35.681236, lng: 139.767125 };

const MAP_TYPE_BTNS: { key: MapTypeId; label: string }[] = [
  { key: 'roadmap', label: '地図' },
  { key: 'hybrid',  label: '衛星' },
  { key: 'terrain', label: '地形' },
];

function speedColor(s: number): string {
  if (s <= 0)   return '#9ca3af'; // 停止
  if (s <= 20)  return '#ef4444'; // 〜20 赤
  if (s <= 60)  return '#f97316'; // 〜60 オレンジ
  if (s <= 100) return '#eab308'; // 〜100 黄
  if (s <= 150) return '#22c55e'; // 〜150 緑
  if (s <= 200) return '#3b82f6'; // 〜200 青
  return '#a855f7';               // 200〜 紫
}

interface Props {
  route: Route | null;
  allRoutes: Route[];
  userId: string;
  mapSettings: MapSettings;
  onMapSettings: (s: MapSettings) => void;
  tags: TagDef[];
  onMapRightClick?: (lat: number, lng: number, placeId?: string) => void;
  pinDragMode?: { id: string; originalLat: number; originalLng: number; onDragEnd: (lat: number, lng: number) => void } | null;
  onUpdateRoute?: (route: Route) => void;
  cars?: Car[];
}

const RouteMapView = forwardRef<RouteMapViewHandle, Props>(
  function RouteMapView({ route, allRoutes, userId, mapSettings, onMapSettings, onMapRightClick, pinDragMode, onUpdateRoute, cars = [] }, ref) {
    const [landmarks, setLandmarks]   = useState<Landmark[]>([]);
    const [playback, setPlayback]     = useState(false);
    const [playIndex, setPlayIndex]   = useState(0);
    const [playSpeed, setPlaySpeed]   = useState(5);
    const [openLandmark, setOpenLandmark] = useState<string | null>(null);
    const [fuelModal, setFuelModal] = useState<Landmark | null>(null);
    const [fuelForm, setFuelForm] = useState({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '', carId: '', timestamp: 0 });
    const [savingFuel, setSavingFuel] = useState(false);
    const [loadedCars, setLoadedCars] = useState<Car[]>(cars);
    const [stopCandidates, setStopCandidates] = useState<StopCluster[]>([]);
    const [addStopModal, setAddStopModal] = useState<StopCluster | null>(null);
    const [newSpotName, setNewSpotName] = useState('');
    const [newSpotCategory, setNewSpotCategory] = useState('その他');
    const [savingSpot, setSavingSpot] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [editPoints, setEditPoints] = useState<TrackPoint[]>([]);
    const [savingEdit, setSavingEdit] = useState(false);
    const [hasUndo, setHasUndo] = useState(false);
    // 区間修正モード: ルート上の2点をクリック→間をOSRMの道なり経路で置き換え
    const [sectionMode, setSectionMode] = useState(false);
    const [sectionStart, setSectionStart] = useState<number | null>(null);
    // 複数の経路候補（高速/下道など）からクリックで選ばせる
    const [sectionCandidates, setSectionCandidates] = useState<{ a: number; b: number; routes: [number, number][][] } | null>(null);
    // 標高プロファイル
    const [showElev, setShowElev] = useState(false);
    const [elevIdx, setElevIdx] = useState<number | null>(null);
    // 密度オーバーレイに渡すためのリアクティブなmap参照
    const [mapObj, setMapObj] = useState<google.maps.Map | null>(null);
    const sectionModeRef = useRef(false);
    const sectionStartRef = useRef<number | null>(null);
    const editPointsRef = useRef<TrackPoint[]>([]);
    const routeModeRef = useRef<string | undefined>(undefined);
    const prevEditPointsRef = useRef<TrackPoint[]>([]);
    const savingEditRef = useRef(false);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);

    const isAllMode = allRoutes.length > 0;
    const { tileKey, colorMode, lineWidth } = mapSettings;

    useImperativeHandle(ref, () => ({
      focusLandmark(lat, lng, id) {
        if (!mapRef.current) return;
        mapRef.current.panTo({ lat, lng });
        mapRef.current.setZoom(17);
        setOpenLandmark(id);
      },
      getMap() {
        return mapRef.current;
      },
      revertLandmarkPosition(id, lat, lng) {
        setLandmarks(prev => prev.map(x => x.id === id ? { ...x, lat, lng } : x));
      },
    }));

    useEffect(() => { getUserLandmarks(userId).then(setLandmarks); }, [userId]);
    useEffect(() => {
      setPlayback(false); setPlayIndex(0); setStopCandidates([]);
      setEditMode(false); setEditPoints([]);
      setHasUndo(false); setSectionMode(false); setSectionStart(null); setSectionCandidates(null);
      setShowElev(false); setElevIdx(null);
      prevEditPointsRef.current = [];
    }, [route?.id]);

    // carsが親から渡されたら同期
    useEffect(() => { if (cars.length > 0) setLoadedCars(cars); }, [cars]);

    // stale closure 防止用 ref の同期
    useEffect(() => { editPointsRef.current = editPoints; }, [editPoints]);
    useEffect(() => { sectionModeRef.current = sectionMode; }, [sectionMode]);
    useEffect(() => { sectionStartRef.current = sectionStart; }, [sectionStart]);
    useEffect(() => { routeModeRef.current = route?.mode; }, [route?.mode]);
    useEffect(() => { savingEditRef.current = savingEdit; }, [savingEdit]);

    // 停車候補を計算（route変化またはlandmarks変化時）
    useEffect(() => {
      if (!route || route.points.length < 2) { setStopCandidates([]); return; }
      const stops = detectStops(route.points);
      setStopCandidates(matchStopsToLandmarks(stops, landmarks));
    }, [route?.id, landmarks]);

    useEffect(() => {
      if (!playback || !route) return;
      intervalRef.current = setInterval(() => {
        setPlayIndex(i => {
          if (i >= route.points.length - 1) { clearInterval(intervalRef.current!); setPlayback(false); return i; }
          return Math.min(i + playSpeed, route.points.length - 1);
        });
      }, 100);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [playback, playSpeed, route?.id, route?.points.length]);

    const handleSaveStop = async () => {
      if (!addStopModal || !newSpotName.trim()) return;
      setSavingSpot(true);
      try {
        const now = Date.now();
        const id = await saveLandmark({
          userId,
          name: newSpotName.trim(),
          category: newSpotCategory,
          lat: addStopModal.lat,
          lng: addStopModal.lng,
          description: '',
          photos: [],
          visitCount: 1,
          firstVisit: addStopModal.startTime,
          lastVisit: addStopModal.startTime,
          createdAt: now,
        });
        const newLm: Landmark = {
          id, userId, name: newSpotName.trim(), category: newSpotCategory,
          lat: addStopModal.lat, lng: addStopModal.lng, description: '', photos: [],
          visitCount: 1, firstVisit: addStopModal.startTime, lastVisit: addStopModal.startTime, createdAt: now,
        };
        setLandmarks(prev => [...prev, newLm]);
        setAddStopModal(null);
      } catch {
        alert('保存に失敗しました');
      } finally {
        setSavingSpot(false);
      }
    };

    const openFuelModal = async (lm: Landmark) => {
      // cars が未ロードなら自動フェッチ
      let activeCars = loadedCars;
      if (activeCars.length === 0) {
        try {
          activeCars = await getUserCars(userId);
          setLoadedCars(activeCars);
        } catch {}
      }
      const tagId = route?.tags?.[0];
      const matchedCar = activeCars.find(c => c.tagId === tagId);

      // 給油時刻の決定: 停車クラスタ中間時刻 > 最近傍GPS点 > ルート開始
      let fuelTimestamp = route?.startTime ?? Date.now();
      if (route && route.points.length > 0) {
        // まず最近傍GPS点を求める
        let minD = Infinity, nearestTs = fuelTimestamp;
        for (const pt of route.points) {
          const d = (pt.lat - lm.lat) ** 2 + (pt.lng - lm.lng) ** 2;
          if (d < minD) { minD = d; nearestTs = pt.timestamp; }
        }
        fuelTimestamp = nearestTs;
        // 停車クラスタ（3分以上停車）がランドマーク周辺にあれば中間時刻を使用（より正確）
        const stops = detectStops(route.points);
        for (const stop of stops) {
          const d = Math.sqrt((stop.lat - lm.lat) ** 2 + (stop.lng - lm.lng) ** 2) * 111;
          if (d < 0.2) { // 200m以内
            fuelTimestamp = Math.round((stop.startTime + stop.endTime) / 2);
            break;
          }
        }
      }

      setFuelForm({
        liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '',
        carId: matchedCar?.id ?? (activeCars.length === 1 ? (activeCars[0].id ?? '') : ''),
        timestamp: fuelTimestamp,
      });
      setFuelModal(lm);
      setOpenLandmark(null);
    };

    const handleSaveFuel = async () => {
      if (!fuelModal || !fuelForm.carId || !fuelForm.liters) return;
      const liters = parseFloat(fuelForm.liters);
      if (isNaN(liters) || liters <= 0) { alert('給油量を正しく入力してください'); return; }
      setSavingFuel(true);
      try {
        const pricePerLiter = fuelForm.pricePerLiter ? parseFloat(fuelForm.pricePerLiter) : undefined;
        const totalCost = fuelForm.totalCost ? parseFloat(fuelForm.totalCost)
          : (pricePerLiter && liters ? pricePerLiter * liters : undefined);
        const logData: Parameters<typeof addFuelLog>[1] = {
          timestamp: fuelForm.timestamp || route?.startTime || Date.now(),
          liters,
          isFull: fuelForm.isFull,
        };
        if (pricePerLiter !== undefined) logData.pricePerLiter = pricePerLiter;
        if (totalCost !== undefined) logData.totalCost = totalCost;
        if (fuelForm.notes.trim()) logData.notes = fuelForm.notes.trim();
        await addFuelLog(fuelForm.carId, logData);
        setFuelModal(null);
        alert(`⛽ ${fuelModal.name} の給油記録を保存しました`);
      } catch (e) {
        alert(`保存失敗: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingFuel(false);
      }
    };

    const startEditMode = () => {
      if (!route) return;
      setEditPoints([...route.points]);
      setEditMode(true);
      setPlayback(false);
    };

    const cancelEditMode = () => {
      setEditMode(false); setEditPoints([]);
      setHasUndo(false);
      setSectionMode(false); setSectionStart(null); setSectionCandidates(null);
      prevEditPointsRef.current = [];
    };

    // 2点間の方位角（度、北=0時計回り）
    const bearingDeg = (a: TrackPoint, b: TrackPoint): number => {
      const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180;
      const dl = (b.lng - a.lng) * Math.PI / 180;
      const y = Math.sin(dl) * Math.cos(f2);
      const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };

    // 候補ジオメトリを実際に editPoints に適用する
    const applySectionGeometry = (a: number, b: number, rc: [number, number][]) => {
      const pts = editPointsRef.current;
      const p1 = pts[a], p2 = pts[b];
      const t0 = p1.timestamp, t1 = p2.timestamp;
      const cum: number[] = [0];
      for (let i = 1; i < rc.length; i++) {
        const pa = { lat: rc[i-1][1], lng: rc[i-1][0] };
        const pb = { lat: rc[i][1], lng: rc[i][0] };
        cum.push(cum[i-1] + haversineKm(pa as TrackPoint, pb as TrackPoint));
      }
      const total = cum[cum.length - 1];
      const newSeg: TrackPoint[] = rc.map((c, i) => ({
        lng: c[0], lat: c[1],
        timestamp: total > 0 ? Math.round(t0 + (t1 - t0) * (cum[i] / total)) : t0,
        speed: 0,
      }));
      saveUndo(pts);
      setEditPoints([...pts.slice(0, a), ...calcSpeedsForSegment(newSeg), ...pts.slice(b + 1)]);
      setSectionCandidates(null);
    };

    // 選択した2点の間をOSRMの道なり経路で置き換える（区間修正）。
    // 高架高速と下道の重なり対策:
    // - 端点の進行方位をbearingsで渡し、走行方向に合う道路（本線）へスナップされやすくする
    // - alternatives=true で代替経路も取得し、複数あれば地図上でクリック選択させる
    const repairSection = async (i0: number, i1: number) => {
      const a = Math.min(i0, i1), b = Math.max(i0, i1);
      const pts = editPointsRef.current;
      if (b - a < 1 || pts.length < 2) return;
      setSavingEdit(true);
      try {
        const profile = routeModeRef.current === 'walk' ? 'foot'
          : routeModeRef.current === 'bicycle' ? 'cycling' : 'driving';
        const p1 = pts[a], p2 = pts[b];
        const base = `https://router.project-osrm.org/route/v1/${profile}/${p1.lng},${p1.lat};${p2.lng},${p2.lat}`;
        // 進行方位ヒント（前後の点から算出、許容±60°）
        const brgStart = Math.round(bearingDeg(p1, pts[Math.min(a + 1, pts.length - 1)]));
        const brgEnd = Math.round(bearingDeg(pts[Math.max(b - 1, 0)], p2));
        // 方位ヒント付き/無しの両方を取得して候補を合流する。
        // ヒントが端点を誤ったエッジ（逆方向ランプ等）にスナップさせて変な経路になるケースがあるため、
        // 素の候補も必ず混ぜる（山手トンネル区間の実測でヒント無しが正解だった）。
        const urls = [
          `${base}?overview=full&geometries=geojson&alternatives=true&bearings=${brgStart},60;${brgEnd},60`,
          `${base}?overview=full&geometries=geojson&alternatives=true`,
        ];
        const routes: [number, number][][] = [];
        const seen = new Set<string>();
        for (const url of urls) {
          try {
            const res = await fetch(url);
            const j = await res.json();
            if (j.code === 'Ok' && j.routes?.length) {
              for (const r of j.routes) {
                const key = `${Math.round(r.distance)}_${r.geometry.coordinates.length}`;
                if (seen.has(key)) continue;
                seen.add(key);
                routes.push(r.geometry.coordinates);
              }
            }
          } catch { /* 次のURLへ */ }
        }
        if (routes.length === 0) {
          alert('道路経路を取得できませんでした');
          return;
        }
        if (routes.length === 1) {
          applySectionGeometry(a, b, routes[0]);
        } else {
          // 複数候補: 地図上でクリック選択してもらう（最大4本）
          setSectionCandidates({ a, b, routes: routes.slice(0, 4) });
        }
      } catch (e) {
        alert(`区間修正失敗: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingEdit(false);
      }
    };

    const handleEditPolylineMouseDown = useCallback((e: google.maps.MapMouseEvent) => {
      if (!e.latLng || savingEditRef.current) return;
      const lat = e.latLng.lat(), lng = e.latLng.lng();
      const pts = editPointsRef.current;
      let ni = 0, minD = Infinity;
      pts.forEach((p, i) => {
        const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
        if (d < minD) { minD = d; ni = i; }
      });

      // 区間修正モード: クリックで始点→終点を選び、間を道なりに置き換え
      if (sectionModeRef.current) {
        const start = sectionStartRef.current;
        if (start == null) {
          setSectionStart(ni);
        } else {
          setSectionStart(null);
          setSectionMode(false);
          void repairSection(start, ni);
        }
      }
    }, []);

    const saveUndo = (pts: TrackPoint[]) => {
      prevEditPointsRef.current = pts;
      setHasUndo(true);
    };

    const applyUndo = () => {
      setEditPoints(prevEditPointsRef.current);
      prevEditPointsRef.current = [];
      setHasUndo(false);
    };


    const forceRecalcSpeeds = () => {
      // 既存速度を無視して座標+タイムスタンプから全点再計算
      saveUndo(editPoints);
      const reset = editPoints.map(p => ({ ...p, speed: 0 }));
      setEditPoints(filterSpeedOutliers(calcSpeedsForSegment(reset)));
    };

    // ルート自動補正 = 記録の「おかしい所」だけ直すクリーンアップ。
    // 実測GPS点はそのまま残す（トンネルと地上道の重なりは距離がほぼ同じなので触らない）。
    // 1) 短距離ワープ（飛んで戻る誤点）を位置ベースで除去
    // 2) 離れたギャップ（GPS喪失区間）だけをOSRMの直進的な経路で補間（回り道になる経路は不採用＝直線のまま）
    // 3) 速度を再計算し外れ値を除去
    const snapToRoads = async () => {
      if (editPoints.length < 2) return;
      setSavingEdit(true);
      try {
        const cleaned = removeGeoWarps(editPoints);
        const r = await bridgeGaps(cleaned.points, routeModeRef.current);
        if (r.bridged === 0 && cleaned.removed === 0) {
          alert('補正が必要な区間は見つかりませんでした。\n（短距離ワープや、GPS喪失によるギャップなし）');
          return;
        }
        saveUndo(editPoints);
        setEditPoints(filterSpeedOutliers(calcSpeedsForSegment(r.points)));
        const msgs: string[] = [];
        if (cleaned.removed > 0) msgs.push(`GPSの飛び ${cleaned.removed}点を除去`);
        if (r.bridged > 0) msgs.push(`GPS喪失区間 ${r.bridged}か所を道なりに補間`);
        if (r.rejectedDetour > 0) msgs.push(`回り道になる補間は不採用（直線のまま）${r.rejectedDetour}か所`);
        if (r.failed > 0) msgs.push(`経路取得失敗 ${r.failed}か所`);
        alert(`${msgs.join(' / ')}。\n内容を確認して「保存」してください。`);
      } catch (e) {
        alert(`ルート補正失敗: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingEdit(false);
      }
    };

    const saveEditedRoute = async () => {
      if (!route?.id || editPoints.length < 2) return;
      setSavingEdit(true);
      try {
        // speed=0の点は座標から補完、既存GPS速度は保持しつつ外れ値のみ除去
        const fixed = filterSpeedOutliers(calcSpeedsForSegment(editPoints));
        await updateRoutePoints(route.id, fixed);
        // ローカル状態もstats含めて更新
        const speeds = fixed.map(p => p.speed).filter(s => s > 0);
        let totalDist = 0;
        for (let i = 1; i < fixed.length; i++) totalDist += haversineKm(fixed[i-1], fixed[i]);
        const updatedRoute = {
          ...route, points: fixed,
          totalDistance: totalDist,
          avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b) / speeds.length : 0,
          maxSpeed: speeds.reduce((m, s) => s > m ? s : m, 0),
        };
        onUpdateRoute?.(updatedRoute);
        setEditMode(false);
      } catch {
        alert('保存に失敗しました');
      } finally {
        setSavingEdit(false);
      }
    };

    const onLoad = useCallback((map: google.maps.Map) => {
      mapRef.current = map;
      setMapObj(map); // DensityOverlay等にリアクティブに渡すため
    }, []);

    useEffect(() => {
      if (!mapRef.current) return;
      if (isAllMode && allRoutes.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        allRoutes.forEach(r => r.points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng })));
        mapRef.current.fitBounds(bounds, 30);
      } else if (route && route.points.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        route.points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
        mapRef.current.fitBounds(bounds, 40);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route?.id, isAllMode, allRoutes.length]);

    const displayed = useMemo(
      () => route ? (playback ? route.points.slice(0, playIndex + 1) : route.points) : [],
      [route, playback, playIndex]
    );
    const displayedPath = useMemo(
      () => displayed.map(p => ({ lat: p.lat, lng: p.lng })),
      [displayed]
    );
    const editPath = useMemo(
      () => editPoints.map(p => ({ lat: p.lat, lng: p.lng })),
      [editPoints]
    );
    const curPt = playback && route ? route.points[playIndex] : null;

    // 編集モード: マップクリックで最近傍点を検出・選択（Markerを使わず軽量）

    const solidOutlineOpts = useMemo(() => ({ strokeColor: '#1d4ed8', strokeWeight: lineWidth + 4, strokeOpacity: 0.25 }), [lineWidth]);
    const solidMainOpts    = useMemo(() => ({ strokeColor: '#2563eb', strokeWeight: lineWidth, strokeOpacity: 0.95 }), [lineWidth]);
    const mapOptions = useMemo(() => ({
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControlOptions: { position: google.maps.ControlPosition.LEFT_TOP },
    }), []);

    return (
      <div style={{ position: 'relative', height: '100%' }}>
        {onMapRightClick && (
          <div style={{ position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: 'rgba(37,99,235,0.95)', color: '#fff', padding: '8px 20px', borderRadius: 24, fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(0,0,0,0.2)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            👆 地図上のスポット（店舗・施設）をクリックして確定
          </div>
        )}
        {pinDragMode && (
          <div style={{ position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: 'rgba(239,68,68,0.95)', color: '#fff', padding: '8px 20px', borderRadius: 24, fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(0,0,0,0.2)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            ✥ 赤いピンをドラッグして新しい位置に移動
          </div>
        )}
        <GoogleMap
          mapContainerStyle={{ height: '100%', width: '100%' }}
          center={DEFAULT_CENTER}
          zoom={10}
          mapTypeId={tileKey}
          onLoad={onLoad}
          options={mapOptions}
          onClick={(e: google.maps.MapMouseEvent) => {
            if (onMapRightClick) {
              const placeId = (e as any).placeId as string | undefined;
              const lat = e.latLng?.lat(); const lng = e.latLng?.lng();
              if (lat !== undefined && lng !== undefined) onMapRightClick(lat, lng, placeId);
            }
          }}
        >
          {/* 全ルート表示: 通過回数の密度オーバーレイ（1回=青 → 回数が増えるほど赤へ） */}
          {isAllMode && <DensityOverlay map={mapObj} routes={allRoutes} />}

          {/* 単一ルート：単色（編集モード中は非表示）。巨大ルートでは速度カラーは重すぎるため単色に落とす */}
          {!isAllMode && !editMode && (colorMode === 'solid' || displayed.length > 20000) && displayed.length > 1 && (
            <>
              <Polyline path={displayedPath} options={solidOutlineOpts} />
              <Polyline path={displayedPath} options={solidMainOpts} />
            </>
          )}

          {/* 単一ルート：速度カラー（編集モード中は非表示・2万点以下のみ） */}
          {!isAllMode && !editMode && colorMode === 'speed' && displayed.length > 1 && displayed.length <= 20000 &&
            displayed.slice(0, -1).map((p, i) => (
              <Polyline
                key={i}
                path={[{ lat: p.lat, lng: p.lng }, { lat: displayed[i+1].lat, lng: displayed[i+1].lng }]}
                options={{ strokeColor: speedColor(displayed[i+1].speed), strokeWeight: lineWidth, strokeOpacity: 0.9 }}
              />
            ))
          }

          {/* スタート・ゴール（編集モード中は非表示） */}
          {!isAllMode && !editMode && route && route.points.length > 0 && (
            <Marker
              position={{ lat: route.points[0].lat, lng: route.points[0].lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#22c55e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
            />
          )}
          {!isAllMode && !editMode && route && !playback && route.points.length > 1 && (
            <Marker
              position={{ lat: route.points[route.points.length-1].lat, lng: route.points[route.points.length-1].lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#ef4444', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
            />
          )}

          {/* 再生中マーカー */}
          {curPt && (
            <Marker
              position={{ lat: curPt.lat, lng: curPt.lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
            />
          )}

          {/* ランドマーク */}
          {landmarks.map(lm => {
            const isDragTarget = pinDragMode?.id === lm.id;
            return (
              <Marker
                key={lm.id}
                position={{ lat: lm.lat, lng: lm.lng }}
                label={{ text: isDragTarget ? '✥' : lm.category === 'ガソリンスタンド' ? '⛽' : '★', color: isDragTarget ? '#ef4444' : lm.category === 'ガソリンスタンド' ? '#16a34a' : '#f59e0b', fontSize: isDragTarget ? '20px' : '16px' }}
                clickable={!onMapRightClick && !isDragTarget}
                draggable={isDragTarget}
                onClick={() => {
                  if (onMapRightClick || isDragTarget) return;
                  if (lm.category === 'ガソリンスタンド' && route) {
                    openFuelModal(lm);
                  } else {
                    setOpenLandmark(lm.id!);
                  }
                }}
                onDragEnd={isDragTarget ? (e: google.maps.MapMouseEvent) => {
                  const lat = e.latLng?.lat();
                  const lng = e.latLng?.lng();
                  if (lat !== undefined && lng !== undefined) {
                    setLandmarks(prev => prev.map(x => x.id === lm.id ? { ...x, lat, lng } : x));
                    pinDragMode!.onDragEnd(lat, lng);
                  }
                } : undefined}
              >
                {openLandmark === lm.id && !isDragTarget && (
                  <InfoWindow onCloseClick={() => setOpenLandmark(null)}>
                    <div style={{ color: '#1f2937', fontSize: 13 }}>
                      <strong>{lm.name}</strong><br />
                      {lm.category} | 来訪{lm.visitCount}回
                      {lm.photos.length > 0 && <><br /><img src={lm.photos[0].url} style={{ width: 120, marginTop: 6, borderRadius: 6 }} /></>}
                      {lm.category === 'ガソリンスタンド' && route && (
                        <><br /><button onClick={() => openFuelModal(lm)} style={{ marginTop: 6, padding: '4px 10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>⛽ 給油記録</button></>
                      )}
                    </div>
                  </InfoWindow>
                )}
              </Marker>
            );
          })}
          {/* 青ピン：未登録の停車候補 */}
          {!isAllMode && !editMode && stopCandidates.map((sc, i) => (
            <Marker
              key={`stop-${i}`}
              position={{ lat: sc.lat, lng: sc.lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#3b82f6', fillOpacity: 0.9, strokeColor: '#fff', strokeWeight: 2 }}
              title={`停車 ${Math.round(sc.durationMs / 60000)}分`}
              onClick={() => { setAddStopModal(sc); setNewSpotName(''); setNewSpotCategory('その他'); }}
            />
          ))}

          {/* 編集モード：グレーPolyline（区間修正のクリック対象） */}
          {editMode && editPoints.length > 1 && (
            <Polyline
              path={editPath}
              options={{ strokeColor: '#374151', strokeWeight: 5, strokeOpacity: 0.8 }}
              onMouseDown={handleEditPolylineMouseDown}
            />
          )}

          {/* 区間修正: 選択済み始点マーカー */}
          {editMode && sectionMode && sectionStart != null && editPoints[sectionStart] && (
            <Marker
              position={{ lat: editPoints[sectionStart].lat, lng: editPoints[sectionStart].lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }}
              zIndex={20}
            />
          )}

          {/* 標高プロファイルのホバー位置を地図に表示 */}
          {!isAllMode && route && elevIdx != null && route.points[elevIdx] && (
            <Marker
              position={{ lat: route.points[elevIdx].lat, lng: route.points[elevIdx].lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#2563eb', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
              zIndex={25}
            />
          )}

          {/* 区間修正: 経路候補（クリックで選択、高速/下道の選び分け） */}
          {editMode && sectionCandidates && sectionCandidates.routes.map((rc, i) => (
            <Polyline
              key={`cand-${i}`}
              path={rc.map(([lng, lat]) => ({ lat, lng }))}
              options={{
                strokeColor: ['#2563eb', '#ef4444', '#22c55e', '#f59e0b'][i % 4],
                strokeWeight: 6, strokeOpacity: 0.85, zIndex: 30 + i,
              }}
              onClick={() => applySectionGeometry(sectionCandidates.a, sectionCandidates.b, rc)}
            />
          ))}
        </GoogleMap>

        {/* 青ピン：スポット登録モーダル */}
        {addStopModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>スポットとして登録</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 16 }}>
                停車 {Math.round(addStopModal.durationMs / 60000)}分
              </div>
              <input
                autoFocus
                value={newSpotName}
                onChange={e => setNewSpotName(e.target.value)}
                placeholder="スポット名"
                style={{ width: '100%', boxSizing: 'border-box', border: '1.5px solid #e8eaed', borderRadius: 8, padding: '8px 12px', fontSize: 14, marginBottom: 12, outline: 'none' }}
                onKeyDown={e => { if (e.key === 'Enter' && newSpotName.trim()) handleSaveStop(); }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {['その他', 'グルメ', 'コンビニ', 'ガソリンスタンド', '観光', 'ショッピング'].map(cat => (
                  <button key={cat} onClick={() => setNewSpotCategory(cat)}
                    style={{ padding: '4px 10px', borderRadius: 20, border: '1.5px solid', fontSize: 12, cursor: 'pointer', borderColor: newSpotCategory === cat ? '#3b82f6' : '#e8eaed', background: newSpotCategory === cat ? '#3b82f6' : '#fff', color: newSpotCategory === cat ? '#fff' : '#374151' }}>
                    {cat}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setAddStopModal(null)} style={{ flex: 1, padding: '9px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>キャンセル</button>
                <button onClick={handleSaveStop} disabled={!newSpotName.trim() || savingSpot}
                  style={{ flex: 1, padding: '9px', background: newSpotName.trim() ? '#3b82f6' : '#93c5fd', border: 'none', borderRadius: 8, cursor: newSpotName.trim() ? 'pointer' : 'default', fontSize: 13, color: '#fff', fontWeight: 600 }}>
                  {savingSpot ? '保存中...' : '登録'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 給油記録モーダル */}
        {fuelModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>⛽ 給油記録</div>
              <div style={{ color: '#6b7280', fontSize: 13 }}>{fuelModal.name}</div>
              <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 16 }}>
                🕐 {new Date(fuelForm.timestamp).toLocaleString('ja-JP')}
              </div>

              {/* 愛車未登録の場合 */}
              {loadedCars.length === 0 && (
                <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>⚠️ 愛車が登録されていません。先に愛車パネルで登録してください。</div>
              )}
              {/* 愛車選択（自動特定できない場合） */}
              {!fuelForm.carId && loadedCars.length > 1 && (
                <select value={fuelForm.carId} onChange={e => setFuelForm(f => ({ ...f, carId: e.target.value }))}
                  style={{ width: '100%', marginBottom: 12, padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e8eaed', fontSize: 14 }}>
                  <option value="">愛車を選択...</option>
                  {loadedCars.map(c => <option key={c.id} value={c.id}>{c.nickname}</option>)}
                </select>
              )}
              {fuelForm.carId && <div style={{ color: '#16a34a', fontSize: 12, marginBottom: 12 }}>🚗 {loadedCars.find(c => c.id === fuelForm.carId)?.nickname}</div>}

              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>給油量 (L) *</div>
                  <input type="number" step="0.01" placeholder="例: 40.5" value={fuelForm.liters}
                    onChange={e => {
                      const l = e.target.value;
                      const ppl = parseFloat(fuelForm.pricePerLiter);
                      setFuelForm(f => ({ ...f, liters: l, totalCost: l && ppl ? (parseFloat(l) * ppl).toFixed(0) : f.totalCost }));
                    }}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e8eaed', fontSize: 14 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>単価 (円/L)</div>
                  <input type="number" step="0.1" placeholder="例: 175" value={fuelForm.pricePerLiter}
                    onChange={e => {
                      const ppl = e.target.value;
                      const l = parseFloat(fuelForm.liters);
                      setFuelForm(f => ({ ...f, pricePerLiter: ppl, totalCost: l && ppl ? (l * parseFloat(ppl)).toFixed(0) : f.totalCost }));
                    }}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e8eaed', fontSize: 14 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>合計 (円)</div>
                  <input type="number" placeholder="例: 7100" value={fuelForm.totalCost}
                    onChange={e => setFuelForm(f => ({ ...f, totalCost: e.target.value }))}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e8eaed', fontSize: 14 }} />
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer', fontSize: 14 }}>
                <input type="checkbox" checked={fuelForm.isFull} onChange={e => setFuelForm(f => ({ ...f, isFull: e.target.checked }))} />
                満タン給油
              </label>

              <input placeholder="メモ（任意）" value={fuelForm.notes}
                onChange={e => setFuelForm(f => ({ ...f, notes: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e8eaed', fontSize: 14, marginBottom: 16 }} />

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setFuelModal(null)} style={{ flex: 1, padding: 10, background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
                <button onClick={handleSaveFuel}
                  disabled={savingFuel || !fuelForm.liters || (!fuelForm.carId && loadedCars.length > 0)}
                  style={{ flex: 2, padding: 10, background: fuelForm.liters && fuelForm.carId ? '#16a34a' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                  {savingFuel ? '保存中...' : '⛽ 給油記録を保存'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 左下：地図タイプ切替 + 速度カラー */}
        <div style={{ position:'absolute', bottom:20, left:10, zIndex:1000, display:'flex', flexDirection:'column', gap:4 }}>
          {MAP_TYPE_BTNS.map(btn => (
            <button
              key={btn.key}
              onClick={() => onMapSettings({ ...mapSettings, tileKey: btn.key })}
              style={{
                background: tileKey === btn.key ? 'rgba(37,99,235,0.95)' : 'rgba(255,255,255,0.95)',
                color: tileKey === btn.key ? '#fff' : '#374151',
                border: '1px solid #e8eaed', borderRadius: 6,
                padding: '5px 10px', fontSize: 12,
                fontWeight: tileKey === btn.key ? 700 : 400,
                cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
              }}
            >
              {btn.label}
            </button>
          ))}
          {!isAllMode && route && (
            <button
              onClick={() => onMapSettings({ ...mapSettings, colorMode: colorMode === 'speed' ? 'solid' : 'speed' })}
              style={{
                background: colorMode === 'speed' ? 'rgba(31,41,55,0.95)' : 'rgba(255,255,255,0.95)',
                color: colorMode === 'speed' ? '#fff' : '#374151',
                border: '1px solid #e8eaed', borderRadius: 6,
                padding: '5px 10px', fontSize: 12, fontWeight: colorMode === 'speed' ? 700 : 400,
                cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
              }}
              title="速度カラー表示の切替"
            >
              🎨 速度色
            </button>
          )}
        </div>

        {/* 速度凡例（中央下） */}
        {!isAllMode && colorMode === 'speed' && (
          <div style={{ position:'absolute', bottom:80, left:'50%', transform:'translateX(-50%)', zIndex:1000, display:'flex', gap:8, background:'rgba(255,255,255,0.97)', borderRadius:8, padding:'5px 14px', fontSize:11, boxShadow:'0 2px 8px rgba(0,0,0,0.15)', border:'1px solid #e8eaed', whiteSpace:'nowrap' }}>
            {([
              ['#ef4444','〜20'],['#f97316','〜60'],['#eab308','〜100'],
              ['#22c55e','〜150'],['#3b82f6','〜200'],['#a855f7','200+'],
            ] as [string,string][]).map(([c,l]) => (
              <span key={l} style={{ color:c, fontWeight:700 }}>● <span style={{ color:'#374151', fontWeight:400 }}>{l}</span></span>
            ))}
          </div>
        )}

        {/* 編集モードバナー */}
        {editMode && (
          <div style={{ position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', zIndex:1001, background: sectionMode ? 'rgba(245,158,11,0.95)' : 'rgba(37,99,235,0.95)', color:'#fff', padding:'8px 20px', borderRadius:24, fontSize:13, fontWeight:600, boxShadow:'0 2px 8px rgba(0,0,0,0.2)', whiteSpace:'nowrap' }}>
            {savingEdit ? '🔄 ルート計算中...'
            : sectionCandidates ? `🎨 経路候補が${sectionCandidates.routes.length}本あります — 実際に走った色の線をクリック`
            : sectionMode && sectionStart == null ? '✂️ おかしい区間の【始点】をルート上でクリック'
            : sectionMode ? '✂️ 続けて【終点】をクリック — 間が道なりに置き換わります'
            : '✏️ 編集モード — ✂️区間修正で形を直せます'}
            {sectionCandidates && (
              <button onClick={() => setSectionCandidates(null)} style={{ marginLeft: 10, background: 'rgba(255,255,255,0.25)', border: 'none', borderRadius: 12, color: '#fff', padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>やめる</button>
            )}
          </div>
        )}

        {/* 標高プロファイル（下部パネルの上に重ねる） */}
        {!isAllMode && route && !editMode && showElev && hasElevationData(route.points) && (
          <div style={{ position: 'absolute', bottom: 88, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, width: 'min(600px, 92%)', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', borderRadius: 10 }}>
            <ElevationProfile points={route.points} onHoverPoint={setElevIdx} />
          </div>
        )}

        {/* 下部コントロール */}
        {!isAllMode && route && !editMode && (
          <div style={ui.panel}>
            <div style={ui.routeInfo}>
              <span style={{ color:'#1f2937', fontWeight:700, fontSize:14 }}>{route.name || '（無名）'}</span>
              <span style={{ color:'#6b7280', fontSize:12 }}>
                {route.totalDistance.toFixed(1)}km | 平均 {route.avgSpeed.toFixed(0)}km/h | 最高 {route.maxSpeed.toFixed(0)}km/h
              </span>
            </div>
            {!playback ? (
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <label style={{ color:'#6b7280', fontSize:12 }}>速度:</label>
                <select value={playSpeed} onChange={e => setPlaySpeed(Number(e.target.value))} style={ui.select}>
                  <option value={1}>1x</option><option value={5}>5x</option>
                  <option value={20}>20x</option><option value={50}>50x</option>
                </select>
                <button className="btn-primary" style={{ padding:'7px 16px', fontSize:13 }} onClick={() => { setPlayIndex(0); setPlayback(true); }}>▶ 再生</button>
                {hasElevationData(route.points) && (
                  <button onClick={() => setShowElev(e => !e)} style={{ padding:'7px 12px', fontSize:13, background: showElev ? '#eff6ff' : '#f3f4f6', border: showElev ? '1.5px solid #2563eb' : '1.5px solid #e8eaed', borderRadius:6, cursor:'pointer', color: showElev ? '#2563eb' : '#374151', fontWeight:500 }}>⛰ 標高</button>
                )}
                {onUpdateRoute && <button onClick={startEditMode} style={{ padding:'7px 14px', fontSize:13, background:'#f3f4f6', border:'1.5px solid #e8eaed', borderRadius:6, cursor:'pointer', color:'#374151', fontWeight:500 }}>✏️ 編集</button>}
              </div>
            ) : (
              <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                <div style={{ width:160, height:4, background:'#e8eaed', borderRadius:2 }}>
                  <div style={{ width:`${(playIndex/(route.points.length-1))*100}%`, height:'100%', background:'#2563eb', borderRadius:2 }} />
                </div>
                <span style={{ color:'#2563eb', fontSize:13, minWidth:60, fontWeight:600 }}>{curPt?.speed.toFixed(0)}km/h</span>
                <button style={ui.stopBtn} onClick={() => { clearInterval(intervalRef.current!); setPlayback(false); }}>■ 停止</button>
              </div>
            )}
          </div>
        )}

        {/* 編集モードコントロール */}
        {!isAllMode && route && editMode && (
          <div style={ui.panel}>
            <div style={ui.routeInfo}>
              <span style={{ color:'#ef4444', fontWeight:700, fontSize:14 }}>✏️ ルート編集</span>
              <span style={{ color:'#6b7280', fontSize:12 }}>{editPoints.length}pt</span>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              {hasUndo && (
                <button onClick={applyUndo} style={{ padding:'7px 12px', fontSize:13, background:'#f3f4f6', border:'1.5px solid #e8eaed', borderRadius:6, cursor:'pointer', color:'#374151' }}>
                  ↩ 元に戻す
                </button>
              )}
              <button
                onClick={forceRecalcSpeeds}
                disabled={savingEdit}
                style={{ padding:'7px 14px', fontSize:13, background:'#7c3aed', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}
                title="座標+タイムスタンプから全速度を強制再計算（速度データが壊れた場合に使用）"
              >
                🔄 速度再計算
              </button>
              <button
                onClick={snapToRoads}
                disabled={savingEdit}
                style={{ padding:'7px 14px', fontSize:13, background:'#059669', color:'#fff', border:'none', borderRadius:6, cursor: savingEdit ? 'default' : 'pointer', fontWeight:600 }}
                title="GPSの飛び（ワープ）を除去し、GPS喪失区間だけ道なりに補間します。実測点はそのまま残します"
              >
                🛣️ 記録クリーンアップ
              </button>
              <button
                onClick={() => { setSectionMode(m => !m); setSectionStart(null); }}
                disabled={savingEdit}
                style={{ padding:'7px 14px', fontSize:13, background: sectionMode ? '#d97706' : '#f59e0b', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}
                title="おかしい区間の始点と終点をルート上でクリックすると、その間を道なりの経路に置き換えます"
              >
                {sectionMode
                  ? (sectionStart == null ? '✂️ 始点をクリック…' : '✂️ 終点をクリック…')
                  : '✂️ 区間修正'}
              </button>
              <button onClick={saveEditedRoute} disabled={savingEdit || editPoints.length < 2}
                style={{ padding:'7px 16px', fontSize:13, background:'#2563eb', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}>
                {savingEdit ? '保存中...' : '💾 保存'}
              </button>
              <button onClick={cancelEditMode} style={{ padding:'7px 12px', fontSize:13, background:'#f3f4f6', border:'1.5px solid #e8eaed', borderRadius:6, cursor:'pointer', color:'#374151' }}>
                キャンセル
              </button>
            </div>
          </div>
        )}

        {isAllMode && (
          <div style={ui.allModeBadge}>
            🌐 全ルート（{allRoutes.length}件）— 通過回数:
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <span style={{ fontSize: 11 }}>1回</span>
              <span style={{ width: 90, height: 8, borderRadius: 4, background: 'linear-gradient(90deg, hsl(220,85%,50%), hsl(180,85%,45%), hsl(120,80%,42%), hsl(60,90%,48%), hsl(30,90%,50%), hsl(0,85%,50%))' }} />
              <span style={{ fontSize: 11 }}>多数</span>
            </span>
          </div>
        )}

      </div>
    );
  }
);

export default RouteMapView;

const ui: Record<string, React.CSSProperties> = {
  panel: {
    position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)',
    background:'rgba(255,255,255,0.97)', borderRadius:12, padding:'12px 20px',
    display:'flex', gap:16, alignItems:'center', zIndex:1000,
    border:'1px solid #e8eaed', boxShadow:'0 4px 16px rgba(0,0,0,0.12)', backdropFilter:'blur(8px)', maxWidth:'90%',
  },
  routeInfo: { display:'flex', flexDirection:'column', gap:2 },
  select: { background:'#f8f9fa', color:'#1f2937', border:'1.5px solid #e8eaed', borderRadius:6, padding:'4px 8px', fontSize:13 },
  stopBtn: { background:'#ef4444', color:'#fff', border:'none', borderRadius:6, padding:'6px 14px', cursor:'pointer', fontSize:13, fontWeight:600 },
  allModeBadge: {
    position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)',
    background:'rgba(255,255,255,0.97)', color:'#2563eb', padding:'10px 20px',
    borderRadius:10, fontSize:13, zIndex:1000, border:'1px solid #bfdbfe',
    boxShadow:'0 4px 16px rgba(0,0,0,0.1)', fontWeight:500,
  },
  hint: {
    position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
    background:'rgba(255,255,255,0.95)', color:'#9ca3af', padding:'12px 24px', borderRadius:10, fontSize:14, zIndex:1000,
    boxShadow:'0 2px 12px rgba(0,0,0,0.1)',
  },
};
