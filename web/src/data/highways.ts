// 自動生成: tools/gen-highways.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// メジャー高速道路の走破率計算用サンプル点列（約600m間隔・上下線込み）。
// samples は [lng, lat]。走破率 = 走行軌跡から250m以内のサンプル点の割合。
export interface HighwayGeom { name: string; lenKm: number; samples: [number, number][] }
export const HIGHWAYS: HighwayGeom[] = [];
