"""Cross-check ShadeMax's sampled solar positions against NREL SPA via pvlib.

This validates only the astronomy inputs to ray tracing. It does not validate
the voxel geometry, shadows, walking graph, or route recommendations.

Run from the repository root after installing the optional validation tool:

    uv pip install --python .venv/bin/python pvlib==0.13.1
    .venv/bin/python pipeline/validate_solar.py
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

try:
    from .cities import load_city_registry, local_datetimes_utc
    from .precompute import (
        DATES,
        HOURS,
        MIN_SUN_ELEV_DEG,
        SOLAR_YEAR,
        rectangle_from_center,
        sun_positions,
    )
except ImportError:
    from cities import load_city_registry, local_datetimes_utc
    from precompute import (  # type: ignore[no-redef]
        DATES,
        HOURS,
        MIN_SUN_ELEV_DEG,
        SOLAR_YEAR,
        rectangle_from_center,
        sun_positions,
    )


@dataclass(frozen=True)
class Errors:
    azimuth: np.ndarray
    elevation: np.ndarray


def circular_error_degrees(actual: np.ndarray, reference: np.ndarray) -> np.ndarray:
    """Return the shortest unsigned angular difference in degrees."""
    return np.abs((actual - reference + 180.0) % 360.0 - 180.0)


def validate_city(city, spa_python, year: int) -> Errors:
    rect = rectangle_from_center(city.center_lat, city.center_lon, 600, 600)
    astral = sun_positions(rect, city.timezone, year=year)
    utc = local_datetimes_utc(city.timezone, DATES, HOURS, year=year)

    times = []
    azimuth = []
    elevation = []
    for date in DATES:
        for index, hour in enumerate(HOURS):
            times.append(utc[date][index])
            _, az, el = astral[date][index]
            azimuth.append(az)
            elevation.append(el)

    reference = spa_python(
        pd.DatetimeIndex(times),
        city.center_lat,
        city.center_lon,
        altitude=0,
        pressure=101325,
        temperature=12,
        how="numpy",
    )
    azimuth_array = np.asarray(azimuth)
    elevation_array = np.asarray(elevation)
    # Low-angle samples are intentionally excluded by ShadeMax's model. Compare
    # only the solar positions that can actually feed the ray tracer.
    modeled = elevation_array >= MIN_SUN_ELEV_DEG
    return Errors(
        azimuth=circular_error_degrees(
            azimuth_array[modeled], reference["azimuth"].to_numpy()[modeled]
        ),
        elevation=np.abs(
            elevation_array[modeled]
            - reference["apparent_elevation"].to_numpy()[modeled]
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=SOLAR_YEAR)
    parser.add_argument("--max-azimuth-error", type=float, default=0.1)
    parser.add_argument("--max-elevation-error", type=float, default=0.02)
    args = parser.parse_args()
    if not (1900 <= args.year <= 2100):
        parser.error("--year must be between 1900 and 2100")
    if not math.isfinite(args.max_azimuth_error) or args.max_azimuth_error <= 0:
        parser.error("--max-azimuth-error must be positive and finite")
    if not math.isfinite(args.max_elevation_error) or args.max_elevation_error <= 0:
        parser.error("--max-elevation-error must be positive and finite")

    try:
        from pvlib.solarposition import spa_python
    except ImportError as exc:
        raise SystemExit(
            "pvlib is required for this optional validation; install pvlib==0.13.1"
        ) from exc

    by_city = []
    for city in load_city_registry().values():
        errors = validate_city(city, spa_python, args.year)
        by_city.append(errors)
        print(
            f"{city.id}: {len(errors.azimuth)} modeled samples, "
            f"az max {errors.azimuth.max():.4f}°, "
            f"elevation max {errors.elevation.max():.4f}°"
        )

    azimuth = np.concatenate([item.azimuth for item in by_city])
    elevation = np.concatenate([item.elevation for item in by_city])
    print(
        f"all cities: {len(azimuth)} modeled samples; "
        f"azimuth mean/max {azimuth.mean():.4f}°/{azimuth.max():.4f}°; "
        f"elevation mean/max {elevation.mean():.4f}°/{elevation.max():.4f}°"
    )
    if azimuth.max() > args.max_azimuth_error:
        print(f"FAIL: azimuth error exceeds {args.max_azimuth_error:.4f}°")
        return 1
    if elevation.max() > args.max_elevation_error:
        print(f"FAIL: elevation error exceeds {args.max_elevation_error:.4f}°")
        return 1
    print("PASS: sampled astronomy agrees with NREL SPA within declared thresholds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
