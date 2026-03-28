import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, TextInput, Alert, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import WebView from 'react-native-webview';
import { getRoute } from '../../src/firebase/routes';
import { saveLandmark, getUserLandmarks } from '../../src/firebase/landmarks';
import { Route } from '../../src/types';
import { useAuthStore } from '../../src/store/authStore';
import { detectStops, matchStopsToLandmarks, StopCluster } from '../../src/utils/visitDetection';

function formatDate(ms: number) {
  return new Date(ms).toLocaleString('ja-JP');
}
function formatDuration(startMs: number, endMs: number) {
  const mins = Math.round((endMs - startMs) / 60000);
  if (mins < 60) return `${mins}分`;
  return `${Math.floor(mins / 60)}時間${mins % 60}分`;
}

const CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', '駐車場'];

const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body,html,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    .leaflet-control-attribution{font-size:9px}
    .pin-start{background:#22c55e;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap}
    .pin-end{background:#ef4444;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap}
    .pin-cursor{width:16px;height:16px;background:#4fc3f7;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 3px rgba(79,195,247,0.4)}
    .pin-stop{width:20px;height:20px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer}
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

  useEffect(() => {
    if (!id) return;
    getRoute(id).then(r => { setRoute(r); setLoading(false); });
  }, [id]);

  // ルート読み込み後に停車クラスタを解析
  useEffect(() => {
    if (!route || !user) return;
    const stops = detectStops(route.points);
    if (stops.length === 0) return;
    getUserLandmarks(user.uid).then(landmarks => {
      const { unmatchedStops } = matchStopsToLandmarks(stops, landmarks);
      setStopCandidates(unmatchedStops);
      if (initialized.current && unmatchedStops.length > 0) {
        webviewRef.current?.injectJavaScript(`window.setStopCandidates(${JSON.stringify(unmatchedStops)});true;`);
      }
    }).catch(() => {});
  }, [route, user]);

  const handleLoad = () => {
    if (!route) return;
    const pts = JSON.stringify(route.points);
    webviewRef.current?.injectJavaScript(`window.initRoute(${pts});true;`);
    initialized.current = true;
    if (stopCandidates.length > 0) {
      webviewRef.current?.injectJavaScript(`window.setStopCandidates(${JSON.stringify(stopCandidates)});true;`);
    }
  };

  useEffect(() => {
    if (route && initialized.current) {
      webviewRef.current?.injectJavaScript(`window.initRoute(${JSON.stringify(route.points)});true;`);
    }
  }, [route]);

  const handleWebViewMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'addStop') {
        setAddStopModal({ lat: msg.lat, lng: msg.lng, durationMs: msg.durationMs });
        setNewSpotName('');
        setNewSpotCategory('その他');
      }
    } catch {}
  };

  const handleSaveSpot = async () => {
    if (!user || !addStopModal || !newSpotName.trim()) return;
    setSaving(true);
    try {
      await saveLandmark({
        userId: user.uid,
        name: newSpotName.trim(),
        category: newSpotCategory,
        lat: addStopModal.lat,
        lng: addStopModal.lng,
        description: '',
        photos: [],
        visitCount: 1,
        firstVisit: Date.now(),
        lastVisit: Date.now(),
        createdAt: Date.now(),
      });
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
        source={{ html: MAP_HTML }}
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
        <Text style={styles.routeName}>{route.name}</Text>
        <Text style={styles.routeDate}>{formatDate(route.startTime)}</Text>

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
            <TextInput
              style={styles.input}
              placeholder="スポット名"
              value={newSpotName}
              onChangeText={setNewSpotName}
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
  routeDate: { color: '#888', fontSize: 13, marginBottom: 16 },
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
});
