import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TABS: { name: string; title: string; icon: IoniconName; activeIcon: IoniconName }[] = [
  { name: 'map',       title: '地図',   icon: 'map-outline',        activeIcon: 'map' },
  { name: 'track',     title: '記録',   icon: 'radio-button-off',   activeIcon: 'radio-button-on' },
  { name: 'routes',    title: 'ルート', icon: 'list-outline',        activeIcon: 'list' },
  { name: 'landmarks', title: 'スポット',icon: 'location-outline',   activeIcon: 'location' },
  { name: 'cars',      title: '移動手段', icon: 'navigate-outline', activeIcon: 'navigate' },
  { name: 'settings',  title: '設定',   icon: 'settings-outline',    activeIcon: 'settings' },
];

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={({ route }) => ({
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#f0f0f0',
          borderTopWidth: 1,
          height: 60 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 4,
        },
        tabBarActiveTintColor: '#2563eb',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
        headerStyle: { backgroundColor: '#ffffff' },
        headerTitleStyle: { fontSize: 16, fontWeight: '700', color: '#111827' },
        headerShadowVisible: false,
        tabBarIcon: ({ color, focused }) => {
          const tab = TABS.find(t => t.name === route.name);
          if (!tab) return null;
          return <Ionicons name={focused ? tab.activeIcon : tab.icon} size={22} color={color} />;
        },
      })}
    >
      {TABS.map(tab => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{ title: tab.title, headerTitle: tab.title === '地図' ? 'PALOGPTracker' : tab.title }}
        />
      ))}
    </Tabs>
  );
}
