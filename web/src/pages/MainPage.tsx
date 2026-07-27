import { useEffect, useMemo, useRef, useState } from 'react';
import { signOut, type User } from 'firebase/auth';
import { auth } from '../firebase/config';
import RoutesPanel from '../components/RoutesPanel';
import RouteMapView from '../components/RouteMapView';
import LandmarksPanel from '../components/LandmarksPanel';
import SettingsPanel from '../components/SettingsPanel';
import CarsPanel from '../components/CarsPanel';
import ActivityPanel from '../components/ActivityPanel';
import PrefectureMapPanel from '../components/PrefectureMapPanel';
import GapScanPanel from '../components/GapScanPanel';
import StatsPanel from '../components/StatsPanel';
import { getUserRoutes, deleteRoute, getUserTags, hydrateRoutePoints, getUserCars } from '../firebase/data';
import { routeFingerprint, getCachedPoints, putCachedPoints, deleteCachedPoints, clearPointsCache } from '../utils/pointsCache';
import type { Route, TagDef, Car } from '../firebase/data';
import type { MapSettings } from '../components/SettingsPanel';
import type { RouteMapViewHandle } from '../components/RouteMapView';
import type { Landmark } from '../firebase/data';

type Tab = 'routes' | 'landmarks';

interface Props { user: User; }

const DEFAULT_SETTINGS: MapSettings = { tileKey: 'roadmap', colorMode: 'solid', lineWidth: 5 };

export default function MainPage({ user }: Props) {
  const [tab, setTab]                       = useState<Tab>('routes');
  const [routes, setRoutes]                 = useState<Route[]>([]);
  const [routesLoading, setRoutesLoading]   = useState(true);
  const [selectedRoute, setSelectedRoute]   = useState<Route | null>(null);
  const [showAllRoutes, setShowAllRoutes]   = useState(false);
  const [mapSettings, setMapSettings]       = useState<MapSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [carsOpen, setCarsOpen]             = useState(false);
  const [activityOpen, setActivityOpen]     = useState(false);
  const [prefsOpen, setPrefsOpen]           = useState(false);
  const [gapScanOpen, setGapScanOpen]       = useState(false);
  const [statsOpen, setStatsOpen]           = useState(false);
  // ルート絞り込み（車両・日付）。一覧と「全ルート表示」の両方に効く
  const [carFilter, setCarFilter]           = useState<string>('');   // Car.id
  const [dateFrom, setDateFrom]             = useState<string>('');   // YYYY-MM-DD
  const [dateTo, setDateTo]                 = useState<string>('');
  const [landmarkCount, setLandmarkCount]   = useState(0);
  const [tags, setTags]                     = useState<TagDef[]>([]);
  const [cars, setCars]                     = useState<Car[]>([]);
  const [activeCar, setActiveCar]           = useState<Car | null>(null);
  const [carWarning, setCarWarning]         = useState(false);
  const [mapRightClickCb, setMapPickCallback] = useState<((lat: number, lng: number, placeId?: string) => void) | null>(null);
  const [pinDragMode, setPinDragMode] = useState<{ id: string; originalLat: number; originalLng: number; onDragEnd: (lat: number, lng: number) => void } | null>(null);
  const mapViewRef = useRef<RouteMapViewHandle>(null);

  // チャンク形式ルートの points をバックグラウンドで補充（一覧表示は先に出す）。
  // IndexedDBキャッシュ優先: 点列が変わっていないルートはFirestore読み取りゼロで即復元。
  const hydrate = (list: Route[]) => {
    hydrateRoutePoints(list, (routeId, points) => {
      setRoutes(prev => prev.map(r => r.id === routeId ? { ...r, points } : r));
      setSelectedRoute(prev => prev?.id === routeId ? { ...prev, points } : prev);
    }, {
      get: r => getCachedPoints(r.id!, routeFingerprint(r)),
      put: (r, points) => putCachedPoints(r.id!, routeFingerprint(r), points),
    }).catch(() => {});
  };

  useEffect(() => {
    getUserRoutes(user.uid).then(r => { setRoutes(r); setRoutesLoading(false); hydrate(r); });
    getUserTags(user.uid).then(setTags);
    getUserCars(user.uid).then(setCars).catch(() => {}); // 車両フィルタ用（CarsPanelを開かなくても必要）
  }, [user.uid]);

  // 車両・日付フィルタを適用した表示対象ルート（一覧・全ルート表示の両方で使用）
  const visibleRoutes = useMemo(() => {
    let list = routes;
    if (carFilter) {
      const car = cars.find(c => c.id === carFilter);
      const carTagName = car?.tagId ? tags.find(t => t.id === car.tagId)?.name : undefined;
      list = list.filter(r => car?.tagId && r.tags.some(id =>
        id === car.tagId || (carTagName != null && tags.find(t => t.id === id)?.name === carTagName)
      ));
    }
    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      if (!isNaN(from)) list = list.filter(r => r.startTime >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo).getTime() + 86400000; // 終了日を含む
      if (!isNaN(to)) list = list.filter(r => r.startTime < to);
    }
    return list;
  }, [routes, carFilter, dateFrom, dateTo, cars, tags]);

  const reloadRoutes = () => {
    setRoutesLoading(true);
    getUserRoutes(user.uid).then(r => { setRoutes(r); setRoutesLoading(false); hydrate(r); });
  };

  const reloadTags = () => getUserTags(user.uid).then(setTags);

  const handleDelete = async (route: Route) => {
    if (!confirm(`「${route.name || '（無名）'}」を削除しますか？`)) return;
    await deleteRoute(route.id!);
    deleteCachedPoints(route.id!).catch(() => {});
    setRoutes(r => r.filter(x => x.id !== route.id));
    if (selectedRoute?.id === route.id) setSelectedRoute(null);
  };

  const handleUpdateRoute = (route: Route) => {
    setRoutes(prev => prev.map(r => r.id === route.id ? route : r));
    if (selectedRoute?.id === route.id) setSelectedRoute(route);
    // 修復・区間修正後の点列をキャッシュにも反映（次回起動時の再フェッチを防ぐ）
    if (route.id && route.points.length > 0) {
      const endTime = route.points[route.points.length - 1].timestamp;
      putCachedPoints(route.id, routeFingerprint({ ...route, pointCount: route.points.length, endTime }), route.points).catch(() => {});
    }
  };

  const handleFocusLandmark = (lm: Landmark) => {
    mapViewRef.current?.focusLandmark(lm.lat, lm.lng, lm.id!);
  };

  const startMapPickMode = (cb: (lat: number, lng: number, placeId?: string) => void) => {
    setMapPickCallback(() => cb);
  };
  const stopMapPickMode = () => setMapPickCallback(null);

  const startPinDragMode = (id: string, originalLat: number, originalLng: number, onDragEnd: (lat: number, lng: number) => void) => {
    setPinDragMode({ id, originalLat, originalLng, onDragEnd });
  };
  const stopPinDragMode = () => setPinDragMode(null);
  // タブ切替時にドラッグモードをリセット（マーカーを元の位置に戻す）
  const handleTabChange = (next: Tab) => {
    if (next !== 'landmarks' && pinDragMode) {
      mapViewRef.current?.revertLandmarkPosition(pinDragMode.id, pinDragMode.originalLat, pinDragMode.originalLng);
      setPinDragMode(null);
    }
    setTab(next);
  };
  const revertLandmarkPosition = (id: string, lat: number, lng: number) => {
    mapViewRef.current?.revertLandmarkPosition(id, lat, lng);
  };

  const getPlacesService = (): google.maps.places.PlacesService | null => {
    const map = mapViewRef.current?.getMap();
    if (!map || !window.google?.maps?.places) return null;
    return new google.maps.places.PlacesService(map);
  };

  return (
    <div style={styles.container}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.logo}>🗺️ PALOGPTracker</span>
          <button style={styles.logoutBtn} onClick={() => signOut(auth)}>ログアウト</button>
        </div>

        <div style={styles.tabs}>
          <button style={{ ...styles.tabBtn, ...(tab === 'routes' ? styles.tabBtnActive : {}) }} onClick={() => handleTabChange('routes')}>
            📋 ルート
          </button>
          <button style={{ ...styles.tabBtn, ...(tab === 'landmarks' ? styles.tabBtnActive : {}) }} onClick={() => handleTabChange('landmarks')}>
            ⭐ スポット
          </button>
        </div>

        <div style={styles.panelContent}>
          <div style={{ display: tab === 'routes' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <RoutesPanel
              userId={user.uid}
              routes={visibleRoutes}
              loading={routesLoading}
              selectedRoute={selectedRoute}
              showAllRoutes={showAllRoutes}
              onSelect={r => { setSelectedRoute(r); setShowAllRoutes(false); }}
              onDelete={handleDelete}
              onShowAll={() => { setShowAllRoutes(true); setSelectedRoute(null); }}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenCars={() => setCarsOpen(true)}
              onOpenActivity={() => setActivityOpen(true)}
              onOpenPrefs={() => setPrefsOpen(true)}
              onOpenGapScan={() => setGapScanOpen(true)}
              onOpenStats={() => setStatsOpen(true)}
              tags={tags}
              onUpdateRoute={handleUpdateRoute}
              onTagsChange={reloadTags}
              activeCar={activeCar}
              carWarning={carWarning}
              cars={cars}
              carFilter={carFilter}
              dateFrom={dateFrom}
              dateTo={dateTo}
              onCarFilter={setCarFilter}
              onDateFrom={setDateFrom}
              onDateTo={setDateTo}
            />
          </div>
          <div style={{ display: tab === 'landmarks' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <LandmarksPanel
              userId={user.uid}
              active={tab === 'landmarks'}
              onFocus={handleFocusLandmark}
              onCountChange={setLandmarkCount}
              getPlacesService={getPlacesService}
              startMapPickMode={startMapPickMode}
              stopMapPickMode={stopMapPickMode}
              startPinDragMode={startPinDragMode}
              stopPinDragMode={stopPinDragMode}
              revertLandmarkPosition={revertLandmarkPosition}
              activePinDragId={pinDragMode?.id ?? null}
            />
          </div>
        </div>
      </div>

      <div style={styles.mapArea}>
        <RouteMapView
          ref={mapViewRef}
          route={selectedRoute}
          allRoutes={showAllRoutes ? visibleRoutes : []}
          userId={user.uid}
          mapSettings={mapSettings}
          onMapSettings={setMapSettings}
          tags={tags}
          cars={cars}
          onMapRightClick={mapRightClickCb ?? undefined}
          pinDragMode={tab === 'landmarks' ? pinDragMode : null}
          onUpdateRoute={handleUpdateRoute}
        />
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={mapSettings}
        onSettings={setMapSettings}
        userId={user.uid}
        routeCount={routes.length}
        landmarkCount={landmarkCount}
        onDeleteAllRoutes={() => { setRoutes([]); setSelectedRoute(null); setShowAllRoutes(false); clearPointsCache().catch(() => {}); }}
        onDeleteAllLandmarks={() => setLandmarkCount(0)}
        onImportDone={reloadRoutes}
        getPlacesService={getPlacesService}
        routes={routes}
      />

      <ActivityPanel
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        routes={routes}
      />

      <PrefectureMapPanel
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        routes={routes}
      />

      <GapScanPanel
        open={gapScanOpen}
        onClose={() => setGapScanOpen(false)}
        routes={routes}
        onSelectRoute={r => { setSelectedRoute(r); setShowAllRoutes(false); setTab('routes'); }}
        onUpdateRoute={handleUpdateRoute}
      />

      <StatsPanel
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        routes={routes}
        cars={cars}
        tags={tags}
      />

      <CarsPanel
        open={carsOpen}
        onClose={() => setCarsOpen(false)}
        userId={user.uid}
        routes={routes}
        tags={tags}
        activeCar={activeCar}
        onSetActiveCar={setActiveCar}
        onTagsChange={reloadTags}
        onCarsChange={setCars}
        onRefreshRoutes={async () => { reloadRoutes(); }}
        onWarningChange={setCarWarning}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:     { display: 'flex', height: '100vh', overflow: 'hidden' },
  sidebar:       { width: 400, background: '#ffffff', display: 'flex', flexDirection: 'column', borderRight: '1px solid #e8eaed', flexShrink: 0 },
  sidebarHeader: { padding: '16px 20px', borderBottom: '1px solid #e8eaed', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo:          { color: '#2563eb', fontWeight: 700, fontSize: 15 },
  logoutBtn:     { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 },
  tabs:          { display: 'flex', borderBottom: '1px solid #e8eaed' },
  tabBtn:        { flex: 1, padding: '12px 8px', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  tabBtnActive:  { color: '#2563eb', borderBottom: '2px solid #2563eb' },
  panelContent:  { flex: 1, overflow: 'auto' },
  mapArea:       { flex: 1, position: 'relative' },
};
