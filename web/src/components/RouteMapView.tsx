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

function detectWarpPoints(points: TrackPoint[]): Set<number> {
  const flagged = new Set<number>();
  if (points.length < 2) return flagged;

  // ①速度スパイク: 連続2点間の計算速度 > 400km/h → テレポート
  for (let i = 0; i < points.length - 1; i++) {
    const dt = (points[i+1].timestamp - points[i].timestamp) / 3600000; // 時間
    if (dt > 0 && haversineKm(points[i], points[i+1]) / dt > 400) {
      flagged.add(i + 1);
    }
  }

  // ②幾何スパイク: A→B→C合計がA→C直線の5倍超 → 往復バグ(トンネル等)
  for (let i = 1; i < points.length - 1; i++) {
    const dAB = haversineKm(points[i-1], points[i]);
    const dBC = haversineKm(points[i], points[i+1]);
    const dAC = haversineKm(points[i-1], points[i+1]);
    if (dAB + dBC > dAC * 5 && dAB + dBC - dAC > 0.3) {
      flagged.add(i);
    }
  }

  return flagged;
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
  if (s <= 0)  return '#9ca3af';
  if (s < 20)  return '#2196f3';
  if (s < 60)  return '#4caf50';
  if (s < 100) return '#ff9800';
  return '#ef4444';
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
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
    const [savingEdit, setSavingEdit] = useState(false);
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
      setEditMode(false); setEditPoints([]); setSelectedIndices(new Set());
    }, [route?.id]);

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
      setSelectedIndices(new Set());
      setEditMode(true);
      setPlayback(false);
    };

    const cancelEditMode = () => {
      setEditMode(false);
      setEditPoints([]);
      setSelectedIndices(new Set());
    };

    const togglePointSelect = (idx: number) => {
      setSelectedIndices(prev => {
        const next = new Set(prev);
        next.has(idx) ? next.delete(idx) : next.add(idx);
        return next;
      });
    };

    const deleteSelected = () => {
      setEditPoints(prev => prev.filter((_, i) => !selectedIndices.has(i)));
      setSelectedIndices(new Set());
    };

    const snapToRoads = async () => {
      if (editPoints.length < 2) return;
      setSavingEdit(true);
      try {
        const profile = route?.mode === 'walk' ? 'foot' : route?.mode === 'bicycle' ? 'cycling' : 'driving';
        const CHUNK = 80;
        const snapped: TrackPoint[] = [];

        for (let i = 0; i < editPoints.length; i += CHUNK - 1) {
          const chunk = editPoints.slice(i, Math.min(i + CHUNK, editPoints.length));
          const coords = chunk.map(p => `${p.lng},${p.lat}`).join(';');
          const timestamps = chunk.map(p => Math.floor(p.timestamp / 1000)).join(';');
          const radiuses = chunk.map(() => '50').join(';');

          const res = await fetch(
            `https://router.project-osrm.org/match/v1/${profile}/${coords}` +
            `?overview=false&timestamps=${timestamps}&radiuses=${radiuses}`
          );
          const data = await res.json();

          const tracepoints: ({ location: [number, number] } | null)[] =
            data.code === 'Ok' ? data.tracepoints : [];

          const chunkResult: TrackPoint[] = chunk.map((p, j) => {
            const tp = tracepoints[j];
            return tp ? { ...p, lng: tp.location[0], lat: tp.location[1] } : p;
          });

          // チャンク結合時に先頭の重複を除く
          snapped.push(...(i === 0 ? chunkResult : chunkResult.slice(1)));

          // レートリミット対策
          if (i + CHUNK < editPoints.length) await new Promise(r => setTimeout(r, 200));
        }

        setEditPoints(snapped);
        setSelectedIndices(new Set());
      } catch {
        alert('道路スナップに失敗しました（ネットワークを確認してください）');
      } finally {
        setSavingEdit(false);
      }
    };

    const saveEditedRoute = async () => {
      if (!route?.id || editPoints.length < 2) return;
      setSavingEdit(true);
      try {
        await updateRoutePoints(route.id, editPoints);
        const updatedRoute = { ...route, points: editPoints };
        onUpdateRoute?.(updatedRoute);
        setEditMode(false);
        setSelectedIndices(new Set());
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

    const displayed = route ? (playback ? route.points.slice(0, playIndex + 1) : route.points) : [];
    const curPt = playback && route ? route.points[playIndex] : null;

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
          onClick={onMapRightClick ? (e: google.maps.MapMouseEvent) => {
            const placeId = (e as any).placeId as string | undefined;
            const lat = e.latLng?.lat();
            const lng = e.latLng?.lng();
            if (lat !== undefined && lng !== undefined) {
              onMapRightClick(lat, lng, placeId);
            }
          } : undefined}
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

          {/* 単一ルート：単色 */}
          {!isAllMode && colorMode === 'solid' && displayed.length > 1 && (
            <>
              <Polyline path={displayed.map(p => ({ lat: p.lat, lng: p.lng }))} options={solidOutlineOpts} />
              <Polyline path={displayed.map(p => ({ lat: p.lat, lng: p.lng }))} options={solidMainOpts} />
            </>
          )}

          {/* 単一ルート：速度カラー */}
          {!isAllMode && colorMode === 'speed' && displayed.length > 1 &&
            displayed.slice(0, -1).map((p, i) => (
              <Polyline
                key={i}
                path={[{ lat: p.lat, lng: p.lng }, { lat: displayed[i+1].lat, lng: displayed[i+1].lng }]}
                options={{ strokeColor: speedColor(displayed[i+1].speed), strokeWeight: lineWidth, strokeOpacity: 0.9 }}
              />
            ))
          }

          {/* スタート・ゴール */}
          {!isAllMode && route && route.points.length > 0 && (
            <Marker
              position={{ lat: route.points[0].lat, lng: route.points[0].lng }}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#22c55e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }}
            />
          )}
          {!isAllMode && route && !playback && route.points.length > 1 && (
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

          {/* 編集モード：GPSポイントを丸で表示してクリック選択 */}
          {editMode && editPoints.map((p, i) => (
            <Marker
              key={`ep-${i}`}
              position={{ lat: p.lat, lng: p.lng }}
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: selectedIndices.has(i) ? 8 : 5,
                fillColor: selectedIndices.has(i) ? '#ef4444' : '#2563eb',
                fillOpacity: selectedIndices.has(i) ? 1 : 0.7,
                strokeColor: '#fff',
                strokeWeight: 2,
              }}
              onClick={() => togglePointSelect(i)}
              title={`#${i} ${new Date(p.timestamp).toLocaleTimeString('ja-JP')} ${p.speed.toFixed(0)}km/h`}
            />
          ))}
          {/* 編集モード：編集中ルートをグレーで表示 */}
          {editMode && editPoints.length > 1 && (
            <Polyline
              path={editPoints.map(p => ({ lat: p.lat, lng: p.lng }))}
              options={{ strokeColor: '#6b7280', strokeWeight: 2, strokeOpacity: 0.6 }}
            />
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

        {/* 左下：地図タイプ切替 */}
        <div style={{ position:'absolute', bottom:20, left:10, zIndex:1000, display:'flex', flexDirection:'column', gap:4 }}>
          {MAP_TYPE_BTNS.map(btn => (
            <button
              key={btn.key}
              onClick={() => onMapSettings({ ...mapSettings, tileKey: btn.key })}
              style={{
                background: tileKey === btn.key ? 'rgba(37,99,235,0.95)' : 'rgba(255,255,255,0.95)',
                color: tileKey === btn.key ? '#fff' : '#374151',
                border: '1px solid #e8eaed',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: tileKey === btn.key ? 700 : 400,
                cursor: 'pointer',
                boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* 速度凡例（中央下） */}
        {!isAllMode && colorMode === 'speed' && (
          <div style={{ position:'absolute', bottom:80, left:'50%', transform:'translateX(-50%)', zIndex:1000, display:'flex', gap:10, background:'rgba(255,255,255,0.95)', borderRadius:8, padding:'5px 14px', fontSize:11, boxShadow:'0 2px 8px rgba(0,0,0,0.15)', border:'1px solid #e8eaed', whiteSpace:'nowrap' }}>
            {(['#2196f3','#4caf50','#ff9800','#ef4444'] as const).map((c,i) => (
              <span key={i} style={{ color:c, fontWeight:600 }}>● {['低速','中速','高速','超高速'][i]}</span>
            ))}
          </div>
        )}

        {/* 編集モードバナー */}
        {editMode && (
          <div style={{ position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', zIndex:1001, background:'rgba(239,68,68,0.95)', color:'#fff', padding:'8px 20px', borderRadius:24, fontSize:13, fontWeight:600, boxShadow:'0 2px 8px rgba(0,0,0,0.2)', whiteSpace:'nowrap' }}>
            ✏️ 編集モード — ポイントをクリックして選択（赤 = 選択中）
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
              <span style={{ color:'#6b7280', fontSize:12 }}>{editPoints.length}pt | {selectedIndices.size > 0 ? `${selectedIndices.size}点選択中` : 'ポイントをクリックして選択'}</span>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button
                onClick={() => setSelectedIndices(detectWarpPoints(editPoints))}
                style={{ padding:'7px 14px', fontSize:13, background:'#f59e0b', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}
                title="速度スパイク・往復バグを自動検出して選択"
              >
                🔍 自動検出
              </button>
              <button
                onClick={snapToRoads}
                disabled={savingEdit}
                style={{ padding:'7px 14px', fontSize:13, background:'#059669', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}
                title="OSRMを使ってGPSポイントを近くの道路に吸着（APIキー不要）"
              >
                🛣️ 道路に合わせる
              </button>
              <button
                onClick={deleteSelected}
                disabled={selectedIndices.size === 0}
                style={{ padding:'7px 14px', fontSize:13, background: selectedIndices.size > 0 ? '#ef4444' : '#f3f4f6', color: selectedIndices.size > 0 ? '#fff' : '#9ca3af', border:'none', borderRadius:6, cursor: selectedIndices.size > 0 ? 'pointer' : 'default', fontWeight:600 }}
              >
                🗑 選択削除 ({selectedIndices.size})
              </button>
              <button
                onClick={saveEditedRoute}
                disabled={savingEdit || editPoints.length < 2}
                style={{ padding:'7px 16px', fontSize:13, background:'#2563eb', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600 }}
              >
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
