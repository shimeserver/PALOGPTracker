import type { Route, TrackPoint } from '../firebase/data';
import { loadRoutePoints } from '../firebase/data';

// 全ルートのエクスポート（バックアップ・他アプリ連携用）。
// CSV = ルートヒストリー互換形式（本アプリで再インポート可能）
// GPX = 標準形式（他の地図アプリ・GPSツールで利用可能）

// points未ロード（チャンク形式）のルートを補充してから返す
async function ensurePoints(routes: Route[], onProgress?: (done: number, total: number) => void): Promise<Route[]> {
  const result: Route[] = [];
  let done = 0;
  for (const r of routes) {
    if (r.points && r.points.length > 0) {
      result.push(r);
    } else if (r.id) {
      const points = await loadRoutePoints(r.id).catch(() => [] as TrackPoint[]);
      result.push({ ...r, points });
    }
    done++;
    onProgress?.(done, routes.length);
  }
  return result;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function exportRoutesGpx(routes: Route[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const loaded = await ensurePoints(routes, onProgress);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="PALOGPTracker" xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  for (const r of loaded) {
    if (!r.points || r.points.length < 2) continue;
    parts.push(`<trk><name>${esc(r.name || `ルート ${new Date(r.startTime).toLocaleDateString('ja-JP')}`)}</name><trkseg>`);
    for (const p of r.points) {
      const ele = p.alt != null ? `<ele>${p.alt}</ele>` : '';
      parts.push(`<trkpt lat="${p.lat}" lon="${p.lng}">${ele}<time>${new Date(p.timestamp).toISOString()}</time></trkpt>`);
    }
    parts.push('</trkseg></trk>');
  }
  parts.push('</gpx>');
  return new Blob([parts.join('\n')], { type: 'application/gpx+xml' });
}

export async function exportRoutesCsv(routes: Route[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const loaded = await ensurePoints(routes, onProgress);
  const lines: string[] = [];
  for (const r of loaded) {
    if (!r.points || r.points.length < 2) continue;
    lines.push(`LogHeader,"${(r.name || '').replace(/"/g, '""')}","",1`);
    if (r.tags.length > 0) lines.push(`LogTag,${r.tags.join(',')}`);
    for (const p of r.points) {
      lines.push(`tp,${p.lat},${p.lng},${new Date(p.timestamp).toISOString()},${p.alt ?? 0}`);
    }
    lines.push('LogEnd');
  }
  return new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportFilename(ext: 'gpx' | 'csv'): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `PALOGP_export_${ymd}.${ext}`;
}
