# Multi-city precompute

The precompute pipeline accepts a registered city or an ad-hoc center point.
Singapore remains the default, so existing commands and `sg_*` filenames keep
working unchanged.

## Inspect and validate without downloads

```bash
./.venv/bin/python pipeline/precompute.py --list-cities
./.venv/bin/python pipeline/precompute.py --city new-york-midtown --test --dry-run
./.venv/bin/python pipeline/precompute.py --city tokyo --test --dry-run
```

`--dry-run` validates coordinates and the IANA timezone, prints the exact cache
and output names, and reports the UTC offsets used on each solar sample date. It
does not import VoxCity, query OpenStreetMap, or download canopy data.

## Generate a registered city

```bash
# 600 m smoke-test tile
./.venv/bin/python pipeline/precompute.py --city london-westminster --test

# 2 km tile with high-resolution Meta/WRI canopy
./.venv/bin/python pipeline/precompute.py --city sydney-cbd --meta-canopy
```

City aliases such as `nyc`, `london`, `tokyo`, and `sg` are accepted. Canonical
ids are preferred in scripts because they are self-documenting.

## Generate an ad-hoc location

```bash
./.venv/bin/python pipeline/precompute.py \
  --lat 27.7172 \
  --lon 85.3240 \
  --timezone Asia/Kathmandu \
  --city-name Kathmandu \
  --city-id kathmandu-thamel \
  --test
```

`--lat`, `--lon`, and `--timezone` are required together. The timezone must be
an IANA identifier rather than a numeric UTC offset. `--city-name` and
`--city-id` are optional; without an id the pipeline derives a deterministic id
from the coordinates. Custom cache names include a short coordinate/timezone
fingerprint so reusing a friendly id at another location cannot read stale
voxel or walking-network data.

`--width-m`, `--height-m`, `--mesh`, and `--solar-year` can override their
normal defaults. The `--test` defaults remain 600 x 600 m and full runs remain
2000 x 2000 m.

## Registry format

City presets live in `data/cities/registry.json`:

```json
{
  "id": "new-york-midtown",
  "name": "New York — Midtown Manhattan",
  "center": { "lat": 40.758, "lon": -73.9855 },
  "timezone": "America/New_York",
  "aliases": ["new-york", "nyc"]
}
```

Ids, aliases, and file prefixes must be unique lowercase slugs. The registry is
fully validated before any expensive pipeline work starts.

## Naming and metadata

Preset outputs use the city id as their stem, for example
`new-york-midtown_test_600x600_m2.json`. Singapore explicitly retains its
legacy prefix: `sg_test_600x600_m2.json` and
`sg_full_2000x2000_m2_canopy.json`.

Graph metadata now includes:

- `city`: canonical machine id
- `city_name`: human-readable display name
- `center`: `[longitude, latitude]`
- `timezone`: authoritative IANA timezone
- `utc_offsets_hours`: the actual offset for every date/hour sample, including DST
- `solar_year`: year used for the astronomy calculation
- `tz_offset_hours`: compatibility field for older clients

Solar times are created as local civil times and converted through Python's
IANA timezone database before astronomy calculations. This correctly handles
DST, fractional offsets such as Nepal's UTC+05:45, southern-hemisphere seasons,
and UTC date rollover.

## Lightweight verification

```bash
./.venv/bin/python -m unittest discover -s tests -v
```

These tests validate the registry, aliases, legacy naming, custom cache
isolation, DST and fractional offsets, metadata, and dry-run CLI. They perform
no network requests and never import VoxCity.
