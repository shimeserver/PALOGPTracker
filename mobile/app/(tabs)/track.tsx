import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput, Modal } from 'react-native';
import WebView from 'react-native-webview';
import { useTrackingStore } from '../../src/store/trackingStore';
import { useAuthStore } from '../../src/store/authStore';
import { useCarStore } from '../../src/store/carStore';

const MINI_MAP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body,html,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    .leaflet-control-attribution{display:none}
    .leaflet-control-zoom{margin:6px!important}
    .loc-dot{width:14px;height:14px;background:#ef4444;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 3px rgba(239,68,68,0.3)}
    .route-start{background:#22c55e;color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:10px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);white-space:nowrap}
  </style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map',{zoomControl:true,attributionControl:false}).setView([35.681236,139.767125],14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
var routeLine=null,locMarker=null,startMarker=null;
function makeLocIcon(){return L.divIcon({html:'<div class="loc-dot"></div>',iconSize:[14,14],iconAnchor:[7,7],className:''});}
window.updateRoute=function(coords){
  if(routeLine){map.removeLayer(routeLine);routeLine=null;}
  if(startMarker){map.removeLayer(startMarker);startMarker=null;}
  if(locMarker){map.removeLayer(locMarker);locMarker=null;}
  if(!coords||coords.length<1)return;
  if(coords.length>=2){
    routeLine=L.polyline(coords,{color:'#2563eb',weight:4,opacity:0.9}).addTo(map);
    var sIcon=L.divIcon({html:'<div class="route-start">START</div>',className:'',iconAnchor:[20,10]});
    startMarker=L.marker(coords[0],{icon:sIcon}).addTo(map);
    map.fitBounds(routeLine.getBounds(),{padding:[20,20]});
  }
  var last=coords[coords.length-1];
  locMarker=L.marker(last,{icon:makeLocIcon(),zIndexOffset:1000}).addTo(map);
  if(coords.length<2){map.setView(last,15);}
};
window.addEventListener('message',function(e){try{var m=JSON.parse(e.data);if(m.type==='updateRoute')window.updateRoute(m.coords);}catch(err){console.error('Message parse error:',err);}});
document.addEventListener('message',function(e){try{var m=JSON.parse(e.data);if(m.type==='updateRoute')window.updateRoute(m.coords);}catch(err){console.error('Message parse error:',err);}});
</script>
</body>
</html>`;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function haversine(p1: { lat: number; lng: number }, p2: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) * Math.cos((p2.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function TrackScreen() {
  const { isTracking, currentPoints, currentSpeed, startTime, startTracking, stopTracking } = useTrackingStore();
  const { user } = useAuthStore();
  const { activeCar } = useCarStore();
  const [elapsed, setElapsed] = useState(0);
  const [showNameModal, setShowNameModal] = useState(false);
  const [routeName, setRouteName] = useState('');
  const miniMapRef = useRef<WebView>(null);
  const miniMapReady = useRef(false);
  const prevMiniMapLen = useRef(0);

  useEffect(() => {
    if (!isTracking || !startTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(timer);
  }, [isTracking, startTime]);

  const handleMiniMapLoad = () => {
    miniMapReady.current = true;
    prevMiniMapLen.current = 0;
    if (currentPoints.length >= 1) {
      const coords = currentPoints.map(p => [p.lat, p.lng]);
      miniMapRef.current?.injectJavaScript(
        `window.updateRoute(${JSON.stringify(coords)});true;`
      );
    }
  };

  useEffect(() => {
    if (!miniMapReady.current) return;
    if (currentPoints.length - prevMiniMapLen.current < 3 && currentPoints.length !== 0) return;
    prevMiniMapLen.current = currentPoints.length;
    const coords = currentPoints.map(p => [p.lat, p.lng]);
    miniMapRef.current?.injectJavaScript(
      `window.updateRoute(${JSON.stringify(coords)});true;`
    );
  }, [currentPoints.length]);

  const totalDist = currentPoints.length > 1
    ? currentPoints.reduce((acc, p, i) => i === 0 ? 0 : acc + haversine(currentPoints[i - 1], p), 0)
    : 0;

  const handleStart = async () => {
    try {
      await startTracking();
    } catch (error) {
      Alert.alert('エラー', error instanceof Error ? error.message : String(error));
    }
  };

  const handleSave = async () => {
    setShowNameModal(false);
    if (!user) return;
    try {
      const tagIds = activeCar?.tagId ? [activeCar.tagId] : undefined;
      const id = await stopTracking(user.uid, routeName || undefined, tagIds);
      if (id) {
        const carMsg = activeCar ? `\n🚗 ${activeCar.nickname} でタグ付け` : '';
        Alert.alert('保存完了', `ルートを保存しました（${currentPoints.length}ポイント）${carMsg}`);
      }
    } catch (error) {
      Alert.alert('保存エラー', error instanceof Error ? error.message : String(error));
    }
    setRouteName('');
    setElapsed(0);
  };

  return (
    <View style={styles.container}>
      {/* ステータス */}
      <View style={styles.statusBar}>
        <View style={[styles.statusDot, isTracking && styles.statusDotActive]} />
        <Text style={styles.statusText}>{isTracking ? '記録中' : '待機中'}</Text>
        {activeCar && (
          <View style={styles.activeCarBadge}>
            <Text style={styles.activeCarText}>🚗 {activeCar.nickname}</Text>
          </View>
        )}
      </View>

      {/* メトリクス */}
      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{currentSpeed.toFixed(1)}</Text>
          <Text style={styles.metricLabel}>km/h</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{formatDuration(elapsed)}</Text>
          <Text style={styles.metricLabel}>経過時間</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{totalDist.toFixed(2)}</Text>
          <Text style={styles.metricLabel}>km</Text>
        </View>
      </View>

      <Text style={styles.points}>{currentPoints.length} ポイント記録済み</Text>

      {/* ミニマップ */}
      <View style={styles.miniMapContainer}>
        <WebView
          ref={miniMapRef}
          source={{ html: MINI_MAP_HTML }}
          style={styles.miniMap}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled
          cacheMode="LOAD_CACHE_ELSE_NETWORK"
          originWhitelist={['*']}
          mixedContentMode="always"
          onLoad={handleMiniMapLoad}
          overScrollMode="never"
          bounces={false}
          scrollEnabled={false}
        />
        {!isTracking && currentPoints.length === 0 && (
          <View style={styles.miniMapOverlay}>
            <Text style={styles.miniMapOverlayText}>記録開始すると軌跡が表示されます</Text>
          </View>
        )}
      </View>

      {!isTracking ? (
        <TouchableOpacity style={styles.startButton} onPress={handleStart}>
          <Text style={styles.startButtonText}>▶ 記録開始</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.stopButton} onPress={() => setShowNameModal(true)}>
          <Text style={styles.stopButtonText}>■ 停止・保存</Text>
        </TouchableOpacity>
      )}

      {isTracking && (
        <Text style={styles.bgNote}>画面をロックしても記録は継続されます</Text>
      )}

      <Modal visible={showNameModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ルート名を入力</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="例: 奥多摩ドライブ"
              placeholderTextColor="#9ca3af"
              value={routeName}
              onChangeText={setRouteName}
              autoFocus
            />
            <TouchableOpacity style={styles.modalButton} onPress={handleSave}>
              <Text style={styles.modalButtonText}>保存する</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowNameModal(false)}>
              <Text style={styles.modalCancel}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9', padding: 24 },
  statusBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  statusDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#d1d5db', marginRight: 8 },
  statusDotActive: { backgroundColor: '#22c55e' },
  statusText: { color: '#6b7280', fontSize: 16, fontWeight: '500' },
  metrics: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 12, backgroundColor: '#fff', borderRadius: 16, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  metric: { alignItems: 'center' },
  metricValue: { fontSize: 28, fontWeight: 'bold', color: '#1f2937' },
  metricLabel: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  points: { color: '#9ca3af', textAlign: 'center', marginBottom: 8, fontSize: 14 },
  miniMapContainer: { borderRadius: 14, overflow: 'hidden', height: 200, marginBottom: 16, borderWidth: 1, borderColor: '#e5e7eb' },
  miniMap: { flex: 1 },
  miniMapOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(244,246,249,0.7)', justifyContent: 'center', alignItems: 'center' },
  miniMapOverlayText: { color: '#9ca3af', fontSize: 13, textAlign: 'center' },
  startButton: {
    backgroundColor: '#22c55e', borderRadius: 60, height: 120, width: 120,
    alignSelf: 'center', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#22c55e', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 8,
  },
  startButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  stopButton: {
    backgroundColor: '#ef4444', borderRadius: 60, height: 120, width: 120,
    alignSelf: 'center', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#ef4444', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 8,
  },
  stopButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
  bgNote: { color: '#9ca3af', textAlign: 'center', marginTop: 20, fontSize: 13 },
  activeCarBadge: { marginLeft: 'auto', backgroundColor: '#eff6ff', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  activeCarText: { color: '#2563eb', fontSize: 12, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 32 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 10 },
  modalTitle: { color: '#1f2937', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  modalInput: { backgroundColor: '#f8f9fa', color: '#1f2937', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 16, borderWidth: 1.5, borderColor: '#e8eaed' },
  modalButton: { backgroundColor: '#2563eb', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 12 },
  modalButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  modalCancel: { color: '#9ca3af', textAlign: 'center', fontSize: 14 },
});
