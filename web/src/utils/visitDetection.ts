import type { TrackPoint, Landmark } from '../firebase/data';

export interface StopCluster {
  lat: number;
  lng: number;
  startTime: number;
  endTime: number;
  durationMs: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const STOP_RADIUS_KM = 0.1;  // 100m
const MIN_DURATION_MS = 3 * 60 * 1000; // 3分

export function detectStops(points: TrackPoint[]): StopCluster[] {
  if (points.length < 2) return [];
  const stops: StopCluster[] = [];
  let i = 0;

  while (i < points.length) {
    let j = i + 1;
    while (j < points.length &&
      haversineKm(points[i].lat, points[i].lng, points[j].lat, points[j].lng) < STOP_RADIUS_KM) {
      j++;
    }
    const duration = points[j - 1].timestamp - points[i].timestamp;
    if (duration >= MIN_DURATION_MS) {
      const slice = points.slice(i, j);
      const lat = slice.reduce((s, p) => s + p.lat, 0) / slice.length;
      const lng = slice.reduce((s, p) => s + p.lng, 0) / slice.length;
      stops.push({ lat, lng, startTime: points[i].timestamp, endTime: points[j - 1].timestamp, durationMs: duration });
    }
    i = j;
  }
  return stops;
}

export function matchStopsToLandmarks(
  stops: StopCluster[],
  landmarks: Landmark[],
): StopCluster[] {
  return stops.filter(stop =>
    !landmarks.some(lm => haversineKm(stop.lat, stop.lng, lm.lat, lm.lng) < STOP_RADIUS_KM)
  );
}
