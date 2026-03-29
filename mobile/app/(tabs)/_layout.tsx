import { View, TouchableOpacity, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCarStore } from '../../src/store/carStore';
import { useUiStore } from '../../src/store/uiStore';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TABS: { name: string; title: string; icon: IoniconName; activeIcon: IoniconName }[] = [
  { name: 'map',       title: '地図',   icon: 'map-outline',        activeIcon: 'map' },
  { name: 'track',     title: '記録',   icon: 'radio-button-off',   activeIcon: 'radio-button-on' },
  { name: 'routes',    title: 'ルート', icon: 'list-outline',        activeIcon: 'list' },
  { name: 'landmarks', title: 'スポット',icon: 'location-outline',   activeIcon: 'location' },
  { name: 'cars',      title: '移動手段', icon: 'navigate-outline', activeIcon: 'navigate' },
  { name: 'settings',  title: '設定',   icon: 'settings-outline',    activeIcon: 'settings' },
];

const HELP_TABS = new Set(['map', 'track', 'routes', 'landmarks', 'cars']);

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const maintenanceWarning = useCarStore(s => s.maintenanceWarning);
  const setHelpTarget = useUiStore(s => s.setHelpTarget);
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
          return (
            <View>
              <Ionicons name={focused ? tab.activeIcon : tab.icon} size={22} color={color} />
              {tab.name === 'cars' && maintenanceWarning && (
                <View style={{ position: 'absolute', top: -2, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444', borderWidth: 1, borderColor: '#fff' }} />
              )}
            </View>
          );
        },
      })}
    >
      {TABS.map(tab => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            headerTitle: tab.title === '地図' ? 'PALOGPTracker' : tab.title,
            ...(HELP_TABS.has(tab.name) ? {
              headerRight: () => (
                <TouchableOpacity
                  onPress={() => setHelpTarget(tab.name)}
                  style={{ marginRight: 16, width: 24, height: 24, borderRadius: 12, backgroundColor: '#e5e7eb', justifyContent: 'center', alignItems: 'center' }}
                >
                  <Text style={{ fontSize: 13, color: '#6b7280', fontWeight: '700', lineHeight: 16 }}>?</Text>
                </TouchableOpacity>
              ),
            } : {}),
          }}
        />
      ))}
    </Tabs>
  );
}
