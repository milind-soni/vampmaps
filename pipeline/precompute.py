"""ShadeMax precompute pipeline.

Generates a voxel city model for the target area (keyless: OSM buildings,
OSM land cover/trees, flat DEM), ray-traces per-hour sun exposure at
pedestrian height for representative dates, maps exposure onto the OSM
walking network, and exports a compact routing graph JSON for the app.

Usage:
    python precompute.py --test                       # legacy Singapore test tile
    python precompute.py --city tokyo-shibuya --test # another registered city
    python precompute.py --list-cities               # show registered cities
"""

import argparse
from collections import Counter
import gzip
import json
import math
import os
import pickle
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

try:  # Support both `python pipeline/precompute.py` and module imports in tests.
    from .cities import (
        CityConfig,
        build_run_names,
        current_utc_offset_hours,
        load_city_registry,
        local_datetimes_utc,
        resolve_city_options,
        utc_offsets_hours,
    )
except ImportError:
    from cities import (  # type: ignore[no-redef]
        CityConfig,
        build_run_names,
        current_utc_offset_hours,
        load_city_registry,
        local_datetimes_utc,
        resolve_city_options,
        utc_offsets_hours,
    )

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

# Legacy defaults. The default registry entry intentionally preserves these
# values and the existing sg_* output/cache filenames.
CENTER_LAT, CENTER_LON = 1.2840, 103.8480
FULL_W, FULL_H = 2000, 2000      # meters
TEST_W, TEST_H = 600, 600
MESH = 2.0                       # voxel size in meters
VIEW_HEIGHT = 1.5                # pedestrian eye level
TZ_OFFSET_H = 8                  # legacy metadata compatibility only
SOLAR_YEAR = 2025
HOURS = list(range(8, 20))       # 08:00..19:00 local
DATES = ["03-21", "06-21", "12-21"]  # equinox + solstices
MIN_SUN_ELEV_DEG = 4.0           # below this, treat as no direct sun

SUN_STATE_MODELED = "modeled"
SUN_STATE_LOW_CUTOFF = "low_sun_cutoff"
SUN_STATE_BELOW_HORIZON = "below_horizon"
UNKNOWN_EXPOSURE_SENTINEL = -1


def observer_height_model(mesh, requested_height=VIEW_HEIGHT):
    """Describe the observer height VoxCity can represent at this mesh.

    VoxCity's CPU solar kernel converts ``view_point_height`` to a vertical
    voxel offset with ``int(view_point_height / meshsize)``.  Passing the
    nominal 1.5 m height at the default 2 m mesh therefore used to collapse to
    ground level.  Round upward so a pedestrian-height observer is represented
    by at least one voxel, and expose the quantization in output metadata.
    """
    mesh = float(mesh)
    requested_height = float(requested_height)
    if not math.isfinite(mesh) or mesh <= 0:
        raise ValueError("mesh must be a positive finite number")
    if not math.isfinite(requested_height) or requested_height <= 0:
        raise ValueError("requested observer height must be positive and finite")

    # The small tolerance avoids an exact voxel boundary being rounded up due
    # solely to floating-point division noise.
    voxel_offset = max(1, math.ceil(requested_height / mesh - 1e-12))
    modeled_height = voxel_offset * mesh
    trace_height = modeled_height
    # Guard against products such as 3 * 0.2 dividing to 2.999999... inside
    # VoxCity's floor-to-int conversion.  This changes no represented height.
    if int(trace_height / mesh) < voxel_offset:
        trace_height = math.nextafter(trace_height, math.inf)
    return {
        "requested_m": requested_height,
        "modeled_m": modeled_height,
        "voxel_offset": voxel_offset,
        "trace_parameter_m": trace_height,
        "quantization": "ceil_to_voxel",
    }


def classify_sun_elevation(elevation_deg, cutoff_deg=MIN_SUN_ELEV_DEG):
    """Classify whether a solar sample is modeled or intentionally zeroed."""
    elevation_deg = float(elevation_deg)
    if elevation_deg <= 0.0:
        return SUN_STATE_BELOW_HORIZON
    if elevation_deg < cutoff_deg:
        return SUN_STATE_LOW_CUTOFF
    return SUN_STATE_MODELED


def _osm_tag_values(value):
    """Normalize common in-memory and GraphML representations of OSM tags."""
    if value is None:
        return ()
    if isinstance(value, (list, tuple, set)):
        return tuple(
            item
            for nested in value
            for item in _osm_tag_values(nested)
        )
    if isinstance(value, bool):
        return ("yes" if value else "no",)

    text = str(value).strip().lower()
    if not text:
        return ()
    # OSMnx may retain multiple values as a Python-list-looking GraphML string.
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return tuple(
        token.strip().strip("'\"")
        for token in text.replace(";", ",").split(",")
        if token.strip().strip("'\"")
    )


def _osm_tag_is_affirmative(value):
    false_values = {"", "0", "false", "no", "none", "null"}
    return any(item not in false_values for item in _osm_tag_values(value))


def direct_sun_block_reason(edge_data):
    """Return why an OSM walking edge should receive zero direct sun.

    OSM's standard building-passage representation is
    ``tunnel=building_passage``.  The standalone key is also accepted for
    compatibility with enriched/synthetic graphs.
    """
    tunnel_values = set(_osm_tag_values(edge_data.get("tunnel")))
    if "building_passage" in tunnel_values or _osm_tag_is_affirmative(
        edge_data.get("building_passage")
    ):
        return "building_passage"
    if _osm_tag_is_affirmative(edge_data.get("tunnel")):
        return "tunnel"
    if _osm_tag_is_affirmative(edge_data.get("covered")):
        return "covered"
    return None


def initialize_edge_exposure(edge_keys, enclosed_edge_reasons):
    """Create exposure storage, pre-filling enclosed OSM edges with shade."""
    return {
        date: {
            edge: (
                [0.0] * len(HOURS)
                if edge in enclosed_edge_reasons
                else [None] * len(HOURS)
            )
            for edge in edge_keys
        }
        for date in DATES
    }


def summarize_graph_exposure(edge_exp, enclosed_edge_reasons):
    """Summarize measured/fallback coverage without changing compact edges."""
    edge_keys = {
        edge
        for date_values in edge_exp.values()
        for edge in date_values
    }
    total_samples = 0
    unknown_samples = 0
    unknown_edges = set()
    for date_values in edge_exp.values():
        for edge, samples in date_values.items():
            total_samples += len(samples)
            missing = sum(value is None for value in samples)
            unknown_samples += missing
            if missing:
                unknown_edges.add(edge)

    reason_counts = Counter(enclosed_edge_reasons.values())
    return {
        "edge_count": len(edge_keys),
        "exposure_sample_count": total_samples,
        "unknown_edge_count": len(unknown_edges),
        "unknown_edge_sample_count": unknown_samples,
        "unknown_edge_sample_fraction": (
            round(unknown_samples / total_samples, 6) if total_samples else 0.0
        ),
        "unknown_exposure_sentinel": UNKNOWN_EXPOSURE_SENTINEL,
        "osm_enclosed_direct_sun_pct": 0,
        "osm_enclosed_edge_count": len(enclosed_edge_reasons),
        "osm_enclosed_edge_counts": {
            reason: reason_counts.get(reason, 0)
            for reason in ("tunnel", "covered", "building_passage")
        },
    }


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

    # Point OSMnx at a private Overpass instance when one is configured. The
    # value is the full interpreter URL (same variable VoxCity's downloader
    # honors); OSMnx wants the base URL without the trailing /interpreter.
    overpass_url = os.environ.get("OVERPASS_API_URL")
    if overpass_url:
        ox.settings.overpass_url = overpass_url.removesuffix("/interpreter").rstrip("/")
        ox.settings.overpass_rate_limit = False

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


def sun_positions(rect, timezone_name="Asia/Singapore", *, year=SOLAR_YEAR):
    """Sun az/el per (date, local hour). Returns {date: [(hour, az, el), ...]}."""
    from voxcity.simulator.solar.temporal import get_solar_positions_astral

    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    lon, lat = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2

    # Convert each local civil time via IANA rules. This handles DST, fractional
    # offsets, and UTC date rollover instead of subtracting a fixed offset.
    utc_times = local_datetimes_utc(timezone_name, DATES, HOURS, year=year)
    out = {}
    for d in DATES:
        times = pd.DatetimeIndex(utc_times[d])
        pos = get_solar_positions_astral(times, lon, lat)
        out[d] = [
            (h, float(pos.iloc[i]["azimuth"]), float(pos.iloc[i]["elevation"]))
            for i, h in enumerate(HOURS)
        ]
    return out


EDGE_SAMPLE_STEP_M = 0.25


def edge_raster_samplers(G, rect, grid_shape, step_m=EDGE_SAMPLE_STEP_M):
    """Precompute which exposure-grid cells lie under each walking edge.

    The exposure grid uses the same Web Mercator cell layout as VoxCity's
    ``grid_to_geodataframe`` (row 0 is the southern edge). Each edge polyline
    is projected once, densified at ``step_m`` spacing, and converted to flat
    raster indices. Sampling those indices approximates the former
    length-weighted polygon-overlay mean while replacing a ~1M-polygon
    ``gpd.overlay`` per solar state with a single numpy gather.

    Returns ``{(u, v, k): int32 flat indices}``; points outside the grid are
    dropped, so an edge fully outside stays unmapped (unknown exposure), the
    same outcome the overlay produced.
    """
    from pyproj import Transformer
    from shapely.geometry import LineString

    rows, cols = grid_shape
    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    min_x, min_y = to_merc.transform(min(lons), min(lats))
    max_x, max_y = to_merc.transform(max(lons), max(lats))
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows

    samplers = {}
    for u, v, k, data in G.edges(keys=True, data=True):
        geom = data.get("geometry")
        if geom is None:
            geom = LineString(
                [
                    (G.nodes[u]["x"], G.nodes[u]["y"]),
                    (G.nodes[v]["x"], G.nodes[v]["y"]),
                ]
            )
        xs, ys = to_merc.transform(*zip(*geom.coords))
        xs = np.asarray(xs, dtype=float)
        ys = np.asarray(ys, dtype=float)
        seg = np.hypot(np.diff(xs), np.diff(ys))
        total = float(seg.sum())
        n = max(2, int(total / max(step_m, 1e-9)) + 1)
        t = np.linspace(0.0, total, n)
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        px = np.interp(t, cum, xs)
        py = np.interp(t, cum, ys)
        j = np.floor((px - min_x) / cell_w).astype(np.int64)
        i = np.floor((py - min_y) / cell_h).astype(np.int64)
        inside = (j >= 0) & (j < cols) & (i >= 0) & (i < rows)
        samplers[(u, v, k)] = (i[inside] * cols + j[inside]).astype(np.int32)
    return samplers


def sample_edge_exposures(exposure_grid, samplers):
    """Mean exposure per edge from a raster, skipping NaN (unmapped) cells.

    Edges whose samples are all NaN or out of bounds are omitted, matching the
    former overlay behavior so callers keep their unknown-exposure handling.
    """
    flat = np.asarray(exposure_grid, dtype=float).ravel()
    values = {}
    for edge, idx in samplers.items():
        if idx.size == 0:
            continue
        vals = flat[idx]
        finite = vals[~np.isnan(vals)]
        if finite.size:
            values[edge] = float(finite.mean())
    return values


def _json_offset(value):
    """Use integers for whole-hour offsets while retaining half/quarter hours."""
    return int(value) if float(value).is_integer() else float(value)


def build_metadata(
    city: CityConfig,
    rect,
    mesh,
    sun,
    *,
    solar_year=SOLAR_YEAR,
    generated_at=None,
    meta_canopy=False,
    graph=None,
):
    """Build output metadata with IANA timezone rules and legacy compatibility."""
    generated_at = generated_at or datetime.now(timezone.utc)
    if generated_at.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    generated_at = generated_at.astimezone(timezone.utc)
    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    offsets = utc_offsets_hours(city.timezone, DATES, HOURS, year=solar_year)
    observer = observer_height_model(mesh)
    metadata = {
        "city": city.id,
        "city_name": city.name,
        "center": [city.center_lon, city.center_lat],
        "bbox": [min(lons), min(lats), max(lons), max(lats)],
        "hours": HOURS,
        "dates": DATES,
        # `timezone` is authoritative. Keep the numeric offset so the existing
        # Singapore app and older graph consumers remain backward compatible.
        "timezone": city.timezone,
        "tz_offset_hours": _json_offset(
            current_utc_offset_hours(city.timezone, generated_at)
        ),
        "utc_offsets_hours": {
            date: [_json_offset(value) for value in values]
            for date, values in offsets.items()
        },
        "solar_year": solar_year,
        "mesh_m": mesh,
        # Retain the existing scalar field, but make it the height actually
        # represented by VoxCity.  The requested pedestrian height remains
        # explicit for consumers that need to understand the quantization.
        "view_height_m": observer["modeled_m"],
        "requested_view_height_m": observer["requested_m"],
        "view_height_voxels": observer["voxel_offset"],
        "view_height_quantization": observer["quantization"],
        "sun": {
            d: [[h, round(az, 1), round(el, 1)] for h, az, el in sun[d]]
            for d in DATES
        },
        "sun_model": {
            "direct_sun_only": True,
            "minimum_modeled_elevation_deg": MIN_SUN_ELEV_DEG,
            "sample_state_meanings": {
                SUN_STATE_MODELED: "ray_traced",
                SUN_STATE_LOW_CUTOFF: "zero_direct_sun_below_model_cutoff",
                SUN_STATE_BELOW_HORIZON: "zero_direct_sun_below_horizon",
            },
            "sample_states": {
                date: [classify_sun_elevation(el) for _, _, el in sun[date]]
                for date in DATES
            },
        },
        "model_quality": {
            "confidence": "screening_estimate_not_field_validated",
            "field_validated": False,
            "sources": {
                "pedestrian_network": "OpenStreetMap via OSMnx",
                "buildings": "OpenStreetMap via VoxCity",
                "land_cover": "OpenStreetMap via VoxCity",
                "tree_canopy": (
                    "OpenStreetMap plus Meta/WRI 1 m Global Canopy Height"
                    if meta_canopy
                    else "OpenStreetMap tree features only"
                ),
                "terrain": "flat DEM",
                "solar_position": "Astral via VoxCity",
            },
            "limitations": [
                "Screening estimate only; no route-level field validation has "
                "been performed.",
                "Terrain is modeled as flat, so hills and terrain shadows are omitted.",
                "OSM geometry, height, tunnel, covered, and building-passage "
                "tags may be incomplete or outdated.",
                "The exposure score models direct-beam transmittance, not "
                "diffuse sky radiation, reflections, clouds, or temporary shade.",
                "Building and canopy geometry is voxelized at the declared mesh resolution.",
            ],
        },
        "generated": generated_at.isoformat(timespec="seconds"),
    }
    if graph is not None:
        metadata["graph"] = graph
    return metadata


def exposure_map(vc, az_deg, el_deg, *, irradiance_fn=None):
    """0..1 sun-exposure fraction per ground cell (1 = full direct sun)."""
    if irradiance_fn is None:
        from voxcity.simulator.solar.radiation import get_direct_solar_irradiance_map

        irradiance_fn = get_direct_solar_irradiance_map

    sin_el = math.sin(math.radians(el_deg))
    observer = observer_height_model(vc.voxels.meta.meshsize)
    # DNI = 1/sin(el) makes the returned map exactly the transmittance (0..1)
    return irradiance_fn(
        vc,
        az_deg,
        el_deg,
        direct_normal_irradiance=1.0 / sin_el,
        show_plot=False,
        view_point_height=observer["trace_parameter_m"],
    )


def positive_float(raw):
    value = float(raw)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return value


def solar_year(raw):
    value = int(raw)
    if not 2000 <= value <= 2100:
        raise argparse.ArgumentTypeError("must be between 2000 and 2100")
    return value


def create_parser():
    ap = argparse.ArgumentParser(
        description="Precompute pedestrian sun exposure for a registered or custom city."
    )
    ap.add_argument("--test", action="store_true", help="small tile sanity run")
    ap.add_argument("--city", metavar="ID", help="registered city id or alias")
    ap.add_argument("--list-cities", action="store_true", help="list city presets and exit")
    ap.add_argument("--lat", type=float, help="custom center latitude")
    ap.add_argument("--lon", type=float, help="custom center longitude")
    ap.add_argument(
        "--timezone",
        dest="timezone_name",
        metavar="IANA_NAME",
        help="custom IANA timezone, for example America/New_York",
    )
    ap.add_argument("--city-name", help="human-readable custom city name")
    ap.add_argument("--city-id", help="filesystem-safe custom city id (slugified)")
    ap.add_argument("--width-m", type=positive_float, help="override tile width in meters")
    ap.add_argument("--height-m", type=positive_float, help="override tile height in meters")
    ap.add_argument("--mesh", type=positive_float, default=MESH)
    ap.add_argument("--solar-year", type=solar_year, default=SOLAR_YEAR)
    ap.add_argument("--meta-canopy", action="store_true",
                    help="merge Meta 1m canopy heights (CC-BY) for real tree shade")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="validate config and print names/timezone offsets without downloads",
    )
    return ap


def print_city_registry(registry):
    width = max(len(city.id) for city in registry.values())
    print("Available city presets:")
    for city in sorted(registry.values(), key=lambda item: item.id):
        print(
            f"  {city.id:<{width}}  {city.name}  "
            f"({city.center_lat:.4f}, {city.center_lon:.4f})  {city.timezone}"
        )


def main(argv=None):
    ap = create_parser()
    args = ap.parse_args(argv)
    try:
        registry = load_city_registry()
    except ValueError as exc:
        ap.error(str(exc))
    if args.list_cities:
        print_city_registry(registry)
        return 0

    try:
        city = resolve_city_options(
            registry,
            city=args.city,
            lat=args.lat,
            lon=args.lon,
            timezone_name=args.timezone_name,
            name=args.city_name,
            city_id=args.city_id,
        )
    except ValueError as exc:
        ap.error(str(exc))

    default_w, default_h = (TEST_W, TEST_H) if args.test else (FULL_W, FULL_H)
    w = args.width_m if args.width_m is not None else default_w
    h = args.height_m if args.height_m is not None else default_h
    names = build_run_names(
        city,
        test=args.test,
        width_m=w,
        height_m=h,
        mesh_m=args.mesh,
    )
    base_key = names.cache_base
    key = names.output_key(args.meta_canopy)
    rect = rectangle_from_center(city.center_lat, city.center_lon, w, h)
    print(f"[city] {city.name} [{city.id}], timezone {city.timezone}")
    print(
        f"[area] {w:g}x{h:g} m around "
        f"({city.center_lat}, {city.center_lon}), mesh {args.mesh:g} m"
    )
    print(f"[names] cache={base_key}, output={key}.json")
    if args.dry_run:
        offsets = utc_offsets_hours(city.timezone, DATES, HOURS, year=args.solar_year)
        summaries = ", ".join(
            f"{date}={sorted({_json_offset(value) for value in values})}"
            for date, values in offsets.items()
        )
        print(f"[timezone] local UTC offsets by sample date: {summaries}")
        return 0

    vc = build_voxcity(rect, args.mesh, base_key)
    if args.meta_canopy:
        vc = apply_meta_canopy(vc, rect, args.mesh, base_key)
    print(f"[voxcity] voxel grid: {vc.voxels.classes.shape}")

    G = get_walk_graph(rect, base_key)  # network is canopy-independent
    print(f"[graph] {len(G.nodes)} nodes, {len(G.edges)} edges")

    sun = sun_positions(rect, city.timezone, year=args.solar_year)

    edge_keys = list(G.edges(keys=True))
    enclosed_edge_reasons = {}
    for edge in edge_keys:
        reason = direct_sun_block_reason(G.edges[edge])
        if reason is not None:
            enclosed_edge_reasons[edge] = reason
    if enclosed_edge_reasons:
        counts = Counter(enclosed_edge_reasons.values())
        print(
            "[graph] forcing zero direct sun for "
            f"{len(enclosed_edge_reasons)} enclosed OSM edges "
            f"(tunnel={counts['tunnel']}, covered={counts['covered']}, "
            f"building_passage={counts['building_passage']})"
        )

    # Unknown raster mappings retain an explicit sentinel on export so neither
    # sun- nor shade-seeking routes mistake missing data for a desired extreme.
    # OSM-enclosed edges are known shade and start at zero for all times.
    edge_exp = initialize_edge_exposure(edge_keys, enclosed_edge_reasons)
    open_air_edges = [edge for edge in edge_keys if edge not in enclosed_edge_reasons]

    samplers = None  # built on the first modeled state, once the grid shape is known
    for d in DATES:
        for i, (hour, az, el) in enumerate(sun[d]):
            sun_state = classify_sun_elevation(el)
            if sun_state != SUN_STATE_MODELED:
                for e in edge_keys:
                    edge_exp[d][e][i] = 0.0
                if sun_state == SUN_STATE_BELOW_HORIZON:
                    print(
                        f"[sun] {d} {hour:02d}:00 sun below horizon "
                        f"(el={el:.1f}) -> 0 direct sun"
                    )
                else:
                    print(
                        f"[sun] {d} {hour:02d}:00 low-sun cutoff "
                        f"(0 < el={el:.1f} < {MIN_SUN_ELEV_DEG:g}) -> 0 direct sun"
                    )
                continue
            emap = exposure_map(vc, az, el)
            if samplers is None:
                samplers = edge_raster_samplers(G, rect, emap.shape)
            vals = sample_edge_exposures(emap, samplers)
            n_valid = 0
            for e in open_air_edges:
                v = vals.get(e)
                if v is not None and not (isinstance(v, float) and math.isnan(v)):
                    edge_exp[d][e][i] = float(min(max(v, 0.0), 1.0))
                    n_valid += 1
            print(
                f"[sun] {d} {hour:02d}:00 az={az:.1f} el={el:.1f} -> "
                f"{n_valid}/{len(open_air_edges)} open-air edges mapped; "
                f"{len(enclosed_edge_reasons)} enclosed edges forced shade"
            )

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
            exp[d] = [
                UNKNOWN_EXPOSURE_SENTINEL if a is None else int(round(a * 100))
                for a in arr
            ]
        edges.append(
            {
                "u": node_ids[u],
                "v": node_ids[v],
                "len": round(float(data.get("length", 0.0)), 1),
                "pts": pts,
                "exp": exp,
            }
        )

    graph_metadata = summarize_graph_exposure(edge_exp, enclosed_edge_reasons)
    graph_metadata["node_count"] = len(nodes)
    print(
        "[quality] "
        f"{graph_metadata['unknown_edge_count']}/{graph_metadata['edge_count']} edges "
        "contain at least one explicitly unknown exposure sample; "
        f"{graph_metadata['unknown_edge_sample_count']}/"
        f"{graph_metadata['exposure_sample_count']} edge-samples unknown"
    )

    out = {
        "meta": build_metadata(
            city,
            rect,
            args.mesh,
            sun,
            solar_year=args.solar_year,
            meta_canopy=args.meta_canopy,
            graph=graph_metadata,
        ),
        "nodes": nodes,
        "edges": edges,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / f"{key}.json"
    payload = json.dumps(out, separators=(",", ":"))
    out_path.write_text(payload)
    with gzip.open(str(out_path) + ".gz", "wt") as f:
        f.write(payload)
    print(f"[done] {out_path} ({out_path.stat().st_size/1e6:.1f} MB, "
          f"{Path(str(out_path)+'.gz').stat().st_size/1e6:.1f} MB gz)")
    return 0


if __name__ == "__main__":
    main()
