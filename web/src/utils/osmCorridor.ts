// OSMデータ直読みのコリドールーティング。
// 公開OSRM/Valhallaは首都高・アクアライン等の有料道路を経路に使わないため、
// 高速トンネル区間の修復が原理的に不可能だった。ここでは Overpass API から
// 2点間コリドーの motorway/motorway_link を直接取得し、oneway を尊重した
// Dijkstra で最短路を組み立てる（C2山手トンネル実測: 10.18km/比率1.19 ✓）。

interface LL { lat: number; lng: number }

function haversineKm(a: LL, b: LL): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// 最小バイナリヒープ（Dijkstra用）
class MinHeap {
  private d: number[] = [];
  private id: number[] = [];
  get size() { return this.d.length; }
  push(dist: number, node: number) {
    this.d.push(dist); this.id.push(node);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      [this.d[p], this.d[i]] = [this.d[i], this.d[p]];
      [this.id[p], this.id[i]] = [this.id[i], this.id[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.d[0], this.id[0]];
    const ld = this.d.pop()!, li = this.id.pop()!;
    if (this.d.length > 0) {
      this.d[0] = ld; this.id[0] = li;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.d.length && this.d[l] < this.d[m]) m = l;
        if (r < this.d.length && this.d[r] < this.d[m]) m = r;
        if (m === i) break;
        [this.d[m], this.d[i]] = [this.d[i], this.d[m]];
        [this.id[m], this.id[i]] = [this.id[i], this.id[m]];
        i = m;
      }
    }
    return top;
  }
}

// 2点間の高速コリドー経路を返す（[lng,lat][]、OSRMのgeometry互換）。失敗時 null。
export async function corridorRoute(p1: LL, p2: LL): Promise<[number, number][] | null> {
  const chord = haversineKm(p1, p2);
  if (chord < 0.5 || chord > 40) return null; // 対象外（短すぎ/広すぎはOverpass負荷も考え回避）

  const m = Math.max(0.02, chord * 0.0012); // コリドー余白（弦が長いほど広く）
  const s = Math.min(p1.lat, p2.lat) - m, n = Math.max(p1.lat, p2.lat) + m;
  const w = Math.min(p1.lng, p2.lng) - m, e = Math.max(p1.lng, p2.lng) + m;
  const q = `[out:json][timeout:25];way["highway"~"^(motorway|motorway_link)$"](${s},${w},${n},${e});(._;>;);out body;`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let data: any;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  // ノード・グラフ構築（ノードIDを連番に圧縮）
  const idMap = new Map<number, number>();
  const coords: LL[] = [];
  for (const el of data.elements as any[]) {
    if (el.type === 'node') {
      idMap.set(el.id, coords.length);
      coords.push({ lat: el.lat, lng: el.lon });
    }
  }
  if (coords.length < 10) return null;
  const adj: [number, number][][] = coords.map(() => []);
  for (const el of data.elements as any[]) {
    if (el.type !== 'way') continue;
    const oneway = (el.tags?.oneway as string) ?? 'yes'; // motorwayは既定one-way
    const rev = oneway === '-1';
    const bidir = oneway === 'no' || oneway === 'false' || oneway === '0';
    const nds: number[] = el.nodes;
    for (let i = 1; i < nds.length; i++) {
      const u = idMap.get(nds[i - 1]), v = idMap.get(nds[i]);
      if (u == null || v == null) continue;
      const wt = haversineKm(coords[u], coords[v]);
      if (rev) adj[v].push([u, wt]);
      else adj[u].push([v, wt]);
      if (bidir) adj[v].push([u, wt]);
    }
  }

  // 上下線の取り違えに備え、両端それぞれ近傍8ノードの全組合せで最短を採用
  const nearestK = (P: LL, k: number): number[] => {
    const arr = coords.map((c, i) => [haversineKm(c, P), i] as [number, number]);
    arr.sort((a, b) => a[0] - b[0]);
    return arr.slice(0, k).map(x => x[1]);
  };
  const starts = nearestK(p1, 8), goals = new Set(nearestK(p2, 8));

  let best: { total: number; path: number[] } | null = null;
  for (const s0 of starts) {
    const dist = new Float64Array(coords.length).fill(Infinity);
    const prev = new Int32Array(coords.length).fill(-1);
    dist[s0] = 0;
    const pq = new MinHeap();
    pq.push(0, s0);
    const remaining = new Set(goals);
    while (pq.size > 0 && remaining.size > 0) {
      const [dcur, u] = pq.pop();
      if (dcur > dist[u]) continue;
      remaining.delete(u);
      for (const [v, wt] of adj[u]) {
        const nd = dcur + wt;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pq.push(nd, v); }
      }
    }
    for (const g of goals) {
      if (!isFinite(dist[g])) continue;
      const total = dist[g] + haversineKm(coords[s0], p1) + haversineKm(coords[g], p2);
      if (!best || total < best.total) {
        const path: number[] = [g];
        while (path[path.length - 1] !== s0) {
          const p = prev[path[path.length - 1]];
          if (p < 0) break;
          path.push(p);
        }
        if (path[path.length - 1] === s0) {
          path.reverse();
          best = { total, path };
        }
      }
    }
  }
  if (!best || best.path.length < 2) return null;
  // 妥当性: 遠回りすぎる経路（弦の2倍超）は不採用
  if (best.total > chord * 2) return null;
  return best.path.map(i => [coords[i].lng, coords[i].lat] as [number, number]);
}
