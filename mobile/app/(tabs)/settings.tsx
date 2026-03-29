import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { signOut } from 'firebase/auth';
import { auth, db } from '../../src/firebase/config';
import { useAuthStore } from '../../src/store/authStore';
import { deleteAllUserRoutes } from '../../src/firebase/routes';
import { collection, getDocs, query, where, deleteDoc } from 'firebase/firestore';

const VERSION = '1.0.7';

const PRIVACY_POLICY = `プライバシーポリシー

PALOGPTracker（以下「本アプリ」）は、以下の情報を収集・利用します。

【収集する情報】
・位置情報（GPS）：ルート記録のため。バックグラウンド取得を含みます。
・メールアドレス：ログイン認証のため。
・走行データ：ルート・スポット・愛車情報。Firebase上に保存されます。

【利用目的】
収集した情報は本アプリの機能提供のみに使用し、第三者への提供は行いません。

【外部サービス】
・Firebase（Google）：認証・データ保存・ストレージ
・Google Maps Platform：スポット検索機能（検索時のみ）
・OpenStreetMap：地図表示（位置情報の送信なし）

【データ削除】
設定画面からルート・スポットデータを削除できます。アカウント削除はお問い合わせください。

© 2025 PALOW.`;

const OSS_LICENSES = `オープンソースライセンス

【Leaflet】
© 2010–2024 Vladimir Agafonkin. BSD 2-Clause License.
https://leafletjs.com

【OpenStreetMap】
© OpenStreetMap contributors. ODbL License.
https://www.openstreetmap.org/copyright

【Firebase SDK】
© Google LLC. Apache License 2.0.
https://firebase.google.com

【Expo】
© 2015–present 650 Industries, Inc. MIT License.
https://expo.dev

【React Native】
© Meta Platforms, Inc. MIT License.
https://reactnative.dev

【Zustand】
© 2019 Paul Henschel. MIT License.`;

export default function SettingsScreen() {
  const { user } = useAuthStore();
  const [deleting, setDeleting] = useState(false);
  const [modal, setModal] = useState<'privacy' | 'oss' | null>(null);
  const insets = useSafeAreaInsets();

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
          } catch (e) {
            Alert.alert('エラー', e instanceof Error ? e.message : String(e));
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
          } catch (e) {
            Alert.alert('エラー', e instanceof Error ? e.message : String(e));
          } finally { setDeleting(false); }
        },
      },
    ]);
  };

  const modalTitle = modal === 'privacy' ? 'プライバシーポリシー' : 'オープンソースライセンス';
  const modalContent = modal === 'privacy' ? PRIVACY_POLICY : OSS_LICENSES;

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

      <Text style={styles.sectionTitle}>このアプリについて</Text>
      <View style={styles.card}>
        <View style={styles.aboutRow}>
          <Text style={styles.aboutLabel}>バージョン</Text>
          <Text style={styles.aboutValue}>v{VERSION}</Text>
        </View>
        <View style={styles.divider} />
        <TouchableOpacity style={styles.aboutRow} onPress={() => setModal('privacy')}>
          <Text style={styles.aboutLabel}>プライバシーポリシー</Text>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
        <View style={styles.divider} />
        <TouchableOpacity style={styles.aboutRow} onPress={() => setModal('oss')}>
          <Text style={styles.aboutLabel}>オープンソースライセンス</Text>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.copyright}>© 2025 PALOW.{'\n'}PALOGPTracker v{VERSION}</Text>

      {/* テキストモーダル */}
      <Modal visible={!!modal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: 24 + insets.bottom }]}>
            <Text style={styles.modalTitle}>{modalTitle}</Text>
            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.modalBody}>{modalContent}</Text>
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setModal(null)}>
              <Text style={styles.modalCloseText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  aboutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  aboutLabel: { color: '#374151', fontSize: 14 },
  aboutValue: { color: '#6b7280', fontSize: 14 },
  chevron: { color: '#9ca3af', fontSize: 20, lineHeight: 22 },
  copyright: { color: '#9ca3af', textAlign: 'center', fontSize: 12, lineHeight: 20, marginTop: 8, marginBottom: 32 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, maxHeight: '85%' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1f2937', marginBottom: 16 },
  modalScroll: { flexGrow: 0 },
  modalBody: { fontSize: 13, color: '#4b5563', lineHeight: 22 },
  modalClose: { marginTop: 20, backgroundColor: '#f3f4f6', borderRadius: 10, padding: 14, alignItems: 'center' },
  modalCloseText: { color: '#374151', fontWeight: '600', fontSize: 15 },
});
