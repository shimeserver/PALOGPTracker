import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Modal, TextInput, Alert, Image, ScrollView, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
import {
  getUserLandmarks, saveLandmark, recordVisit,
  uploadLandmarkPhoto, updateLandmark,
} from '../../src/firebase/landmarks';
import { Landmark } from '../../src/types';
import { deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../src/firebase/config';

const CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', '駐車場'];
type SortKey = 'visitCount' | 'category' | 'lastVisit';

export default function LandmarksScreen() {
  const { user } = useAuthStore();
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('visitCount');
  const [sortAsc, setSortAsc] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('その他');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const data = await getUserLandmarks(user.uid);
    setLandmarks(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [user]);

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('エラー', 'カメラロールへのアクセス許可が必要です'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (!result.canceled && result.assets[0]) setPhotos(p => [...p, result.assets[0].uri]);
  };

  const handleTakePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') { Alert.alert('エラー', 'カメラへのアクセス許可が必要です'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (!result.canceled && result.assets[0]) setPhotos(p => [...p, result.assets[0].uri]);
  };

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert('エラー', 'スポット名を入力してください'); return; }
    if (!user) return;
    setSaving(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('位置情報の許可が必要です');
      const loc = await Location.getCurrentPositionAsync({});
      const now = Date.now();
      const id = await saveLandmark({
        userId: user.uid, name: name.trim(), category,
        lat: loc.coords.latitude, lng: loc.coords.longitude,
        description: description.trim(), photos: [],
        visitCount: 1, firstVisit: now, lastVisit: now, createdAt: now,
      });
      const uploadedPhotos = [];
      for (const uri of photos) {
        const r = await uploadLandmarkPhoto(user.uid, id, uri);
        uploadedPhotos.push({ ...r, takenAt: now });
      }
      if (uploadedPhotos.length > 0) await updateLandmark(id, { photos: uploadedPhotos });
      await recordVisit(id, { landmarkId: id, userId: user.uid, timestamp: now });
      Alert.alert('登録完了', `${name}を登録しました`);
      setName(''); setCategory('その他'); setDescription(''); setPhotos([]);
      setShowAdd(false);
      await load();
    } catch (e: any) {
      Alert.alert('エラー', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (lm: Landmark) => {
    Alert.alert('削除確認', `「${lm.name}」を削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive',
        onPress: async () => {
          await deleteDoc(doc(db, 'landmarks', lm.id!));
          setLandmarks(prev => prev.filter(x => x.id !== lm.id));
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: Landmark }) => (
    <TouchableOpacity style={styles.card} onPress={() => router.push(`/landmark/${item.id}`)}>
      {item.photos.length > 0 && (
        <Image source={{ uri: item.photos[0].url }} style={styles.cardPhoto} />
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={styles.visitCount}>{item.visitCount}回</Text>
            <TouchableOpacity onPress={() => handleDelete(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.deleteIcon}>🗑</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.cardCategory}>{item.category}</Text>
        {item.description ? <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  const sortedLandmarks = [...landmarks].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortKey === 'visitCount') return dir * (a.visitCount - b.visitCount);
    if (sortKey === 'category') return dir * a.category.localeCompare(b.category, 'ja');
    return dir * ((a.lastVisit ?? 0) - (b.lastVisit ?? 0));
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const SORT_LABELS: Record<SortKey, string> = { visitCount: '来訪回数', category: 'カテゴリ', lastVisit: '最終訪問' };

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.addButton} onPress={() => setShowAdd(true)}>
        <Text style={styles.addButtonText}>＋ 現在地にスポットを追加</Text>
      </TouchableOpacity>

      {/* ソートバー */}
      <View style={styles.sortBar}>
        {(['visitCount', 'category', 'lastVisit'] as SortKey[]).map(key => (
          <TouchableOpacity
            key={key}
            style={[styles.sortBtn, sortKey === key && styles.sortBtnActive]}
            onPress={() => handleSort(key)}
          >
            <Text style={[styles.sortBtnText, sortKey === key && styles.sortBtnTextActive]}>
              {SORT_LABELS[key]}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color="#2563eb" style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={sortedLandmarks}
          renderItem={renderItem}
          keyExtractor={item => item.id!}
          contentContainerStyle={{ padding: 16 }}
          onRefresh={load}
          refreshing={loading}
          ListEmptyComponent={
            <Text style={styles.empty}>スポットがありません{'\n'}「＋ 現在地にスポットを追加」で登録</Text>
          }
        />
      )}

      <Modal visible={showAdd} animationType="slide">
        <ScrollView style={styles.modal} contentContainerStyle={{ paddingBottom: 60 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>スポットを追加</Text>
            <TouchableOpacity onPress={() => setShowAdd(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>スポット名</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName}
            placeholder="例: お気に入りのカフェ" placeholderTextColor="#9ca3af" />

          <Text style={styles.label}>カテゴリ</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            {CATEGORIES.map(c => (
              <TouchableOpacity key={c} onPress={() => setCategory(c)}
                style={[styles.chip, category === c && styles.chipActive]}>
                <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{c}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <Text style={styles.label}>メモ</Text>
          <TextInput style={[styles.input, { height: 80 }]} value={description}
            onChangeText={setDescription} multiline
            placeholder="感想や特徴など" placeholderTextColor="#9ca3af" />

          <Text style={styles.label}>写真</Text>
          <View style={styles.photoRow}>
            <TouchableOpacity style={styles.photoBtn} onPress={handleTakePhoto}>
              <Text style={styles.photoBtnText}>📷 撮影</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.photoBtn} onPress={handlePickPhoto}>
              <Text style={styles.photoBtnText}>🖼️ 選択</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal style={{ marginBottom: 20 }}>
            {photos.map((uri, i) => (
              <View key={i} style={{ marginRight: 8 }}>
                <Image source={{ uri }} style={styles.thumb} />
                <TouchableOpacity onPress={() => setPhotos(p => p.filter((_, j) => j !== i))}>
                  <Text style={{ color: '#ef4444', textAlign: 'center', fontSize: 12, marginTop: 4 }}>削除</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            <Text style={styles.saveBtnText}>{saving ? '保存中...' : '現在地に登録'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  sortBar: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e8eaed' },
  sortBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e8eaed' },
  sortBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  sortBtnText: { fontSize: 12, color: '#6b7280', fontWeight: '500' },
  sortBtnTextActive: { color: '#fff', fontWeight: '700' },
  addButton: {
    backgroundColor: '#2563eb', margin: 16, borderRadius: 10, padding: 14, alignItems: 'center',
  },
  addButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 12, marginBottom: 10, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  cardPhoto: { width: '100%', height: 140 },
  cardBody: { padding: 14 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardName: { color: '#1f2937', fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  visitCount: { color: '#f59e0b', fontSize: 13, fontWeight: '700' },
  deleteIcon: { fontSize: 15, opacity: 0.5 },
  cardCategory: { color: '#2563eb', fontSize: 12, backgroundColor: '#eff6ff', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start', marginBottom: 4 },
  cardDesc: { color: '#9ca3af', fontSize: 13 },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 80, lineHeight: 26, fontSize: 15 },
  modal: { flex: 1, backgroundColor: '#f4f6f9', padding: 20, paddingTop: 60 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  modalTitle: { color: '#1f2937', fontSize: 20, fontWeight: 'bold' },
  modalClose: { color: '#9ca3af', fontSize: 20 },
  label: { color: '#6b7280', fontSize: 13, fontWeight: '500', marginBottom: 8 },
  input: { backgroundColor: '#fff', color: '#1f2937', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 15, borderWidth: 1.5, borderColor: '#e8eaed' },
  chip: { backgroundColor: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, borderWidth: 1.5, borderColor: '#e8eaed' },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  chipText: { color: '#6b7280', fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  photoRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  photoBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 10, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: '#e8eaed' },
  photoBtnText: { color: '#2563eb', fontSize: 14 },
  thumb: { width: 80, height: 80, borderRadius: 8 },
  saveBtn: { backgroundColor: '#2563eb', borderRadius: 12, padding: 16, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});
