export type LonLat = [number, number];

export interface GraphEdge {
  u: number;
  v: number;
  len: number; // meters
  pts: LonLat[];
  exp: Record<string, number[]>; // date -> per-hour exposure; -1 unknown, otherwise 0..100
}

export interface GraphData {
  meta: {
    city: string;
    city_name?: string;
    timezone?: string;
    center?: [number, number];
    bbox: [number, number, number, number]; // w s e n
    hours: number[];
    dates: string[];
    tz_offset_hours: number;
    utc_offsets_hours?: Record<string, number[]>;
    solar_year?: number;
    mesh_m?: number;
    view_height_m?: number;
    requested_view_height_m?: number;
    view_height_voxels?: number;
    view_height_quantization?: string;
    min_sun_elevation_deg?: number;
    sun_model?: {
      direct_sun_only?: boolean;
      minimum_modeled_elevation_deg?: number;
      sample_states?: Record<string, string[]>;
    };
    model_quality?: {
      confidence?: string;
      field_validated?: boolean;
      sources?: Record<string, string>;
      limitations?: string[];
    };
    graph?: {
      edge_count?: number;
      exposure_sample_count?: number;
      unknown_edge_count?: number;
      unknown_edge_sample_count?: number;
      unknown_edge_sample_fraction?: number;
      unknown_exposure_sentinel?: number;
      unknown_exposure_fallback_pct?: number;
      osm_enclosed_edge_count?: number;
    };
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

/** Legacy 100%-fallback packs must be updated before they can seek sun safely. */
export function supportsSunPreference(data: GraphData): boolean {
  const quality = data.meta.graph;
  const hasUnknownSamples = (quality?.unknown_edge_sample_count ?? 0) > 0;
  return !hasUnknownSamples || quality?.unknown_exposure_sentinel === -1;
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

export type EdgeExposureSample = { fraction: number; known: boolean };

/** Unknown samples stay conservative in metrics but are never sought as sun. */
export function edgeExposureSample(e: GraphEdge, date: string, hourIdx: number): EdgeExposureSample {
  const arr = e.exp[date];
  const raw = arr?.[hourIdx];
  if (raw === undefined || raw < 0) return { fraction: 1, known: false };
  return { fraction: raw / 100, known: true };
}

/** Exposure fraction 0..1 for display/metrics; unknown remains conservative. */
export function edgeExposure(e: GraphEdge, date: string, hourIdx: number): number {
  return edgeExposureSample(e, date, hourIdx).fraction;
}

const MAX_LIGHT_PENALTY = 15;

/**
 * Signed route preference: -1 seeks more sun, 0 is shortest, +1 seeks shade.
 * The unwanted condition is always added as a non-negative penalty, keeping
 * every edge safe for Dijkstra. Intermediate stops scale to strengths 3 and 15.
 */
export function preferenceEdgeCost(
  lengthM: number,
  exposure: number,
  preference: number,
  known = true,
): number {
  const normalizedPreference = Number.isFinite(preference)
    ? Math.max(-1, Math.min(1, preference))
    : 0;
  const normalizedExposure = Number.isFinite(exposure)
    ? Math.max(0, Math.min(1, exposure))
    : 1;
  const strength = Math.pow(MAX_LIGHT_PENALTY + 1, Math.abs(normalizedPreference)) - 1;
  const unwanted = known
    ? normalizedPreference < 0
      ? 1 - normalizedExposure
      : normalizedExposure
    : 1;
  return Math.max(0, lengthM) * (1 + strength * unwanted);
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
  sunMin: number; // direct-sun-equivalent minutes
  /** Per-edge polyline coords oriented along travel direction. */
  unknownMin: number;
  segments: { coords: LonLat[]; exposure: number; known: boolean }[];
}

export const WALK_SPEED_MS = 1.4;

export function shortestRoute(
  g: Graph,
  start: number,
  end: number,
  date: string,
  hourIdx: number,
  lightPreference: number, // -1 = most sun; 0 = fastest; +1 = most shade
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
      const sample = edgeExposureSample(e, date, hourIdx);
      const cost = preferenceEdgeCost(e.len, sample.fraction, lightPreference, sample.known);
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
  let unknownMin = 0;
  const segments: Route["segments"] = [];
  for (let i = 0; i < edgePath.length; i++) {
    const e = g.data.edges[edgePath[i]];
    const fromNode = nodePath[i];
    const sample = edgeExposureSample(e, date, hourIdx);
    const exp = sample.fraction;
    distM += e.len;
    const edgeWalkMin = (e.len / WALK_SPEED_MS) / 60;
    sunMin += edgeWalkMin * exp;
    if (!sample.known) unknownMin += edgeWalkMin;
    // orient geometry along travel direction
    let coords = e.pts;
    const [fx, fy] = g.data.nodes[fromNode];
    const d0 = Math.abs(coords[0][0] - fx) + Math.abs(coords[0][1] - fy);
    const dN = Math.abs(coords[coords.length - 1][0] - fx) + Math.abs(coords[coords.length - 1][1] - fy);
    if (dN < d0) coords = [...coords].reverse();
    segments.push({ coords, exposure: exp, known: sample.known });
  }

  return {
    nodePath,
    edgePath,
    distM,
    walkMin: distM / WALK_SPEED_MS / 60,
    sunMin,
    unknownMin,
    segments,
  };
}

/**
 * Find the strongest requested light preference that stays within a practical
 * walking budget. The preference cost is monotonic in strength, so a short
 * binary search keeps the best supported route under both a relative and an
 * absolute detour cap.
 */
export function boundedPreferenceRoute(
  g: Graph,
  start: number,
  end: number,
  date: string,
  hourIdx: number,
  lightPreference: number,
  fastest: Route,
  maxDetourRatio = 1.5,
  maxExtraDistanceM = 1_200,
): Route {
  const normalizedPreference = Number.isFinite(lightPreference)
    ? Math.max(-1, Math.min(1, lightPreference))
    : 0;
  if (normalizedPreference === 0) return fastest;

  const ratio = Number.isFinite(maxDetourRatio) ? Math.max(1, maxDetourRatio) : 1;
  const extra = Number.isFinite(maxExtraDistanceM) ? Math.max(0, maxExtraDistanceM) : 0;
  const distanceBudget = Math.min(fastest.distM * ratio, fastest.distM + extra);
  const requested = shortestRoute(g, start, end, date, hourIdx, normalizedPreference);
  if (!requested || requested.distM <= distanceBudget + 1e-6) return requested ?? fastest;

  const direction = Math.sign(normalizedPreference);
  let lowerStrength = 0;
  let upperStrength = Math.abs(normalizedPreference);
  let best = fastest;
  for (let iteration = 0; iteration < 10; iteration++) {
    const strength = (lowerStrength + upperStrength) / 2;
    const candidate = shortestRoute(g, start, end, date, hourIdx, direction * strength);
    if (candidate && candidate.distM <= distanceBudget + 1e-6) {
      best = candidate;
      lowerStrength = strength;
    } else {
      upperStrength = strength;
    }
  }
  return best;
}

/**
 * Pick the bundled date with the closest solar declination. This correctly
 * maps the September equinox to the March equinox model instead of a solstice.
 */
export function seasonDate(dates: string[], now: Date): string {
  const declination = (month: number, day: number) => {
    const date = new Date(Date.UTC(2025, month - 1, day));
    const start = new Date(Date.UTC(2025, 0, 0));
    const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
    return 23.44 * Math.sin((2 * Math.PI * (dayOfYear - 81)) / 365);
  };
  const target = declination(now.getMonth() + 1, now.getDate());
  let best = dates[0];
  let bestD = Infinity;
  for (const ds of dates) {
    const [m, d] = ds.split("-").map(Number);
    const diff = Math.abs(declination(m, d) - target);
    if (diff < bestD) {
      bestD = diff;
      best = ds;
    }
  }
  return best;
}

export function dateInTimezone(now: Date, timezone?: string): Date {
  if (!timezone) return now;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(value("year"), value("month") - 1, value("day"), value("hour"));
}

export function solarElevation(data: GraphData, date: string, hour: number): number | null {
  const sample = data.meta.sun[date]?.find(([sampleHour]) => sampleHour === hour);
  return sample?.[2] ?? null;
}
