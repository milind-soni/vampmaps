# Downloadable coverage delivery

Vamp coverage should be generated offline, published once, and downloaded only
when someone chooses an area. A phone should never run VoxCity or wait on OSM,
canopy, voxelization, and solar ray tracing during a tap.

## Build the static catalog

The publisher validates every graph, writes canonical content-addressed JSON,
and replaces the manifest only after every referenced bundle exists:

```bash
python pipeline/publish_coverage.py
```

By default it publishes the current Singapore, New York, and Sydney graphs to
`dist/coverage`. Pipeline output is preferred; the matching `app/assets` graph
is a fallback. Publish selected or newly generated graphs with repeated flags:

```bash
python pipeline/publish_coverage.py \
  --output dist/coverage \
  --source singapore-cbd=data/sg_full_2000x2000_m2_canopy.json \
  --source data/my-new-area.json
```

For reproducible output, set `SOURCE_DATE_EPOCH` or pass an ISO 8601
`--generated-at` value. The graph bytes—not that timestamp—define each version.

```text
dist/coverage/
├── manifest.json
└── bundles/
    ├── singapore-cbd.<sha256-prefix>.json
    ├── new-york-midtown.<sha256-prefix>.json
    └── sydney-cbd.<sha256-prefix>.json
```

Manifest bundle URLs are relative to `manifest.json`, so the directory works
unchanged on an object store, a static web host, or a CDN. Each entry includes
display metadata, center and bounds, node/edge counts, exact decoded byte size,
the full SHA-256 digest, and the immutable bundle URL. `version` is the same
full digest.

## Host it safely

Upload the directory to any HTTPS origin and configure:

- `manifest.json`: `Content-Type: application/json` and a short cache lifetime
  such as `Cache-Control: public, max-age=60, must-revalidate`.
- `bundles/*.json`: `Content-Type: application/json` and
  `Cache-Control: public, max-age=31536000, immutable`.
- CORS: allow the app's `GET` and `HEAD` requests. No credentials are needed for
  a public catalog.
- Compression: let the host/CDN serve Brotli or gzip by `Accept-Encoding` while
  preserving the manifest's SHA-256 and `bytes` as checks of the decoded JSON.

Deploy bundles before the manifest. The publisher follows the same rule on the
local filesystem: it validates and packages all inputs, atomically installs
immutable bundles, then atomically replaces `manifest.json`. Old bundles remain
available for clients that fetched an older manifest and can be garbage
collected only after a safe retention window.

## App download contract

Set the catalog URL at build time:

```bash
EXPO_PUBLIC_COVERAGE_MANIFEST_URL=https://cdn.example.com/vamp/coverage/manifest.json \
  npx expo export --platform ios
```

Development falls back to `http://127.0.0.1:8791/manifest.json` for the iOS
Simulator. Release builds intentionally fail when the variable is missing, so
a store binary cannot silently ship with a localhost data source. Keep the
production value HTTPS; the client rejects insecure non-local bundle URLs.

The map-first area picker uses each manifest entry's bounds. The user pans and
zooms, places the fixed target over an area, and taps **Fetch this area**. Vamp
prefers a published pack that contains the target and substantially overlaps
the viewport; an overly broad view asks the user to zoom in instead of silently
selecting a tiny tile. A secondary list remains available for accessibility and
quick switching.

Downloads use this small state machine:

```text
available → downloading → verifying → ready
                 └───────────────→ error → retry
ready + new digest → update available
```

When the user taps **Download area**, the app should:

1. Resolve `bundleUrl` against the manifest URL and download to a temporary
   file in app-private storage.
2. Reject an unexpected decoded byte count, compute SHA-256, and compare it
   with the manifest using a constant-time digest comparison where available.
3. Parse the JSON and verify `meta.city`, `meta.bbox`, node references, and the
   exposure-array shape before activating it.
4. Atomically rename the temporary file to a filename containing the full
   digest, then update a tiny local cache index.
5. Build the routing graph only after verification. On cancellation, network
   failure, or invalid data, delete the temporary file and keep the previously
   active area.

One small bundled area can remain as a first-run/offline fallback. Installed
areas continue to work without a network connection; checking the manifest is
only needed to discover areas or updates. A SHA-256 check detects corruption
and cache mix-ups, while HTTPS protects the manifest itself from tampering.

## Optional arbitrary-area requests

An arbitrary rectangle is a queued compute job, not a synchronous fetch:

1. When `EXPO_PUBLIC_COVERAGE_REQUEST_URL` is configured, the client submits a
   bounded viewport, center, approximate dimensions, and model profile to that
   authenticated API. The server derives and validates the authoritative IANA
   timezone; it must not trust the phone's timezone.
2. The API normalizes coordinates to a stable request key, enforces area and
   rate limits, returns `202 Accepted` plus a job id, and reuses an existing
   result when the same model inputs already exist.
3. A worker runs `pipeline/precompute.py` outside the request lifecycle with
   explicit CPU/memory/time limits. Status reports coarse stages rather than a
   misleading percent: queued, acquiring data, modeling, packaging, ready.
4. A successful job passes the same publisher validation and uploads an
   immutable bundle. It must atomically publish that area into the same catalog
   before returning `ready` with its `areaId`; the app refreshes the manifest,
   then downloads and verifies it through the existing flow.
5. Failed jobs expose a retryable/non-retryable reason and never publish a
   partial bundle. Temporary source data and custom-location records get a
   documented retention period.

Start with curated precomputed areas: they are fast, cacheable, predictable in
cost, and easy to quality-check. Add queued custom areas only after limits,
observability, retries, source licensing, and deletion/privacy behavior are in
place.

Minimal request:

```http
POST /v1/coverage-requests
Content-Type: application/json
Idempotency-Key: v1:vamp-walk-shade-v1:<normalized-bounds>
```

```json
{
  "schemaVersion": 1,
  "bbox": [103.84, 1.275, 103.858, 1.293],
  "center": [103.849, 1.284],
  "widthMeters": 2003,
  "heightMeters": 2004,
  "modelProfile": "vamp-walk-shade-v1"
}
```

Return `202` with `requestId`, a coarse status, and optional retry guidance;
return `200` with `status: "ready"` and `areaId` only after publication. Use
`422` for unsupported geometry and `429` for rate limiting. The current mobile
client deliberately does not claim success when this endpoint is absent.
