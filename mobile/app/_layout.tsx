import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuthStore } from '../src/store/authStore';
import { useCarStore } from '../src/store/carStore';
import { useExternalGpsStore } from '../src/store/externalGpsStore';
import { initErrorReporting } from '../src/utils/errorLog';

initErrorReporting();

export default function RootLayout() {
  const { user, loading, init } = useAuthStore();
  const { loadActiveCar } = useCarStore();

  useEffect(() => {
    const unsubscribe = init();
    loadActiveCar();
    // 外部GPS（RaceBox）の設定読み込み＋有効なら自動接続
    useExternalGpsStore.getState().init();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!loading) {
      if (user) {
        router.replace('/(tabs)/map');
      } else {
        router.replace('/auth');
      }
    }
  }, [user, loading]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="auth" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="route/[id]" options={{ headerShown: true, title: 'ルート詳細' }} />
      <Stack.Screen name="landmark/[id]" options={{ headerShown: true, title: 'ランドマーク' }} />
    </Stack>
  );
}
