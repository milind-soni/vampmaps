# Vamp

Vamp helps people choose the light they want: a sunnier walk, a shadier walk,
or the fastest balanced option. Routing runs on-device; the 3D sun-and-shade
model is precomputed offline.

The app ships with Singapore as an offline starter area. New York and Sydney
are small, user-initiated downloads that remain available offline. The pipeline
also has presets for London, Tokyo, Barcelona, Mexico City, and Cape Town.

## How it works

```text
pipeline/precompute.py  (Python, offline)
  ├─ OSM walking network, buildings, land cover, and enclosure tags
  ├─ Optional Meta/WRI 1 m canopy-height data
  ├─ VoxCity ray tracing on a 2 m voxel grid
  ├─ IANA timezone-aware samples at 08:00–19:00 on three reference dates
  └─ Compact graph JSON with model-quality metadata

pipeline/publish_coverage.py  (static delivery)
  ├─ Strict graph validation and canonical JSON
  ├─ Immutable content-addressed area packs
  └─ Small manifest for any HTTPS object store or CDN

app/  (Expo SDK 57, TypeScript)
  ├─ Apple Maps with explicit coverage boundaries
  ├─ Map-first area selection: pan, zoom, then fetch the viewport
  ├─ On-device, symmetric sun-to-shade preference routing
  ├─ Fastest route plus a configurable sunnier or shadier alternative
  ├─ Verified on-demand area downloads with persistent offline caching
  └─ Tap-expandable route sheet, light/dark appearance, and large-text layouts
```

“Sun minutes” are direct-sun-equivalent minutes: walking time multiplied by
modeled direct-beam transmittance. They are experimental comparison estimates,
not literal field measurements or heat/UV safety guidance. See
[`docs/accuracy.md`](docs/accuracy.md) for validation results and limitations.

## Run the app

```bash
# Terminal 1: build and serve the local coverage catalog
./.venv/bin/python pipeline/publish_coverage.py
python3 -m http.server 8791 --bind 127.0.0.1 --directory dist/coverage

# Terminal 2: run the iOS app
cd app
npm install
npx expo start --ios
```

Development defaults to `http://127.0.0.1:8791/manifest.json`. Store builds
must set `EXPO_PUBLIC_COVERAGE_MANIFEST_URL` to the deployed HTTPS manifest;
an optional `EXPO_PUBLIC_COVERAGE_REQUEST_URL` enables honest asynchronous
requests for views that do not yet have a published pack. Without it, Vamp
simply says that the area is not ready rather than pretending to generate it.
see [`app/.env.example`](app/.env.example) and
[`docs/coverage-delivery.md`](docs/coverage-delivery.md).

## Precompute city data

```bash
# See all registered cities
./.venv/bin/python pipeline/precompute.py --list-cities

# Generate a small preset tile
./.venv/bin/python pipeline/precompute.py --city new-york-midtown --test --meta-canopy

# Generate the legacy 2 km Singapore area
./.venv/bin/python pipeline/precompute.py --city singapore-cbd --meta-canopy
```

See [`docs/precompute-cities.md`](docs/precompute-cities.md) for custom
coordinates, timezone handling, caches, and output naming.

New-area generation makes 5-6 queries against public Overpass mirrors, which
are rate-limited, queued, and occasionally unreachable. For reliable or bulk
generation, run the self-hosted instance in
[`infra/overpass/docker-compose.yml`](infra/overpass/docker-compose.yml) and
set `OVERPASS_API_URL=http://127.0.0.1:12345/api/interpreter`; the pipeline
and VoxCity's downloaders try it before the public mirrors.

## Verify

```bash
./.venv/bin/python -m unittest discover -s tests -v
./.venv/bin/python pipeline/validate_solar.py

cd app
npm run check
npx expo-doctor
EXPO_PUBLIC_COVERAGE_MANIFEST_URL=https://cdn.example.com/vamp/coverage/manifest.json \
  npx expo export --platform ios
npm audit --omit=dev
```

The optional solar cross-check uses `pvlib==0.13.1`; its install command is in
`pipeline/validate_solar.py`.

## Graph format

- `meta`: city, timezone, bbox, sample dates/hours, observer quantization,
  solar states, source limitations, and fallback counts.
- `nodes`: `[longitude, latitude]` by node ID.
- `edges`: `{u, v, len, pts, exp}`. Exposure is `0` for no modeled direct beam
  and `100` for full modeled direct beam; `-1` explicitly marks an unmapped
  sample. Routing avoids unknowns for either light preference, while displayed
  sun totals conservatively count them as exposed.
