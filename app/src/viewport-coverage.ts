import type { CoverageAreaState } from "./coverage-client";

export type CoverageBbox = [west: number, south: number, east: number, north: number];

export type MapRegionLike = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export type MapBoundariesLike = {
  northEast: { latitude: number; longitude: number };
  southWest: { latitude: number; longitude: number };
};

export type CoverageViewport = {
  bbox: CoverageBbox;
  center: [longitude: number, latitude: number];
  widthMeters: number;
  heightMeters: number;
};

export type CoverageViewportMatch =
  | { kind: "match"; state: CoverageAreaState; overlap: number }
  | { kind: "zoom-in" }
  | { kind: "none" };

export type CoverageRequestReceipt = {
  requestId: string;
  status: "queued" | "acquiring" | "modeling" | "packaging" | "ready";
  statusUrl?: string;
  areaId?: string;
  retryAfterSeconds?: number;
};

export class CoverageViewportError extends Error {
  constructor(
    public readonly code:
      | "invalid-viewport"
      | "unsupported-viewport"
      | "invalid-endpoint"
      | "request-failed"
      | "invalid-response",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoverageViewportError";
  }
}

const EPSILON = 1e-10;
// Tall phone aspect ratios can expose substantially more latitude than the
// requested Region while the selected pack still fills most of the map width.
const MIN_MATCH_OVERLAP = 0.25;
const EARTH_METERS_PER_DEGREE = 111_320;
const REQUEST_STATUSES = new Set(["queued", "acquiring", "modeling", "packaging", "ready"]);

function finite(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new CoverageViewportError("invalid-viewport", `${context} must be finite.`);
  }
  return value;
}

function viewportFromBbox(bbox: CoverageBbox): CoverageViewport {
  const [west, south, east, north] = bbox;
  bbox.forEach((value, index) => finite(value, `bbox[${index}]`));
  if (
    west < -180 ||
    east > 180 ||
    south < -85 ||
    north > 85 ||
    west >= east ||
    south >= north
  ) {
    throw new CoverageViewportError(
      "unsupported-viewport",
      "Choose a smaller area away from the poles or date line.",
    );
  }

  const latitude = (south + north) / 2;
  const longitude = (west + east) / 2;
  const heightMeters = (north - south) * EARTH_METERS_PER_DEGREE;
  const widthMeters =
    (east - west) * EARTH_METERS_PER_DEGREE * Math.max(0, Math.cos((latitude * Math.PI) / 180));
  return {
    bbox,
    center: [longitude, latitude],
    widthMeters,
    heightMeters,
  };
}

export function viewportFromRegion(region: MapRegionLike): CoverageViewport {
  const latitude = finite(region.latitude, "region.latitude");
  const longitude = finite(region.longitude, "region.longitude");
  const latitudeDelta = finite(region.latitudeDelta, "region.latitudeDelta");
  const longitudeDelta = finite(region.longitudeDelta, "region.longitudeDelta");
  if (latitudeDelta <= 0 || longitudeDelta <= 0) {
    throw new CoverageViewportError("invalid-viewport", "The map view must have a positive size.");
  }
  return viewportFromBbox([
    longitude - longitudeDelta / 2,
    latitude - latitudeDelta / 2,
    longitude + longitudeDelta / 2,
    latitude + latitudeDelta / 2,
  ]);
}

export function viewportFromBoundaries(boundaries: MapBoundariesLike): CoverageViewport {
  return viewportFromBbox([
    boundaries.southWest.longitude,
    boundaries.southWest.latitude,
    boundaries.northEast.longitude,
    boundaries.northEast.latitude,
  ]);
}

function containsPoint(bbox: CoverageBbox, point: [number, number]): boolean {
  return (
    point[0] >= bbox[0] - EPSILON &&
    point[0] <= bbox[2] + EPSILON &&
    point[1] >= bbox[1] - EPSILON &&
    point[1] <= bbox[3] + EPSILON
  );
}

function containsBbox(container: CoverageBbox, inner: CoverageBbox): boolean {
  return (
    inner[0] >= container[0] - EPSILON &&
    inner[1] >= container[1] - EPSILON &&
    inner[2] <= container[2] + EPSILON &&
    inner[3] <= container[3] + EPSILON
  );
}

function bboxArea(bbox: CoverageBbox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function overlapRatio(area: CoverageBbox, viewport: CoverageBbox): number {
  const west = Math.max(area[0], viewport[0]);
  const south = Math.max(area[1], viewport[1]);
  const east = Math.min(area[2], viewport[2]);
  const north = Math.min(area[3], viewport[3]);
  const intersection = Math.max(0, east - west) * Math.max(0, north - south);
  const viewportArea = bboxArea(viewport);
  return viewportArea <= 0 ? 0 : intersection / viewportArea;
}

/**
 * Finds the most relevant published pack under the fixed map target. A padded
 * viewport may extend slightly outside a pack, but a world-sized view must not
 * accidentally select a tiny tile merely because its center happens to align.
 */
export function matchCoverageViewport(
  states: readonly CoverageAreaState[],
  viewport: CoverageViewport,
): CoverageViewportMatch {
  const candidates = states
    .filter(
      (state): state is CoverageAreaState & { area: { bbox: CoverageBbox } } =>
        Boolean(state.area.bbox && containsPoint(state.area.bbox, viewport.center)),
    )
    .map((state) => ({
      state,
      full: containsBbox(state.area.bbox, viewport.bbox),
      overlap: overlapRatio(state.area.bbox, viewport.bbox),
      areaSize: bboxArea(state.area.bbox),
    }));

  if (candidates.length === 0) return { kind: "none" };

  const eligible = candidates.filter((candidate) => candidate.full || candidate.overlap >= MIN_MATCH_OVERLAP);
  if (eligible.length === 0) return { kind: "zoom-in" };

  eligible.sort((a, b) => {
    if (a.full !== b.full) return a.full ? -1 : 1;
    if (Math.abs(a.overlap - b.overlap) > EPSILON) return b.overlap - a.overlap;
    if (Math.abs(a.areaSize - b.areaSize) > EPSILON) return a.areaSize - b.areaSize;
    if (a.state.usable !== b.state.usable) return a.state.usable ? -1 : 1;
    return a.state.area.id.localeCompare(b.state.area.id);
  });

  return { kind: "match", state: eligible[0].state, overlap: eligible[0].overlap };
}

export function coverageRequestKey(
  viewport: CoverageViewport,
  profile = "vamp-walk-shade-v1",
): string {
  const normalized = viewport.bbox.map((value) => value.toFixed(5)).join(",");
  return `v1:${profile}:${normalized}`;
}

function requestEndpoint(url: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new CoverageViewportError("invalid-endpoint", "Coverage requests are not configured correctly.", {
      cause: error,
    });
  }
  const localHost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "10.0.2.2";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (allowInsecureHttp || localHost))) {
    throw new CoverageViewportError("invalid-endpoint", "Coverage requests must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new CoverageViewportError("invalid-endpoint", "Coverage request URL is not allowed.");
  }
  return parsed.toString();
}

type RequestResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type CoverageRequestFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<RequestResponse>;

function parseReceipt(value: unknown): CoverageRequestReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoverageViewportError("invalid-response", "The coverage service returned an invalid response.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || record.requestId.trim() === "") {
    throw new CoverageViewportError("invalid-response", "The coverage service did not return a request ID.");
  }
  if (typeof record.status !== "string" || !REQUEST_STATUSES.has(record.status)) {
    throw new CoverageViewportError("invalid-response", "The coverage service returned an unknown status.");
  }
  if (record.statusUrl !== undefined && typeof record.statusUrl !== "string") {
    throw new CoverageViewportError("invalid-response", "The coverage service returned an invalid status URL.");
  }
  if (record.areaId !== undefined && typeof record.areaId !== "string") {
    throw new CoverageViewportError("invalid-response", "The coverage service returned an invalid area ID.");
  }
  if (record.status === "ready" && (typeof record.areaId !== "string" || record.areaId.trim() === "")) {
    throw new CoverageViewportError("invalid-response", "A ready coverage response must include an area ID.");
  }
  if (
    record.retryAfterSeconds !== undefined &&
    (typeof record.retryAfterSeconds !== "number" ||
      !Number.isFinite(record.retryAfterSeconds) ||
      record.retryAfterSeconds < 0)
  ) {
    throw new CoverageViewportError("invalid-response", "The coverage service returned an invalid retry time.");
  }
  return record as CoverageRequestReceipt;
}

export async function requestCoverageViewport({
  endpoint,
  viewport,
  signal,
  fetcher = globalThis.fetch as CoverageRequestFetch,
  allowInsecureHttp = false,
}: {
  endpoint: string;
  viewport: CoverageViewport;
  signal?: AbortSignal;
  fetcher?: CoverageRequestFetch;
  allowInsecureHttp?: boolean;
}): Promise<CoverageRequestReceipt> {
  if (typeof fetcher !== "function") {
    throw new CoverageViewportError("request-failed", "This device cannot submit coverage requests.");
  }
  const profile = "vamp-walk-shade-v1";
  const response = await fetcher(requestEndpoint(endpoint, allowInsecureHttp), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": coverageRequestKey(viewport, profile),
    },
    body: JSON.stringify({
      schemaVersion: 1,
      bbox: viewport.bbox,
      center: viewport.center,
      widthMeters: Math.round(viewport.widthMeters),
      heightMeters: Math.round(viewport.heightMeters),
      modelProfile: profile,
    }),
    signal,
  });

  if (!response.ok) {
    const message =
      response.status === 422
        ? "This view can’t be generated. Try a smaller nearby area."
        : response.status === 429
          ? "Area requests are busy. Try again in a little while."
          : "Couldn’t request this area. Try again later.";
    throw new CoverageViewportError("request-failed", message);
  }
  return parseReceipt(await response.json());
}
