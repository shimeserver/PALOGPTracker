import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuthStore } from '../src/store/authStore';
import { useCarStore } from '../src/store/carStore';

export default function RootLayout() {
  const { user, loading, init } = useAuthStore();
  const { loadActiveCar } = useCarStore();

  useEffect(() => {
    const unsubscribe = init();
    loadActiveCar();
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
