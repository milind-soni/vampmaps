/** Unit tests for viewport matching and async coverage requests. */
import type { CoverageAreaState } from "../src/coverage-client";
import {
  CoverageViewportError,
  coverageRequestKey,
  matchCoverageViewport,
  requestCoverageViewport,
  viewportFromBoundaries,
  viewportFromRegion,
} from "../src/viewport-coverage";

const ok = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const state = (
  id: string,
  bbox: [number, number, number, number] | undefined,
  usable = false,
): CoverageAreaState => ({
  area: {
    id,
    name: id,
    district: "",
    timezone: "UTC",
    coverage: "Test area",
    searchBias: id,
    bbox,
  },
  phase: usable ? "ready" : "available",
  usable,
  canDownload: !usable,
});

async function expectError(promise: Promise<unknown>, code: CoverageViewportError["code"]) {
  try {
    await promise;
  } catch (error) {
    ok(error instanceof CoverageViewportError && error.code === code, `throws ${code}`);
    return;
  }
  throw new Error(`FAIL: expected ${code}`);
}

async function main() {
  const viewport = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.85,
    latitudeDelta: 0.012,
    longitudeDelta: 0.018,
  });
  ok(viewport.bbox[0] === 103.841 && viewport.bbox[3] === 1.306, "region converts to a bbox");
  ok(viewport.widthMeters > viewport.heightMeters, "viewport dimensions account for both axes");

  const bounded = viewportFromBoundaries({
    southWest: { latitude: 1, longitude: 2 },
    northEast: { latitude: 3, longitude: 4 },
  });
  ok(bounded.center[0] === 3 && bounded.center[1] === 2, "native map boundaries convert to a center");

  const pack: [number, number, number, number] = [103.84, 1.29, 103.86, 1.31];
  const padded = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.85,
    latitudeDelta: 0.024,
    longitudeDelta: 0.024,
  });
  ok(
    matchCoverageViewport([state("pack", pack)], padded).kind === "match",
    "the app's 1.2x padded pack view still matches",
  );
  const tallPhone = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.85,
    latitudeDelta: 0.05,
    longitudeDelta: 0.024,
  });
  ok(
    matchCoverageViewport([state("pack", pack)], tallPhone).kind === "match",
    "a centered tile still matches on a tall phone viewport",
  );

  const huge = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.85,
    latitudeDelta: 0.2,
    longitudeDelta: 0.2,
  });
  ok(matchCoverageViewport([state("pack", pack)], huge).kind === "zoom-in", "a huge view does not select a tiny tile");

  const fringe = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.875,
    latitudeDelta: 0.02,
    longitudeDelta: 0.04,
  });
  ok(matchCoverageViewport([state("pack", pack)], fringe).kind === "none", "edge overlap without the center does not match");
  ok(matchCoverageViewport([state("missing", undefined)], viewport).kind === "none", "areas without bounds are ignored");

  const nested = state("nested", [103.845, 1.295, 103.855, 1.305]);
  const broad = state("broad", pack, true);
  const smallView = viewportFromRegion({
    latitude: 1.3,
    longitude: 103.85,
    latitudeDelta: 0.004,
    longitudeDelta: 0.004,
  });
  const nestedMatch = matchCoverageViewport([broad, nested], smallView);
  ok(nestedMatch.kind === "match" && nestedMatch.state.area.id === "nested", "the most specific containing pack wins");
  const reverseMatch = matchCoverageViewport([nested, broad], smallView);
  ok(reverseMatch.kind === "match" && reverseMatch.state.area.id === "nested", "matching is independent of catalog order");

  try {
    viewportFromRegion({ latitude: 0, longitude: 179.9, latitudeDelta: 1, longitudeDelta: 1 });
    throw new Error("FAIL: date-line viewport was accepted");
  } catch (error) {
    ok(error instanceof CoverageViewportError && error.code === "unsupported-viewport", "date-line views are rejected clearly");
  }

  const sent: { url?: string; init?: { headers: Record<string, string>; body: string } } = {};
  const receipt = await requestCoverageViewport({
    endpoint: "https://coverage.example/v1/coverage-requests",
    viewport,
    fetcher: async (url, init) => {
      sent.url = url;
      sent.init = init;
      return {
        ok: true,
        status: 202,
        json: async () => ({ requestId: "req_123", status: "queued", retryAfterSeconds: 15 }),
      };
    },
  });
  ok(receipt.status === "queued", "queued request receipts are parsed");
  ok(sent.url === "https://coverage.example/v1/coverage-requests", "the configured request endpoint is used");
  ok(
    sent.init?.headers["Idempotency-Key"] === coverageRequestKey(viewport),
    "identical viewport requests carry a stable idempotency key",
  );
  const body = JSON.parse(sent.init?.body ?? "{}");
  ok(body.schemaVersion === 1 && body.bbox.length === 4, "the request sends a versioned geographic payload");

  await expectError(
    requestCoverageViewport({
      endpoint: "http://coverage.example/v1/coverage-requests",
      viewport,
      fetcher: async () => ({ ok: true, status: 202, json: async () => ({}) }),
    }),
    "invalid-endpoint",
  );
  await expectError(
    requestCoverageViewport({
      endpoint: "https://coverage.example/v1/coverage-requests",
      viewport,
      fetcher: async () => ({ ok: false, status: 422, json: async () => ({}) }),
    }),
    "request-failed",
  );
  await expectError(
    requestCoverageViewport({
      endpoint: "https://coverage.example/v1/coverage-requests",
      viewport,
      fetcher: async () => ({ ok: true, status: 202, json: async () => ({ requestId: "req", status: "mystery" }) }),
    }),
    "invalid-response",
  );
  await expectError(
    requestCoverageViewport({
      endpoint: "https://coverage.example/v1/coverage-requests",
      viewport,
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ requestId: "req", status: "ready" }) }),
    }),
    "invalid-response",
  );

  console.log("Viewport coverage checks passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
