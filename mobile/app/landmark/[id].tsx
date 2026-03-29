import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image, TouchableOpacity,
  Alert, ActivityIndicator, Modal, TextInput, FlatList,
} from 'react-native';
import WebView from 'react-native-webview';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import {
  getUserLandmarks, getVisits, recordVisit,
  uploadLandmarkPhoto, updateLandmark,
} from '../../src/firebase/landmarks';
import { useAuthStore } from '../../src/store/authStore';
import { Landmark, Visit } from '../../src/types';

const LANDMARK_MAP_HTML = (lat: number, lng: number, name: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="file:///android_asset/leaflet.min.css"/>
  <script src="file:///android_asset/leaflet.min.js"></script>
  <style>body,html,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden}.leaflet-control-attribution{font-size:9px}</style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map',{zoomControl:false}).setView([${lat},${lng}],15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19
}).addTo(map);
L.marker([${lat},${lng}]).addTo(map).bindPopup(${JSON.stringify(name)});
</script>
</body>
</html>`;

export default function LandmarkDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();
  const [landmark, setLandmark] = useState<Landmark | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [visitNote, setVisitNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!id || !user) return;
    setLoading(true);
    const landmarks = await getUserLandmarks(user.uid);
    const found = landmarks.find(l => l.id === id) || null;
    setLandmark(found);
    if (found) {
      const v = await getVisits(id);
      setVisits(v);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const handleAddVisit = async () => {
    if (!user || !id) return;
    setSaving(true);
    try {
      await recordVisit(id, {
        landmarkId: id, userId: user.uid,
        timestamp: Date.now(), notes: visitNote.trim() || undefined,
      });
      setShowVisitModal(false);
      setVisitNote('');
      await load();
    } catch (e: any) {
      Alert.alert('エラー', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAddPhoto = async () => {
    if (!user || !id || !landmark) return;
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (result.canceled || !result.assets[0]) return;
    try {
      const uploaded = await uploadLandmarkPhoto(user.uid, id, result.assets[0].uri);
      const newPhoto = { ...uploaded, takenAt: Date.now() };
      const updatedPhotos = [...landmark.photos, newPhoto];
      await updateLandmark(id, { photos: updatedPhotos });
      setLandmark({ ...landmark, photos: updatedPhotos });
    } catch (e: any) {
      Alert.alert('エラー', e.message);
    }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color="#4fc3f7" size="large" /></View>;
  if (!landmark) return <View style={styles.center}><Text style={styles.err}>見つかりません</Text></View>;

  return (
    <ScrollView style={styles.container}>
      {/* 地図 */}
      <WebView
        style={styles.map}
        source={{ html: LANDMARK_MAP_HTML(landmark.lat, landmark.lng, landmark.name) }}
        scrollEnabled={false}
      />

      {/* ヘッダー */}
      <View style={styles.header}>
        <Text style={styles.name}>{landmark.name}</Text>
        <Text style={styles.category}>{landmark.category}</Text>
        <Text style={styles.visits}>来訪 {landmark.visitCount}回</Text>
        {landmark.lastVisit && (
          <Text style={styles.lastVisit}>最終来訪: {new Date(landmark.lastVisit).toLocaleDateString('ja-JP')}</Text>
        )}
      </View>

      {/* 説明 */}
      {landmark.description ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>メモ</Text>
          <Text style={styles.description}>{landmark.description}</Text>
        </View>
      ) : null}

      {/* 写真 */}
      <View style={styles.section}>
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>写真</Text>
          <TouchableOpacity onPress={handleAddPhoto}>
            <Text style={styles.addLink}>＋ 追加</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {landmark.photos.length === 0 ? (
            <Text style={styles.noData}>写真なし</Text>
          ) : (
            landmark.photos.map((p, i) => (
              <Image key={i} source={{ uri: p.url }} style={styles.photo} />
            ))
          )}
        </ScrollView>
      </View>

      {/* 来訪履歴 */}
      <View style={styles.section}>
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>来訪履歴</Text>
          <TouchableOpacity onPress={() => setShowVisitModal(true)}>
            <Text style={styles.addLink}>＋ 来訪記録</Text>
          </TouchableOpacity>
        </View>
        {visits.slice(0, 10).map(v => (
          <View key={v.id} style={styles.visitRow}>
            <Text style={styles.visitDate}>{new Date(v.timestamp).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}</Text>
            {v.notes && <Text style={styles.visitNote}>{v.notes}</Text>}
          </View>
        ))}
        {visits.length === 0 && <Text style={styles.noData}>来訪履歴なし</Text>}
      </View>

      {/* 来訪記録モーダル */}
      <Modal visible={showVisitModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>来訪を記録</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="メモ（任意）"
              placeholderTextColor="#555"
              value={visitNote}
              onChangeText={setVisitNote}
            />
            <TouchableOpacity
              style={[styles.modalBtn, saving && { opacity: 0.6 }]}
              onPress={handleAddVisit} disabled={saving}
            >
              <Text style={styles.modalBtnText}>{saving ? '記録中...' : '記録する'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowVisitModal(false)}>
              <Text style={styles.modalCancel}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  err: { color: '#fff' },
  map: { height: 200 },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#0f3460' },
  name: { color: '#fff', fontSize: 22, fontWeight: 'bold', marginBottom: 6 },
  category: { color: '#4fc3f7', fontSize: 13, marginBottom: 8 },
  visits: { color: '#ff9800', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  lastVisit: { color: '#888', fontSize: 13 },
  section: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#0f3460' },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { color: '#aaa', fontSize: 13, fontWeight: 'bold', textTransform: 'uppercase' },
  addLink: { color: '#4fc3f7', fontSize: 14 },
  description: { color: '#ccc', fontSize: 15, lineHeight: 22 },
  photo: { width: 140, height: 140, borderRadius: 10, marginRight: 10 },
  noData: { color: '#555', fontSize: 14 },
  visitRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#16213e' },
  visitDate: { color: '#ccc', fontSize: 14, fontWeight: 'bold' },
  visitNote: { color: '#888', fontSize: 13, marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#16213e', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 28 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  modalInput: { backgroundColor: '#0f3460', color: '#fff', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 15 },
  modalBtn: { backgroundColor: '#4fc3f7', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 12 },
  modalBtnText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 16 },
  modalCancel: { color: '#888', textAlign: 'center', fontSize: 14 },
});
