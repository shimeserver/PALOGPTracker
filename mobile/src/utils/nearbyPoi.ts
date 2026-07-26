import { categorizeByName } from './spotCategory';

// Overpass API で近隣の名前付きPOIを取得する（スポット登録時の名前候補用・無料）。
// Google Places非対応のモバイル版でも「候補タップで名前・カテゴリ自動入力」を実現する。

export interface NearbyPoi {
  name: string;
  category: string;
  distM: number; // 中心からの距離(m)
}

// OSMタグ → アプリのカテゴリ
function osmToCategory(tags: Record<string, string>, name: string): string {
  const byName = categorizeByName(name);
  if (byName) return byName;
  if (tags.shop === 'convenience') return 'コンビニ';
  if (tags.amenity === 'fuel') return 'ガソリンスタンド';
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'SA/PA';
  if (['restaurant', 'fast_food', 'food_court'].includes(tags.amenity)) return 'グルメ';
  if (tags.amenity === 'cafe') return 'カフェ';
  if (tags.tourism) return '観光';
  if (tags.leisure === 'park' || tags.leisure === 'garden') return '公園';
  if (['mall', 'supermarket', 'department_store'].includes(tags.shop)) return 'ショッピング';
  if (tags.amenity === 'parking') return '駐車場';
  return 'その他';
}

function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export async function fetchNearbyPois(lat: number, lng: number, radiusM = 150): Promise<NearbyPoi[]> {
  const around = `around:${radiusM},${lat},${lng}`;
  const query = `[out:json][timeout:8];(
    nwr(${around})["name"]["amenity"];
    nwr(${around})["name"]["shop"];
    nwr(${around})["name"]["tourism"];
    nwr(${around})["name"]["leisure"];
    nwr(${around})["name"]["highway"~"^(rest_area|services)$"];
  );out center 20;`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    const seen = new Set<string>();
    const pois: NearbyPoi[] = [];
    for (const el of json.elements ?? []) {
      const name: string | undefined = el.tags?.name;
      if (!name || seen.has(name)) continue;
      const plat = el.lat ?? el.center?.lat;
      const plng = el.lon ?? el.center?.lon;
      if (plat == null || plng == null) continue;
      seen.add(name);
      pois.push({ name, category: osmToCategory(el.tags, name), distM: Math.round(distM(lat, lng, plat, plng)) });
    }
    return pois.sort((a, b) => a.distM - b.distM).slice(0, 6);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
