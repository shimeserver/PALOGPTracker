import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { GoogleMap, Polyline, Marker, InfoWindow } from '@react-google-maps/api';
import { getUserLandmarks, saveLandmark, updateRoutePoints } from '../firebase/data';
import type { Route, Landmark, TagDef, TrackPoint } from '../firebase/data';
import type { MapSettings } from './SettingsPanel';
import { detectStops, matchStopsToLandmarks } from '../utils/visitDetection';
import type { StopCluster } from '../utils/visitDetection';

function haversineKm(a: TrackPoint, b: TrackPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// GPS速度の外れ値を局所中央値フィルタで除去（前後10点の中央値の3倍超のみ置換）
function filterSpeedOutliers(points: TrackPoint[]): TrackPoint[] {
  if (points.length < 2) return points;
  const result = points.map(p => ({ ...p }));
  const speeds = points.map(p => p.speed);
  const WINDOW = 10, MULT = 3;
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i] <= 0) continue;
    const neighbors = speeds
      .slice(Math.max(0, i - WINDOW), Math.min(speeds.length, i + WINDOW + 1))
      .filter(s => s > 0)
      .sort((a, b) => a - b);
    if (neighbors.length === 0) continue;
    const localMed = neighbors[Math.floor(neighbors.length / 2)];
    if (speeds[i] > localMed * MULT) result[i].speed = localMed;
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
      result[i].speed = dt > 0 ? haversineKm(result[i], result[i+1]) / dt : 0;
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

const ROUTE_COLORS = ['#2563eb','#ef4444','#22c55e','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#84cc16'];
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
}

const RouteMapView = forwardRef<RouteMapViewHandle, Props>(
  function RouteMapView({ route, allRoutes, userId, mapSettings, onMapSettings, tags, onMapRightClick, pinDragMode, onUpdateRoute }, ref) {
    const [landmarks, setLandmarks]   = useState<Landmark[]>([]);
    const [playback, setPlayback]     = useState(false);
    const [playIndex, setPlayIndex]   = useState(0);
    const [playSpeed, setPlaySpeed]   = useState(5);
    const [openLandmark, setOpenLandmark] = useState<string | null>(null);
    const [stopCandidates, setStopCandidates] = useState<StopCluster[]>([]);
    const [addStopModal, setAddStopModal] = useState<StopCluster | null>(null);
    const [newSpotName, setNewSpotName] = useState('');
    const [newSpotCategory, setNewSpotCategory] = useState('その他');
    const [savingSpot, setSavingSpot] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [editPoints, setEditPoints] = useState<TrackPoint[]>([]);
    const [savingEdit, setSavingEdit] = useState(false);
    const [hasUndo, setHasUndo] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [dragPos, setDragPos] = useState<{lat:number;lng:number}|null>(null);
    const [dragAnchor, setDragAnchor] = useState<{before:number;after:number}|null>(null);
    const editPointsRef = useRef<TrackPoint[]>([]);
    const routeModeRef = useRef<string | undefined>(undefined);
    const prevEditPointsRef = useRef<TrackPoint[]>([]);
    const dragPosRef = useRef<{lat:number;lng:number}|null>(null);
    const dragAnchorRef = useRef<{before:number;after:number}|null>(null);
    const savingEditRef = useRef(false);
    const hasDraggedRef = useRef(false);
    const mouseDownPosRef = useRef<{lat:number;lng:number}|null>(null);
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
      setHasUndo(false); setIsDragging(false); setDragPos(null); setDragAnchor(null);
      prevEditPointsRef.current = [];
    }, [route?.id]);

    // stale closure 防止用 ref の同期
    useEffect(() => { editPointsRef.current = editPoints; }, [editPoints]);
    useEffect(() => { routeModeRef.current = route?.mode; }, [route?.mode]);
    useEffect(() => { dragPosRef.current = dragPos; }, [dragPos]);
    useEffect(() => { savingEditRef.current = savingEdit; }, [savingEdit]);

    // ドラッグ中のマウス追跡・mouseup処理
    useEffect(() => {
      if (!mapRef.current || !editMode || !isDragging) return;
      const map = mapRef.current;
      map.setOptions({ draggable: false });
      map.getDiv().style.cursor = 'grabbing';

      const DRAG_THRESHOLD = 0.00015; // 約15m
      const onMove = map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const lat = e.latLng.lat(), lng = e.latLng.lng();
        // 閾値を超えるまでプレビューを表示しない
        if (!hasDraggedRef.current) {
          const md = mouseDownPosRef.current;
          if (!md) return;
          const dist = Math.sqrt((lat - md.lat) ** 2 + (lng - md.lng) ** 2);
          if (dist < DRAG_THRESHOLD) return;
          hasDraggedRef.current = true;
        }
        setDragPos({ lat, lng });
      });

      const onUp = map.addListener('mouseup', async () => {
        setIsDragging(false);
        const didDrag = hasDraggedRef.current;
        const anchor = dragAnchorRef.current;
        const pos = dragPosRef.current;
        const pts = editPointsRef.current;
        setDragPos(null); setDragAnchor(null);
        hasDraggedRef.current = false;
        mouseDownPosRef.current = null;
        // 実際にドラッグしていない場合はクリック扱い（OSRM不要）
        if (!didDrag || !anchor || !pos || pts.length < 2 || savingEditRef.current) return;

        setSavingEdit(true);
        try {
          const profile = routeModeRef.current === 'walk' ? 'foot'
            : routeModeRef.current === 'bicycle' ? 'cycling' : 'driving';
          const p1 = pts[anchor.before], p2 = pts[anchor.after];
          const coords = `${p1.lng},${p1.lat};${pos.lng},${pos.lat};${p2.lng},${p2.lat}`;
          const res = await fetch(
            `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson`
          );
          const data = await res.json();
          const t0 = p1.timestamp, t1 = p2.timestamp;
          let newSeg: TrackPoint[];
          if (data.code === 'Ok' && data.routes?.[0]) {
            const rc: [number, number][] = data.routes[0].geometry.coordinates;
            const aDur: number[] = data.routes[0].legs.flatMap((l: any) => l.annotation?.duration ?? []);
            const aDist: number[] = data.routes[0].legs.flatMap((l: any) => l.annotation?.distance ?? []);
            const hasAnn = aDur.length === rc.length - 1;
            const ct: number[] = [0];
            if (hasAnn) {
              for (const d of aDur) ct.push(ct[ct.length-1] + d);
            } else {
              for (let i = 1; i < rc.length; i++) {
                const a = { lat: rc[i-1][1], lng: rc[i-1][0], timestamp: 0, speed: 0 };
                const b = { lat: rc[i][1], lng: rc[i][0], timestamp: 0, speed: 0 };
                ct.push(ct[i-1] + haversineKm(a, b));
              }
            }
            const tt = ct[ct.length-1];
            newSeg = rc.map((c, i) => ({
              lng: c[0], lat: c[1],
              timestamp: tt > 0 ? t0 + (t1 - t0) * (ct[i] / tt) : t0,
              speed: hasAnn && i < aDur.length && aDur[i] > 0
                ? (aDist[i] / 1000) / (aDur[i] / 3600) : 0,
            }));
          } else {
            newSeg = [p1, { lat: pos.lat, lng: pos.lng, timestamp: (t0+t1)/2, speed: 0 }, p2];
          }
          prevEditPointsRef.current = pts;
          setHasUndo(true);
          setEditPoints([...pts.slice(0, anchor.before), ...calcSpeedsForSegment(newSeg), ...pts.slice(anchor.after + 1)]);
        } catch (e) {
          alert(`ルート更新失敗: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setSavingEdit(false);
          dragAnchorRef.current = null;
        }
      });

      return () => {
        google.maps.event.removeListener(onMove);
        google.maps.event.removeListener(onUp);
        map.setOptions({ draggable: true });
        map.getDiv().style.cursor = '';
      };
    }, [editMode, isDragging]);

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
    }, [playback, playSpeed, route?.id]);

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

    const startEditMode = () => {
      if (!route) return;
      setEditPoints([...route.points]);
      setEditMode(true);
      setPlayback(false);
    };

    const cancelEditMode = () => {
      setEditMode(false); setEditPoints([]);
      setHasUndo(false); setIsDragging(false); setDragPos(null); setDragAnchor(null);
      prevEditPointsRef.current = [];
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
      // ドラッグ範囲: ルート長の5%または最低30点
      const pad = Math.max(30, Math.floor(pts.length * 0.05));
      const before = Math.max(0, ni - pad);
      const after = Math.min(pts.length - 1, ni + pad);
      dragAnchorRef.current = { before, after };
      hasDraggedRef.current = false;
      mouseDownPosRef.current = { lat, lng };
      setDragAnchor({ before, after });
      setIsDragging(true);
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


    const snapToRoads = async () => {
      if (editPoints.length < 2) return;
      setSavingEdit(true);
      try {
        const profile = routeModeRef.current === 'walk' ? 'foot' : routeModeRef.current === 'bicycle' ? 'cycling' : 'driving';

        // 最大25 waypoint を等間隔でサンプリング
        const N = Math.min(25, editPoints.length);
        const step = (editPoints.length - 1) / (N - 1);
        const sampled = Array.from({ length: N }, (_, i) =>
          editPoints[Math.round(i * step)]
        );
        // ワープ点を除去（前点から400km/h超の点をスキップ）
        const waypoints: TrackPoint[] = [sampled[0]];
        for (let i = 1; i < sampled.length - 1; i++) {
          const prev = waypoints[waypoints.length - 1];
          const dt = (sampled[i].timestamp - prev.timestamp) / 3600000;
          if (dt > 0 && haversineKm(prev, sampled[i]) / dt > 400) continue;
          waypoints.push(sampled[i]);
        }
        waypoints.push(sampled[sampled.length - 1]);
        const coords = waypoints.map(p => `${p.lng},${p.lat}`).join(';');

        // annotations=duration,distance で道路種別ごとの速度推定を取得
        const res = await fetch(
          `https://router.project-osrm.org/route/v1/${profile}/${coords}` +
          `?overview=full&geometries=geojson&annotations=duration,distance`
        );
        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes?.[0]) {
          alert(`道路スナップ失敗: ${data.code ?? 'エラー'}`);
          return;
        }

        const routeCoords: [number, number][] = data.routes[0].geometry.coordinates;
        const t0 = editPoints[0].timestamp;
        const t1 = editPoints[editPoints.length - 1].timestamp;

        // 各レグのannotationを結合（レグ間はノード共有なので末尾重複なし）
        const annDur: number[] = data.routes[0].legs.flatMap((l: any) => l.annotation?.duration ?? []);
        const annDist: number[] = data.routes[0].legs.flatMap((l: any) => l.annotation?.distance ?? []);
        const hasAnnotations = annDur.length === routeCoords.length - 1;

        // タイムスタンプ: annotationがあればOSRM所要時間比例、なければ距離比例
        const cumTime: number[] = [0];
        if (hasAnnotations) {
          for (const d of annDur) cumTime.push(cumTime[cumTime.length-1] + d);
        } else {
          for (let i = 1; i < routeCoords.length; i++) {
            const a = { lat: routeCoords[i-1][1], lng: routeCoords[i-1][0], timestamp: 0, speed: 0 };
            const b = { lat: routeCoords[i][1], lng: routeCoords[i][0], timestamp: 0, speed: 0 };
            cumTime.push(cumTime[i-1] + haversineKm(a, b));
          }
        }
        const totalT = cumTime[cumTime.length - 1];

        const snapped: TrackPoint[] = routeCoords.map((c, i) => {
          const ts = totalT > 0 ? t0 + (t1 - t0) * (cumTime[i] / totalT) : t0;
          // annotationがあれば各区間の実際の速度（道路種別推定）を使用
          const spd = hasAnnotations && i < annDur.length && annDur[i] > 0
            ? (annDist[i] / 1000) / (annDur[i] / 3600)
            : 0;
          return { lng: c[0], lat: c[1], timestamp: ts, speed: spd };
        });
        // speed=0の点だけ距離/時間から補完してフィルタ
        const snappedFixed = calcSpeedsForSegment(snapped);

        saveUndo(editPoints);
        setEditPoints(snappedFixed);
      } catch (e) {
        alert(`道路スナップ失敗: ${e instanceof Error ? e.message : String(e)}`);
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
          maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
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
    }, [route?.id, isAllMode ? allRoutes.length : 0]);

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

    // タグIDから色を取得
    const getRouteColor = (r: Route, fallbackIndex: number): string => {
      if (r.tags?.length > 0) {
        const tag = tags.find(t => t.id === r.tags[0]);
        if (tag) return tag.color;
      }
      return ROUTE_COLORS[fallbackIndex % ROUTE_COLORS.length];
    };

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
          {/* 全ルート表示（タグ色対応） */}
          {isAllMode && allRoutes.map((r, i) =>
            r.points.length > 1 && (
              <Polyline
                key={r.id}
                path={r.points.map(p => ({ lat: p.lat, lng: p.lng }))}
                options={{ strokeColor: getRouteColor(r, i), strokeWeight: 2, strokeOpacity: 0.75 }}
              />
            )
          )}

          {/* 単一ルート：単色（編集モード中は非表示） */}
          {!isAllMode && !editMode && colorMode === 'solid' && displayed.length > 1 && (
            <>
              <Polyline path={displayedPath} options={solidOutlineOpts} />
              <Polyline path={displayedPath} options={solidMainOpts} />
            </>
          )}

          {/* 単一ルート：速度カラー（編集モード中は非表示） */}
          {!isAllMode && !editMode && colorMode === 'speed' && displayed.length > 1 &&
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
                label={{ text: isDragTarget ? '✥' : '★', color: isDragTarget ? '#ef4444' : '#f59e0b', fontSize: isDragTarget ? '20px' : '16px' }}
                clickable={!onMapRightClick && !isDragTarget}
                draggable={isDragTarget}
                onClick={() => !onMapRightClick && !isDragTarget && setOpenLandmark(lm.id!)}
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

          {/* 編集モード：ドラッグ可能なグレーPolyline */}
          {editMode && editPoints.length > 1 && (
            <Polyline
              path={editPath}
              options={{ strokeColor: isDragging ? '#9ca3af' : '#374151', strokeWeight: 5, strokeOpacity: isDragging ? 0.4 : 0.8 }}
              onMouseDown={handleEditPolylineMouseDown}
            />
          )}
          {/* ドラッグ中プレビュー: anchor-before → dragPos → anchor-after */}
          {editMode && dragPos && dragAnchor && editPoints[dragAnchor.before] && editPoints[dragAnchor.after] && (
            <>
              <Polyline
                path={[
                  { lat: editPoints[dragAnchor.before].lat, lng: editPoints[dragAnchor.before].lng },
                  dragPos,
                  { lat: editPoints[dragAnchor.after].lat, lng: editPoints[dragAnchor.after].lng },
                ]}
                options={{ strokeColor: '#22c55e', strokeWeight: 4, strokeOpacity: 0.9, zIndex: 10 }}
              />
              <Marker
                position={dragPos}
                icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#22c55e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
              />
            </>
          )}
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
          <div style={{ position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', zIndex:1001, background: isDragging ? 'rgba(34,197,94,0.95)' : 'rgba(37,99,235,0.95)', color:'#fff', padding:'8px 20px', borderRadius:24, fontSize:13, fontWeight:600, boxShadow:'0 2px 8px rgba(0,0,0,0.2)', whiteSpace:'nowrap' }}>
            {isDragging && !dragPos ? '🟢 ドラッグ開始 — 離すと道路に自動スナップ'
            : isDragging ? '🟢 ドラッグ中 — 離すと道路に自動スナップ'
            : savingEdit ? '🔄 ルート計算中...'
            : '✏️ ルートをドラッグして形を変える'}
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
                onClick={snapToRoads}
                disabled={savingEdit || isDragging}
                style={{ padding:'7px 14px', fontSize:13, background:'#059669', color:'#fff', border:'none', borderRadius:6, cursor: savingEdit || isDragging ? 'default' : 'pointer', fontWeight:600 }}
                title="OSRMで全ポイントを道路に自動修正"
              >
                🛣️ ルート自動修正
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
            🌐 全ルート表示中（{allRoutes.length}件）— 左でルートを選択すると個別表示
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
