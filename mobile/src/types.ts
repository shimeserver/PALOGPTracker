// shared/src/types.ts と同内容（Expo用コピー）

export interface TrackPoint {
  lat: number;
  lng: number;
  timestamp: number;
  speed: number;
}

export type TrackingMode = 'car' | 'walk' | 'bicycle';

export interface Route {
  id?: string;
  userId: string;
  name: string;
  tags: string[];
  startTime: number;
  endTime: number;
  totalDistance: number;
  avgSpeed: number;
  maxSpeed: number;
  points: TrackPoint[];
  source: 'recorded' | 'imported';
  mode?: TrackingMode;
  createdAt: number;
}

export interface LandmarkPhoto {
  url: string;
  storagePath: string;
  takenAt: number;
}

export interface Landmark {
  id?: string;
  userId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  description: string;
  photos: LandmarkPhoto[];
  visitCount: number;
  firstVisit?: number;
  lastVisit?: number;
  createdAt: number;
}

export interface Visit {
  id?: string;
  landmarkId: string;
  userId: string;
  timestamp: number;
  routeId?: string;
  notes?: string;
}

export interface Car {
  id: string;
  userId: string;
  nickname: string;
  vehicleType?: 'car' | 'bicycle';
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  photoUrl?: string;
  tagId?: string;
  odometerKm?: number;
  createdAt: number;
}

export interface FuelLog {
  id?: string;
  carId: string;
  timestamp: number;
  liters: number;
  pricePerLiter?: number;
  totalCost?: number;
  isFull: boolean;
  notes?: string;
}

export type MaintenanceType = 'oil' | 'tire' | 'brake' | 'battery' | 'inspection' | 'other';

export const MAINTENANCE_LABELS: Record<MaintenanceType, string> = {
  oil: 'オイル交換',
  tire: 'タイヤ交換/ローテーション',
  brake: 'ブレーキ',
  battery: 'バッテリー',
  inspection: '車検',
  other: 'その他',
};

export interface MaintenanceLog {
  id?: string;
  carId: string;
  type: MaintenanceType;
  customLabel?: string;
  itemType?: string; // オイル銘柄・タイヤ銘柄など任意
  timestamp: number;
  odometerKm?: number;
  cost?: number;
  notes?: string;
  nextDueMonths?: number;
  nextDueKm?: number;
}
