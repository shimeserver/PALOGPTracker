import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import WebView from 'react-native-webview';
import * as Location from 'expo-location';
import { useTrackingStore } from '../../src/store/trackingStore';
import { useAuthStore } from '../../src/store/authStore';
import { getUserLandmarks } from '../../src/firebase/landmarks';
import { Landmark } from '../../src/types';
import HelpModal from '../../src/components/HelpModal';

const MAP_HELP = [
  { q: 'マップの見方は？', a: '青い点が現在地、黄色ピンがスポット、青いラインが現在の記録ルートです。' },
  { q: 'スポットをタップすると？', a: 'スポット名・カテゴリ・来訪回数がポップアップ表示されます。' },
  { q: '記録中バッジの意味は？', a: '「記録中 ○pt」は現在のルート記録ポイント数です。記録タブで停止できます。' },
  { q: 'マップが動かない？', a: 'インターネット接続を確認してください。地図タイルはOpenStreetMapを使用しています。' },
];

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
    .leaflet-popup-content-wrapper{border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,0.2)}
    .leaflet-popup-content{margin:10px 14px;font-size:13px}
    .lm-pin{display:flex;flex-direction:column;align-items:center}
    .lm-pin-dot{width:32px;height:32px;background:#f59e0b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-size:16px;line-height:1}
    .lm-pin-tail{width:3px;height:8px;background:#f59e0b;margin-top:-1px}
    .lm-label{background:rgba(255,255,255,0.95);color:#1f2937;font-size:10px;font-weight:600;padding:2px 6px;border-radius:8px;margin-top:2px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.18);max-width:90px;overflow:hidden;text-overflow:ellipsis}
    .loc-pulse{width:18px;height:18px;background:#2563eb;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.25)}
    .route-start{background:#22c55e;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.25);white-space:nowrap}
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

var locMarker = null;
var routeLine = null;
var startMarker = null;
var landmarkMarkers = [];
var initialized = false;

function makeLocIcon(){
  return L.divIcon({html:'<div class="loc-pulse"></div>',iconSize:[18,18],iconAnchor:[9,9],className:''});
}

function makeLandmarkIcon(name){
  var short = name.length > 8 ? name.slice(0,8)+'…' : name;
  var html = '<div class="lm-pin"><div class="lm-pin-dot">★</div><div class="lm-pin-tail"></div><div class="lm-label">'+short+'</div></div>';
  return L.divIcon({html:html,iconSize:[90,52],iconAnchor:[45,40],className:''});
}

window.initMap = function(lat,lng,routeCoords,landmarks){
  if(locMarker) map.removeLayer(locMarker);
  locMarker = L.marker([lat,lng],{icon:makeLocIcon(),zIndexOffset:1000}).addTo(map);
  if(!initialized){ map.setView([lat,lng],15); initialized=true; }
  window.updateRoute(routeCoords);
  window.setLandmarks(landmarks);
};

window.updateLocation = function(lat,lng){
  if(!locMarker){ locMarker=L.marker([lat,lng],{icon:makeLocIcon(),zIndexOffset:1000}).addTo(map); }
  else { locMarker.setLatLng([lat,lng]); }
};

window.updateRoute = function(coords){
  if(routeLine){ map.removeLayer(routeLine); routeLine=null; }
  if(startMarker){ map.removeLayer(startMarker); startMarker=null; }
  if(!coords||coords.length<2) return;
  routeLine = L.polyline(coords,{color:'#2563eb',weight:5,opacity:0.85}).addTo(map);
  var sIcon = L.divIcon({html:'<div class="route-start">START</div>',className:'',iconAnchor:[24,12]});
  startMarker = L.marker(coords[0],{icon:sIcon}).addTo(map);
  map.panTo(coords[coords.length-1]);
};

window.setLandmarks = function(landmarks){
  landmarkMarkers.forEach(function(m){map.removeLayer(m);}); landmarkMarkers=[];
  if(!landmarks) return;
  landmarks.forEach(function(lm){
    var m = L.marker([lm.lat,lm.lng],{icon:makeLandmarkIcon(lm.name),zIndexOffset:500}).addTo(map);
    m.bindPopup(
      '<div style="line-height:1.6"><b style="font-size:14px">'+lm.name+'</b><br>'+
      '<span style="color:#2563eb;font-size:11px">'+lm.category+'</span>'+
      '<span style="color:#f59e0b;font-weight:700;margin-left:8px">'+lm.visitCount+'回</span></div>',
      {maxWidth:200}
    );
    landmarkMarkers.push(m);
  });
};

window.addEventListener('message',function(e){
  try{
    var msg=JSON.parse(e.data);
    if(msg.type==='init') window.initMap(msg.lat,msg.lng,msg.route,msg.landmarks);
    if(msg.type==='updateLocation') window.updateLocation(msg.lat,msg.lng);
    if(msg.type==='updateRoute') window.updateRoute(msg.coords);
  }catch(err){}
});
document.addEventListener('message',function(e){
  try{
    var msg=JSON.parse(e.data);
    if(msg.type==='init') window.initMap(msg.lat,msg.lng,msg.route,msg.landmarks);
    if(msg.type==='updateLocation') window.updateLocation(msg.lat,msg.lng);
    if(msg.type==='updateRoute') window.updateRoute(msg.coords);
  }catch(err){}
});
</script>
</body>
</html>`;

export default function MapScreen() {
  const webviewRef = useRef<WebView>(null);
  const { isTracking, currentPoints } = useTrackingStore();
  const { user } = useAuthStore();
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const initialized = useRef(false);
  const landmarksRef = useRef<Landmark[]>([]);
  const locUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPointsLen = useRef(0);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({});
        setCurrentLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      } catch (error) {
        console.error('Location error:', error);
      }
    })();
  }, []);

  useEffect(() => {
    if (user) getUserLandmarks(user.uid).then(data => {
      setLandmarks(data);
      landmarksRef.current = data;
    });
  }, [user]);

  // WebView読み込み完了後に初期データを送信
  const handleLoad = () => {
    const lat = currentLocation?.lat ?? 35.681236;
    const lng = currentLocation?.lng ?? 139.767125;
    const route = currentPoints.map(p => [p.lat, p.lng]);
    const lms = landmarksRef.current.map(lm => ({ lat: lm.lat, lng: lm.lng, name: lm.name, category: lm.category, visitCount: lm.visitCount }));
    webviewRef.current?.injectJavaScript(
      `window.initMap(${lat},${lng},${JSON.stringify(route)},${JSON.stringify(lms)});true;`
    );
    initialized.current = true;
    prevPointsLen.current = currentPoints.length;
  };

  // 位置更新（デバウンス: 2秒）
  useEffect(() => {
    if (!initialized.current || !currentLocation) return;
    if (locUpdateTimer.current) clearTimeout(locUpdateTimer.current);
    let isMounted = true;
    locUpdateTimer.current = setTimeout(() => {
      if (isMounted && webviewRef.current) {
        webviewRef.current.injectJavaScript(
          `window.updateLocation(${currentLocation.lat},${currentLocation.lng});true;`
        );
      }
    }, 2000);
    return () => {
      isMounted = false;
      if (locUpdateTimer.current) clearTimeout(locUpdateTimer.current);
    };
  }, [currentLocation]);

  // ルート更新（5点ごと）
  useEffect(() => {
    if (!initialized.current) return;
    if (currentPoints.length - prevPointsLen.current < 5 && currentPoints.length !== 0) return;
    prevPointsLen.current = currentPoints.length;
    const coords = currentPoints.map(p => [p.lat, p.lng]);
    webviewRef.current?.injectJavaScript(
      `window.updateRoute(${JSON.stringify(coords)});true;`
    );
  }, [currentPoints.length]);

  return (
    <View style={styles.container}>
      <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} title="マップ画面の使い方" items={MAP_HELP} />
      <TouchableOpacity onPress={() => setShowHelp(true)} style={styles.helpBtn}>
        <Text style={styles.helpBtnText}>?</Text>
      </TouchableOpacity>
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
        onError={(e) => console.log('WebView error:', e.nativeEvent)}
        overScrollMode="never"
        bounces={false}
      />
      {isTracking && (
        <View style={styles.recordingBadge}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>記録中 {currentPoints.length}pt</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  helpBtn: { position: 'absolute', top: 16, left: 16, zIndex: 10, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.9)', justifyContent: 'center', alignItems: 'center', elevation: 4 },
  helpBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '700', lineHeight: 16 },
  recordingBadge: {
    position: 'absolute', top: 16, right: 16,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: '#22c55e',
    elevation: 4,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginRight: 8 },
  recordingText: { color: '#1f2937', fontSize: 13, fontWeight: '600' },
});
