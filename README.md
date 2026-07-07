# vampmaps 🧛🌴

Playful shade-route navigation. Compares the *fastest* walking route against the
*shadiest* one and tells you how melted you'll be when you arrive.

Demo area: Singapore CBD / Chinatown / Marina Bay.

## How it works

```
pipeline/precompute.py  (Python, offline, once per city)
  ├─ VoxCity: voxel 3D model from OSM buildings + OSM trees, flat DEM (keyless, no GEE)
  ├─ --meta-canopy: Meta/WRI 1m canopy heights (CC-BY) via windowed COG reads
  │    from public S3 — real tree shade, still no keys (meta_canopy.py)
  ├─ Ray-traced sun exposure at 1.5 m pedestrian height,
  │    hourly 08:00–19:00 SGT × 3 dates (equinox + solstices)
  ├─ Exposure mapped onto the OSM walking network (length-weighted per edge)
  └─ Compact graph JSON → data/ → app/assets/singapore.json

app/  (Expo SDK 57, TypeScript)
  ├─ react-native-maps (Apple Maps, works in Expo Go on iOS)
  ├─ Client-side Dijkstra: cost = length × (1 + mood_weight × sun_exposure)
  ├─ Fastest (dashed gray) vs Shady (colored teal→orange by exposure per segment)
  └─ Melt meter, sun-minutes saved, time slider, mood presets (😎 🥵 🧛)
```

No API keys, no backend: all data comes from OSM + astronomy, routing runs on-device.

## Commands

```bash
# precompute (test tile: 600 m; full: 2 km)
./.venv/bin/python pipeline/precompute.py --test
./.venv/bin/python pipeline/precompute.py --meta-canopy

# copy output into the app
cp data/sg_full_2000x2000_m2_canopy.json app/assets/singapore.json

# run the app (Expo Go on iPhone)
cd app && npx expo start
```

## Data format (app/assets/singapore.json)

- `meta`: bbox, hours (8–19), dates (`03-21`, `06-21`, `12-21`), per-date sun az/el
- `nodes`: `[lon, lat]` per node
- `edges`: `{u, v, len, pts, exp}` — `exp[date][hourIdx]` is sun exposure 0–100
  (0 = full shade, 100 = full sun; unknown edges default to 100)

## Roadmap

- Live cloud check (Open-Meteo, free) — "it's cloudy, walk wherever you want, king"
- More neighborhoods / cities; move routing server-side when coverage grows
- Share cards ("I saved 14 sun-minutes 🧊")
