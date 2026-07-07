"""Shady precompute pipeline.

Generates a voxel city model for the target area (keyless: OSM buildings,
OSM land cover/trees, flat DEM), ray-traces per-hour sun exposure at
pedestrian height for representative dates, maps exposure onto the OSM
walking network, and exports a compact routing graph JSON for the app.

Usage:
    python precompute.py --test          # small tile, sanity check
    python precompute.py                 # full launch area
"""

import argparse
import gzip
import json
import math
import pickle
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# VoxCity's downloader package imports Japan-only modules (oemj, gsi) at package
# level, which need GDAL's osgeo bindings. We don't use those sources — stub the
# import so the keyless OSM path works without a GDAL install.
try:
    import osgeo  # noqa: F401
except ImportError:
    _stub = types.ModuleType("osgeo")
    _stub.gdal = types.SimpleNamespace()
    _stub.osr = types.SimpleNamespace()
    sys.modules["osgeo"] = _stub

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_DIR = DATA_DIR / "cache"

# Singapore CBD / Chinatown / Marina Bay
CENTER_LAT, CENTER_LON = 1.2840, 103.8480
FULL_W, FULL_H = 2000, 2000      # meters
TEST_W, TEST_H = 600, 600
MESH = 2.0                       # voxel size in meters
VIEW_HEIGHT = 1.5                # pedestrian eye level
TZ_OFFSET_H = 8                  # SGT = UTC+8
HOURS = list(range(8, 20))       # 08:00..19:00 local
DATES = ["03-21", "06-21", "12-21"]  # equinox + solstices
MIN_SUN_ELEV_DEG = 4.0           # below this, treat as no direct sun


def rectangle_from_center(lat, lon, width_m, height_m):
    dlat = (height_m / 2) / 111_320
    dlon = (width_m / 2) / (111_320 * math.cos(math.radians(lat)))
    w, e = lon - dlon, lon + dlon
    s, n = lat - dlat, lat + dlat
    return [(w, s), (w, n), (e, n), (e, s)]  # SW NW NE SE


def build_voxcity(rect, mesh, cache_key):
    cache = CACHE_DIR / f"voxcity_{cache_key}.pkl"
    if cache.exists():
        print(f"[voxcity] cache hit: {cache}")
        with open(cache, "rb") as f:
            return pickle.load(f)
    from voxcity.generator import get_voxcity
    vc = get_voxcity(
        rect,
        mesh,
        building_source="OpenStreetMap",
        land_cover_source="OpenStreetMap",
        canopy_height_source="OpenStreetMap",
        dem_source="Flat",
        output_dir=str(CACHE_DIR / f"voxcity_dl_{cache_key}"),
        gridvis=False,
        mapvis=False,
        save_voxcity_data=False,
    )
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(cache, "wb") as f:
        pickle.dump(vc, f)
    return vc


def apply_meta_canopy(vc, rect, mesh, cache_key):
    """Merge Meta 1m canopy heights into the model and re-voxelize.

    Meta CHM supersedes/augments the sparse OSM tree points (elementwise max).
    Canopy on building footprints is dropped (CHM sometimes reads rooftops or
    green roofs as canopy, which would shade streets that aren't shaded).
    """
    import pickle as _pickle

    cache = CACHE_DIR / f"voxcity_{cache_key}_canopy.pkl"
    if cache.exists():
        print(f"[canopy] voxcity cache hit: {cache}")
        with open(cache, "rb") as f:
            return _pickle.load(f)

    from meta_canopy import fetch_meta_canopy_tif
    from voxcity.geoprocessor.raster.raster import create_height_grid_from_geotiff_polygon
    from voxcity.generator.pipeline import VoxCityPipeline
    from voxcity.generator.voxelizer import Voxelizer

    tif = fetch_meta_canopy_tif(rect, CACHE_DIR / f"meta_chm_{cache_key}.tif")
    meta_top = create_height_grid_from_geotiff_polygon(tif, mesh, rect)
    meta_top = np.nan_to_num(meta_top, nan=0.0)
    meta_top[meta_top < 2.0] = 0.0                    # noise floor
    meta_top[vc.buildings.heights > 0] = 0.0          # no phantom rooftop trees

    trunk_ratio = vc.extras.get("trunk_height_ratio") or (11.76 / 19.98)
    canopy_top = np.maximum(vc.tree_canopy.top, meta_top)
    canopy_bottom = canopy_top * float(trunk_ratio)

    n_before = int((vc.tree_canopy.top >= 2).sum())
    n_after = int((canopy_top >= 2).sum())
    print(f"[canopy] tree cells: {n_before} (OSM) -> {n_after} (merged with Meta CHM)")

    voxelizer = Voxelizer(
        voxel_size=mesh,
        land_cover_source=vc.extras.get("land_cover_source", "OpenStreetMap"),
        trunk_height_ratio=float(trunk_ratio),
    )
    vox = voxelizer.generate_combined(
        building_height_grid_ori=vc.buildings.heights,
        building_min_height_grid_ori=vc.buildings.min_heights,
        building_id_grid_ori=vc.buildings.ids,
        land_cover_grid_ori=vc.land_cover.classes,
        dem_grid_ori=vc.dem.elevation,
        tree_grid_ori=canopy_top,
        canopy_bottom_height_grid_ori=canopy_bottom,
    )
    vc2 = VoxCityPipeline(mesh, rect).assemble_voxcity(
        voxcity_grid=vox,
        building_height_grid=vc.buildings.heights,
        building_min_height_grid=vc.buildings.min_heights,
        building_id_grid=vc.buildings.ids,
        land_cover_grid=vc.land_cover.classes,
        dem_grid=vc.dem.elevation,
        canopy_height_top=canopy_top,
        canopy_height_bottom=canopy_bottom,
        extras=vc.extras,
    )
    with open(cache, "wb") as f:
        _pickle.dump(vc2, f)
    return vc2


def get_walk_graph(rect, cache_key):
    import osmnx as ox
    from shapely.geometry import Polygon

    cache = CACHE_DIR / f"walk_{cache_key}.graphml"
    if cache.exists():
        print(f"[graph] cache hit: {cache}")
        G = ox.load_graphml(cache)
    else:
        G = ox.graph_from_polygon(Polygon(rect), network_type="walk", simplify=True)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(G, cache)
    try:
        G = ox.convert.to_undirected(G)  # osmnx >= 2.0
    except AttributeError:
        G = ox.utils_graph.get_undirected(G)
    return G


def sun_positions(rect):
    """Sun az/el per (date, local hour). Returns {date: [(hour, az, el), ...]}."""
    from voxcity.simulator.solar.temporal import get_solar_positions_astral

    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    lon, lat = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2

    out = {}
    for d in DATES:
        month, day = (int(x) for x in d.split("-"))
        times = pd.DatetimeIndex(
            [
                datetime(2025, month, day, h - TZ_OFFSET_H if h >= TZ_OFFSET_H else h + 24 - TZ_OFFSET_H,
                         tzinfo=timezone.utc)
                for h in HOURS
            ]
        )
        pos = get_solar_positions_astral(times, lon, lat)
        out[d] = [
            (h, float(pos.iloc[i]["azimuth"]), float(pos.iloc[i]["elevation"]))
            for i, h in enumerate(HOURS)
        ]
    return out


def exposure_map(vc, az_deg, el_deg):
    """0..1 sun-exposure fraction per ground cell (1 = full direct sun)."""
    from voxcity.simulator.solar.radiation import get_direct_solar_irradiance_map

    sin_el = math.sin(math.radians(el_deg))
    # DNI = 1/sin(el) makes the returned map exactly the transmittance (0..1)
    return get_direct_solar_irradiance_map(
        vc,
        az_deg,
        el_deg,
        direct_normal_irradiance=1.0 / sin_el,
        show_plot=False,
        view_point_height=VIEW_HEIGHT,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="small tile sanity run")
    ap.add_argument("--mesh", type=float, default=MESH)
    ap.add_argument("--meta-canopy", action="store_true",
                    help="merge Meta 1m canopy heights (CC-BY) for real tree shade")
    args = ap.parse_args()

    w, h = (TEST_W, TEST_H) if args.test else (FULL_W, FULL_H)
    base_key = f"sg_{'test' if args.test else 'full'}_{int(w)}x{int(h)}_m{args.mesh:g}"
    key = base_key + ("_canopy" if args.meta_canopy else "")
    rect = rectangle_from_center(CENTER_LAT, CENTER_LON, w, h)
    print(f"[area] {w}x{h} m around ({CENTER_LAT}, {CENTER_LON}), mesh {args.mesh} m")

    vc = build_voxcity(rect, args.mesh, base_key)
    if args.meta_canopy:
        vc = apply_meta_canopy(vc, rect, args.mesh, base_key)
    print(f"[voxcity] voxel grid: {vc.voxels.classes.shape}")

    G = get_walk_graph(rect, base_key)  # network is canopy-independent
    print(f"[graph] {len(G.nodes)} nodes, {len(G.edges)} edges")

    sun = sun_positions(rect)

    from voxcity.geoprocessor.network import vectorized_edge_values
    from voxcity.geoprocessor.raster.export import grid_to_geodataframe

    # exposure per edge per (date, hour); default 1.0 (assume exposed) when unknown
    edge_exp = {d: {e: [None] * len(HOURS) for e in G.edges(keys=True)} for d in DATES}

    for d in DATES:
        for i, (hour, az, el) in enumerate(sun[d]):
            if el < MIN_SUN_ELEV_DEG:
                for e in G.edges(keys=True):
                    edge_exp[d][e][i] = 0.0
                print(f"[sun] {d} {hour:02d}:00 sun below horizon (el={el:.1f}) -> 0")
                continue
            emap = exposure_map(vc, az, el)
            gdf = grid_to_geodataframe(emap, rect, args.mesh)
            vals = vectorized_edge_values(G, gdf, value_col="value")
            n_valid = 0
            for e in G.edges(keys=True):
                v = vals.get(e)
                if v is not None and not (isinstance(v, float) and math.isnan(v)):
                    edge_exp[d][e][i] = float(min(max(v, 0.0), 1.0))
                    n_valid += 1
            print(f"[sun] {d} {hour:02d}:00 az={az:.1f} el={el:.1f} -> {n_valid}/{len(G.edges)} edges")

    # ---- export compact JSON ----
    node_ids = {nid: i for i, nid in enumerate(G.nodes)}
    nodes = [
        [round(G.nodes[nid]["x"], 6), round(G.nodes[nid]["y"], 6)] for nid in G.nodes
    ]

    edges = []
    for (u, v, k) in G.edges(keys=True):
        data = G.edges[u, v, k]
        geom = data.get("geometry")
        if geom is not None:
            pts = [[round(x, 6), round(y, 6)] for x, y in geom.coords]
        else:
            pts = [nodes[node_ids[u]], nodes[node_ids[v]]]
        exp = {}
        for d in DATES:
            arr = edge_exp[d][(u, v, k)]
            exp[d] = [100 if a is None else int(round(a * 100)) for a in arr]
        edges.append(
            {
                "u": node_ids[u],
                "v": node_ids[v],
                "len": round(float(data.get("length", 0.0)), 1),
                "pts": pts,
                "exp": exp,
            }
        )

    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    out = {
        "meta": {
            "city": "singapore-cbd",
            "bbox": [min(lons), min(lats), max(lons), max(lats)],
            "hours": HOURS,
            "dates": DATES,
            "tz_offset_hours": TZ_OFFSET_H,
            "mesh_m": args.mesh,
            "view_height_m": VIEW_HEIGHT,
            "sun": {d: [[h, round(az, 1), round(el, 1)] for h, az, el in sun[d]] for d in DATES},
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "nodes": nodes,
        "edges": edges,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / f"{key}.json"
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    with gzip.open(str(out_path) + ".gz", "wt") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[done] {out_path} ({out_path.stat().st_size/1e6:.1f} MB, "
          f"{Path(str(out_path)+'.gz').stat().st_size/1e6:.1f} MB gz)")


if __name__ == "__main__":
    main()
