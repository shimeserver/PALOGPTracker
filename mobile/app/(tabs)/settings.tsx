import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { signOut } from 'firebase/auth';
import { auth, db } from '../../src/firebase/config';
import { useAuthStore } from '../../src/store/authStore';
import { deleteAllUserRoutes } from '../../src/firebase/routes';
import { collection, getDocs, query, where, deleteDoc } from 'firebase/firestore';

export default function SettingsScreen() {
  const { user } = useAuthStore();
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAllRoutes = () => {
    Alert.alert('全ルートを削除', '全てのルートを削除しますか？この操作は取り消せません。', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            const n = await deleteAllUserRoutes(user!.uid);
            Alert.alert('完了', `${n}件のルートを削除しました`);
          } catch (e: any) {
            Alert.alert('エラー', e.message);
          } finally { setDeleting(false); }
        },
      },
    ]);
  };

  const handleDeleteAllLandmarks = () => {
    Alert.alert('全スポットを削除', '全てのスポットを削除しますか？この操作は取り消せません。', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            const q = query(collection(db, 'landmarks'), where('userId', '==', user!.uid));
            const snap = await getDocs(q);
            await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
            Alert.alert('完了', `${snap.docs.length}件のスポットを削除しました`);
          } catch (e: any) {
            Alert.alert('エラー', e.message);
          } finally { setDeleting(false); }
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20 }}>
      <Text style={styles.sectionTitle}>アカウント</Text>
      <View style={styles.card}>
        <Text style={styles.email}>{user?.email}</Text>
        <TouchableOpacity style={styles.logoutBtn} onPress={() => signOut(auth)}>
          <Text style={styles.logoutBtnText}>ログアウト</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>データ管理</Text>
      <View style={styles.card}>
        <TouchableOpacity style={[styles.deleteRow, deleting && { opacity: 0.5 }]} onPress={handleDeleteAllRoutes} disabled={deleting}>
          <Text style={styles.deleteText}>🗑 全ルートを削除</Text>
        </TouchableOpacity>
        <View style={styles.divider} />
        <TouchableOpacity style={[styles.deleteRow, deleting && { opacity: 0.5 }]} onPress={handleDeleteAllLandmarks} disabled={deleting}>
          <Text style={styles.deleteText}>🗑 全スポットを削除</Text>
        </TouchableOpacity>
        <Text style={styles.note}>削除後にPCからCSVを再インポートすると正しく処理されます</Text>
      </View>

      <Text style={styles.version}>PALOGPTracker v1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  sectionTitle: { color: '#9ca3af', fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, marginTop: 8 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  email: { color: '#374151', fontSize: 15, marginBottom: 16 },
  logoutBtn: { backgroundColor: '#f8f9fa', borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#e8eaed' },
  logoutBtnText: { color: '#6b7280', fontSize: 14, fontWeight: '500' },
  deleteRow: { padding: 12 },
  deleteText: { color: '#ef4444', fontSize: 14, fontWeight: '500' },
  divider: { height: 1, backgroundColor: '#f3f4f6' },
  note: { color: '#9ca3af', fontSize: 12, marginTop: 10, lineHeight: 18 },
  version: { color: '#d1d5db', textAlign: 'center', fontSize: 12, marginTop: 8 },
});
