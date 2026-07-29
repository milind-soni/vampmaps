import type { GraphData } from "./graph";
import {
  COVERAGE_INDEX_SCHEMA_VERSION,
  CoverageError,
  assertCoverageIntegrity,
  coverageCacheFileName,
  coverageTempFileName,
  parseCoverageAreaManifest,
  parseCoverageCacheFileName,
  parseCoverageGraphJson,
  parseCoverageManifest,
  resolveCoverageBundleUrl,
  validateCoverageGraph,
} from "./coverage-model";
import type {
  BundledCoverageArea,
  CoverageAreaManifest,
  CoverageAreaMetadata,
  CoverageManifest,
} from "./coverage-model";

const MANIFEST_CACHE_FILE = "catalog.json";
const INDEX_FILE = "installed.json";
const DEFAULT_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export type CoverageDownloadProgress = {
  bytesWritten: number;
  totalBytes: number | null;
  fraction: number | null;
};

export type CoverageDownloadResult = {
  md5?: string | null;
};

export interface CoverageDownloadOperation {
  start(): Promise<CoverageDownloadResult>;
  cancel(): void | Promise<void>;
}

export type CoverageFileInfo = {
  exists: boolean;
  bytes: number;
  md5?: string | null;
};

/**
 * Small storage seam used by CoverageClient. The Expo implementation lives in
 * coverage-expo.ts; tests can use an in-memory adapter without loading native modules.
 */
export interface CoverageFileStore {
  ensureReady(): Promise<void>;
  info(fileName: string, options?: { md5?: boolean }): Promise<CoverageFileInfo>;
  readText(fileName: string): Promise<string>;
  writeText(fileName: string, text: string): Promise<void>;
  delete(fileName: string): Promise<void>;
  move(fromFileName: string, toFileName: string): Promise<void>;
  list(): Promise<string[]>;
  createDownload(
    url: string,
    fileName: string,
    onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void,
  ): CoverageDownloadOperation;
}

export type CoverageFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type CoverageFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<CoverageFetchResponse>;

type InstalledCoverageRecord = {
  area: CoverageAreaManifest;
  fileName: string;
  installedAt: string;
};

type InstalledCoverageIndex = {
  schemaVersion: typeof COVERAGE_INDEX_SCHEMA_VERSION;
  records: InstalledCoverageRecord[];
};

type ActiveDownload = {
  operation: CoverageDownloadOperation;
  progress: CoverageDownloadProgress;
  stage: "downloading" | "verifying";
};

export type CoverageAreaPhase =
  | "available"
  | "downloading"
  | "error"
  | "ready"
  | "update-available"
  | "verifying";
export type CoverageSource = "bundled" | "downloaded";

export type CoverageAreaState = {
  area: CoverageAreaMetadata;
  phase: CoverageAreaPhase;
  usable: boolean;
  source?: CoverageSource;
  installedVersion?: string;
  availableVersion?: string;
  downloadBytes?: number;
  progress?: CoverageDownloadProgress;
  error?: string;
  canDownload: boolean;
};

export type CoverageSnapshot = {
  initialized: boolean;
  refreshing: boolean;
  manifestGeneratedAt?: string;
  manifestError?: string;
  areas: CoverageAreaState[];
};

export type CoverageLoadResult = {
  area: CoverageAreaMetadata;
  data: GraphData;
  source: CoverageSource;
  version: string;
};

export type CoverageClientOptions = {
  manifestUrl: string;
  fileStore: CoverageFileStore;
  /** SHA-256 of the exact UTF-8 string. expo-crypto supplies this in coverage-expo.ts. */
  sha256Text: (text: string) => Promise<string>;
  fetch?: CoverageFetch;
  bundled?: readonly BundledCoverageArea[];
  maxBundleBytes?: number;
  allowInsecureHttp?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstalledIndex(value: unknown): InstalledCoverageIndex {
  if (!isRecord(value) || value.schemaVersion !== COVERAGE_INDEX_SCHEMA_VERSION || !Array.isArray(value.records)) {
    throw new CoverageError("storage-failed", "Installed coverage index is invalid.");
  }
  const ids = new Set<string>();
  const records = value.records.map((rawRecord, index): InstalledCoverageRecord => {
    if (!isRecord(rawRecord)) {
      throw new CoverageError("storage-failed", `Installed coverage record ${index} is invalid.`);
    }
    const area = parseCoverageAreaManifest(rawRecord.area, `installed.records[${index}].area`);
    if (ids.has(area.id)) {
      throw new CoverageError("storage-failed", `Installed coverage index repeats ${area.id}.`);
    }
    ids.add(area.id);
    const expectedFileName = coverageCacheFileName(area.id, area.version);
    if (rawRecord.fileName !== expectedFileName) {
      throw new CoverageError("storage-failed", `Installed coverage filename for ${area.id} is invalid.`);
    }
    if (typeof rawRecord.installedAt !== "string" || !Number.isFinite(Date.parse(rawRecord.installedAt))) {
      throw new CoverageError("storage-failed", `Installed date for ${area.id} is invalid.`);
    }
    return { area, fileName: expectedFileName, installedAt: rawRecord.installedAt };
  });
  return { schemaVersion: COVERAGE_INDEX_SCHEMA_VERSION, records };
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Couldn’t download this area. Check your connection and try again.";
}

function cancelledError(error: unknown): boolean {
  return (
    (error instanceof CoverageError && error.code === "cancelled") ||
    (error instanceof Error && (error.name === "AbortError" || /cancel/i.test(error.message)))
  );
}

function invalidCachedFile(error: unknown): boolean {
  return (
    error instanceof CoverageError &&
    (error.code === "integrity-failed" || error.code === "invalid-bundle")
  );
}

function progressState(bytesWritten: number, totalBytes: number): CoverageDownloadProgress {
  const knownTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
  return {
    bytesWritten: Math.max(0, bytesWritten),
    totalBytes: knownTotal,
    fraction: knownTotal === null ? null : Math.max(0, Math.min(1, bytesWritten / knownTotal)),
  };
}

export class CoverageClient {
  private readonly manifestUrl: string;
  private readonly store: CoverageFileStore;
  private readonly sha256Text: (text: string) => Promise<string>;
  private readonly fetcher: CoverageFetch;
  private readonly bundled = new Map<string, BundledCoverageArea>();
  private readonly maxBundleBytes: number;
  private readonly allowInsecureHttp: boolean;
  private readonly listeners = new Set<(snapshot: CoverageSnapshot) => void>();
  private readonly installed = new Map<string, InstalledCoverageRecord>();
  private readonly active = new Map<string, ActiveDownload>();
  private readonly errors = new Map<string, string>();
  private readonly downloadPromises = new Map<string, Promise<CoverageLoadResult>>();
  private readonly cancelRequested = new Set<string>();
  private readonly atomicWriteQueues = new Map<string, Promise<void>>();
  private manifest?: CoverageManifest;
  private manifestError?: string;
  private initialized = false;
  private refreshing = false;
  private initialization?: Promise<void>;
  private refreshPromise?: Promise<CoverageManifest>;

  constructor(options: CoverageClientOptions) {
    this.manifestUrl = resolveCoverageBundleUrl(
      options.manifestUrl,
      options.manifestUrl,
      options.allowInsecureHttp,
    );
    this.store = options.fileStore;
    this.sha256Text = options.sha256Text;
    this.fetcher = options.fetch ?? (globalThis.fetch as CoverageFetch);
    if (typeof this.fetcher !== "function") {
      throw new CoverageError("catalog-unavailable", "This runtime does not provide fetch().");
    }
    this.maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
    if (!Number.isSafeInteger(this.maxBundleBytes) || this.maxBundleBytes <= 0) {
      throw new CoverageError("too-large", "maxBundleBytes must be a positive integer.");
    }
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    for (const fallback of options.bundled ?? []) {
      if (this.bundled.has(fallback.area.id)) {
        throw new CoverageError("catalog-invalid", `Duplicate bundled coverage area: ${fallback.area.id}.`);
      }
      // Reuse the same path-token rules applied to remote catalog entries.
      coverageCacheFileName(fallback.area.id, fallback.area.version);
      this.bundled.set(fallback.area.id, fallback);
    }
  }

  subscribe(listener: (snapshot: CoverageSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CoverageSnapshot {
    const remoteById = new Map(this.manifest?.areas.map((area) => [area.id, area]) ?? []);
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of [
      ...(this.manifest?.areas.map((area) => area.id) ?? []),
      ...this.installed.keys(),
      ...this.bundled.keys(),
    ]) {
      if (!seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }

    const areas = orderedIds.map((id): CoverageAreaState => {
      const remote = remoteById.get(id);
      const downloaded = this.installed.get(id);
      const fallback = this.bundled.get(id);
      const active = this.active.get(id);
      const error = this.errors.get(id);
      const current = downloaded
        ? { source: "downloaded" as const, version: downloaded.area.version, area: downloaded.area }
        : fallback
          ? { source: "bundled" as const, version: fallback.area.version, area: fallback.area }
          : undefined;
      const updateAvailable = Boolean(remote && current && remote.version !== current.version);
      const phase: CoverageAreaPhase = active
        ? active.stage
        : error
          ? "error"
          : updateAvailable
            ? "update-available"
            : current
              ? "ready"
              : "available";
      return {
        area: remote ?? current!.area,
        phase,
        usable: Boolean(current),
        source: current?.source,
        installedVersion: current?.version,
        availableVersion: remote?.version,
        downloadBytes: remote?.bundle.bytes,
        progress: active?.progress,
        error,
        canDownload: Boolean(remote && !active && (!current || remote.version !== current.version || error)),
      };
    });

    return {
      initialized: this.initialized,
      refreshing: this.refreshing,
      manifestGeneratedAt: this.manifest?.generatedAt,
      manifestError: this.manifestError,
      areas,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce();
    try {
      await this.initialization;
    } finally {
      this.initialization = undefined;
    }
  }

  private async initializeOnce(): Promise<void> {
    try {
      await this.store.ensureReady();
      await this.restoreManifest();
      await this.restoreInstalled();
      await this.cleanupOrphans();
      this.initialized = true;
      this.emit();
    } catch (error) {
      throw error instanceof CoverageError
        ? error
        : new CoverageError("storage-failed", "Couldn’t open downloaded coverage.", { cause: error });
    }
  }

  refreshManifest(signal?: AbortSignal): Promise<CoverageManifest> {
    if (this.refreshPromise) return this.refreshPromise;
    let promise!: Promise<CoverageManifest>;
    promise = (async () => {
      try {
        return await this.refreshManifestOnce(signal);
      } finally {
        if (this.refreshPromise === promise) this.refreshPromise = undefined;
      }
    })();
    this.refreshPromise = promise;
    return promise;
  }

  private async refreshManifestOnce(signal?: AbortSignal): Promise<CoverageManifest> {
    await this.initialize();
    this.refreshing = true;
    this.manifestError = undefined;
    this.emit();
    try {
      const response = await this.fetcher(this.manifestUrl, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new CoverageError("catalog-unavailable", `Coverage catalog returned HTTP ${response.status}.`);
      }
      const manifest = parseCoverageManifest(await response.json());
      await this.atomicWrite(MANIFEST_CACHE_FILE, JSON.stringify(manifest));
      this.manifest = manifest;
      this.manifestError = undefined;
      return manifest;
    } catch (error) {
      const wrapped =
        error instanceof CoverageError
          ? error
          : new CoverageError("catalog-unavailable", "Couldn’t refresh available areas.", { cause: error });
      this.manifestError = wrapped.message;
      throw wrapped;
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }

  download(areaId: string): Promise<CoverageLoadResult> {
    const existing = this.downloadPromises.get(areaId);
    if (existing) return existing;
    const promise = this.performDownload(areaId).finally(() => {
      this.downloadPromises.delete(areaId);
      this.cancelRequested.delete(areaId);
    });
    this.downloadPromises.set(areaId, promise);
    return promise;
  }

  retry(areaId: string): Promise<CoverageLoadResult> {
    this.errors.delete(areaId);
    this.emit();
    return this.download(areaId);
  }

  cancel(areaId: string): void {
    if (!this.downloadPromises.has(areaId)) return;
    this.cancelRequested.add(areaId);
    const operation = this.active.get(areaId)?.operation;
    if (operation) {
      Promise.resolve(operation.cancel()).catch(() => undefined);
    }
  }

  async load(areaId: string): Promise<CoverageLoadResult> {
    await this.initialize();
    const record = this.installed.get(areaId);
    if (record) {
      try {
        const data = await this.readAndVerify(record.fileName, record.area);
        return { area: record.area, data, source: "downloaded", version: record.area.version };
      } catch (error) {
        if (!invalidCachedFile(error)) {
          throw error instanceof CoverageError
            ? error
            : new CoverageError("storage-failed", "Couldn’t read downloaded coverage.", { cause: error });
        }
        await this.discardInstalled(record);
      }
    }

    const fallback = this.bundled.get(areaId);
    if (fallback) {
      const data = validateCoverageGraph(await fallback.load());
      return { area: fallback.area, data, source: "bundled", version: fallback.area.version };
    }
    if (this.manifest?.areas.some((area) => area.id === areaId)) {
      throw new CoverageError("not-installed", "Download this area before using it.");
    }
    throw new CoverageError("not-available", "This area is not in the coverage catalog.");
  }

  async removeDownloadedArea(areaId: string): Promise<void> {
    await this.initialize();
    const record = this.installed.get(areaId);
    if (!record) return;
    await this.discardInstalled(record);
    this.errors.delete(areaId);
    this.emit();
  }

  private async performDownload(areaId: string): Promise<CoverageLoadResult> {
    await this.initialize();
    const area = this.manifest?.areas.find((candidate) => candidate.id === areaId);
    if (!area) throw new CoverageError("not-available", "This area is not available to download.");
    if (area.bundle.bytes > this.maxBundleBytes) {
      throw new CoverageError(
        "too-large",
        `This area is larger than the ${Math.round(this.maxBundleBytes / 1024 / 1024)} MB mobile limit.`,
      );
    }
    const existing = this.installed.get(areaId);
    if (existing?.area.version === area.version) return this.load(areaId);
    const fallback = this.bundled.get(areaId);
    if (!existing && fallback?.area.version === area.version) return this.load(areaId);
    if (this.cancelRequested.has(areaId)) throw new CoverageError("cancelled", "Area download cancelled.");

    const fileName = coverageCacheFileName(area.id, area.version);
    const tempFileName = coverageTempFileName(area.id, area.version);
    const url = resolveCoverageBundleUrl(this.manifestUrl, area.bundle.url, this.allowInsecureHttp);
    await this.store.delete(tempFileName);
    let operation!: CoverageDownloadOperation;
    operation = this.store.createDownload(url, tempFileName, ({ bytesWritten, totalBytes }) => {
      const active = this.active.get(areaId);
      if (!active || active.operation !== operation) return;
      const expectedBytes = Number.isFinite(totalBytes) && totalBytes > 0
        ? totalBytes
        : area.bundle.bytes;
      const previous = active.progress;
      const next = progressState(bytesWritten, expectedBytes);
      active.progress = next;
      const previousPercent = previous.fraction === null ? null : Math.round(previous.fraction * 100);
      const nextPercent = next.fraction === null ? null : Math.round(next.fraction * 100);
      // Native callbacks can fire far more often than the displayed percentage
      // changes. Keep exact bytes internally, but avoid rerendering the map for
      // invisible sub-percent updates.
      if (previous.totalBytes !== next.totalBytes || previousPercent !== nextPercent) {
        this.emit();
      }
    });
    this.active.set(areaId, {
      operation,
      progress: progressState(0, area.bundle.bytes),
      stage: "downloading",
    });
    this.errors.delete(areaId);
    this.emit();

    try {
      const result = await operation.start();
      if (this.cancelRequested.has(areaId)) throw new CoverageError("cancelled", "Area download cancelled.");
      const active = this.active.get(areaId);
      if (active) {
        active.stage = "verifying";
        this.emit();
      }
      const data = await this.readAndVerify(tempFileName, area, result.md5);
      if (this.cancelRequested.has(areaId)) throw new CoverageError("cancelled", "Area download cancelled.");
      await this.store.move(tempFileName, fileName);

      const previous = this.installed.get(areaId);
      const record: InstalledCoverageRecord = {
        area,
        fileName,
        installedAt: new Date().toISOString(),
      };
      this.installed.set(areaId, record);
      try {
        await this.persistIndex();
      } catch (error) {
        if (previous) this.installed.set(areaId, previous);
        else this.installed.delete(areaId);
        await this.store.delete(fileName).catch(() => undefined);
        throw error;
      }
      if (previous && previous.fileName !== fileName) {
        await this.store.delete(previous.fileName).catch(() => undefined);
      }
      this.active.delete(areaId);
      this.errors.delete(areaId);
      this.emit();
      return { area, data, source: "downloaded", version: area.version };
    } catch (error) {
      await this.store.delete(tempFileName).catch(() => undefined);
      this.active.delete(areaId);
      if (this.cancelRequested.has(areaId) || cancelledError(error)) {
        this.errors.delete(areaId);
        this.emit();
        throw new CoverageError("cancelled", "Area download cancelled.", { cause: error });
      }
      const wrapped =
        error instanceof CoverageError
          ? error
          : new CoverageError("download-failed", "Couldn’t download this area. Check your connection and try again.", {
              cause: error,
            });
      this.errors.set(areaId, messageFor(wrapped));
      this.emit();
      throw wrapped;
    }
  }

  private async readAndVerify(
    fileName: string,
    area: CoverageAreaManifest,
    downloadedMd5?: string | null,
  ): Promise<GraphData> {
    const info = await this.store.info(fileName, { md5: Boolean(area.bundle.md5 && !downloadedMd5) });
    if (!info.exists) {
      throw new CoverageError("integrity-failed", "Downloaded coverage file is missing.");
    }
    const text = await this.store.readText(fileName);
    const sha256 = (await this.sha256Text(text)).toLowerCase();
    assertCoverageIntegrity(area.bundle, {
      bytes: info.bytes,
      sha256,
      md5: downloadedMd5 ?? info.md5,
    });
    const data = parseCoverageGraphJson(text);
    if (data.meta.city !== area.id) {
      throw new CoverageError(
        "invalid-bundle",
        `Coverage bundle identifies ${data.meta.city}, expected ${area.id}.`,
      );
    }
    if (
      area.bbox &&
      area.bbox.some((value, index) => Math.abs(value - data.meta.bbox[index]) > 1e-9)
    ) {
      throw new CoverageError("invalid-bundle", "Coverage bundle bounds do not match the catalog.");
    }
    return data;
  }

  private async restoreManifest(): Promise<void> {
    const info = await this.store.info(MANIFEST_CACHE_FILE);
    if (!info.exists) return;
    try {
      this.manifest = parseCoverageManifest(JSON.parse(await this.store.readText(MANIFEST_CACHE_FILE)));
    } catch {
      await this.store.delete(MANIFEST_CACHE_FILE).catch(() => undefined);
    }
  }

  private async restoreInstalled(): Promise<void> {
    const info = await this.store.info(INDEX_FILE);
    if (!info.exists) return;
    let index: InstalledCoverageIndex;
    try {
      index = parseInstalledIndex(JSON.parse(await this.store.readText(INDEX_FILE)));
    } catch {
      await this.store.delete(INDEX_FILE).catch(() => undefined);
      return;
    }

    let changed = false;
    for (const record of index.records) {
      try {
        const file = await this.store.info(record.fileName, { md5: Boolean(record.area.bundle.md5) });
        if (
          !file.exists ||
          file.bytes !== record.area.bundle.bytes ||
          (record.area.bundle.md5 && file.md5?.toLowerCase() !== record.area.bundle.md5)
        ) {
          throw new CoverageError("integrity-failed", "Cached coverage metadata does not match its index.");
        }
        this.installed.set(record.area.id, record);
      } catch (error) {
        if (!invalidCachedFile(error)) throw error;
        changed = true;
        await this.store.delete(record.fileName).catch(() => undefined);
      }
    }
    if (changed) await this.persistIndex();
  }

  private async discardInstalled(record: InstalledCoverageRecord): Promise<void> {
    this.installed.delete(record.area.id);
    await this.persistIndex();
    await this.store.delete(record.fileName).catch(() => undefined);
    this.emit();
  }

  private async persistIndex(): Promise<void> {
    const index: InstalledCoverageIndex = {
      schemaVersion: COVERAGE_INDEX_SCHEMA_VERSION,
      records: [...this.installed.values()],
    };
    await this.atomicWrite(INDEX_FILE, JSON.stringify(index));
  }

  private async atomicWrite(fileName: string, text: string): Promise<void> {
    const previous = this.atomicWriteQueues.get(fileName) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.atomicWriteNow(fileName, text));
    this.atomicWriteQueues.set(fileName, write);
    try {
      await write;
    } finally {
      if (this.atomicWriteQueues.get(fileName) === write) this.atomicWriteQueues.delete(fileName);
    }
  }

  private async atomicWriteNow(fileName: string, text: string): Promise<void> {
    const tempFileName = `${fileName}.part`;
    await this.store.delete(tempFileName);
    try {
      await this.store.writeText(tempFileName, text);
      await this.store.move(tempFileName, fileName);
    } finally {
      await this.store.delete(tempFileName).catch(() => undefined);
    }
  }

  private async cleanupOrphans(): Promise<void> {
    const referenced = new Set([...this.installed.values()].map((record) => record.fileName));
    for (const fileName of await this.store.list()) {
      if (fileName.endsWith(".part")) {
        await this.store.delete(fileName).catch(() => undefined);
        continue;
      }
      if (parseCoverageCacheFileName(fileName) && !referenced.has(fileName)) {
        await this.store.delete(fileName).catch(() => undefined);
      }
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A rendering listener must not break cache state transitions.
      }
    }
  }
}
