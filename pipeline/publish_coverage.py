"""Publish precomputed ShadeMax graphs as static, content-addressed area bundles.

The output is deliberately host-agnostic: ``manifest.json`` only contains
relative bundle URLs, so the directory can be copied to any HTTPS static host
or CDN. Bundles are immutable and the manifest is replaced last, making the
manifest the atomic commit point for a publication.

Examples:
    python pipeline/publish_coverage.py
    python pipeline/publish_coverage.py --output /tmp/shademax-coverage
    python pipeline/publish_coverage.py --source data/my-area.json
    python pipeline/publish_coverage.py --source my-area=data/my-area.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


REPO_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO_DIR / "dist" / "coverage"
MANIFEST_SCHEMA_VERSION = 1
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@dataclass(frozen=True)
class AreaSource:
    """One graph plus the small amount of copy needed by the area picker."""

    path: Path
    id: str | None = None
    name: str | None = None
    district: str = ""
    coverage: str = "Modeled walking area"
    search_bias: str | None = None


@dataclass(frozen=True)
class _DefaultArea:
    id: str
    name: str
    district: str
    coverage: str
    search_bias: str
    candidates: tuple[str, ...]


_DEFAULT_AREAS = (
    _DefaultArea(
        id="singapore-cbd",
        name="Singapore",
        district="CBD · Chinatown · Marina Bay",
        coverage="2 km test area",
        search_bias="Singapore CBD, Singapore",
        candidates=(
            "data/sg_full_2000x2000_m2_canopy.json",
            "app/assets/singapore.json",
        ),
    ),
    _DefaultArea(
        id="new-york-midtown",
        name="New York",
        district="Midtown Manhattan",
        coverage="600 m evaluation tile",
        search_bias="Midtown Manhattan, New York, USA",
        candidates=(
            "data/new-york-midtown_test_600x600_m2_canopy.json",
            "app/assets/new-york.json",
        ),
    ),
    _DefaultArea(
        id="sydney-cbd",
        name="Sydney",
        district="CBD",
        coverage="600 m evaluation tile",
        search_bias="Sydney CBD, Australia",
        candidates=(
            "data/sydney-cbd_test_600x600_m2_canopy.json",
            "app/assets/sydney.json",
        ),
    ),
)


def default_area_sources(repo_dir: Path = REPO_DIR) -> list[AreaSource]:
    """Resolve the app's current areas, preferring canonical pipeline output."""
    sources: list[AreaSource] = []
    missing: list[str] = []
    for area in _DEFAULT_AREAS:
        path = next(
            (repo_dir / candidate for candidate in area.candidates if (repo_dir / candidate).is_file()),
            None,
        )
        if path is None:
            missing.append(f"{area.id}: {', '.join(area.candidates)}")
            continue
        sources.append(
            AreaSource(
                path=path,
                id=area.id,
                name=area.name,
                district=area.district,
                coverage=area.coverage,
                search_bias=area.search_bias,
            )
        )
    if missing:
        raise ValueError("missing graph source(s):\n  " + "\n  ".join(missing))
    return sources


def _fail(path: Path, message: str) -> ValueError:
    return ValueError(f"invalid coverage graph {path}: {message}")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_non_finite(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value}")


def _read_graph(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"cannot read coverage graph {path}: {exc}") from exc
    try:
        graph = json.loads(
            raw,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite,
        )
    except (json.JSONDecodeError, UnicodeError, ValueError) as exc:
        raise _fail(path, f"malformed JSON ({exc})") from exc
    if not isinstance(graph, dict):
        raise _fail(path, "root must be an object")
    return graph


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _coordinates(value: object, *, size: int, label: str, path: Path) -> list[float]:
    if not isinstance(value, list) or len(value) != size or not all(_is_number(v) for v in value):
        raise _fail(path, f"{label} must contain {size} finite numbers")
    return [float(v) for v in value]


def _validate_graph(graph: Mapping[str, Any], source: AreaSource) -> dict[str, Any]:
    path = source.path
    meta = graph.get("meta")
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(meta, dict):
        raise _fail(path, "meta must be an object")
    if not isinstance(nodes, list) or not nodes:
        raise _fail(path, "nodes must be a non-empty array")
    if not isinstance(edges, list) or not edges:
        raise _fail(path, "edges must be a non-empty array")

    city_id = meta.get("city")
    if not isinstance(city_id, str) or not _SLUG_RE.fullmatch(city_id):
        raise _fail(path, "meta.city must be a lowercase slug")
    if source.id is not None and city_id != source.id:
        raise _fail(path, f"meta.city is {city_id!r}, expected {source.id!r}")

    timezone_name = meta.get("timezone")
    if not isinstance(timezone_name, str) or not timezone_name:
        raise _fail(path, "meta.timezone must be a non-empty IANA timezone")
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise _fail(path, f"unknown IANA timezone {timezone_name!r}") from exc

    center = _coordinates(meta.get("center"), size=2, label="meta.center", path=path)
    bbox = _coordinates(meta.get("bbox"), size=4, label="meta.bbox", path=path)
    if not -180 <= center[0] <= 180 or not -90 <= center[1] <= 90:
        raise _fail(path, "meta.center must be [longitude, latitude]")
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise _fail(path, "meta.bbox must be [west, south, east, north]")

    hours = meta.get("hours")
    if (
        not isinstance(hours, list)
        or not hours
        or any(isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 23 for hour in hours)
        or len(set(hours)) != len(hours)
    ):
        raise _fail(path, "meta.hours must contain unique integer hours from 0 through 23")
    dates = meta.get("dates")
    if (
        not isinstance(dates, list)
        or not dates
        or any(not isinstance(date, str) or not date for date in dates)
        or len(set(dates)) != len(dates)
    ):
        raise _fail(path, "meta.dates must contain unique non-empty strings")

    for index, node in enumerate(nodes):
        lon, lat = _coordinates(node, size=2, label=f"nodes[{index}]", path=path)
        if not -180 <= lon <= 180 or not -90 <= lat <= 90:
            raise _fail(path, f"nodes[{index}] is outside valid longitude/latitude bounds")

    node_count = len(nodes)
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise _fail(path, f"edges[{index}] must be an object")
        for endpoint in ("u", "v"):
            node_id = edge.get(endpoint)
            if isinstance(node_id, bool) or not isinstance(node_id, int) or not 0 <= node_id < node_count:
                raise _fail(path, f"edges[{index}].{endpoint} must reference a node")
        length = edge.get("len")
        if not _is_number(length) or length < 0:
            raise _fail(path, f"edges[{index}].len must be a non-negative finite number")
        points = edge.get("pts")
        if not isinstance(points, list) or len(points) < 2:
            raise _fail(path, f"edges[{index}].pts must contain at least two coordinates")
        for point_index, point in enumerate(points):
            _coordinates(point, size=2, label=f"edges[{index}].pts[{point_index}]", path=path)
        exposure = edge.get("exp")
        if not isinstance(exposure, dict):
            raise _fail(path, f"edges[{index}].exp must be an object")
        for date in dates:
            samples = exposure.get(date)
            if not isinstance(samples, list) or len(samples) != len(hours):
                raise _fail(path, f"edges[{index}].exp[{date!r}] must match meta.hours")
            if any(not _is_number(sample) or not -1 <= sample <= 100 for sample in samples):
                raise _fail(
                    path,
                    f"edges[{index}].exp[{date!r}] must contain -1 for unknown or values from 0 through 100",
                )

    city_name = meta.get("city_name")
    if source.name is None and (not isinstance(city_name, str) or not city_name.strip()):
        raise _fail(path, "meta.city_name is required when no display name is configured")
    return {
        "id": city_id,
        "name": source.name or city_name.strip(),
        "district": source.district,
        "timezone": timezone_name,
        "coverage": source.coverage,
        "searchBias": source.search_bias or source.name or city_name.strip(),
        "center": center,
        "bbox": bbox,
        "nodeCount": node_count,
        "edgeCount": len(edges),
    }


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _manifest_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _utc_generated_at(value: str | None) -> str:
    if value is None:
        epoch = os.environ.get("SOURCE_DATE_EPOCH")
        if epoch is not None:
            try:
                instant = datetime.fromtimestamp(int(epoch), timezone.utc)
            except (ValueError, OverflowError) as exc:
                raise ValueError("SOURCE_DATE_EPOCH must be a valid integer timestamp") from exc
        else:
            instant = datetime.now(timezone.utc)
    else:
        try:
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("--generated-at must be an ISO 8601 timestamp") from exc
        if instant.tzinfo is None:
            raise ValueError("--generated-at must include a timezone")
        instant = instant.astimezone(timezone.utc)
    return instant.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        _fsync_directory(path.parent)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_immutable(path: Path, payload: bytes) -> None:
    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError as exc:
            raise ValueError(f"cannot inspect existing bundle {path}: {exc}") from exc
        if existing != payload:
            raise ValueError(f"immutable bundle collision at {path}")
        return
    _atomic_write(path, payload)


def publish_coverage(
    sources: Sequence[AreaSource],
    output_dir: Path,
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Validate, package, and atomically publish an area manifest.

    All inputs are validated and packaged before the output directory is
    touched. Content-addressed bundles are committed first; ``manifest.json``
    is atomically replaced last so readers never discover missing bundles.
    Superseded bundles are intentionally retained for in-flight clients.
    """
    if not sources:
        raise ValueError("at least one coverage graph source is required")

    planned: list[tuple[str, bytes, dict[str, Any]]] = []
    seen_ids: set[str] = set()
    for source in sources:
        graph = _read_graph(source.path)
        entry = _validate_graph(graph, source)
        area_id = entry["id"]
        if area_id in seen_ids:
            raise ValueError(f"duplicate coverage area id {area_id!r}")
        seen_ids.add(area_id)

        payload = _canonical_json(graph)
        digest = hashlib.sha256(payload).hexdigest()
        filename = f"{area_id}.{digest[:16]}.json"
        entry.update(
            {
                "version": digest,
                "bytes": len(payload),
                "sha256": digest,
                "bundleUrl": f"bundles/{filename}",
                "mediaType": "application/json",
            }
        )
        planned.append((filename, payload, entry))

    planned.sort(key=lambda item: item[2]["id"])
    manifest: dict[str, Any] = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "generatedAt": _utc_generated_at(generated_at),
        "areas": [entry for _, _, entry in planned],
    }

    output_dir = Path(output_dir)
    bundles_dir = output_dir / "bundles"
    for filename, payload, _ in planned:
        _write_immutable(bundles_dir / filename, payload)
    _atomic_write(output_dir / "manifest.json", _manifest_json(manifest))
    return manifest


def _source_from_cli(value: str) -> AreaSource:
    expected_id: str | None = None
    path_value = value
    if "=" in value:
        candidate, remainder = value.split("=", 1)
        if _SLUG_RE.fullmatch(candidate):
            expected_id = candidate
            path_value = remainder
    if not path_value:
        raise argparse.ArgumentTypeError("source path cannot be empty")

    path = Path(path_value).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    defaults = {area.id: area for area in _DEFAULT_AREAS}
    metadata = defaults.get(expected_id or "")
    if metadata is None:
        return AreaSource(path=path, id=expected_id)
    return AreaSource(
        path=path,
        id=metadata.id,
        name=metadata.name,
        district=metadata.district,
        coverage=metadata.coverage,
        search_bias=metadata.search_bias,
    )


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"static output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--source",
        action="append",
        type=_source_from_cli,
        metavar="[AREA_ID=]GRAPH.json",
        help="publish this graph; repeat for multiple areas (defaults to current app areas)",
    )
    parser.add_argument(
        "--generated-at",
        help="ISO 8601 build timestamp; SOURCE_DATE_EPOCH is also supported",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        sources = args.source or default_area_sources()
        manifest = publish_coverage(sources, args.output, generated_at=args.generated_at)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    total_bytes = sum(area["bytes"] for area in manifest["areas"])
    print(f"Published {len(manifest['areas'])} area(s), {total_bytes:,} bytes")
    print(Path(args.output).resolve() / "manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
