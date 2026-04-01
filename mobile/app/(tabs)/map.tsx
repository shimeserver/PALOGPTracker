import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../src/store/uiStore';
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
  <link rel="stylesheet" href="file:///android_asset/leaflet.min.css"/>
  <script src="file:///android_asset/leaflet.min.js"></script>
  <style>
    body,html{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}
    /* 150%×150%のラッパーで回転時の角切れを防ぐ */
    #map-outer{position:absolute;width:150%;height:150%;top:-25%;left:-25%;transform-origin:50% 50%}
    #map{width:100%;height:100%}
    .leaflet-control-attribution{font-size:9px}
    .leaflet-popup-content-wrapper{border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,0.2)}
    .leaflet-popup-content{margin:10px 14px;font-size:13px}
    .lm-pin{display:flex;flex-direction:column;align-items:center}
    .lm-pin-dot{width:32px;height:32px;background:#f59e0b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-size:16px;line-height:1}
    .lm-pin-tail{width:3px;height:8px;background:#f59e0b;margin-top:-1px}
    .lm-label{background:rgba(255,255,255,0.95);color:#1f2937;font-size:10px;font-weight:600;padding:2px 6px;border-radius:8px;margin-top:2px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.18);max-width:90px;overflow:hidden;text-overflow:ellipsis}
    .loc-pulse{width:18px;height:18px;background:#2563eb;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.25)}
    .loc-arrow{width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:30px solid #2563eb;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5))}
    .route-start{background:#22c55e;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.25);white-space:nowrap}
  </style>
</head>
<body>
<div id="map-outer"><div id="map"></div></div>
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
var headingUpMode = false;

function makeLocIcon(arrow){
  if(arrow) return L.divIcon({html:'<div class="loc-arrow"></div>',iconSize:[20,30],iconAnchor:[10,20],className:''});
  return L.divIcon({html:'<div class="loc-pulse"></div>',iconSize:[18,18],iconAnchor:[9,9],className:''});
}

function makeLandmarkIcon(name){
  var short = name.length > 8 ? name.slice(0,8)+'…' : name;
  var html = '<div class="lm-pin"><div class="lm-pin-dot">★</div><div class="lm-pin-tail"></div><div class="lm-label">'+short+'</div></div>';
  return L.divIcon({html:html,iconSize:[90,52],iconAnchor:[45,40],className:''});
}

window.initMap = function(lat,lng,routeCoords,landmarks){
  if(locMarker) map.removeLayer(locMarker);
  locMarker = L.marker([lat,lng],{icon:makeLocIcon(false),zIndexOffset:1000}).addTo(map);
  if(!initialized){ map.setView([lat,lng],15); initialized=true; }
  window.updateRoute(routeCoords);
  window.setLandmarks(landmarks);
};

var followMode = false;

window.updateLocation = function(lat,lng){
  if(!locMarker){ locMarker=L.marker([lat,lng],{icon:makeLocIcon(false),zIndexOffset:1000}).addTo(map); }
  else { locMarker.setLatLng([lat,lng]); }
  if(followMode){ map.panTo([lat,lng],{animate:true,duration:0.5}); }
};

window.panToLocation = function(lat,lng){
  map.setView([lat,lng],16,{animate:true});
};

window.setFollowMode = function(enabled){
  followMode = enabled;
};

// 主観モード（heading-up）
window.setHeadingUpMode = function(enabled){
  headingUpMode = enabled;
  var outer = document.getElementById('map-outer');
  if(!enabled){
    outer.style.transform = '';
    if(locMarker) locMarker.setIcon(makeLocIcon(false));
  } else {
    if(locMarker) locMarker.setIcon(makeLocIcon(true));
  }
  followMode = enabled; // 主観モードは常にfollow
};

window.updateHeading = function(deg){
  if(!headingUpMode) return;
  document.getElementById('map-outer').style.transform = 'rotate('+(-deg)+'deg)';
};

// ドラッグで追随・主観モード解除
map.on('dragstart', function(){
  if(followMode || headingUpMode){
    followMode = false; headingUpMode = false;
    document.getElementById('map-outer').style.transform = '';
    if(locMarker) locMarker.setIcon(makeLocIcon(false));
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'headingOff'}));
  }
});

window.updateRoute = function(coords){
  if(routeLine){ map.removeLayer(routeLine); routeLine=null; }
  if(startMarker){ map.removeLayer(startMarker); startMarker=null; }
  if(!coords||coords.length<2) return;
  routeLine = L.polyline(coords,{color:'#2563eb',weight:5,opacity:0.85}).addTo(map);
  var sIcon = L.divIcon({html:'<div class="route-start">START</div>',className:'',iconAnchor:[24,12]});
  startMarker = L.marker(coords[0],{icon:sIcon}).addTo(map);
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
  const landmarksCachedUidRef = useRef<string | null>(null);
  const locUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPointsLen = useRef(0);
  const { helpTarget, setHelpTarget } = useUiStore();
  const showHelp = helpTarget === 'map';
  const [following, setFollowing] = useState(false);
  const [headingMode, setHeadingMode] = useState(false);
  const headingSubRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled || status !== 'granted') return;
        // 記録中: 3秒/5m（高精度）、非記録中: 10秒/20m（省電力）
        sub = await Location.watchPositionAsync(
          isTracking
            ? { accuracy: Location.Accuracy.Balanced, timeInterval: 3000, distanceInterval: 5 }
            : { accuracy: Location.Accuracy.Balanced, timeInterval: 10000, distanceInterval: 20 },
          (loc) => setCurrentLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude })
        );
        // await 解決前に cleanup が走った場合は即座に破棄
        if (cancelled) sub.remove();
      } catch (error) {
        console.error('Location error:', error);
      }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [isTracking]);

  useEffect(() => {
    if (!user) return;
    // UID が変わった（アカウント切替）ときはキャッシュをクリアして再フェッチ
    if (landmarksCachedUidRef.current === user.uid && landmarksRef.current.length > 0) return;
    landmarksCachedUidRef.current = user.uid;
    landmarksRef.current = [];
    getUserLandmarks(user.uid).then(data => {
      setLandmarks(data);
      landmarksRef.current = data;
      if (initialized.current) {
        const lms = data.map(lm => ({ lat: lm.lat, lng: lm.lng, name: lm.name, category: lm.category, visitCount: lm.visitCount }));
        webviewRef.current?.injectJavaScript(`window.setLandmarks(${JSON.stringify(lms)});true;`);
      }
    });
  }, [user]);

  // 記録終了時に追随解除
  useEffect(() => {
    if (!isTracking && following) {
      setFollowing(false);
      webviewRef.current?.injectJavaScript(`window.setFollowMode(false);true;`);
    }
  }, [isTracking]);

  // 主観モードON/OFF
  const toggleHeadingMode = async () => {
    if (headingMode) {
      // OFF
      headingSubRef.current?.remove();
      headingSubRef.current = null;
      setHeadingMode(false);
      setFollowing(false);
      webviewRef.current?.injectJavaScript(`window.setHeadingUpMode(false);true;`);
    } else {
      // ON
      setHeadingMode(true);
      setFollowing(true);
      webviewRef.current?.injectJavaScript(`window.setHeadingUpMode(true);true;`);
      if (currentLocation) {
        webviewRef.current?.injectJavaScript(`window.panToLocation(${currentLocation.lat},${currentLocation.lng});true;`);
      }
      headingSubRef.current = await Location.watchHeadingAsync((heading) => {
        const deg = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
        webviewRef.current?.injectJavaScript(`window.updateHeading(${deg});true;`);
      });
    }
  };

  // アンマウント時にheading購読を解除
  useEffect(() => {
    return () => { headingSubRef.current?.remove(); };
  }, []);

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
      <HelpModal visible={showHelp} onClose={() => setHelpTarget(null)} title="マップ画面の使い方" items={MAP_HELP} />
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
        onError={(e) => console.log('WebView error:', e.nativeEvent)}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'followOff') setFollowing(false);
            if (msg.type === 'headingOff') {
              headingSubRef.current?.remove();
              headingSubRef.current = null;
              setHeadingMode(false);
              setFollowing(false);
            }
          } catch {}
        }}
        overScrollMode="never"
        bounces={false}
      />

      {/* 主観モードボタン（常時表示） */}
      <TouchableOpacity
        style={[styles.headingBtn, headingMode && styles.headingBtnActive]}
        onPress={toggleHeadingMode}
      >
        <Text style={[styles.headingBtnText, headingMode && styles.headingBtnTextActive]}>
          {headingMode ? '🧭主観中' : '🧭主観'}
        </Text>
      </TouchableOpacity>

      {/* 現在位置ボタン */}
      <TouchableOpacity
        style={styles.locBtn}
        onPress={() => {
          if (currentLocation) {
            webviewRef.current?.injectJavaScript(`window.panToLocation(${currentLocation.lat},${currentLocation.lng});true;`);
          }
        }}
      >
        <Text style={styles.locBtnText}>◎</Text>
      </TouchableOpacity>

      {/* 追随ボタン（記録中のみ・主観モード中は非表示） */}
      {isTracking && !headingMode && (
        <TouchableOpacity
          style={[styles.followBtn, following && styles.followBtnActive]}
          onPress={() => {
            const next = !following;
            setFollowing(next);
            webviewRef.current?.injectJavaScript(`window.setFollowMode(${next});true;`);
            if (next && currentLocation) {
              webviewRef.current?.injectJavaScript(`window.panToLocation(${currentLocation.lat},${currentLocation.lng});true;`);
            }
          }}
        >
          <Text style={[styles.followBtnText, following && styles.followBtnTextActive]}>
            {following ? '追随中' : '追随'}
          </Text>
        </TouchableOpacity>
      )}

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
  helpBtn: { position: 'absolute', top: 16, right: 16, zIndex: 10, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.9)', justifyContent: 'center', alignItems: 'center', elevation: 4 },
  helpBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '700', lineHeight: 16 },
  locBtn: { position: 'absolute', bottom: 100, right: 16, zIndex: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  locBtnText: { fontSize: 22, color: '#2563eb' },
  headingBtn: { position: 'absolute', bottom: 204, right: 16, zIndex: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#fff', elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  headingBtnActive: { backgroundColor: '#f59e0b' },
  headingBtnText: { fontSize: 13, fontWeight: '700', color: '#6b7280' },
  headingBtnTextActive: { color: '#fff' },
  followBtn: { position: 'absolute', bottom: 152, right: 16, zIndex: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#fff', elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  followBtnActive: { backgroundColor: '#2563eb' },
  followBtnText: { fontSize: 13, fontWeight: '700', color: '#2563eb' },
  followBtnTextActive: { color: '#fff' },
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
