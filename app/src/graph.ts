export type LonLat = [number, number];

export interface GraphEdge {
  u: number;
  v: number;
  len: number; // meters
  pts: LonLat[];
  exp: Record<string, number[]>; // date -> per-hour exposure 0..100
}

export interface GraphData {
  meta: {
    city: string;
    bbox: [number, number, number, number]; // w s e n
    hours: number[];
    dates: string[];
    tz_offset_hours: number;
    sun: Record<string, [number, number, number][]>; // [hour, az, el]
  };
  nodes: LonLat[];
  edges: GraphEdge[];
}

interface AdjEntry {
  to: number;
  edge: number;
}

export interface Graph {
  data: GraphData;
  adj: AdjEntry[][];
}

export function buildGraph(data: GraphData): Graph {
  const adj: AdjEntry[][] = data.nodes.map(() => []);
  data.edges.forEach((e, i) => {
    adj[e.u].push({ to: e.v, edge: i });
    adj[e.v].push({ to: e.u, edge: i });
  });
  return { data, adj };
}

export function nearestNode(g: Graph, lat: number, lon: number): { node: number; distM: number } {
  let best = -1;
  let bestD = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < g.data.nodes.length; i++) {
    const [nlon, nlat] = g.data.nodes[i];
    const dx = (nlon - lon) * cosLat;
    const dy = nlat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { node: best, distM: Math.sqrt(bestD) * 111_320 };
}

/** Exposure fraction 0..1 for an edge at a given date key + hour index. */
export function edgeExposure(e: GraphEdge, date: string, hourIdx: number): number {
  const arr = e.exp[date];
  if (!arr || arr[hourIdx] === undefined) return 1;
  return arr[hourIdx] / 100;
}

// Minimal binary min-heap of [cost, node]
class Heap {
  a: [number, number][] = [];
  push(x: [number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface Route {
  nodePath: number[];
  edgePath: number[];
  distM: number;
  walkMin: number;
  sunMin: number; // minutes spent in direct sun
  /** Per-edge polyline coords oriented along travel direction. */
  segments: { coords: LonLat[]; exposure: number }[];
}

export const WALK_SPEED_MS = 1.4;

export function shortestRoute(
  g: Graph,
  start: number,
  end: number,
  date: string,
  hourIdx: number,
  sunWeight: number, // 0 = fastest; >0 = shade preference strength
): Route | null {
  const n = g.data.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  dist[start] = 0;
  const heap = new Heap();
  heap.push([0, start]);

  while (true) {
    const top = heap.pop();
    if (!top) break;
    const [d, u] = top;
    if (u === end) break;
    if (d > dist[u]) continue;
    for (const { to, edge } of g.adj[u]) {
      const e = g.data.edges[edge];
      const exp = edgeExposure(e, date, hourIdx);
      const cost = e.len * (1 + sunWeight * exp);
      const nd = d + cost;
      if (nd < dist[to]) {
        dist[to] = nd;
        prevNode[to] = u;
        prevEdge[to] = edge;
        heap.push([nd, to]);
      }
    }
  }

  if (dist[end] === Infinity) return null;

  const nodePath: number[] = [];
  const edgePath: number[] = [];
  for (let cur = end; cur !== -1; cur = prevNode[cur]) {
    nodePath.push(cur);
    if (prevEdge[cur] !== -1) edgePath.push(prevEdge[cur]);
  }
  nodePath.reverse();
  edgePath.reverse();

  let distM = 0;
  let sunMin = 0;
  const segments: Route["segments"] = [];
  for (let i = 0; i < edgePath.length; i++) {
    const e = g.data.edges[edgePath[i]];
    const fromNode = nodePath[i];
    const exp = edgeExposure(e, date, hourIdx);
    distM += e.len;
    sunMin += ((e.len / WALK_SPEED_MS) / 60) * exp;
    // orient geometry along travel direction
    let coords = e.pts;
    const [fx, fy] = g.data.nodes[fromNode];
    const d0 = Math.abs(coords[0][0] - fx) + Math.abs(coords[0][1] - fy);
    const dN = Math.abs(coords[coords.length - 1][0] - fx) + Math.abs(coords[coords.length - 1][1] - fy);
    if (dN < d0) coords = [...coords].reverse();
    segments.push({ coords, exposure: exp });
  }

  return {
    nodePath,
    edgePath,
    distM,
    walkMin: distM / WALK_SPEED_MS / 60,
    sunMin,
    segments,
  };
}

/** Pick the bundled date key closest to the current month. */
export function seasonDate(dates: string[], now: Date): string {
  const doy = (m: number, d: number) => m * 30.5 + d;
  const nowDoy = doy(now.getMonth() + 1, now.getDate());
  let best = dates[0];
  let bestD = Infinity;
  for (const ds of dates) {
    const [m, d] = ds.split("-").map(Number);
    let diff = Math.abs(doy(m, d) - nowDoy);
    diff = Math.min(diff, 366 - diff);
    if (diff < bestD) {
      bestD = diff;
      best = ds;
    }
  }
  return best;
}
