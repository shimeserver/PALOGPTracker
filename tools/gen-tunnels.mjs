// 全国の高速道路トンネル（GPS喪失区間）の実ジオメトリを OSM から取得し、
// web/mobile に同梱する静的データ tunnels.ts を生成する。
//
// 使い方: node tools/gen-tunnels.mjs
// 出力: web/src/data/tunnels.ts と mobile/src/data/tunnels.ts（同一内容）
//
// 方式: 日本を経度帯で分割した各リージョンから motorway のトンネル way を全取得し、
// 連結成分ごと（上下線は別成分になる）に oneway を尊重した最長経路を1本の折れ線にする。
// 名前に依存しないため、無名トンネル（川崎航路等）や圏央道の中規模トンネルも拾える。
// 連続するトンネル（短い明かり区間で分かれた山岳トンネル群）は方向連続なら連結する。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 日本全域を分割（境界またぎ対策で0.1度オーバーラップ・重複は後段でdedupe）。
// 単純な経度帯だと韓国（釜山〜インジェ）・中国東北部・ウラジオストクの
// 高速トンネルまで拾ってしまうため、南西側は緯度で刻んで日本域のみに限定する。
const REGIONS = [
  [23.5, 122.0, 30.5, 131.5],   // 沖縄・奄美（韓国は北緯33以北なので入らない）
  [30.4, 129.0, 34.85, 132.1],  // 九州・対馬（釜山34.9+/巨済島128.5-を除外）
  [24.0, 131.9, 40.0, 135.1],   // 中国・四国・近畿西部（ウラジオ43+を除外）
  [24.0, 134.9, 46.5, 137.6],
  [24.0, 137.4, 46.5, 139.6],
  [24.0, 139.4, 46.5, 141.6],
  [24.0, 141.4, 46.0, 146.0],
];

const MIN_LEN_KM = 2.0;   // 収録する最小トンネル長（これ未満はOSRM/コリドー/直線処理で十分）
const CHAIN_GAP_KM = 0.3; // 明かり区間がこれ未満で方向が連続なら1本に連結
const SIMPLIFY_M = 40;    // 出力点間隔の下限（データサイズ削減）

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

// Node fetch がこの環境で IPv6 起因の失敗をするため curl 経由で取得。
// 混雑時は「server too busy」を返し続けるため辛抱強くリトライする。
function overpass(query) {
  const tmp = path.join(__dirname, '.overpass-query.tmp');
  fs.writeFileSync(tmp, `data=${encodeURIComponent(query)}`);
  try {
    let lastErr = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ep = ENDPOINTS[attempt % ENDPOINTS.length];
      try {
        const out = execFileSync('curl', [
          '-s', '-m', '180', '-A', 'PALOGPTracker/1.0 (tunnel geometry generator)',
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

// 有向グラフ上で最長の最短路（=本線経路）を求める。枝=出入口ランプは短いので負ける
function longestPath(coords, adj) {
  const n = coords.length;
  const indeg = new Array(n).fill(0);
  adj.forEach(edges => edges.forEach(([v]) => indeg[v]++));
  let starts = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0 && adj[i].length > 0) starts.push(i);
  if (starts.length === 0) starts = [...Array(n).keys()].filter(i => adj[i].length > 0);
  let best = null;
  for (const s of starts) {
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    dist[s] = 0;
    const done = new Array(n).fill(false);
    for (;;) {
      let u = -1, du = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = true;
      for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    for (let g = 0; g < n; g++) {
      if (!isFinite(dist[g]) || dist[g] === 0) continue;
      if (!best || dist[g] > best.len) {
        const p = [g];
        while (p[p.length - 1] !== s) p.push(prev[p[p.length - 1]]);
        p.reverse();
        best = { len: dist[g], path: p };
      }
    }
  }
  return best;
}

function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (haversineKm(out[out.length - 1], pts[i]) * 1000 >= SIMPLIFY_M) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const all = []; // { name, len, pts }
for (const bbox of REGIONS) {
  const q = `[out:json][timeout:120];way["highway"~"^(motorway|motorway_link)$"]["tunnel"](${bbox.join(',')});(._;>;);out body;`;
  let data;
  try {
    data = await overpass(q);
  } catch (e) {
    console.error(`✗ region ${bbox.join(',')}: ${e.message}`);
    continue;
  }
  const idMap = new Map();
  const coords = [];
  for (const el of data.elements) {
    if (el.type === 'node') { idMap.set(el.id, coords.length); coords.push({ lat: el.lat, lng: el.lon }); }
  }
  const ways = data.elements.filter(e => e.type === 'way');
  // 連結成分に分割
  const comp = new Array(coords.length).fill(-1);
  const undirected = coords.map(() => []);
  for (const w of ways) {
    for (let i = 1; i < w.nodes.length; i++) {
      const u = idMap.get(w.nodes[i - 1]), v = idMap.get(w.nodes[i]);
      if (u == null || v == null) continue;
      undirected[u].push(v); undirected[v].push(u);
    }
  }
  let nComp = 0;
  for (let i = 0; i < coords.length; i++) {
    if (comp[i] >= 0 || undirected[i].length === 0) continue;
    const stack = [i]; comp[i] = nComp;
    while (stack.length) {
      const u = stack.pop();
      for (const v of undirected[u]) if (comp[v] < 0) { comp[v] = nComp; stack.push(v); }
    }
    nComp++;
  }
  // 成分ごとの最長路
  const compWays = Array.from({ length: nComp }, () => []);
  for (const w of ways) {
    const c = comp[idMap.get(w.nodes[0]) ?? -1];
    if (c >= 0) compWays[c].push(w);
  }
  let regionCount = 0;
  for (let c = 0; c < nComp; c++) {
    const localIdx = new Map();
    const localCoords = [];
    for (let i = 0; i < coords.length; i++) if (comp[i] === c) { localIdx.set(i, localCoords.length); localCoords.push(coords[i]); }
    if (localCoords.length < 2 || localCoords.length > 4000) continue;
    const adj = localCoords.map(() => []);
    for (const w of compWays[c]) {
      const oneway = w.tags?.oneway ?? 'yes';
      const rev = oneway === '-1';
      const bidir = oneway === 'no' || oneway === 'false' || oneway === '0';
      for (let i = 1; i < w.nodes.length; i++) {
        const gu = idMap.get(w.nodes[i - 1]), gv = idMap.get(w.nodes[i]);
        if (gu == null || gv == null) continue;
        const u = localIdx.get(gu), v = localIdx.get(gv);
        if (u == null || v == null) continue;
        const wt = haversineKm(localCoords[u], localCoords[v]);
        if (rev) adj[v].push([u, wt]); else adj[u].push([v, wt]);
        if (bidir) adj[v].push([u, wt]);
      }
    }
    const best = longestPath(localCoords, adj);
    if (!best || best.len < 0.4) continue; // 断片は連結処理で拾う
    // 成分の代表名（最長wayのtunnel:name > name）
    let name = '';
    let nameLen = 0;
    for (const w of compWays[c]) {
      let wl = 0;
      for (let i = 1; i < w.nodes.length; i++) {
        const u = idMap.get(w.nodes[i - 1]), v = idMap.get(w.nodes[i]);
        if (u != null && v != null) wl += haversineKm(coords[u], coords[v]);
      }
      const wn = w.tags?.['tunnel:name'] || w.tags?.name || '';
      if (wn && wl > nameLen) { name = wn; nameLen = wl; }
    }
    all.push({ name: name || '無名トンネル', len: best.len, pts: best.path.map(i => localCoords[i]) });
    regionCount++;
  }
  console.log(`region [${bbox[1]}-${bbox[3]}] ways=${ways.length} 候補成分=${regionCount}`);
  await new Promise(r => setTimeout(r, 3000)); // Overpass礼儀
}

// リージョン重複のdedupe（始点終点がほぼ同一のものを除去）
const key = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
const seen = new Set();
const cands = [];
for (const t of all) {
  const k = `${key(t.pts[0])}|${key(t.pts[t.pts.length - 1])}`;
  if (seen.has(k)) continue;
  seen.add(k);
  cands.push(t);
}

// 端点が近く方向が連続な経路を連結（トンネル群・OSM上の名前分割対応）。Uターン連結は拒否
let changed = true;
while (changed) {
  changed = false;
  outer: for (let i = 0; i < cands.length; i++) {
    for (let j = 0; j < cands.length; j++) {
      if (i === j) continue;
      const a = cands[i], b = cands[j];
      const gap = haversineKm(a.pts[a.pts.length - 1], b.pts[0]);
      if (gap >= CHAIN_GAP_KM) continue;
      const a2 = a.pts[a.pts.length - 2] ?? a.pts[a.pts.length - 1];
      const a1 = a.pts[a.pts.length - 1];
      const b1 = b.pts[0];
      const b2 = b.pts[1] ?? b.pts[0];
      const ax = a1.lng - a2.lng, ay = a1.lat - a2.lat;
      const bx = b2.lng - b1.lng, by = b2.lat - b1.lat;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const cont = (la && lb) ? (ax * bx + ay * by) / (la * lb) : 1;
      if (cont <= 0) continue;
      cands[i] = { name: a.len >= b.len ? a.name : b.name, len: a.len + gap + b.len, pts: [...a.pts, ...b.pts] };
      cands.splice(j, 1);
      changed = true;
      break outer;
    }
  }
}

const result = [];
for (const t of cands) {
  if (t.len < MIN_LEN_KM) continue;
  if (/[가-힯]/.test(t.name)) continue; // ハングル名=韓国（bbox漏れの保険）
  const pts = simplify(t.pts);
  result.push({
    name: t.name,
    lenKm: Math.round(t.len * 100) / 100,
    path: pts.map(p => [Math.round(p.lng * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5]),
  });
}
result.sort((a, b) => b.lenKm - a.lenKm);
console.log(`\n収録 ${result.length} 本:`);
result.slice(0, 30).forEach(t => console.log(`  ${t.lenKm.toFixed(1)}km ${t.name} (${t.path.length}点)`));
if (result.length > 30) console.log(`  … 他 ${result.length - 30} 本`);

const ts = `// 自動生成: tools/gen-tunnels.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// 全国の高速道路トンネル（${MIN_LEN_KM}km以上・GPS喪失区間）の実ジオメトリ。
// gapBridge が決定論的に補間に使う。path は [lng, lat] の順（OSRM geometry 互換）。
// 再生成: node tools/gen-tunnels.mjs
export interface TunnelGeom { name: string; lenKm: number; path: [number, number][] }
export const TUNNELS: TunnelGeom[] = ${JSON.stringify(result)};
`;
for (const dest of ['web/src/data', 'mobile/src/data']) {
  const dir = path.join(__dirname, '..', dest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tunnels.ts'), ts);
}
console.log(`\n合計 ${result.length} 本 / ${(ts.length / 1024).toFixed(1)}KB → web,mobile の src/data/tunnels.ts`);
