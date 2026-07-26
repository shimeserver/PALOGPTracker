// 既知の長大トンネル（GPS完全喪失区間）の実ジオメトリを OSM から取得し、
// web/mobile に同梱する静的データ tunnels.json を生成する。
//
// 使い方: node tools/gen-tunnels.mjs
// 出力: web/src/data/tunnels.json と mobile/src/data/tunnels.json（同一内容）
//
// 方式: トンネル名で motorway の way を検索 → 連結成分ごとに（上下線が別成分になる）
// oneway を尊重した最長経路を求めて1本の折れ線にする。座標の手打ちをしないので確実。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 対象トンネル（車で走れるGPS喪失級の長大・海底トンネル）。
// 青函トンネルは鉄道専用なので対象外。関門トンネル(国道2号)はmotorwayでないため対象外
// （関門橋経由は地上なのでGPSが生きる）。
// 名前regex/等値クエリはOverpassが混雑時に処理しきれないため、
// 「狭いbbox + tunnel + motorway」の軽量クエリで取得し、名前はクライアント側で照合する。
// bbox は s,w,n,e。トンネル位置を広めに覆っていれば良い（名前照合で他は落ちる）。
// match: name / tunnel:name に含まれていれば採用する部分文字列（省略時はlabel）
// アクアラインのトンネル部は name="東京湾アクアライン;東京湾横断・木更津東金道路" で
// tunnel:name が無いため「アクアライン」で照合する（bbox内のアクアラインのトンネル=海底部のみ）。
// 川崎航路・空港北トンネルはOSM上で無名（name/tunnel:nameなし）のため対象外
// （2km級で短く、OSRM/コリドー/直線処理で十分）。
const TUNNELS = [
  { label: '山手トンネル', bbox: [35.63, 139.64, 35.76, 139.73] },       // 首都高C2 18.2km
  { label: 'アクアトンネル', bbox: [35.40, 139.74, 35.56, 139.93], match: ['アクアトンネル', 'アクアライン'] }, // 9.6km 海底
  { label: '東京港トンネル', bbox: [35.57, 139.72, 35.64, 139.79] },     // 湾岸線 海底
  { label: '多摩川トンネル', bbox: [35.50, 139.73, 35.57, 139.81] },     // 湾岸線 河口部
  { label: '横浜北トンネル', bbox: [35.45, 139.55, 35.56, 139.68] },     // K7 8.2km
  { label: '関越トンネル', bbox: [36.72, 138.80, 36.94, 139.05] },       // 関越道 11.0km
  { label: '恵那山トンネル', bbox: [35.38, 137.42, 35.64, 137.70] },     // 中央道 8.6km
  { label: '飛騨トンネル', bbox: [36.08, 136.82, 36.32, 137.18], match: ['飛騨トンネル', '飛驒トンネル'] }, // 東海北陸道 10.7km（OSMは旧字体「驒」・対面通行）
];

const MIN_LEN_KM = 1.2;   // これ未満の成分（ランプ等）は捨てる
const SIMPLIFY_M = 40;    // 出力点間隔の下限（データサイズ削減）

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

import { execFileSync } from 'child_process';

// Node fetch がこの環境で IPv6 起因の失敗をするため curl 経由で取得。
// 日本語を argv で渡すと Windows で文字化けするため一時ファイル経由で渡す。
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

function overpass(query) {
  const tmp = path.join(__dirname, '.overpass-query.tmp');
  fs.writeFileSync(tmp, `data=${encodeURIComponent(query)}`);
  try {
    // Overpassは混雑時に「server too busy」を返し続けるため、辛抱強くリトライする
    let lastErr = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ep = ENDPOINTS[attempt % ENDPOINTS.length];
      try {
        const out = execFileSync('curl', [
          '-s', '-m', '120', '-A', 'PALOGPTracker/1.0 (tunnel geometry generator)',
          '--data', `@${tmp}`, ep,
        ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' });
        const json = JSON.parse(out);
        if (json.remark?.includes('error')) throw new Error(json.remark);
        return json;
      } catch (e) {
        lastErr = e;
        console.error(`  … retry ${attempt + 1}/12 (${ep.split('/')[2]}): ${String(e.message).slice(0, 60)}`);
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']); // 30秒待って再試行
      }
    }
    throw lastErr;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// 有向グラフ上で「startから到達できる最遠ノードまでの最短路」を全startで試し、
// 最長のものを本線経路として採用する（枝=出入口ランプは短いので負けて消える）。
function longestPath(coords, adj) {
  const n = coords.length;
  // 入次数0のノード（=このトンネル方向の入口候補）を優先、なければ全ノード
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
    // トンネル成分は小さいので単純なDijkstra（配列走査）で十分
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

const result = [];
for (const { label: name, bbox, match } of TUNNELS) {
  const q = `[out:json][timeout:30];way["highway"~"^(motorway|motorway_link)$"]["tunnel"](${bbox.join(',')});(._;>;);out body;`;
  let data;
  try {
    data = await overpass(q);
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    continue;
  }
  // 名前照合はクライアント側で行う。首都高等は way の name が路線名（中央環状線等）で
  // トンネル名は tunnel:name に入ることがあるため両方を見る。
  const matchers = match ?? [name];
  const wayNameOf = (el) => `${el.tags?.name ?? ''}|${el.tags?.['tunnel:name'] ?? ''}`;
  const allWays = data.elements.filter(el => el.type === 'way');
  data.elements = data.elements.filter(el =>
    el.type === 'node' || (el.type === 'way' && matchers.some(m => wayNameOf(el).includes(m)))
  );
  if (!data.elements.some(el => el.type === 'way')) {
    const names = [...new Set(allWays.map(wayNameOf))].slice(0, 10).join(' / ');
    console.error(`✗ ${name}: 一致するwayなし。bbox内のトンネル名: ${names}`);
    continue;
  }
  const idMap = new Map();
  const coords = [];
  for (const el of data.elements) {
    if (el.type === 'node') { idMap.set(el.id, coords.length); coords.push({ lat: el.lat, lng: el.lon }); }
  }
  // 連結成分に分ける（無向で成分分割 → 各成分内で有向最長路）
  const comp = new Array(coords.length).fill(-1);
  const undirected = coords.map(() => []);
  const ways = data.elements.filter(e => e.type === 'way');
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
  const cands = [];
  for (let c = 0; c < nComp; c++) {
    const localIdx = new Map();
    const localCoords = [];
    for (let i = 0; i < coords.length; i++) if (comp[i] === c) { localIdx.set(i, localCoords.length); localCoords.push(coords[i]); }
    const adj = localCoords.map(() => []);
    for (const w of ways) {
      const oneway = w.tags?.oneway ?? 'yes';
      const rev = oneway === '-1';
      const bidir = oneway === 'no' || oneway === 'false' || oneway === '0';
      for (let i = 1; i < w.nodes.length; i++) {
        const gu = idMap.get(w.nodes[i - 1]), gv = idMap.get(w.nodes[i]);
        if (gu == null || gv == null || comp[gu] !== c || comp[gv] !== c) continue;
        const u = localIdx.get(gu), v = localIdx.get(gv);
        const wt = haversineKm(localCoords[u], localCoords[v]);
        if (rev) adj[v].push([u, wt]); else adj[u].push([v, wt]);
        if (bidir) adj[v].push([u, wt]);
      }
    }
    const best = longestPath(localCoords, adj);
    if (!best || best.len < 0.4) continue; // 断片は連結処理に回すので低めに拾う
    cands.push({ len: best.len, pts: best.path.map(i => localCoords[i]) });
  }
  // OSM上で途切れて成分が分かれるケース: 端点同士が300m以内の経路を連結する
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < cands.length; i++) {
      for (let j = 0; j < cands.length; j++) {
        if (i === j) continue;
        const a = cands[i], b = cands[j];
        const gap = haversineKm(a.pts[a.pts.length - 1], b.pts[0]);
        // 方向連続性: 接合点でUターンになる連結（=反対車線との誤連結）は拒否する
        const a2 = a.pts[a.pts.length - 2] ?? a.pts[a.pts.length - 1];
        const a1 = a.pts[a.pts.length - 1];
        const b1 = b.pts[0];
        const b2 = b.pts[1] ?? b.pts[0];
        const ax = a1.lng - a2.lng, ay = a1.lat - a2.lat;
        const bx = b2.lng - b1.lng, by = b2.lat - b1.lat;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        const cont = (la && lb) ? (ax * bx + ay * by) / (la * lb) : 1;
        if (gap < 0.3 && cont > 0) {
          cands[i] = { len: a.len + gap + b.len, pts: [...a.pts, ...b.pts] };
          cands.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  for (const cand of cands) {
    if (cand.len < MIN_LEN_KM) continue;
    const pts = simplify(cand.pts);
    result.push({
      name,
      lenKm: Math.round(cand.len * 100) / 100,
      path: pts.map(p => [Math.round(p.lng * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5]),
    });
    console.log(`✓ ${name} ${cand.len.toFixed(2)}km ${pts.length}点`);
  }
  await new Promise(r => setTimeout(r, 2000)); // Overpass礼儀
}

result.sort((a, b) => b.lenKm - a.lenKm);
const ts = `// 自動生成: tools/gen-tunnels.mjs（OSMデータ由来 © OpenStreetMap contributors, ODbL）
// GPS完全喪失級の既知長大トンネルの実ジオメトリ。gapBridge が決定論的に補間に使う。
// path は [lng, lat] の順（OSRM geometry 互換）。再生成: node tools/gen-tunnels.mjs
export interface TunnelGeom { name: string; lenKm: number; path: [number, number][] }
export const TUNNELS: TunnelGeom[] = ${JSON.stringify(result)};
`;
for (const dest of ['web/src/data', 'mobile/src/data']) {
  const dir = path.join(__dirname, '..', dest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tunnels.ts'), ts);
}
console.log(`\n合計 ${result.length} 本 / ${(ts.length / 1024).toFixed(1)}KB → web,mobile の src/data/tunnels.ts`);
