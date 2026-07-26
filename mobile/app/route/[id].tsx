import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, TextInput, Alert, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import WebView from 'react-native-webview';
import { getRoute, updateRoute } from '../../src/firebase/routes';
import { getUserTags, getUserCars, addFuelLog } from '../../src/firebase/cars';
import { saveLandmark, getUserLandmarks, recordVisit, recordVisitOnly } from '../../src/firebase/landmarks';
import { Route, TrackingMode } from '../../src/types';
import { useAuthStore } from '../../src/store/authStore';
import { detectStops, matchStopsToLandmarks, StopCluster } from '../../src/utils/visitDetection';
import { SPOT_CATEGORIES, categorizeByName, categoryEmoji } from '../../src/utils/spotCategory';
import { fetchNearbyPois, NearbyPoi } from '../../src/utils/nearbyPoi';

function formatDate(ms: number) {
  return new Date(ms).toLocaleString('ja-JP');
}
function formatDuration(startMs: number, endMs: number) {
  const mins = Math.round((endMs - startMs) / 60000);
  if (mins < 60) return `${mins}分`;
  return `${Math.floor(mins / 60)}時間${mins % 60}分`;
}

const CATEGORIES = SPOT_CATEGORIES;

const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="file:///android_asset/leaflet.min.css"/>
  <script src="file:///android_asset/leaflet.min.js"></script>
  <style>
    body,html,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    .leaflet-control-attribution{font-size:9px}
    .pin-start{background:#22c55e;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap}
    .pin-end{background:#ef4444;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap}
    .pin-cursor{width:16px;height:16px;background:#4fc3f7;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 3px rgba(79,195,247,0.4)}
    .pin-stop{width:20px;height:20px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer}
    .pin-lm{display:flex;flex-direction:column;align-items:center;cursor:pointer}
    .pin-lm-dot{width:28px;height:28px;background:#f59e0b;border:2.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,0.3)}
    .pin-lm-fuel{background:#16a34a}
    .pin-lm-label{background:rgba(255,255,255,0.95);color:#1f2937;font-size:9px;font-weight:600;padding:1px 5px;border-radius:6px;margin-top:1px;white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,0.15)}
  </style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map',{zoomControl:true}).setView([35.681236,139.767125],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom:19
}).addTo(map);

var routeLine = null;
var startMarker = null;
var endMarker = null;
var cursorMarker = null;
var stopMarkers = [];
var lmMarkers = [];
var playbackPoints = null;

function makeIcon(cls){ return L.divIcon({html:'<div class="'+cls+'"></div>',className:'',iconAnchor:[20,10]}); }
function makeCursor(){ return L.divIcon({html:'<div class="pin-cursor"></div>',className:'',iconSize:[16,16],iconAnchor:[8,8]}); }
function makeStopIcon(){ return L.divIcon({html:'<div class="pin-stop"></div>',className:'',iconSize:[20,20],iconAnchor:[10,10]}); }

window.initRoute = function(points) {
  if(!points||points.length===0) return;
  var latlngs = points.map(function(p){return[p.lat,p.lng];});
  routeLine = L.polyline(latlngs,{color:'#4fc3f7',weight:4,opacity:0.9}).addTo(map);
  map.fitBounds(routeLine.getBounds(),{padding:[40,40]});
  startMarker = L.marker([points[0].lat,points[0].lng],{icon:makeIcon('pin-start')}).addTo(map);
  if(points.length>1){
    endMarker = L.marker([points[points.length-1].lat,points[points.length-1].lng],{icon:makeIcon('pin-end')}).addTo(map);
  }
};

window.setLandmarks = function(landmarks) {
  lmMarkers.forEach(function(m){map.removeLayer(m);});
  lmMarkers = [];
  landmarks.forEach(function(lm){
    var isFuel = lm.category === 'ガソリンスタンド';
    var emoji = lm.emoji || '★';
    var dotCls = 'pin-lm-dot' + (isFuel ? ' pin-lm-fuel' : '');
    var short = lm.name.length > 8 ? lm.name.slice(0,8)+'…' : lm.name;
    var html = '<div class="pin-lm"><div class="'+dotCls+'">'+emoji+'</div><div class="pin-lm-label">'+short+'</div></div>';
    var icon = L.divIcon({html:html,className:'',iconSize:[80,42],iconAnchor:[40,34]});
    var m = L.marker([lm.lat,lm.lng],{icon:icon}).addTo(map);
    m.on('click',function(){
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type:'tapLandmark',id:lm.id,name:lm.name,category:lm.category,lat:lm.lat,lng:lm.lng
      }));
    });
    lmMarkers.push(m);
  });
};

window.setStopCandidates = function(stops) {
  stopMarkers.forEach(function(m){map.removeLayer(m);});
  stopMarkers = [];
  stops.forEach(function(stop){
    var m = L.marker([stop.lat,stop.lng],{icon:makeStopIcon()}).addTo(map);
    m.bindPopup(
      '<b style="font-size:13px">🔵 未登録スポット候補</b><br>' +
      '<span style="font-size:11px;color:#6b7280">' + Math.round(stop.durationMs/60000) + '分滞在</span><br>' +
      '<span style="font-size:11px;color:#2563eb">タップしてスポット追加</span>',
      {maxWidth:200}
    );
    m.on('click', function(){
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'addStop',
        lat: stop.lat,
        lng: stop.lng,
        durationMs: stop.durationMs
      }));
    });
    stopMarkers.push(m);
  });
};

window.startPlayback = function(points) {
  playbackPoints = points;
  if(endMarker){ endMarker.remove(); endMarker=null; }
};

window.updatePlayback = function(index) {
  if(!playbackPoints) return;
  var slice = playbackPoints.slice(0, index+1);
  var latlngs = slice.map(function(p){return[p.lat,p.lng];});
  if(routeLine) routeLine.setLatLngs(latlngs);
  var cur = playbackPoints[index];
  if(!cursorMarker){
    cursorMarker = L.marker([cur.lat,cur.lng],{icon:makeCursor(),zIndexOffset:1000}).addTo(map);
  } else {
    cursorMarker.setLatLng([cur.lat,cur.lng]);
  }
  map.panTo([cur.lat,cur.lng],{animate:true,duration:0.2});
};

window.resetPlayback = function(points) {
  if(!points||points.length===0) return;
  var latlngs = points.map(function(p){return[p.lat,p.lng];});
  if(routeLine) routeLine.setLatLngs(latlngs);
  if(cursorMarker){ cursorMarker.remove(); cursorMarker=null; }
  if(!endMarker && points.length>1){
    endMarker = L.marker([points[points.length-1].lat,points[points.length-1].lng],{icon:makeIcon('pin-end')}).addTo(map);
  }
  map.fitBounds(L.polyline(latlngs).getBounds(),{padding:[40,40]});
};
</script>
</body>
</html>`;

export default function RouteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();
  const webviewRef = useRef<WebView>(null);
  const initialized = useRef(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [playback, setPlayback] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 未登録スポット候補
  const [stopCandidates, setStopCandidates] = useState<StopCluster[]>([]);
  const [addStopModal, setAddStopModal] = useState<{ lat: number; lng: number; durationMs: number } | null>(null);
  const [newSpotName, setNewSpotName] = useState('');
  const [newSpotCategory, setNewSpotCategory] = useState('その他');
  const [saving, setSaving] = useState(false);
  const [nearbyPois, setNearbyPois] = useState<NearbyPoi[]>([]);

  // 名前変更
  const [renameModal, setRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  // 給油モーダル
  const [fuelModal, setFuelModal] = useState<{ name: string; lat: number; lng: number } | null>(null);
  const [fuelForm, setFuelForm] = useState({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '' });
  const [fuelCarId, setFuelCarId] = useState('');
  const [fuelTimestamp, setFuelTimestamp] = useState(0);
  const [savingFuel, setSavingFuel] = useState(false);
  const [userCars, setUserCars] = useState<{ id: string; nickname: string; tagId?: string }[]>([]);

  // モード／タグ編集
  const [editModeModal, setEditModeModal] = useState(false);
  const [editMode, setEditMode] = useState<TrackingMode>('car');
  const [editTagId, setEditTagId] = useState<string | null>(null);
  const [userTags, setUserTags] = useState<{ id: string; name: string; color: string }[]>([]);
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    if (!id) return;
    getRoute(id).then(r => { setRoute(r); setLoading(false); });
  }, [id]);

  useEffect(() => {
    if (!user) return;
    getUserTags(user.uid).then(setUserTags).catch(() => {});
  }, [user]);

  // ルート読み込み後に停車クラスタ解析＋ランドマーク表示
  useEffect(() => {
    if (!route || !user) return;
    const stops = detectStops(route.points);
    getUserLandmarks(user.uid).then(landmarks => {
      // 停車候補（未登録スポット）
      if (stops.length > 0) {
        const { unmatchedStops } = matchStopsToLandmarks(stops, landmarks);
        setStopCandidates(unmatchedStops);
        if (initialized.current && unmatchedStops.length > 0) {
          webviewRef.current?.injectJavaScript(`window.setStopCandidates(${JSON.stringify(unmatchedStops)});true;`);
        }
      }
      // ランドマーク表示
      const lmData = landmarks.map(lm => ({ id: lm.id, name: lm.name, category: lm.category, lat: lm.lat, lng: lm.lng, emoji: categoryEmoji(lm.category) }));
      if (initialized.current) {
        webviewRef.current?.injectJavaScript(`window.setLandmarks(${JSON.stringify(lmData)});true;`);
      }
    }).catch(() => {});
  }, [route, user]);

  const handleLoad = () => {
    initialized.current = true;
    if (!route) return; // route未着なら useEffect([route]) が後で送る
    const pts = JSON.stringify(route.points);
    webviewRef.current?.injectJavaScript(`window.initRoute(${pts});true;`);
    if (stopCandidates.length > 0) {
      webviewRef.current?.injectJavaScript(`window.setStopCandidates(${JSON.stringify(stopCandidates)});true;`);
    }
  };

  useEffect(() => {
    if (route && initialized.current) {
      webviewRef.current?.injectJavaScript(`window.initRoute(${JSON.stringify(route.points)});true;`);
      // WebViewロード後にrouteが到着したケース: stopCandidatesはまだ空なので
      // useEffect([route, user]) 内の matchStopsToLandmarks 完了後に送られる
    }
  }, [route]);

  const handleWebViewMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'addStop') {
        setAddStopModal({ lat: msg.lat, lng: msg.lng, durationMs: msg.durationMs });
        setNewSpotName('');
        setNewSpotCategory('その他');
        // 近隣施設候補を取得（タップで名前・カテゴリ自動入力）
        setNearbyPois([]);
        fetchNearbyPois(msg.lat, msg.lng).then(setNearbyPois).catch(() => {});
      } else if (msg.type === 'tapLandmark' && msg.category === 'ガソリンスタンド' && route) {
        openFuelModal(msg);
      }
    } catch {}
  };

  const openFuelModal = async (lm: { name: string; lat: number; lng: number }) => {
    if (!user || !route) return;
    // 愛車を自動取得・特定
    let cars = userCars;
    if (cars.length === 0) {
      try { cars = await getUserCars(user.uid); setUserCars(cars); } catch {}
    }
    const tagId = route.tags?.[0];
    const matched = cars.find(c => c.tagId === tagId);
    setFuelCarId(matched?.id ?? (cars.length === 1 ? (cars[0].id ?? '') : ''));
    // タイムスタンプ: 停車クラスタ中間 > 最近傍GPS点
    let ts = route.startTime;
    const stops = detectStops(route.points);
    const cosLat = Math.cos((lm.lat * Math.PI) / 180); // 経度は緯度により縮む
    let usedStop = false;
    for (const stop of stops) {
      const dLat = stop.lat - lm.lat, dLng = (stop.lng - lm.lng) * cosLat;
      const d = Math.sqrt(dLat ** 2 + dLng ** 2) * 111;
      if (d < 0.2) { ts = Math.round((stop.startTime + stop.endTime) / 2); usedStop = true; break; }
    }
    if (!usedStop) {
      let minD = Infinity;
      for (const pt of route.points) {
        const dLat = pt.lat - lm.lat, dLng = (pt.lng - lm.lng) * cosLat;
        const d = dLat ** 2 + dLng ** 2;
        if (d < minD) { minD = d; ts = pt.timestamp; }
      }
    }
    setFuelTimestamp(ts);
    setFuelForm({ liters: '', pricePerLiter: '', totalCost: '', isFull: true, notes: '' });
    setFuelModal(lm);
  };

  const handleSaveFuel = async () => {
    if (!fuelCarId || !fuelForm.liters) return;
    const liters = parseFloat(fuelForm.liters);
    if (isNaN(liters) || liters <= 0) { Alert.alert('エラー', '給油量を正しく入力してください'); return; }
    setSavingFuel(true);
    try {
      const pricePerLiter = fuelForm.pricePerLiter ? parseFloat(fuelForm.pricePerLiter) : undefined;
      const totalCost = fuelForm.totalCost ? parseFloat(fuelForm.totalCost)
        : (pricePerLiter ? pricePerLiter * liters : undefined);
      const logData: Omit<import('../../src/types').FuelLog, 'id' | 'carId'> = {
        timestamp: fuelTimestamp,
        liters,
        isFull: fuelForm.isFull,
        ...(pricePerLiter !== undefined && { pricePerLiter }),
        ...(totalCost !== undefined && { totalCost }),
        ...(fuelForm.notes.trim() && { notes: fuelForm.notes.trim() }),
      };
      await addFuelLog(fuelCarId, logData);
      setFuelModal(null);
      Alert.alert('完了', `⛽ ${fuelModal?.name} の給油記録を保存しました`);
    } catch (e: any) {
      Alert.alert('エラー', e.message ?? '保存に失敗しました');
    } finally {
      setSavingFuel(false);
    }
  };

  const handleSaveRename = async () => {
    if (!route?.id) return;
    const name = renameValue.trim();
    if (!name) return;
    setSavingRename(true);
    try {
      await updateRoute(route.id, { name });
      setRoute(r => r ? { ...r, name } : r);
      setRenameModal(false);
    } catch {
      Alert.alert('エラー', '名前の変更に失敗しました');
    } finally {
      setSavingRename(false);
    }
  };

  const handleOpenEditMode = () => {
    if (!route) return;
    setEditMode((route.mode ?? 'car') as TrackingMode);
    setEditTagId(route.tags?.[0] ?? null);
    setEditModeModal(true);
  };

  const handleSaveMode = async () => {
    if (!route?.id) return;
    setSavingMode(true);
    try {
      const tags = editTagId ? [editTagId] : [];
      await updateRoute(route.id, { mode: editMode, tags });
      setRoute(r => r ? { ...r, mode: editMode, tags } : r);
      setEditModeModal(false);
    } catch {
      Alert.alert('エラー', '更新に失敗しました');
    } finally {
      setSavingMode(false);
    }
  };

  const handleSaveSpot = async () => {
    if (!user || !addStopModal || !newSpotName.trim()) return;
    setSaving(true);
    try {
      const now = Date.now();
      const landmarkId = await saveLandmark({
        userId: user.uid,
        name: newSpotName.trim(),
        category: newSpotCategory,
        lat: addStopModal.lat,
        lng: addStopModal.lng,
        description: '',
        photos: [],
        visitCount: 1,
        firstVisit: now,
        lastVisit: now,
        createdAt: now,
      });
      // visitsサブコレクションに初回来訪ドキュメントを作成（visitCount:1と一致）
      // recordVisitはincrementするため直接visits追加のみ行う
      await recordVisitOnly(landmarkId, { landmarkId, userId: user.uid, timestamp: now, routeId: id ?? undefined });
      // 保存済み候補を除去してマップから消す
      const remaining = stopCandidates.filter(s => s.lat !== addStopModal.lat || s.lng !== addStopModal.lng);
      setStopCandidates(remaining);
      webviewRef.current?.injectJavaScript(`window.setStopCandidates(${JSON.stringify(remaining)});true;`);
      setAddStopModal(null);
      Alert.alert('追加完了', `「${newSpotName.trim()}」をスポットに追加しました`);
    } catch {
      Alert.alert('エラー', 'スポットの保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const startPlayback = () => {
    if (!route) return;
    const pts = JSON.stringify(route.points);
    webviewRef.current?.injectJavaScript(`window.startPlayback(${pts});true;`);
    setPlayIndex(0);
    setPlayback(true);
    playRef.current = setInterval(() => {
      setPlayIndex(i => {
        const next = i + 1;
        if (next >= route.points.length) {
          clearInterval(playRef.current!);
          setPlayback(false);
          return i;
        }
        webviewRef.current?.injectJavaScript(`window.updatePlayback(${next});true;`);
        return next;
      });
    }, 100);
  };

  const stopPlayback = () => {
    if (playRef.current) clearInterval(playRef.current);
    setPlayback(false);
    if (route) {
      webviewRef.current?.injectJavaScript(`window.resetPlayback(${JSON.stringify(route.points)});true;`);
    }
  };

  useEffect(() => {
    return () => { if (playRef.current) clearInterval(playRef.current); };
  }, []);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#4fc3f7" size="large" /></View>;
  }
  if (!route) {
    return <View style={styles.center}><Text style={styles.errorText}>ルートが見つかりません</Text></View>;
  }

  const currentPlayPoint = route.points[playIndex];

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={{ html: MAP_HTML, baseUrl: 'https://localhost' }}
        style={styles.map}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        originWhitelist={['*']}
        mixedContentMode="always"
        onLoad={handleLoad}
        onMessage={handleWebViewMessage}
        overScrollMode="never"
        bounces={false}
      />

      {stopCandidates.length > 0 && (
        <View style={styles.stopBadge}>
          <Text style={styles.stopBadgeText}>🔵 {stopCandidates.length}か所の未登録スポット候補（ピンをタップ）</Text>
        </View>
      )}

      <View style={styles.panel}>
        <TouchableOpacity onPress={() => { setRenameValue(route.name); setRenameModal(true); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.routeName} numberOfLines={1}>{route.name}</Text>
          <Text style={{ color: '#4fc3f7', fontSize: 14 }}>✏️</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 10 }}>
          <Text style={styles.routeDate}>{formatDate(route.startTime)}</Text>
          <TouchableOpacity onPress={handleOpenEditMode} style={{ backgroundColor: '#1e3a5f', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 }}>
            <Text style={{ color: '#4fc3f7', fontSize: 12 }}>
              {route.mode === 'walk' ? '🚶' : route.mode === 'bicycle' ? '🚲' : '🚗'} 変更
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setLoading(true); getRoute(id!).then(r => { setRoute(r); setLoading(false); initialized.current = false; }); }} style={{ backgroundColor: '#1e3a5f', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 }}>
            <Text style={{ color: '#4fc3f7', fontSize: 12 }}>🔄</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.metrics}>
          <View style={styles.metric}>
            <Text style={styles.metricVal}>{route.totalDistance.toFixed(1)}</Text>
            <Text style={styles.metricLbl}>km</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricVal}>{route.avgSpeed.toFixed(0)}</Text>
            <Text style={styles.metricLbl}>平均km/h</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricVal}>{route.maxSpeed.toFixed(0)}</Text>
            <Text style={styles.metricLbl}>最高km/h</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricVal}>{formatDuration(route.startTime, route.endTime)}</Text>
            <Text style={styles.metricLbl}>時間</Text>
          </View>
        </View>

        {playback ? (
          <View style={styles.playbackRow}>
            <Text style={styles.playbackInfo}>
              {Math.round((playIndex / route.points.length) * 100)}%{'  '}{currentPlayPoint?.speed.toFixed(0)}km/h
            </Text>
            <TouchableOpacity style={styles.stopBtn} onPress={stopPlayback}>
              <Text style={styles.stopBtnText}>■ 停止</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.playBtn} onPress={startPlayback}>
            <Text style={styles.playBtnText}>▶ ルートを再生</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* スポット追加モーダル */}
      <Modal visible={!!addStopModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>スポットを追加</Text>
            {addStopModal && (
              <Text style={styles.modalSub}>{Math.round(addStopModal.durationMs / 60000)}分滞在したエリア</Text>
            )}
            {nearbyPois.length > 0 && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: '#9ca3af', fontSize: 11, fontWeight: '600', marginBottom: 6 }}>📍 近くの施設（タップで自動入力）</Text>
                <View style={{ maxHeight: 130, borderWidth: 1, borderColor: '#f3f4f6', borderRadius: 8 }}>
                  <ScrollView>
                    {nearbyPois.map((p, i) => (
                      <TouchableOpacity
                        key={`${p.name}-${i}`}
                        onPress={() => { setNewSpotName(p.name); setNewSpotCategory(p.category); }}
                        style={{ paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: newSpotName === p.name ? '#eff6ff' : '#fff' }}
                      >
                        <Text style={{ fontSize: 13, color: '#1f2937' }}>
                          {categoryEmoji(p.category)} {p.name}
                          <Text style={{ color: '#9ca3af', fontSize: 11 }}>  {p.distM}m</Text>
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              </View>
            )}
            <TextInput
              style={styles.input}
              placeholder="スポット名"
              value={newSpotName}
              onChangeText={(v) => { setNewSpotName(v); const c = categorizeByName(v); if (c) setNewSpotCategory(c); }}
              autoFocus
            />
            <Text style={styles.catLabel}>カテゴリ</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll}>
              {CATEGORIES.map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.catBtn, newSpotCategory === cat && styles.catBtnActive]}
                  onPress={() => setNewSpotCategory(cat)}
                >
                  <Text style={[styles.catBtnText, newSpotCategory === cat && styles.catBtnTextActive]}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setAddStopModal(null)}>
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, (!newSpotName.trim() || saving) && styles.saveBtnDisabled]}
                onPress={handleSaveSpot}
                disabled={!newSpotName.trim() || saving}
              >
                <Text style={styles.saveBtnText}>{saving ? '保存中...' : '追加'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 給油記録モーダル */}
      <Modal visible={!!fuelModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <ScrollView>
            <View style={[styles.modalCard, { maxHeight: '90%' }]}>
              <Text style={styles.modalTitle}>⛽ 給油記録</Text>
              <Text style={{ color: '#6b7280', fontSize: 13, marginBottom: 4 }}>{fuelModal?.name}</Text>
              <Text style={{ color: '#9ca3af', fontSize: 11, marginBottom: 16 }}>
                🕐 {new Date(fuelTimestamp).toLocaleString('ja-JP')}
              </Text>
              {/* 愛車の選択（複数ある場合や自動特定できない場合に選べる） */}
              {userCars.length > 0 && (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 6 }}>
                    愛車{!fuelCarId ? ' — 選択してください' : ''}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {userCars.map(c => (
                      <TouchableOpacity key={c.id} onPress={() => setFuelCarId(c.id ?? '')}
                        style={{
                          paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5,
                          borderColor: fuelCarId === c.id ? '#16a34a' : '#d1d5db',
                          backgroundColor: fuelCarId === c.id ? '#dcfce7' : '#fff',
                        }}>
                        <Text style={{ color: fuelCarId === c.id ? '#16a34a' : '#6b7280', fontSize: 13, fontWeight: fuelCarId === c.id ? '700' : '400' }}>
                          🚗 {c.nickname}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>給油量 (L) *</Text>
                  <TextInput style={styles.modalInput} placeholder="例: 45.5" placeholderTextColor="#9ca3af"
                    keyboardType="decimal-pad" value={fuelForm.liters}
                    onChangeText={v => setFuelForm(f => ({ ...f, liters: v }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>単価 (円/L)</Text>
                  <TextInput style={styles.modalInput} placeholder="例: 165" placeholderTextColor="#9ca3af"
                    keyboardType="decimal-pad" value={fuelForm.pricePerLiter}
                    onChangeText={v => setFuelForm(f => ({ ...f, pricePerLiter: v }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>合計 (円)</Text>
                  <TextInput style={styles.modalInput} placeholder="例: 7500" placeholderTextColor="#9ca3af"
                    keyboardType="decimal-pad" value={fuelForm.totalCost}
                    onChangeText={v => setFuelForm(f => ({ ...f, totalCost: v }))} />
                </View>
              </View>
              <TouchableOpacity onPress={() => setFuelForm(f => ({ ...f, isFull: !f.isFull }))}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: fuelForm.isFull ? '#2563eb' : '#d1d5db', backgroundColor: fuelForm.isFull ? '#2563eb' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {fuelForm.isFull && <Text style={{ color: '#fff', fontSize: 12 }}>✓</Text>}
                </View>
                <Text style={{ color: '#374151', fontSize: 14 }}>満タン給油</Text>
              </TouchableOpacity>
              <TextInput style={styles.modalInput} placeholder="メモ（任意）" placeholderTextColor="#9ca3af"
                value={fuelForm.notes} onChangeText={v => setFuelForm(f => ({ ...f, notes: v }))} />
              <TouchableOpacity style={[styles.modalButton, { backgroundColor: (!fuelCarId || !fuelForm.liters) ? '#9ca3af' : '#16a34a', marginTop: 16 }]}
                onPress={handleSaveFuel} disabled={savingFuel || !fuelForm.liters || !fuelCarId}>
                <Text style={styles.modalButtonText}>{savingFuel ? '保存中...' : !fuelCarId ? '愛車を選択してください' : '⛽ 給油記録を保存'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setFuelModal(null)}>
                <Text style={styles.modalCancel}>キャンセル</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* 名前変更モーダル */}
      <Modal visible={renameModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ルート名を変更</Text>
            <TextInput
              style={styles.input}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="ルート名"
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setRenameModal(false)}>
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, (!renameValue.trim() || savingRename) && styles.saveBtnDisabled]}
                onPress={handleSaveRename}
                disabled={!renameValue.trim() || savingRename}
              >
                <Text style={styles.saveBtnText}>{savingRename ? '保存中...' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* モード／タグ編集モーダル */}
      <Modal visible={editModeModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>移動モードを変更</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
              {([['car', '🚗 車'], ['walk', '🚶 徒歩'], ['bicycle', '🚲 自転車']] as [TrackingMode, string][]).map(([m, label]) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.catBtn, { flex: 1, alignItems: 'center' }, editMode === m && styles.catBtnActive]}
                  onPress={() => setEditMode(m)}
                >
                  <Text style={[styles.catBtnText, editMode === m && styles.catBtnTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {userTags.length > 0 && (
              <>
                <Text style={styles.catLabel}>タグ（車）</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
                  <TouchableOpacity
                    style={[styles.catBtn, !editTagId && styles.catBtnActive]}
                    onPress={() => setEditTagId(null)}
                  >
                    <Text style={[styles.catBtnText, !editTagId && styles.catBtnTextActive]}>なし</Text>
                  </TouchableOpacity>
                  {userTags.map(tag => (
                    <TouchableOpacity
                      key={tag.id}
                      style={[styles.catBtn, { marginLeft: 8, borderColor: tag.color, borderWidth: 2 }, editTagId === tag.id && { backgroundColor: tag.color }]}
                      onPress={() => setEditTagId(tag.id)}
                    >
                      <Text style={[styles.catBtnText, editTagId === tag.id && { color: '#fff' }]}>{tag.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditModeModal(false)}>
                <Text style={styles.cancelBtnText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, savingMode && styles.saveBtnDisabled]} onPress={handleSaveMode} disabled={savingMode}>
                <Text style={styles.saveBtnText}>{savingMode ? '保存中...' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  errorText: { color: '#fff' },
  map: { flex: 1 },
  stopBadge: { backgroundColor: '#1e3a5f', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#0f3460' },
  stopBadgeText: { color: '#93c5fd', fontSize: 12 },
  panel: { backgroundColor: '#16213e', padding: 20, borderTopWidth: 1, borderTopColor: '#0f3460' },
  routeName: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  routeDate: { color: '#888', fontSize: 13 },
  metrics: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 },
  metric: { alignItems: 'center' },
  metricVal: { color: '#4fc3f7', fontSize: 22, fontWeight: 'bold' },
  metricLbl: { color: '#888', fontSize: 11, marginTop: 2 },
  playBtn: { backgroundColor: '#4fc3f7', borderRadius: 10, padding: 14, alignItems: 'center' },
  playBtnText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 16 },
  stopBtn: { backgroundColor: '#f44336', borderRadius: 10, padding: 12, alignItems: 'center', flex: 1 },
  stopBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  playbackRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playbackInfo: { color: '#4fc3f7', fontSize: 16, fontWeight: 'bold', flex: 1 },
  // モーダル
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1f2937', marginBottom: 4 },
  modalSub: { fontSize: 12, color: '#6b7280', marginBottom: 16 },
  input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 16 },
  catLabel: { fontSize: 13, color: '#6b7280', marginBottom: 8 },
  catScroll: { marginBottom: 20 },
  catBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: '#f3f4f6', marginRight: 8, borderWidth: 1, borderColor: '#e5e7eb' },
  catBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  catBtnText: { fontSize: 13, color: '#374151' },
  catBtnTextActive: { color: '#fff' },
  modalActions: { flexDirection: 'row', gap: 12 },
  cancelBtn: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#f3f4f6', alignItems: 'center' },
  cancelBtnText: { color: '#6b7280', fontWeight: '600' },
  saveBtn: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#2563eb', alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: '#93c5fd' },
  saveBtnText: { color: '#fff', fontWeight: '700' },
  modalInput: { borderWidth: 1.5, borderColor: '#e8eaed', borderRadius: 10, padding: 10, fontSize: 14, color: '#1f2937', backgroundColor: '#f9fafb', marginBottom: 0 },
  modalButton: { padding: 14, borderRadius: 10, alignItems: 'center' as const, backgroundColor: '#2563eb' },
  modalButtonText: { color: '#fff', fontWeight: '700' as const, fontSize: 15 },
  modalCancel: { textAlign: 'center' as const, color: '#9ca3af', fontSize: 14, marginTop: 12 },
});
