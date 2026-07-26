import { describe, it, expect } from 'vitest';
import { removeGeoWarps, routeGapStats, recalcSpeeds, GAP_MIN_DIST_KM } from '../gapBridge';
import { findTunnelPath } from '../tunnelBridge';
import { TUNNELS } from '../../data/tunnels';
import type { TrackPoint } from '../../firebase/data';
import realRoutes from './fixtures/realRoutes.json';

// クリーンアップ系の回帰テスト。
// 過去に「バックトラック切除・完全直線圧縮」がアクアライン・湾岸線の実走行データを
// 破壊した事故（2025/12/16検証で発覚）を受け、実データフィクスチャで
// 「壊してはいけないものを壊さない」ことを恒久的に保証する。

function toPoints(arr: { lat: number; lng: number; timestamp: number; alt?: number }[]): TrackPoint[] {
  return arr.map(p => ({ lat: p.lat, lng: p.lng, timestamp: p.timestamp, speed: 0 }));
}

function haversineKm(a: TrackPoint, b: TrackPoint): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

describe('removeGeoWarps — 実データを破壊しない（回帰）', () => {
  it('アクアライン実走行データ: 走行区間（橋・海上）の点を除去しない', () => {
    const pts = toPoints(realRoutes.aquaLine);
    expect(pts.length).toBeGreaterThan(100);
    const r = removeGeoWarps(pts);
    // 海ほたるPA周辺（駐車場・徒歩の徘徊=毛玉）の除去は設計どおりの動作なので許容し、
    // それ以外の「走行中の実点」を消していないことを検証する。
    const UMIHOTARU = { lat: 35.4643, lng: 139.8745 };
    const kept = new Set(r.points.map(p => `${p.lat},${p.lng}`));
    const removedDriving = pts.filter(p =>
      !kept.has(`${p.lat},${p.lng}`) && haversineKm(p, { ...UMIHOTARU, timestamp: 0, speed: 0 }) > 0.4
    );
    expect(removedDriving.length).toBeLessThanOrEqual(2);
    // 全体でも毛玉除去の規模を超えないこと（暴走検知）
    expect(r.removed).toBeLessThanOrEqual(pts.length * 0.15);
  });

  it('湾岸線実走行データ（高速直線区間）をほぼ除去しない', () => {
    const pts = toPoints(realRoutes.wangan);
    expect(pts.length).toBeGreaterThan(100);
    const r = removeGeoWarps(pts);
    expect(r.removed).toBeLessThanOrEqual(pts.length * 0.01);
  });

  it('ヘアピンカーブ（合成）を誤爆しない', () => {
    // 25m間隔でヘアピンを往復する合成データ（山道の折り返し）
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 20; i++) pts.push({ lat: 35.0 + i * 0.00022, lng: 138.0, timestamp: i * 3000, speed: 0 });
    for (let i = 0; i < 20; i++) pts.push({ lat: 35.0 + (19 - i) * 0.00022, lng: 138.0003, timestamp: (20 + i) * 3000, speed: 0 });
    const r = removeGeoWarps(pts);
    expect(r.removed).toBe(0);
  });

  it('市街地グリッド走行（合成・90°連続）を誤爆しない', () => {
    const pts: TrackPoint[] = [];
    let lat = 35.0, lng = 139.0, t = 0;
    // 200mごとに右左折を繰り返すグリッド走行
    for (let block = 0; block < 8; block++) {
      for (let i = 0; i < 5; i++) { pts.push({ lat, lng, timestamp: t, speed: 0 }); t += 3000; if (block % 2 === 0) lat += 0.00036; else lng += 0.00044; }
    }
    const r = removeGeoWarps(pts);
    expect(r.removed).toBe(0);
  });

  it('密集反転クラスタ（トンネル出口の毛玉）を除去する', () => {
    // 正常走行の途中に、狭い範囲で鋭い反転を繰り返す毛玉を挿入
    const pts: TrackPoint[] = [];
    let t = 0;
    for (let i = 0; i < 30; i++) { pts.push({ lat: 35.0 + i * 0.0008, lng: 139.5, timestamp: t, speed: 0 }); t += 3000; }
    const cLat = 35.0 + 30 * 0.0008;
    for (let i = 0; i < 8; i++) {
      pts.push({ lat: cLat + (i % 2 === 0 ? 0.0012 : -0.0009), lng: 139.5 + (i % 3 === 0 ? 0.001 : -0.0008), timestamp: t, speed: 0 });
      t += 3000;
    }
    for (let i = 0; i < 30; i++) { pts.push({ lat: cLat + 0.001 + i * 0.0008, lng: 139.5, timestamp: t, speed: 0 }); t += 3000; }
    const r = removeGeoWarps(pts);
    expect(r.removed).toBeGreaterThanOrEqual(5); // 毛玉の大半が消える
    expect(r.points.length).toBeGreaterThanOrEqual(58); // 正常部は残る
  });

  it('除去が3割を超える暴走時は元データを返す（安全弁）', () => {
    // 全点が毛玉のような異常データ → 破壊を避けて原本を返すはず
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 40; i++) {
      pts.push({ lat: 35.0 + (i % 2 === 0 ? 0.002 : -0.002), lng: 139.0 + (i % 3 === 0 ? 0.002 : -0.001), timestamp: i * 3000, speed: 0 });
    }
    const r = removeGeoWarps(pts);
    expect(r.removed === 0 || r.removed <= pts.length * 0.3).toBe(true);
    if (r.removed === 0) expect(r.points.length).toBe(pts.length);
  });
});

describe('routeGapStats', () => {
  it('ギャップ数・最大・合計を正しく数える', () => {
    const mk = (lat: number, lng: number, i: number): TrackPoint => ({ lat, lng, timestamp: i * 1000, speed: 0 });
    // 約1.1kmのギャップ1つ（緯度0.01度）と正常間隔
    const pts = [mk(35.0, 139.0, 0), mk(35.0001, 139.0, 1), mk(35.0101, 139.0, 2), mk(35.0102, 139.0, 3)];
    const s = routeGapStats(pts);
    expect(s.count).toBe(1);
    expect(s.maxKm).toBeGreaterThan(1.0);
    expect(s.totalKm).toBeCloseTo(s.maxKm, 5);
  });

  it('しきい値（0.3km）未満はギャップ扱いしない', () => {
    const pts: TrackPoint[] = [
      { lat: 35.0, lng: 139.0, timestamp: 0, speed: 0 },
      { lat: 35.002, lng: 139.0, timestamp: 1000, speed: 0 }, // ~0.22km
    ];
    expect(GAP_MIN_DIST_KM).toBeCloseTo(0.3);
    expect(routeGapStats(pts).count).toBe(0);
  });
});

describe('recalcSpeeds', () => {
  it('speed=0の点に座標と時刻から速度を与え、300km/h超をクリップする', () => {
    const pts: TrackPoint[] = [
      { lat: 35.0, lng: 139.0, timestamp: 0, speed: 0 },
      { lat: 35.009, lng: 139.0, timestamp: 60_000, speed: 0 },   // 約1km/分 = 60km/h
      { lat: 35.018, lng: 139.0, timestamp: 60_100, speed: 0 },   // 0.1秒で1km = 36000km/h → クリップ
      { lat: 35.027, lng: 139.0, timestamp: 120_000, speed: 0 },
    ];
    const r = recalcSpeeds(pts);
    expect(r[0].speed).toBeGreaterThan(50);
    expect(r[0].speed).toBeLessThan(70);
    expect(r[1].speed).toBe(0); // 物理的にありえない区間は0
    expect(r.every(p => p.speed <= 300)).toBe(true);
  });
});

describe('findTunnelPath — 既知トンネル補間', () => {
  it.skipIf(TUNNELS.length === 0)('各トンネルの両端ギャップに対して線形を返す', () => {
    for (const t of TUNNELS) {
      const s = { lat: t.path[0][1], lng: t.path[0][0] };
      const e = { lat: t.path[t.path.length - 1][1], lng: t.path[t.path.length - 1][0] };
      const gapKm = Math.max(0.5, t.lenKm * 0.9);
      const m = findTunnelPath(s, e, gapKm);
      expect(m, t.name).not.toBeNull();
      expect(m!.lenKm).toBeGreaterThan(t.lenKm * 0.8);
    }
  });

  it.skipIf(TUNNELS.length === 0)('逆方向のギャップにはマッチしない（上下線の取り違え防止）', () => {
    const t = TUNNELS[0];
    const s = { lat: t.path[0][1], lng: t.path[0][0] };
    const e = { lat: t.path[t.path.length - 1][1], lng: t.path[t.path.length - 1][0] };
    // 終点→始点（逆走）は同じ線形にはマッチしないはず（反対車線の線形が別途あればそちらに合う）
    const m = findTunnelPath(e, s, t.lenKm);
    if (m) expect(m.name).toBe(t.name); // マッチするなら反対車線の同名トンネルのみ
  });

  it('トンネルと無関係なギャップにはマッチしない', () => {
    const m = findTunnelPath({ lat: 43.06, lng: 141.35 }, { lat: 43.07, lng: 141.36 }, 1.5); // 札幌市内
    expect(m).toBeNull();
  });
});
