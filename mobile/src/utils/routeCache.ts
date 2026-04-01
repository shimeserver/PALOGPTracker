import AsyncStorage from '@react-native-async-storage/async-storage';
import { RouteMetadata } from '../firebase/routes';

export interface RoutesCache {
  routes: RouteMetadata[];
  lastFetchTime: number;
}

const cacheKey = (uid: string) => `routes_cache_v1_${uid}`;

export async function loadCachedRoutes(uid: string): Promise<RoutesCache | null> {
  try {
    const json = await AsyncStorage.getItem(cacheKey(uid));
    if (!json) return null;
    return JSON.parse(json) as RoutesCache;
  } catch {
    return null;
  }
}

export async function saveRoutesCache(uid: string, routes: RouteMetadata[], lastFetchTime: number): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(uid), JSON.stringify({ routes, lastFetchTime }));
  } catch {
    // ignore storage errors
  }
}

export async function clearRoutesCache(uid: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(cacheKey(uid));
  } catch {
    // ignore
  }
}

// Merge cached + new routes, dedup by id, sort newest first
export function mergeRoutes(cached: RouteMetadata[], newRoutes: RouteMetadata[]): RouteMetadata[] {
  const map = new Map(cached.map(r => [r.id, r]));
  for (const r of newRoutes) {
    map.set(r.id, r);
  }
  return Array.from(map.values()).sort((a, b) => b.startTime - a.startTime);
}
