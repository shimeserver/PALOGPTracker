// 共通型定義

export interface TrackPoint {
  lat: number;
  lng: number;
  timestamp: number; // Unix ms
  speed: number;     // km/h
}

export interface Route {
  id?: string;
  userId: string;
  name: string;
  tags: string[];
  startTime: number;  // Unix ms
  endTime: number;    // Unix ms
  totalDistance: number; // km
  avgSpeed: number;      // km/h
  maxSpeed: number;      // km/h
  points: TrackPoint[];
  source: 'recorded' | 'imported';
  createdAt: number;
}

export interface LandmarkPhoto {
  url: string;
  storagePath: string;
  takenAt: number; // Unix ms
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
  firstVisit?: number; // Unix ms
  lastVisit?: number;  // Unix ms
  createdAt: number;
}

export interface Visit {
  id?: string;
  landmarkId: string;
  userId: string;
  timestamp: number; // Unix ms
  routeId?: string;
  notes?: string;
}

export type RouteImportTag = string;

export interface ImportedRouteGroup {
  name: string;
  tags: RouteImportTag[];
  points: TrackPoint[];
}
