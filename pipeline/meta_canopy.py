"""Fetch Meta/WRI 1m Global Canopy Height (CC-BY 4.0) for a bbox — no Earth Engine.

Tiles are zoom-9 quadkey COGs (EPSG:3857, ~1.19m px, uint8 meters) in the
public dataforgood-fb-data S3 bucket. We do windowed HTTP range reads of just
the target bbox and write a small local GeoTIFF.

Dataset: https://registry.opendata.aws/dataforgood-fb-forests/
Citation: Tolan et al. (2024), "Very high resolution canopy height maps from
RGB imagery using self-supervised vision transformer and convolutional
decoder trained on aerial lidar".
"""

import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
from rasterio.windows import from_bounds as window_from_bounds

BASE_URL = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"
ZOOM = 9
NATIVE_RES = 1.1943285669558747  # meters at equator (EPSG:3857)


def _quadkey(tx: int, ty: int, zoom: int) -> str:
    qk = ""
    for i in range(zoom, 0, -1):
        digit, mask = 0, 1 << (i - 1)
        if tx & mask:
            digit += 1
        if ty & mask:
            digit += 2
        qk += str(digit)
    return qk


def _tile_xy(lat: float, lon: float, zoom: int) -> tuple:
    x = int((lon + 180) / 360 * (1 << zoom))
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * (1 << zoom))
    return x, y


def quadkeys_for_bbox(west, south, east, north) -> list:
    x0, y0 = _tile_xy(north, west, ZOOM)  # y grows southward
    x1, y1 = _tile_xy(south, east, ZOOM)
    return [
        _quadkey(tx, ty, ZOOM)
        for tx in range(min(x0, x1), max(x0, x1) + 1)
        for ty in range(min(y0, y1), max(y0, y1) + 1)
    ]


def fetch_meta_canopy_tif(rectangle_vertices, out_path, margin_m=60.0) -> str:
    """Download canopy heights for the rectangle into a local GeoTIFF (EPSG:3857)."""
    out_path = Path(out_path)
    if out_path.exists():
        print(f"[canopy] cache hit: {out_path}")
        return str(out_path)

    lons = [p[0] for p in rectangle_vertices]
    lats = [p[1] for p in rectangle_vertices]
    west, south, east, north = min(lons), min(lats), max(lons), max(lats)

    # target bounds in 3857 with margin
    wx, sy, ex, ny = transform_bounds("EPSG:4326", "EPSG:3857", west, south, east, north)
    wx, sy, ex, ny = wx - margin_m, sy - margin_m, ex + margin_m, ny + margin_m

    width = int(math.ceil((ex - wx) / NATIVE_RES))
    height = int(math.ceil((ny - sy) / NATIVE_RES))
    dst_transform = from_origin(wx, ny, NATIVE_RES, NATIVE_RES)
    mosaic = np.zeros((height, width), dtype=np.uint8)

    qks = quadkeys_for_bbox(west, south, east, north)
    print(f"[canopy] fetching {len(qks)} Meta CHM tile(s): {qks}")
    for qk in qks:
        url = f"{BASE_URL}/{qk}.tif"
        with rasterio.open(url) as src:
            win = window_from_bounds(wx, sy, ex, ny, src.transform)
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            if win.width <= 0 or win.height <= 0:
                continue
            data = src.read(1, window=win)
            reproject(
                source=data,
                destination=mosaic,
                src_transform=src.window_transform(win),
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs="EPSG:3857",
                resampling=Resampling.max,
                dst_nodata=None,
                init_dest_nodata=False,
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs="EPSG:3857",
        transform=dst_transform,
        compress="deflate",
    ) as dst:
        dst.write(mosaic, 1)

    pct_tree = 100 * float((mosaic >= 2).sum()) / mosaic.size
    print(f"[canopy] wrote {out_path} ({width}x{height} px, {pct_tree:.1f}% cells >= 2 m)")
    return str(out_path)
