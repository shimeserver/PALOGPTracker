import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import MapView, { Polyline, UrlTile, Marker } from 'react-native-maps';
import { getRoute } from '../../src/firebase/routes';
import { Route, TrackPoint } from '../../src/types';

function formatDate(ms: number) {
  return new Date(ms).toLocaleString('ja-JP');
}
function formatDuration(startMs: number, endMs: number) {
  const mins = Math.round((endMs - startMs) / 60000);
  if (mins < 60) return `${mins}分`;
  return `${Math.floor(mins / 60)}時間${mins % 60}分`;
}

// 速度に応じた色
function speedColor(speed: number): string {
  if (speed < 30) return '#4caf50';
  if (speed < 60) return '#ffeb3b';
  if (speed < 100) return '#ff9800';
  return '#f44336';
}

export default function RouteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mapRef = useRef<MapView>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [playback, setPlayback] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!id) return;
    getRoute(id).then(r => {
      setRoute(r);
      setLoading(false);
    });
  }, [id]);

  // ルート全体が見えるように地図をフィット
  useEffect(() => {
    if (!route || !mapRef.current) return;
    const coords = route.points.map(p => ({ latitude: p.lat, longitude: p.lng }));
    if (coords.length === 0) return;
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }, [route]);

  // 再生
  const startPlayback = () => {
    if (!route) return;
    setPlayIndex(0);
    setPlayback(true);
    playRef.current = setInterval(() => {
      setPlayIndex(i => {
        if (i >= route.points.length - 1) {
          clearInterval(playRef.current!);
          setPlayback(false);
          return i;
        }
        const next = i + 1;
        mapRef.current?.animateToRegion({
          latitude: route.points[next].lat,
          longitude: route.points[next].lng,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }, 200);
        return next;
      });
    }, 100); // 100ms毎に1ポイント進める
  };

  const stopPlayback = () => {
    if (playRef.current) clearInterval(playRef.current);
    setPlayback(false);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#4fc3f7" size="large" />
      </View>
    );
  }
  if (!route) {
    return <View style={styles.center}><Text style={styles.errorText}>ルートが見つかりません</Text></View>;
  }

  const displayedPoints = playback ? route.points.slice(0, playIndex + 1) : route.points;
  const currentPlayPoint = route.points[playIndex];

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map}>
        <UrlTile urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maximumZ={19} flipY={false} />

        {/* ルートライン */}
        <Polyline
          coordinates={displayedPoints.map(p => ({ latitude: p.lat, longitude: p.lng }))}
          strokeColor="#4fc3f7"
          strokeWidth={3}
        />

        {/* スタート・ゴール */}
        {route.points.length > 0 && (
          <Marker coordinate={{ latitude: route.points[0].lat, longitude: route.points[0].lng }}
            title="スタート" pinColor="green" />
        )}
        {!playback && route.points.length > 1 && (
          <Marker
            coordinate={{ latitude: route.points[route.points.length - 1].lat, longitude: route.points[route.points.length - 1].lng }}
            title="ゴール" pinColor="red"
          />
        )}

        {/* 再生中のカーソル */}
        {playback && currentPlayPoint && (
          <Marker
            coordinate={{ latitude: currentPlayPoint.lat, longitude: currentPlayPoint.lng }}
            title={`${currentPlayPoint.speed.toFixed(0)}km/h`}
          />
        )}
      </MapView>

      {/* 下部パネル */}
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
              {Math.round((playIndex / route.points.length) * 100)}%  {currentPlayPoint?.speed.toFixed(0)}km/h
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  errorText: { color: '#fff' },
  map: { flex: 1 },
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
});
