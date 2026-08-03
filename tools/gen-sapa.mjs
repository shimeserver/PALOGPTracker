// 全国の高速道路SA/PAの位置データを OSM から取得し、
// 踏破判定用の静的データ web/src/data/sapa.ts を生成する。
//
// 使い方: node tools/gen-sapa.mjs
//
// 方式: highway=services(SA系)/rest_area(PA系) の名前付き要素を日本域から取得し、
// 名前がSA/PA系（〜SA・〜PA・サービスエリア・パーキングエリア・ハイウェイオアシス）の
// ものだけ採用。上下線（「海老名SA (下り)」等）は基本名でまとめ、両側の座標を保持する。
// 踏破判定は「走行軌跡が施設中心の約80〜160m以内を通ったか」（アプリ側）。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 日本域（gen-tunnels.mjs と同じ・韓国/中国/ウラジオを除外）
const REGIONS = [
  [23.5, 122.0, 30.5, 131.5],
  [30.4, 129.0, 34.85, 132.1],
  [24.0, 131.9, 40.0, 135.1],
  [24.0, 134.9, 46.5, 137.6],
  [24.0, 137.4, 46.5, 139.6],
  [24.0, 139.4, 46.5, 141.6],
  [24.0, 141.4, 46.0, 146.0],
];

const NAME_RE = /(^|[^A-Za-z])(SA|PA)([\s（(]|$)|サービスエリア|パーキングエリア|ハイウェイオアシス/;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

function overpass(query) {
  const tmp = path.join(__dirname, '.overpass-query.tmp');
  fs.writeFileSync(tmp, `data=${encodeURIComponent(query)}`);
  try {
    let lastErr = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ep = ENDPOINTS[attempt % ENDPOINTS.length];
      try {
        const out = execFileSync('curl', [
          '-s', '-m', '180', '-A', 'PALOGPTracker/1.0 (SA/PA registry generator)',
          '--data', `@${tmp}`, ep,
        ], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf-8' });
        const json = JSON.parse(out);
        if (json.remark?.includes('error')) throw new Error(json.remark);
        return json;
      } catch (e) {
        lastErr = e;
        console.error(`  … retry ${attempt + 1}/12 (${ep.split('/')[2]}): ${String(e.message).slice(0, 60)}`);
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
      }
    }
    throw lastErr;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// 上下線表記を取り除いた基本名（「海老名SA (下り)」→「海老名SA」）
function baseName(name) {
  return name
    .replace(/[（(]?(上り|下り|上|下|外回り|内回り|東行き?|西行き?|南行き?|北行き?)(線|方面)?[）)]?/g, '')
    .replace(/[・\s]+$/g, '')
    .trim();
}

// 敷地ポリゴンの外周を約50m間隔でサンプリング（海老名SA級の大型施設でも
// 「端に停めた」ケースを敷地との距離で判定できるようにする）
function samplePerimeter(geom) {
  const out = [geom[0]];
  let acc = 0;
  for (let i = 1; i < geom.length; i++) {
    acc += haversineKm(geom[i - 1], geom[i]);
    if (acc >= 0.05) { out.push(geom[i]); acc = 0; }
  }
  return out.slice(0, 40); // 巨大ポリゴンの保険
}

const raw = []; // { name, lat, lng, pts: [{lat,lng}...] }
for (const bbox of REGIONS) {
  const q = `[out:json][timeout:90];nwr["highway"~"^(services|rest_area)$"]["name"](${bbox.join(',')});out geom;`;
  let data;
  try {
    data = await overpass(q);
  } catch (e) {
    console.error(`✗ region ${bbox.join(',')}: ${e.message}`);
    continue;
  }
  let n = 0;
  for (const el of data.elements) {
    const name = el.tags?.name;
    if (!name || !NAME_RE.test(name)) continue;
    let pts = null;
    if (el.type === 'node' && el.lat != null) {
      pts = [{ lat: el.lat, lng: el.lon }];
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
      pts = samplePerimeter(el.geometry.map(g => ({ lat: g.lat, lng: g.lon })));
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      const g = el.members.flatMap(m => Array.isArray(m.geometry) ? m.geometry : []);
      if (g.length > 0) pts = samplePerimeter(g.map(p => ({ lat: p.lat, lng: p.lon })));
    }
    if (!pts || pts.length === 0) continue;
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    raw.push({ name, lat, lng, pts });
    n++;
  }
  console.log(`region [${bbox[1]}-${bbox[3]}] SA/PA要素 ${n}`);
  await new Promise(r => setTimeout(r, 2000));
}

// 基本名でグループ化し、5km以内の同名要素をひとつの施設にまとめる（上下線・重複タグ対応）
const groups = new Map();
for (const r of raw) {
  const base = baseName(r.name);
  if (!groups.has(base)) groups.set(base, []);
  const g = groups.get(base);
  const near = g.find(f => haversineKm(f, r) < 5);
  if (near) near.sides.push(r);
  else g.push({ lat: r.lat, lng: r.lng, sides: [r] });
}

const result = [];
for (const [base, facilities] of groups) {
  for (const f of facilities) {
    const type = /(サービスエリア|SA)([\s（(]|$)|SA$/.test(base) || base.includes('サービスエリア') ? 'SA'
      : base.includes('ハイウェイオアシス') ? 'SA' : 'PA';
    // 全側（上下線）の外周サンプル点をまとめる（どこに停めても踏破判定できる）
    const pts = f.sides.flatMap(s => s.pts).slice(0, 80)
      .map(p => [Math.round(p.lng * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4]);
    result.push({ name: base, type, pts });
  }
}
result.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
console.log(`\n施設数 ${result.length}（SA ${result.filter(r => r.type === 'SA').length} / PA ${result.filter(r => r.type === 'PA').length}）`);

const ts = `// 自動生成: tools/gen-sapa.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// 全国の高速道路SA/PA。pts は敷地外周の約50m間隔サンプル [lng, lat]（上下線込み）。
// 踏破判定 = 「敷地外周の近くに低速の走行点がある」（アプリ側）。
export interface SapaGeom { name: string; type: 'SA' | 'PA'; pts: [number, number][] }
export const SAPAS: SapaGeom[] = ${JSON.stringify(result)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'web/src/data/sapa.ts'), ts);
console.log(`${(ts.length / 1024).toFixed(1)}KB → web/src/data/sapa.ts`);
