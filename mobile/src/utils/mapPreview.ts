import type { TrackPoint } from '../types';

// Display only; the recorded and uploaded points retain their original resolution.
export function mapPreview(points: TrackPoint[], limit = 2000): number[][] {
  if (points.length <= limit) return points.map(p => [p.lat, p.lng]);
  return Array.from({ length: limit }, (_, i) => {
    const p = points[Math.round(i * (points.length - 1) / (limit - 1))];
    return [p.lat, p.lng];
  });
}
