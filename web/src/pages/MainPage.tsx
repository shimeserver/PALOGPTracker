import { useEffect, useRef, useState } from 'react';
import { signOut, type User } from 'firebase/auth';
import { auth } from '../firebase/config';
import RoutesPanel from '../components/RoutesPanel';
import RouteMapView from '../components/RouteMapView';
import LandmarksPanel from '../components/LandmarksPanel';
import SettingsPanel from '../components/SettingsPanel';
import CarsPanel from '../components/CarsPanel';
import ActivityPanel from '../components/ActivityPanel';
import { getUserRoutes, deleteRoute, getUserTags } from '../firebase/data';
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
  const [landmarkCount, setLandmarkCount]   = useState(0);
  const [tags, setTags]                     = useState<TagDef[]>([]);
  const [, setCars]                         = useState<Car[]>([]);
  const [activeCar, setActiveCar]           = useState<Car | null>(null);
  const [carWarning, setCarWarning]         = useState(false);
  const [mapRightClickCb, setMapPickCallback] = useState<((lat: number, lng: number, placeId?: string) => void) | null>(null);
  const mapViewRef = useRef<RouteMapViewHandle>(null);

  useEffect(() => {
    getUserRoutes(user.uid).then(r => { setRoutes(r); setRoutesLoading(false); });
    getUserTags(user.uid).then(setTags);
  }, [user.uid]);

  const reloadRoutes = () => {
    setRoutesLoading(true);
    getUserRoutes(user.uid).then(r => { setRoutes(r); setRoutesLoading(false); });
  };

  const reloadTags = () => getUserTags(user.uid).then(setTags);

  const handleDelete = async (route: Route) => {
    if (!confirm(`「${route.name || '（無名）'}」を削除しますか？`)) return;
    await deleteRoute(route.id!);
    setRoutes(r => r.filter(x => x.id !== route.id));
    if (selectedRoute?.id === route.id) setSelectedRoute(null);
  };

  const handleUpdateRoute = (route: Route) => {
    setRoutes(prev => prev.map(r => r.id === route.id ? route : r));
    if (selectedRoute?.id === route.id) setSelectedRoute(route);
  };

  const handleFocusLandmark = (lm: Landmark) => {
    mapViewRef.current?.focusLandmark(lm.lat, lm.lng, lm.id!);
  };

  const startMapPickMode = (cb: (lat: number, lng: number, placeId?: string) => void) => {
    setMapPickCallback(() => cb);
  };
  const stopMapPickMode = () => setMapPickCallback(null);

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
          <button style={{ ...styles.tabBtn, ...(tab === 'routes' ? styles.tabBtnActive : {}) }} onClick={() => setTab('routes')}>
            📋 ルート
          </button>
          <button style={{ ...styles.tabBtn, ...(tab === 'landmarks' ? styles.tabBtnActive : {}) }} onClick={() => setTab('landmarks')}>
            ⭐ スポット
          </button>
        </div>

        <div style={styles.panelContent}>
          <div style={{ display: tab === 'routes' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <RoutesPanel
              userId={user.uid}
              routes={routes}
              loading={routesLoading}
              selectedRoute={selectedRoute}
              showAllRoutes={showAllRoutes}
              onSelect={r => { setSelectedRoute(r); setShowAllRoutes(false); }}
              onDelete={handleDelete}
              onShowAll={() => { setShowAllRoutes(true); setSelectedRoute(null); }}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenCars={() => setCarsOpen(true)}
              onOpenActivity={() => setActivityOpen(true)}
              tags={tags}
              onUpdateRoute={handleUpdateRoute}
              onTagsChange={reloadTags}
              activeCar={activeCar}
              carWarning={carWarning}
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
            />
          </div>
        </div>
      </div>

      <div style={styles.mapArea}>
        <RouteMapView
          ref={mapViewRef}
          route={selectedRoute}
          allRoutes={showAllRoutes ? routes : []}
          userId={user.uid}
          mapSettings={mapSettings}
          onMapSettings={setMapSettings}
          tags={tags}
          onMapRightClick={mapRightClickCb ?? undefined}
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
        onDeleteAllRoutes={() => { setRoutes([]); setSelectedRoute(null); setShowAllRoutes(false); }}
        onDeleteAllLandmarks={() => setLandmarkCount(0)}
        onImportDone={reloadRoutes}
      />

      <ActivityPanel
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        routes={routes}
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
  sidebar:       { width: 360, background: '#ffffff', display: 'flex', flexDirection: 'column', borderRight: '1px solid #e8eaed', flexShrink: 0 },
  sidebarHeader: { padding: '16px 20px', borderBottom: '1px solid #e8eaed', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo:          { color: '#2563eb', fontWeight: 700, fontSize: 15 },
  logoutBtn:     { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12 },
  tabs:          { display: 'flex', borderBottom: '1px solid #e8eaed' },
  tabBtn:        { flex: 1, padding: '12px 8px', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  tabBtnActive:  { color: '#2563eb', borderBottom: '2px solid #2563eb' },
  panelContent:  { flex: 1, overflow: 'auto' },
  mapArea:       { flex: 1, position: 'relative' },
};
