/** Unit tests for the host-agnostic coverage catalog/cache client. Run: npx tsx scripts/test-coverage.ts */
import { createHash } from "node:crypto";

import {
  CoverageClient,
  CoverageDownloadOperation,
  CoverageFileInfo,
  CoverageFileStore,
} from "../src/coverage-client";
import {
  BundledCoverageArea,
  CoverageAreaManifest,
  CoverageError,
  CoverageManifest,
  coverageCacheFileName,
  integrityMismatches,
  parseCoverageCacheFileName,
  parseCoverageGraphJson,
  parseCoverageManifest,
  resolveCoverageBundleUrl,
} from "../src/coverage-model";
import {
  coverageOperationArea,
  coverageProgressPresentation,
  normalizeCoverageProgress,
} from "../src/coverage-progress";
import type { CoverageAreaState } from "../src/coverage-client";

const ok = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const progressArea = (
  id: string,
  phase: CoverageAreaState["phase"],
  fraction: number | null = null,
): CoverageAreaState => ({
  area: {
    id,
    name: id,
    district: "",
    timezone: "UTC",
    coverage: "Test area",
    searchBias: id,
    version: "v1",
  },
  phase,
  usable: false,
  downloadBytes: 1_000,
  progress: phase === "downloading" || phase === "verifying"
    ? {
        bytesWritten: fraction === null ? 0 : fraction * 1_000,
        totalBytes: 1_000,
        fraction,
      }
    : undefined,
  canDownload: phase === "available",
});

const downloadPresentation = coverageProgressPresentation(
  "fetching",
  progressArea("target", "downloading", 0.42),
);
ok(
  downloadPresentation?.indicator === "determinate" && downloadPresentation.fraction === 0.42,
  "coverage presentation exposes real determinate download progress",
);
const fallbackProgress = normalizeCoverageProgress(
  { bytesWritten: 420, totalBytes: null, fraction: null },
  1_000,
);
ok(
  fallbackProgress.totalBytes === 1_000 && fallbackProgress.fraction === 0.42,
  "manifest bytes preserve progress when transport total is unknown",
);
const clampedProgress = normalizeCoverageProgress(
  { bytesWritten: 2_000, totalBytes: 1_000, fraction: Number.NaN },
  1_000,
);
ok(
  clampedProgress.bytesWritten === 1_000 && clampedProgress.fraction === 1,
  "coverage progress clamps invalid and oversized values",
);
ok(
  coverageProgressPresentation("checking", undefined)?.indicator === "indeterminate" &&
    coverageProgressPresentation("requesting", undefined)?.indicator === "indeterminate",
  "checking and requesting use honest indeterminate progress",
);
ok(
  coverageProgressPresentation("fetching", progressArea("target", "verifying"))?.stage === "verifying",
  "verification replaces download percentage with a preparation stage",
);
ok(
  coverageProgressPresentation("fetching", progressArea("target", "ready"))?.stage === "opening",
  "a completed fetch never flashes back to zero percent before opening",
);
const previewState = progressArea("preview", "available");
const targetState = progressArea("target", "downloading", 0.5);
ok(
  coverageOperationArea([previewState, targetState], "target", previewState)?.area.id === "target",
  "progress stays attached to the fetched area instead of the map preview",
);

const graphText = (exposure: number, city = "test") =>
  JSON.stringify({
    meta: {
      city,
      bbox: [0, 0, 0.001, 0.001],
      hours: [12],
      dates: ["06-21"],
      tz_offset_hours: 0,
      sun: { "06-21": [[12, 180, 60]] },
    },
    nodes: [
      [0, 0],
      [0.001, 0],
    ],
    edges: [
      {
        u: 0,
        v: 1,
        len: 100,
        pts: [
          [0, 0],
          [0.001, 0],
        ],
        exp: { "06-21": [exposure] },
      },
    ],
  });

const area = (id: string, version: string, url: string, text: string): CoverageAreaManifest => ({
  id,
  name: id === "singapore-cbd" ? "Singapore" : "New York",
  district: id === "singapore-cbd" ? "CBD" : "Midtown Manhattan",
  timezone: id === "singapore-cbd" ? "Asia/Singapore" : "America/New_York",
  coverage: "Evaluation area",
  searchBias: id === "singapore-cbd" ? "Singapore" : "New York",
  version,
  bundle: {
    url,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
    md5: md5(text),
  },
});

const manifest = (...areas: CoverageAreaManifest[]): CoverageManifest => ({
  schemaVersion: 1,
  generatedAt: "2026-07-10T10:00:00.000Z",
  areas,
});

class MemoryStore implements CoverageFileStore {
  readonly files = new Map<string, string>();
  readonly remote = new Map<string, string>();
  pauseNextDownload = false;
  downloadStarted?: () => void;
  private releasePaused?: () => void;

  async ensureReady() {}

  async info(fileName: string, options?: { md5?: boolean }): Promise<CoverageFileInfo> {
    const text = this.files.get(fileName);
    return text === undefined
      ? { exists: false, bytes: 0, md5: null }
      : {
          exists: true,
          bytes: Buffer.byteLength(text, "utf8"),
          md5: options?.md5 ? md5(text) : undefined,
        };
  }

  async readText(fileName: string): Promise<string> {
    const text = this.files.get(fileName);
    if (text === undefined) throw new Error(`Missing memory file: ${fileName}`);
    return text;
  }

  async writeText(fileName: string, text: string) {
    this.files.set(fileName, text);
  }

  async delete(fileName: string) {
    this.files.delete(fileName);
  }

  async move(fromFileName: string, toFileName: string) {
    const text = this.files.get(fromFileName);
    if (text === undefined) throw new Error(`Missing move source: ${fromFileName}`);
    this.files.set(toFileName, text);
    this.files.delete(fromFileName);
  }

  async list() {
    return [...this.files.keys()];
  }

  createDownload(
    url: string,
    fileName: string,
    onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void,
  ): CoverageDownloadOperation {
    let cancelled = false;
    return {
      start: async () => {
        const text = this.remote.get(url);
        if (text === undefined) throw new Error(`Missing remote fixture: ${url}`);
        const bytes = Buffer.byteLength(text, "utf8");
        onProgress({ bytesWritten: Math.floor(bytes / 2), totalBytes: bytes });
        this.downloadStarted?.();
        if (this.pauseNextDownload) {
          this.pauseNextDownload = false;
          await new Promise<void>((resolve) => {
            this.releasePaused = resolve;
          });
        }
        if (cancelled) throw new CoverageError("cancelled", "cancelled in fake transport");
        this.files.set(fileName, text);
        onProgress({ bytesWritten: bytes, totalBytes: bytes });
        return { md5: md5(text) };
      },
      cancel: () => {
        cancelled = true;
        this.releasePaused?.();
        this.releasePaused = undefined;
      },
    };
  }
}

async function expectCoverageError(promise: Promise<unknown>, code: CoverageError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    ok(error instanceof CoverageError && error.code === code, `throws CoverageError(${code})`);
    return;
  }
  throw new Error(`FAIL: expected CoverageError(${code})`);
}

async function main() {
  const v1Text = graphText(20, "new-york-midtown");
  ok(
    parseCoverageGraphJson(graphText(-1)).edges[0].exp["06-21"][0] === -1,
    "graph parser preserves the explicit unknown-exposure sentinel",
  );
  try {
    parseCoverageGraphJson(graphText(-2));
    throw new Error("FAIL: graph parser accepted an invalid negative exposure");
  } catch (error) {
    ok(error instanceof CoverageError && error.code === "invalid-bundle", "graph parser rejects exposure below the sentinel");
  }
  const v1Area = area("new-york-midtown", "2026-07-10-a", "bundles/new-york-a.json", v1Text);
  const parsed = parseCoverageManifest(manifest(v1Area));
  ok(parsed.areas[0].bundle.sha256 === sha256(v1Text), "strict manifest parser keeps SHA-256");
  const publisherWireManifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-10T10:00:00Z",
    areas: [
      {
        ...v1Area,
        bundle: undefined,
        bundleUrl: v1Area.bundle.url,
        bytes: v1Area.bundle.bytes,
        sha256: v1Area.bundle.sha256,
        md5: v1Area.bundle.md5,
      },
    ],
  };
  ok(
    parseCoverageManifest(publisherWireManifest).areas[0].bundle.url === v1Area.bundle.url,
    "publisher flat wire schema normalizes to the client bundle model",
  );
  ok(
    resolveCoverageBundleUrl("https://cdn.example/coverage/manifest.json", v1Area.bundle.url) ===
      "https://cdn.example/coverage/bundles/new-york-a.json",
    "bundle URLs resolve relative to the manifest host",
  );
  ok(
    resolveCoverageBundleUrl("http://127.0.0.1:8791/manifest.json", "bundles/test.json").startsWith(
      "http://127.0.0.1:8791/",
    ),
    "localhost HTTP remains available for emulator testing",
  );
  try {
    resolveCoverageBundleUrl("http://untrusted.example/manifest.json", "bundle.json");
    throw new Error("FAIL: insecure production HTTP was accepted");
  } catch (error) {
    ok(error instanceof CoverageError && error.code === "catalog-invalid", "non-local bundle hosts require HTTPS");
  }
  ok(
    parseCoverageCacheFileName(coverageCacheFileName(v1Area.id, v1Area.version))?.version === v1Area.version,
    "versioned cache filenames round-trip",
  );
  ok(
    integrityMismatches(v1Area.bundle, {
      bytes: v1Area.bundle.bytes,
      sha256: v1Area.bundle.sha256,
      md5: v1Area.bundle.md5,
    }).length === 0,
    "size, SHA-256, and MD5 integrity checks agree",
  );
  const missingSha = JSON.parse(JSON.stringify(manifest(v1Area)));
  delete missingSha.areas[0].bundle.sha256;
  try {
    parseCoverageManifest(missingSha);
    throw new Error("FAIL: manifest without SHA-256 was accepted");
  } catch (error) {
    ok(error instanceof CoverageError && error.code === "catalog-invalid", "manifest requires SHA-256");
  }

  const store = new MemoryStore();
  const manifestUrl = "https://cdn.example/coverage/manifest.json";
  const sydneyText = graphText(45, "sydney-cbd");
  const sydneyArea = area("sydney-cbd", "2026-07-10-a", "bundles/sydney-a.json", sydneyText);
  let remoteManifest = manifest(
    area("singapore-cbd", "remote-2", "bundles/singapore.json", graphText(10, "singapore-cbd")),
    v1Area,
    sydneyArea,
  );
  const fetcher = async () => ({ ok: true, status: 200, json: async () => remoteManifest });
  const bundledGraph = parseCoverageGraphJson(graphText(35, "singapore-cbd"));
  const bundled: BundledCoverageArea[] = [
    {
      area: {
        id: "singapore-cbd",
        name: "Singapore",
        district: "CBD",
        timezone: "Asia/Singapore",
        coverage: "Offline starter area",
        searchBias: "Singapore",
        version: "bundled-1",
      },
      load: () => bundledGraph,
    },
  ];
  const makeClient = (customFetch = fetcher) =>
    new CoverageClient({
      manifestUrl,
      fileStore: store,
      fetch: customFetch,
      bundled,
      sha256Text: async (text) => sha256(text),
    });

  const coalescingStore = new MemoryStore();
  let releaseManifest!: () => void;
  let manifestFetches = 0;
  const manifestGate = new Promise<void>((resolve) => {
    releaseManifest = resolve;
  });
  const coalescingClient = new CoverageClient({
    manifestUrl,
    fileStore: coalescingStore,
    bundled,
    sha256Text: async (text) => sha256(text),
    fetch: async () => {
      manifestFetches += 1;
      await manifestGate;
      return { ok: true, status: 200, json: async () => remoteManifest };
    },
  });
  await coalescingClient.initialize();
  const firstRefresh = coalescingClient.refreshManifest();
  const secondRefresh = coalescingClient.refreshManifest();
  ok(firstRefresh === secondRefresh, "concurrent manifest refreshes share one promise");
  releaseManifest();
  await Promise.all([firstRefresh, secondRefresh]);
  ok(manifestFetches === 1, "concurrent manifest refreshes make one request");

  const client = makeClient();
  await client.initialize();
  ok(client.getSnapshot().areas[0].phase === "ready", "bundled fallback is ready before network access");
  await client.refreshManifest();
  ok(
    client.getSnapshot().areas.find((item) => item.area.id === "singapore-cbd")?.phase === "update-available",
    "remote catalog advertises an update without hiding bundled coverage",
  );
  ok((await client.load("singapore-cbd")).source === "bundled", "bundled fallback loads while offline pack is absent");

  const v1Url = resolveCoverageBundleUrl(manifestUrl, v1Area.bundle.url);
  const sydneyUrl = resolveCoverageBundleUrl(manifestUrl, sydneyArea.bundle.url);
  store.remote.set(v1Url, v1Text);
  store.remote.set(sydneyUrl, sydneyText);
  let observedProgress = false;
  let observedVerifying = false;
  const unsubscribe = client.subscribe((snapshot) => {
    const state = snapshot.areas.find((item) => item.area.id === v1Area.id);
    if (state?.progress?.fraction && state.progress.fraction > 0) observedProgress = true;
    if (state?.phase === "verifying") observedVerifying = true;
  });
  const [downloaded, concurrentDownload] = await Promise.all([
    client.download(v1Area.id),
    client.download(sydneyArea.id),
  ]);
  unsubscribe();
  ok(downloaded.source === "downloaded" && downloaded.version === v1Area.version, "area downloads and loads");
  ok(observedProgress, "download progress is observable");
  ok(observedVerifying, "verification is exposed as a distinct UI phase");
  ok(concurrentDownload.version === sydneyArea.version, "different areas can download concurrently");
  ok(store.files.has(coverageCacheFileName(v1Area.id, v1Area.version)), "verified bundle is promoted atomically");
  ok(![...store.files.keys()].some((name) => name.endsWith(".part")), "temporary files are cleaned up");

  const restarted = makeClient(async () => {
    throw new Error("offline");
  });
  await restarted.initialize();
  const restored = await restarted.load(v1Area.id);
  ok(restored.version === v1Area.version, "persistent index restores a verified download after restart");
  ok(
    (await restarted.load(sydneyArea.id)).version === sydneyArea.version,
    "serialized index writes retain concurrent downloads",
  );

  const v2Text = graphText(12, "new-york-midtown");
  const v2Area = area("new-york-midtown", "2026-07-10-b", "bundles/new-york-b.json", v2Text);
  remoteManifest = manifest(remoteManifest.areas[0], v2Area, remoteManifest.areas[2]);
  await client.refreshManifest();
  ok(
    client.getSnapshot().areas.find((item) => item.area.id === v2Area.id)?.phase === "update-available",
    "a new manifest leaves the old verified version usable",
  );

  const v2Url = resolveCoverageBundleUrl(manifestUrl, v2Area.bundle.url);
  store.remote.set(v2Url, graphText(13, "new-york-midtown")); // Same shape/size, deliberately wrong SHA-256 and MD5.
  await expectCoverageError(client.download(v2Area.id), "integrity-failed");
  ok((await client.load(v2Area.id)).version === v1Area.version, "failed update preserves the previous version");
  ok(
    client.getSnapshot().areas.find((item) => item.area.id === v2Area.id)?.usable === true,
    "integrity error is retryable without making the area unusable",
  );

  store.remote.set(v2Url, v2Text);
  const retried = await client.retry(v2Area.id);
  ok(retried.version === v2Area.version, "retry installs a valid replacement");
  ok(!store.files.has(coverageCacheFileName(v1Area.id, v1Area.version)), "successful update removes stale versions");

  const singaporeArea = remoteManifest.areas[0];
  const singaporeUrl = resolveCoverageBundleUrl(manifestUrl, singaporeArea.bundle.url);
  store.remote.set(singaporeUrl, graphText(10, "singapore-cbd"));
  store.pauseNextDownload = true;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  store.downloadStarted = markStarted;
  const pending = client.download("singapore-cbd");
  await started;
  client.cancel("singapore-cbd");
  await expectCoverageError(pending, "cancelled");
  store.downloadStarted = undefined;
  ok((await client.load("singapore-cbd")).source === "bundled", "cancel keeps the bundled fallback usable");
  ok(
    client.getSnapshot().areas.find((item) => item.area.id === "singapore-cbd")?.error === undefined,
    "cancel is not presented as a download error",
  );

  console.log("\nALL COVERAGE CLIENT TESTS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
