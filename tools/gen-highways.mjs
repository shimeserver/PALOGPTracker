// メジャー高速道路の路線ジオメトリを OSM から取得し、走破率計算用の
// サンプル点列データ highways.ts を生成する（web のみ・遅延ロード前提）。
//
// 使い方: node tools/gen-highways.mjs
// 出力: web/src/data/highways.ts
//
// 方式: 路線名の完全一致で本線(motorway)のwayを取得し、約600m間隔のサンプル点に間引く。
// 走破率 = サンプル点のうち「走行軌跡から250m以内」の割合（上下線は近接なので方向不問）。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// [表示名, OSM名の候補（完全一致・複数可）]
const HIGHWAYS = [
  ['東名高速道路', ['東名高速道路']],
  ['新東名高速道路', ['新東名高速道路']],
  ['名神高速道路', ['名神高速道路']],
  ['新名神高速道路', ['新名神高速道路']],
  ['中央自動車道', ['中央自動車道', '中央自動車道富士吉田線']],
  ['関越自動車道', ['関越自動車道']],
  ['東北自動車道', ['東北自動車道']],
  ['常磐自動車道', ['常磐自動車道']],
  ['東関東自動車道', ['東関東自動車道']],
  ['館山自動車道', ['館山自動車道']],
  ['京葉道路', ['京葉道路']],
  ['東京湾アクアライン', ['東京湾アクアライン', '東京湾アクアライン;東京湾横断・木更津東金道路', '東京湾アクアライン連絡道']],
  ['圏央道', ['首都圏中央連絡自動車道']],
  ['東京外環自動車道', ['東京外環自動車道']],
  ['上信越自動車道', ['上信越自動車道']],
  ['長野自動車道', ['長野自動車道']],
  ['北陸自動車道', ['北陸自動車道']],
  ['東海北陸自動車道', ['東海北陸自動車道']],
  ['東名阪自動車道', ['東名阪自動車道']],
  ['伊勢湾岸自動車道', ['伊勢湾岸自動車道']],
  ['近畿自動車道', ['近畿自動車道']],
  ['阪和自動車道', ['阪和自動車道']],
  ['中国自動車道', ['中国自動車道']],
  ['山陽自動車道', ['山陽自動車道', '山陽自動車道吹田山口線']],
  ['九州自動車道', ['九州自動車道']],
  ['長崎自動車道', ['長崎自動車道']],
  ['大分自動車道', ['大分自動車道']],
  ['道央自動車道', ['道央自動車道']],
  // 首都高（ユーザーのホームグラウンドなので路線別に）
  ['首都高 都心環状線', ['首都高速都心環状線']],
  ['首都高 中央環状線', ['首都高速中央環状線']],
  ['首都高 湾岸線', ['首都高速湾岸線']],
  ['首都高 3号渋谷線', ['首都高速3号渋谷線']],
  ['首都高 4号新宿線', ['首都高速4号新宿線']],
  ['首都高 横羽線', ['首都高速神奈川1号横羽線']],
];

const SAMPLE_KM = 0.6; // サンプル点間隔

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
          '-s', '-m', '180', '-A', 'PALOGPTracker/1.0 (highway coverage generator)',
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

const result = [];
for (const [label, names] of HIGHWAYS) {
  // 本線のみ（motorway_linkは含めない: ランプで分母を膨らませない）。
  // 日本域bboxで海外の同名道路を除外
  const clauses = names.map(n => `way["name"="${n}"]["highway"="motorway"](24.0,122.0,46.5,146.0);`).join('');
  const q = `[out:json][timeout:90];(${clauses});(._;>;);out body;`;
  let data;
  try {
    data = await overpass(q);
  } catch (e) {
    console.error(`✗ ${label}: ${e.message}`);
    continue;
  }
  const nodeMap = new Map();
  for (const el of data.elements) if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lng: el.lon });
  const ways = data.elements.filter(e => e.type === 'way');
  if (ways.length === 0) { console.error(`✗ ${label}: wayなし`); continue; }

  // way単位で距離を積みながら SAMPLE_KM ごとにサンプル点を打つ
  const samples = [];
  let totalKm = 0;
  for (const w of ways) {
    let acc = SAMPLE_KM; // wayの先頭点は必ず打つ
    let prev = null;
    for (const nid of w.nodes) {
      const p = nodeMap.get(nid);
      if (!p) continue;
      if (prev) {
        const d = haversineKm(prev, p);
        totalKm += d;
        acc += d;
      }
      if (acc >= SAMPLE_KM) { samples.push(p); acc = 0; }
      prev = p;
    }
  }
  // 上下線があるので実路線長は約半分
  const lenKm = Math.round(totalKm / 2);
  result.push({
    name: label,
    lenKm,
    samples: samples.map(p => [Math.round(p.lng * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4]),
  });
  console.log(`✓ ${label} ${lenKm}km ${samples.length}サンプル`);
  await new Promise(r => setTimeout(r, 2000));
}

const ts = `// 自動生成: tools/gen-highways.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// メジャー高速道路の走破率計算用サンプル点列（約600m間隔・上下線込み）。
// samples は [lng, lat]。走破率 = 走行軌跡から250m以内のサンプル点の割合。
export interface HighwayGeom { name: string; lenKm: number; samples: [number, number][] }
export const HIGHWAYS: HighwayGeom[] = ${JSON.stringify(result)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'web/src/data/highways.ts'), ts);
console.log(`\n合計 ${result.length} 路線 / ${(ts.length / 1024).toFixed(1)}KB → web/src/data/highways.ts`);
