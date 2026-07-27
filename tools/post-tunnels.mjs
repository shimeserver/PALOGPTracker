// tunnels.ts の後処理（Overpass再取得なしで実行できる検品パス）。
// 内部に強いUターン（進行方向反転）を含むエントリ＝上下線の誤連結を除去する。
// 分割・再連結は「別方向の車線を再びループ状に繋ぐ」事故が起きるため行わない
// （落としたトンネルはOSRM/コリドー/直線の既存処理でカバーされる）。
// 使い方: node tools/gen-tunnels.mjs && node tools/post-tunnels.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REVERSAL_COS = -0.7; // これ未満の内部反転を含む線形は不正とみなす

const file = path.join(__dirname, '..', 'web/src/data/tunnels.ts');
const src = fs.readFileSync(file, 'utf-8');
const arr = JSON.parse(src.match(/TUNNELS: TunnelGeom\[\] = (.*);/s)[1]);

const ok = [];
const dropped = [];
for (const t of arr) {
  const p = t.path;
  let worst = 1;
  for (let i = 1; i < p.length - 1; i++) {
    const ax = p[i][0] - p[i - 1][0], ay = p[i][1] - p[i - 1][1];
    const bx = p[i + 1][0] - p[i][0], by = p[i + 1][1] - p[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la && lb) { const c = (ax * bx + ay * by) / (la * lb); if (c < worst) worst = c; }
  }
  if (worst < REVERSAL_COS) dropped.push(`${t.name} ${t.lenKm}km (cos ${worst.toFixed(2)})`);
  else ok.push(t);
}
ok.sort((a, b) => b.lenKm - a.lenKm);

console.log(`検品: ${arr.length} → ${ok.length}本（除去 ${dropped.length}件）`);
dropped.forEach(d => console.log('  除去:', d));

const ts = `// 自動生成: tools/gen-tunnels.mjs + post-tunnels.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// 全国の高速道路トンネル（2km以上・GPS喪失区間）の実ジオメトリ。
// gapBridge が決定論的に補間に使う。path は [lng, lat] の順（OSRM geometry 互換）。
// 再生成: node tools/gen-tunnels.mjs && node tools/post-tunnels.mjs
export interface TunnelGeom { name: string; lenKm: number; path: [number, number][] }
export const TUNNELS: TunnelGeom[] = ${JSON.stringify(ok)};
`;
for (const dest of ['web/src/data', 'mobile/src/data']) {
  fs.writeFileSync(path.join(__dirname, '..', dest, 'tunnels.ts'), ts);
}
console.log(`合計 ${ok.length} 本 / ${(ts.length / 1024).toFixed(1)}KB を書き出しました`);
