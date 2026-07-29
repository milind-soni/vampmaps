"""Migrate legacy ShadeMax graphs from a 100% exposure fallback to ``-1``.

Older graphs used ``100`` when a modeled raster sample could not be mapped to
an open-air walking edge. That was conservative for shade-only routing, but it
would make missing data attractive to sun-seeking routes. New graphs are
generated with an explicit ``-1`` sentinel; this utility upgrades retained
legacy artifacts without rerunning the ray tracer.

When every always-100 edge is known to be unmapped, the indices can be inferred
strictly from the recorded unknown-edge count. If genuinely always-sunny edges
also exist, provide the verified edge indices explicitly with ``--indices``.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable


UNKNOWN_SENTINEL = -1


def modeled_positions(graph: dict[str, Any]) -> list[tuple[str, int]]:
    meta = graph["meta"]
    states = meta.get("sun_model", {}).get("sample_states", {})
    positions: list[tuple[str, int]] = []
    for date in meta["dates"]:
        date_states = states.get(date)
        if not isinstance(date_states, list) or len(date_states) != len(meta["hours"]):
            raise ValueError(f"missing sample-state metadata for {date}")
        positions.extend(
            (date, index)
            for index, state in enumerate(date_states)
            if state == "modeled"
        )
    if not positions:
        raise ValueError("graph has no modeled solar samples")
    return positions


def infer_unknown_edges(
    graph: dict[str, Any], positions: Iterable[tuple[str, int]]
) -> list[int]:
    sample_positions = list(positions)
    return [
        index
        for index, edge in enumerate(graph["edges"])
        if all(edge["exp"][date][hour_index] == 100 for date, hour_index in sample_positions)
    ]


def migrate_graph(
    graph: dict[str, Any], *, edge_indices: Iterable[int] | None = None
) -> int:
    graph_meta = graph.get("meta", {}).get("graph")
    if not isinstance(graph_meta, dict):
        raise ValueError("graph quality metadata is missing")
    if graph_meta.get("unknown_exposure_sentinel") == UNKNOWN_SENTINEL:
        return 0
    if graph_meta.get("unknown_exposure_fallback_pct") != 100:
        raise ValueError("graph does not declare the legacy 100% unknown fallback")

    positions = modeled_positions(graph)
    expected_edges = graph_meta.get("unknown_edge_count")
    expected_samples = graph_meta.get("unknown_edge_sample_count")
    if not isinstance(expected_edges, int) or not isinstance(expected_samples, int):
        raise ValueError("unknown-edge counts are missing")

    if edge_indices is None:
        indices = infer_unknown_edges(graph, positions)
        if len(indices) != expected_edges:
            raise ValueError(
                f"found {len(indices)} always-sunny candidates for {expected_edges} unknown "
                "edges; pass verified --indices"
            )
    else:
        indices = list(edge_indices)

    if len(indices) != len(set(indices)):
        raise ValueError("edge indices must be unique")
    if len(indices) != expected_edges:
        raise ValueError(f"received {len(indices)} indices for {expected_edges} unknown edges")

    migrated_samples = 0
    for edge_index in indices:
        if not 0 <= edge_index < len(graph["edges"]):
            raise ValueError(f"edge index is out of range: {edge_index}")
        exposure = graph["edges"][edge_index]["exp"]
        for date, hour_index in positions:
            if exposure[date][hour_index] != 100:
                raise ValueError(
                    f"edge {edge_index} sample {date}[{hour_index}] is not the legacy fallback"
                )
            exposure[date][hour_index] = UNKNOWN_SENTINEL
            migrated_samples += 1

    if migrated_samples != expected_samples:
        raise ValueError(
            f"migrated {migrated_samples} samples, expected {expected_samples}"
        )
    graph_meta.pop("unknown_exposure_fallback_pct", None)
    graph_meta["unknown_exposure_sentinel"] = UNKNOWN_SENTINEL
    return migrated_samples


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as temporary:
            temporary.write(data)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def migrate_file(path: Path, *, edge_indices: Iterable[int] | None = None) -> int:
    graph = json.loads(path.read_text(encoding="utf-8"))
    migrated = migrate_graph(graph, edge_indices=edge_indices)
    if migrated == 0:
        return 0
    encoded = json.dumps(graph, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    _atomic_write(path, encoded)
    gzip_path = path.with_suffix(path.suffix + ".gz")
    if gzip_path.exists():
        _atomic_write(gzip_path, gzip.compress(encoded, mtime=0))
    return migrated


def _indices(value: str) -> list[int]:
    try:
        return [int(item) for item in value.split(",") if item.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("indices must be comma-separated integers") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="legacy graph JSON to migrate in place")
    parser.add_argument(
        "--indices",
        type=_indices,
        help="verified comma-separated unknown edge indices; otherwise infer strictly",
    )
    args = parser.parse_args()
    migrated = migrate_file(args.path, edge_indices=args.indices)
    print(f"{args.path}: migrated {migrated} unknown exposure samples")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
