import type { GraphData, LonLat } from "./graph";

export const COVERAGE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const COVERAGE_INDEX_SCHEMA_VERSION = 1 as const;

const SAFE_TOKEN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const MD5 = /^[a-f0-9]{32}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

export type CoverageAreaMetadata = {
  id: string;
  name: string;
  district: string;
  timezone: string;
  coverage: string;
  searchBias: string;
  center?: LonLat;
  bbox?: [number, number, number, number];
};

export type CoverageBundleDescriptor = {
  /** Relative to the manifest URL, or an absolute HTTPS URL. */
  url: string;
  /** Size of the decoded UTF-8 JSON file that will be stored on device. */
  bytes: number;
  /** Required publisher digest of the decoded UTF-8 JSON file. */
  sha256: string;
  /** Optional fast corruption check. SHA-256 remains authoritative. */
  md5?: string;
};

export type CoverageAreaManifest = CoverageAreaMetadata & {
  version: string;
  bundle: CoverageBundleDescriptor;
};

export type CoverageManifest = {
  schemaVersion: typeof COVERAGE_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  areas: CoverageAreaManifest[];
};

export type BundledCoverageArea = {
  area: CoverageAreaMetadata & { version: string };
  load: () => GraphData | Promise<GraphData>;
};

export type CoverageIntegrity = {
  bytes: number;
  sha256?: string | null;
  md5?: string | null;
};

export type CoverageErrorCode =
  | "cancelled"
  | "catalog-invalid"
  | "catalog-unavailable"
  | "download-failed"
  | "integrity-failed"
  | "invalid-bundle"
  | "not-available"
  | "not-installed"
  | "storage-failed"
  | "too-large";

export class CoverageError extends Error {
  constructor(
    public readonly code: CoverageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CoverageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoverageError("catalog-invalid", `${context}.${key} must be a non-empty string.`);
  }
  return value;
}

function stringFieldAllowEmpty(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new CoverageError("catalog-invalid", `${context}.${key} must be a string.`);
  }
  return value;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CoverageError("catalog-invalid", `${context} must be a finite number.`);
  }
  return value;
}

function optionalLonLat(value: unknown, context: string): LonLat | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new CoverageError("catalog-invalid", `${context} must be [longitude, latitude].`);
  }
  const lon = finiteNumber(value[0], `${context}[0]`);
  const lat = finiteNumber(value[1], `${context}[1]`);
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new CoverageError("catalog-invalid", `${context} is outside valid longitude/latitude bounds.`);
  }
  return [lon, lat];
}

function optionalBbox(value: unknown, context: string): [number, number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new CoverageError("catalog-invalid", `${context} must be [west, south, east, north].`);
  }
  const bbox = value.map((item, index) => finiteNumber(item, `${context}[${index}]`)) as [
    number,
    number,
    number,
    number,
  ];
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new CoverageError("catalog-invalid", `${context} has invalid geographic bounds.`);
  }
  return bbox;
}

function safeToken(value: string, context: string): string {
  if (!SAFE_TOKEN.test(value)) {
    throw new CoverageError(
      "catalog-invalid",
      `${context} must use 1–96 lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return value;
}

function digest(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new CoverageError("catalog-invalid", `${context} is not a valid hexadecimal digest.`);
  }
  return value.toLowerCase();
}

function parseAreaMetadata(record: Record<string, unknown>, context: string): CoverageAreaMetadata {
  return {
    id: safeToken(stringField(record, "id", context), `${context}.id`),
    name: stringField(record, "name", context),
    district: stringFieldAllowEmpty(record, "district", context),
    timezone: stringField(record, "timezone", context),
    coverage: stringField(record, "coverage", context),
    searchBias: stringField(record, "searchBias", context),
    center: optionalLonLat(record.center, `${context}.center`),
    bbox: optionalBbox(record.bbox, `${context}.bbox`),
  };
}

export function parseCoverageAreaManifest(value: unknown, context = "area"): CoverageAreaManifest {
  if (!isRecord(value)) {
    throw new CoverageError("catalog-invalid", `${context} must be an object.`);
  }

  // The publisher's wire format is intentionally flat. The nested form is the
  // normalized representation stored in the local install index.
  const bundle = isRecord(value.bundle)
    ? value.bundle
    : {
        url: value.bundleUrl,
        bytes: value.bytes,
        sha256: value.sha256,
        md5: value.md5,
      };

  const bytes = finiteNumber(bundle.bytes, `${context}.bundle.bytes`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new CoverageError("catalog-invalid", `${context}.bundle.bytes must be a positive integer.`);
  }

  return {
    ...parseAreaMetadata(value, context),
    version: safeToken(stringField(value, "version", context), `${context}.version`),
    bundle: {
      url: stringField(bundle, "url", `${context}.bundle`),
      bytes,
      sha256: digest(bundle.sha256, SHA256, `${context}.bundle.sha256`),
      md5:
        bundle.md5 === undefined
          ? undefined
          : digest(bundle.md5, MD5, `${context}.bundle.md5`),
    },
  };
}

export function parseCoverageManifest(value: unknown): CoverageManifest {
  if (!isRecord(value)) {
    throw new CoverageError("catalog-invalid", "Coverage manifest must be an object.");
  }
  if (value.schemaVersion !== COVERAGE_MANIFEST_SCHEMA_VERSION) {
    throw new CoverageError(
      "catalog-invalid",
      `Unsupported coverage manifest schema: ${String(value.schemaVersion)}.`,
    );
  }
  const generatedAt = stringField(value, "generatedAt", "manifest");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new CoverageError("catalog-invalid", "manifest.generatedAt must be an ISO date-time.");
  }
  if (!Array.isArray(value.areas)) {
    throw new CoverageError("catalog-invalid", "manifest.areas must be an array.");
  }

  const ids = new Set<string>();
  const areas = value.areas.map((area, index) => {
    const parsed = parseCoverageAreaManifest(area, `manifest.areas[${index}]`);
    if (ids.has(parsed.id)) {
      throw new CoverageError("catalog-invalid", `Duplicate coverage area id: ${parsed.id}.`);
    }
    ids.add(parsed.id);
    return parsed;
  });

  return { schemaVersion: COVERAGE_MANIFEST_SCHEMA_VERSION, generatedAt, areas };
}

export function resolveCoverageBundleUrl(
  manifestUrl: string,
  bundleUrl: string,
  allowInsecureHttp = false,
): string {
  let resolved: URL;
  try {
    resolved = new URL(bundleUrl, manifestUrl);
  } catch (error) {
    throw new CoverageError("catalog-invalid", `Invalid coverage bundle URL: ${bundleUrl}.`, { cause: error });
  }

  const localHost =
    resolved.hostname === "localhost" ||
    resolved.hostname === "127.0.0.1" ||
    resolved.hostname === "[::1]" ||
    resolved.hostname === "10.0.2.2";
  if (resolved.protocol !== "https:" && !(resolved.protocol === "http:" && (allowInsecureHttp || localHost))) {
    throw new CoverageError("catalog-invalid", "Coverage bundles must use HTTPS (localhost HTTP is allowed)." );
  }
  if (resolved.username !== "" || resolved.password !== "") {
    throw new CoverageError("catalog-invalid", "Coverage bundle URLs cannot contain credentials.");
  }
  if (resolved.hash !== "") {
    throw new CoverageError("catalog-invalid", "Coverage bundle URLs cannot contain fragments.");
  }
  return resolved.toString();
}

export function coverageCacheFileName(areaId: string, version: string): string {
  return `area--${safeToken(areaId, "areaId")}--${safeToken(version, "version")}.json`;
}

export function coverageTempFileName(areaId: string, version: string): string {
  return `${coverageCacheFileName(areaId, version)}.part`;
}

export function parseCoverageCacheFileName(fileName: string): { areaId: string; version: string } | null {
  const match = /^area--([a-z0-9][a-z0-9._-]{0,95})--([a-z0-9][a-z0-9._-]{0,95})\.json$/.exec(fileName);
  return match ? { areaId: match[1], version: match[2] } : null;
}

export function integrityMismatches(expected: CoverageBundleDescriptor, actual: CoverageIntegrity): string[] {
  const mismatches: string[] = [];
  if (actual.bytes !== expected.bytes) {
    mismatches.push(`size ${actual.bytes} B does not match ${expected.bytes} B`);
  }
  if (!actual.sha256 || actual.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    mismatches.push("SHA-256 digest does not match");
  }
  if (expected.md5 && (!actual.md5 || actual.md5.toLowerCase() !== expected.md5.toLowerCase())) {
    mismatches.push("MD5 digest does not match");
  }
  return mismatches;
}

export function assertCoverageIntegrity(expected: CoverageBundleDescriptor, actual: CoverageIntegrity): void {
  const mismatches = integrityMismatches(expected, actual);
  if (mismatches.length > 0) {
    throw new CoverageError("integrity-failed", `Coverage download failed integrity checks: ${mismatches.join("; ")}.`);
  }
}

function graphError(message: string): never {
  throw new CoverageError("invalid-bundle", `Invalid coverage graph: ${message}`);
}

function graphLonLat(value: unknown, context: string): LonLat {
  if (!Array.isArray(value) || value.length !== 2) graphError(`${context} must be [longitude, latitude].`);
  const lon = value[0];
  const lat = value[1];
  if (
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    graphError(`${context} contains invalid coordinates.`);
  }
  return [lon, lat];
}

/**
 * Parse and structurally validate routing data before it enters the graph code.
 * Digest verification establishes authenticity; these checks protect the UI from
 * a correctly delivered but malformed publisher artifact.
 */
export function parseCoverageGraphJson(text: string): GraphData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CoverageError("invalid-bundle", "Coverage bundle is not valid JSON.", { cause: error });
  }
  return validateCoverageGraph(value);
}

export function validateCoverageGraph(value: unknown): GraphData {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    graphError("root must contain meta, nodes, and edges.");
  }
  const meta = value.meta;
  if (typeof meta.city !== "string" || meta.city === "") graphError("meta.city is required.");
  if (!Array.isArray(meta.bbox) || meta.bbox.length !== 4 || !meta.bbox.every((item) => typeof item === "number" && Number.isFinite(item))) {
    graphError("meta.bbox must contain four finite numbers.");
  }
  if (!Array.isArray(meta.hours) || meta.hours.length === 0 || !meta.hours.every((hour) => Number.isInteger(hour))) {
    graphError("meta.hours must contain integer hours.");
  }
  if (!Array.isArray(meta.dates) || meta.dates.length === 0 || !meta.dates.every((date) => typeof date === "string" && date !== "")) {
    graphError("meta.dates must contain date keys.");
  }
  if (typeof meta.tz_offset_hours !== "number" || !Number.isFinite(meta.tz_offset_hours)) {
    graphError("meta.tz_offset_hours must be finite.");
  }
  if (!isRecord(meta.sun)) graphError("meta.sun must be an object.");

  const nodes = value.nodes.map((node, index) => graphLonLat(node, `nodes[${index}]`));
  if (nodes.length === 0) graphError("nodes cannot be empty.");

  for (const date of meta.dates as string[]) {
    const samples = meta.sun[date];
    if (!Array.isArray(samples) || samples.length !== (meta.hours as unknown[]).length) {
      graphError(`meta.sun[${date}] must align with meta.hours.`);
    }
    samples.forEach((sample, index) => {
      if (!Array.isArray(sample) || sample.length !== 3 || !sample.every((item) => typeof item === "number" && Number.isFinite(item))) {
        graphError(`meta.sun[${date}][${index}] must contain [hour, azimuth, elevation].`);
      }
    });
  }

  value.edges.forEach((edge, edgeIndex) => {
    if (!isRecord(edge)) graphError(`edges[${edgeIndex}] must be an object.`);
    if (!Number.isInteger(edge.u) || !Number.isInteger(edge.v)) graphError(`edges[${edgeIndex}] has invalid endpoints.`);
    const u = edge.u as number;
    const v = edge.v as number;
    if (u < 0 || v < 0 || u >= nodes.length || v >= nodes.length) graphError(`edges[${edgeIndex}] references a missing node.`);
    if (typeof edge.len !== "number" || !Number.isFinite(edge.len) || edge.len < 0) graphError(`edges[${edgeIndex}].len must be non-negative.`);
    if (!Array.isArray(edge.pts) || edge.pts.length < 2) graphError(`edges[${edgeIndex}].pts must have at least two points.`);
    edge.pts.forEach((point, pointIndex) => graphLonLat(point, `edges[${edgeIndex}].pts[${pointIndex}]`));
    if (!isRecord(edge.exp)) graphError(`edges[${edgeIndex}].exp must be an object.`);
    for (const date of meta.dates as string[]) {
      const exposure = edge.exp[date];
      if (!Array.isArray(exposure) || exposure.length !== (meta.hours as unknown[]).length) {
        graphError(`edges[${edgeIndex}].exp[${date}] must align with meta.hours.`);
      }
      if (!exposure.every((item) => typeof item === "number" && Number.isFinite(item) && item >= -1 && item <= 100)) {
        graphError(`edges[${edgeIndex}].exp[${date}] must contain -1 for unknown or percentages from 0 to 100.`);
      }
    }
  });

  return value as unknown as GraphData;
}
