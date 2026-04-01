import { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
import { getUserRoutesMetadata, getUserRoutesMetadataSince, deleteRoute, RouteMetadata } from '../../src/firebase/routes';
import { loadCachedRoutes, saveRoutesCache, clearRoutesCache, mergeRoutes } from '../../src/utils/routeCache';
import HelpModal from '../../src/components/HelpModal';
import { useUiStore } from '../../src/store/uiStore';

const ROUTES_HELP = [
  { q: 'ルートの見方は？', a: 'タップすると詳細マップが開きます。長押しで削除できます。' },
  { q: 'アイコンの意味は？', a: '🚗 車での記録、🚶 徒歩・公共交通での記録です。' },
  { q: 'ルート名を変えるには？', a: '詳細画面から編集できます。' },
  { q: 'ルートが消えてしまった？', a: '引っ張って更新（プルダウン）してみてください。Firebaseと同期します。' },
];

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}
function formatDuration(start: number, end: number): string {
  const mins = Math.round((end - start) / 60000);
  return mins < 60 ? `${mins}分` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export default function RoutesScreen() {
  const { user } = useAuthStore();
  const [routes, setRoutes] = useState<RouteMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const { helpTarget, setHelpTarget } = useUiStore();
  const showHelp = helpTarget === 'routes';
  const initialLoadDone = useRef(false);

  // 起動時: キャッシュを即表示 → 差分フェッチ
  useEffect(() => {
    if (!user || initialLoadDone.current) return;
    initialLoadDone.current = true;

    (async () => {
      const cached = await loadCachedRoutes(user.uid);
      if (cached) {
        setRoutes(cached.routes);
        setLoading(false);
        // 差分フェッチ
        setSyncing(true);
        try {
          const newRoutes = await getUserRoutesMetadataSince(user.uid, cached.lastFetchTime);
          if (newRoutes.length > 0) {
            const merged = mergeRoutes(cached.routes, newRoutes);
            setRoutes(merged);
            await saveRoutesCache(user.uid, merged, Date.now());
          }
        } catch {
          // 差分フェッチ失敗は無視（キャッシュ表示のまま）
        } finally {
          setSyncing(false);
        }
      } else {
        // キャッシュなし: フルフェッチ
        try {
          const data = await getUserRoutesMetadata(user.uid);
          setRoutes(data);
          await saveRoutesCache(user.uid, data, Date.now());
        } catch {
          Alert.alert('エラー', 'データの読み込みに失敗しました');
        } finally {
          setLoading(false);
        }
      }
    })();
  }, [user]);

  // プルダウン更新: フルフェッチでキャッシュ再構築
  const loadRoutes = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await getUserRoutesMetadata(user.uid);
      setRoutes(data);
      await saveRoutesCache(user.uid, data, Date.now());
    } catch {
      Alert.alert('エラー', 'データの読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (route: RouteMetadata) => {
    Alert.alert('削除確認', `「${route.name}」を削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除', style: 'destructive',
        onPress: async () => {
          await deleteRoute(route.id!);
          setRoutes(r => {
            const updated = r.filter(x => x.id !== route.id);
            if (user) saveRoutesCache(user.uid, updated, Date.now());
            return updated;
          });
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: RouteMetadata }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/route/${item.id}`)}
      onLongPress={() => handleDelete(item)}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.modeIcon}>
          {item.mode === 'walk' ? '🚶' : '🚗'}
        </Text>
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          {item.source === 'imported' && (
            <Text style={[styles.badge, styles.badgeImported]}>インポート</Text>
          )}
          <TouchableOpacity onPress={() => handleDelete(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.deleteIcon}>🗑</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.cardDate}>{formatDate(item.startTime)}</Text>
      <View style={styles.cardMetrics}>
        <Text style={styles.cardMetric}>📏 {item.totalDistance.toFixed(1)}km</Text>
        <Text style={styles.cardMetric}>⚡ {item.avgSpeed.toFixed(0)}km/h</Text>
        <Text style={styles.cardMetric}>⏱ {formatDuration(item.startTime, item.endTime)}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <HelpModal visible={showHelp} onClose={() => setHelpTarget(null)} title="ルート画面の使い方" items={ROUTES_HELP} />
      {syncing && (
        <View style={styles.syncBar}>
          <ActivityIndicator size="small" color="#2563eb" />
          <Text style={styles.syncText}>同期中...</Text>
        </View>
      )}
      {loading ? (
        <ActivityIndicator color="#2563eb" style={{ marginTop: 64 }} />
      ) : (
        <FlatList
          data={routes}
          renderItem={renderItem}
          keyExtractor={item => item.id!}
          contentContainerStyle={{ padding: 16 }}
          onRefresh={loadRoutes}
          refreshing={loading}
          ListEmptyComponent={
            <Text style={styles.empty}>ルートがありません{'\n'}記録タブから記録を開始してください</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  syncBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: '#eff6ff' },
  syncText: { fontSize: 12, color: '#2563eb' },
  helpBtn: { position: 'absolute', top: 12, right: 16, zIndex: 10, width: 24, height: 24, borderRadius: 12, backgroundColor: '#e5e7eb', justifyContent: 'center', alignItems: 'center' },
  helpBtnText: { fontSize: 13, color: '#6b7280', fontWeight: '700', lineHeight: 16 },
  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
    borderLeftWidth: 3, borderLeftColor: '#2563eb',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modeIcon: { fontSize: 16, marginRight: 6 },
  cardName: { color: '#1f2937', fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  badge: { backgroundColor: '#f0fdf4', color: '#15803d', fontSize: 11, fontWeight: '500', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  badgeImported: { backgroundColor: '#fff7ed', color: '#c2410c' },
  deleteIcon: { fontSize: 15, opacity: 0.5 },
  cardDate: { color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  cardMetrics: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  cardMetric: { color: '#6b7280', fontSize: 13 },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 80, lineHeight: 26, fontSize: 15 },
});
