"""City configuration and timezone helpers for the shade precompute pipeline.

This module intentionally uses only the Python standard library so city
selection, naming, and timezone behavior can be tested without importing
VoxCity or making network requests.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


REPO_DIR = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY_PATH = REPO_DIR / "data" / "cities" / "registry.json"
DEFAULT_CITY_ID = "singapore-cbd"
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def slugify(value: str) -> str:
    """Return a stable, filesystem-safe ASCII slug."""
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")


def _validate_timezone(name: str) -> None:
    if not name or name.startswith("/") or ".." in name:
        raise ValueError(f"invalid IANA timezone: {name!r}")
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"unknown IANA timezone: {name!r}") from exc


@dataclass(frozen=True)
class CityConfig:
    """A geographic center and the civil-time rules used for solar samples."""

    id: str
    name: str
    center_lat: float
    center_lon: float
    timezone: str
    file_prefix: str
    aliases: tuple[str, ...] = ()
    custom: bool = False

    def __post_init__(self) -> None:
        if not _SLUG_RE.fullmatch(self.id):
            raise ValueError(f"city id must be a lowercase slug: {self.id!r}")
        if not self.name.strip():
            raise ValueError("city name cannot be empty")
        # Web Mercator and the canopy dataset stop near +/-85 degrees.
        if not -85.0 <= self.center_lat <= 85.0:
            raise ValueError("latitude must be between -85 and 85 degrees")
        if not -180.0 <= self.center_lon <= 180.0:
            raise ValueError("longitude must be between -180 and 180 degrees")
        if not _SLUG_RE.fullmatch(self.file_prefix):
            raise ValueError(f"file prefix must be a lowercase slug: {self.file_prefix!r}")
        _validate_timezone(self.timezone)
        for alias in self.aliases:
            if not _SLUG_RE.fullmatch(alias):
                raise ValueError(f"city alias must be a lowercase slug: {alias!r}")

    @classmethod
    def from_mapping(cls, raw: Mapping[str, object]) -> "CityConfig":
        center = raw.get("center")
        if not isinstance(center, Mapping):
            raise ValueError("city center must be an object containing lat and lon")
        aliases = raw.get("aliases", ())
        if not isinstance(aliases, list) or not all(isinstance(v, str) for v in aliases):
            raise ValueError("city aliases must be an array of strings")
        try:
            return cls(
                id=str(raw["id"]),
                name=str(raw["name"]),
                center_lat=float(center["lat"]),
                center_lon=float(center["lon"]),
                timezone=str(raw["timezone"]),
                file_prefix=str(raw.get("file_prefix", raw["id"])),
                aliases=tuple(aliases),
            )
        except KeyError as exc:
            raise ValueError(f"missing city field: {exc.args[0]}") from exc


def load_city_registry(path: Path = DEFAULT_REGISTRY_PATH) -> dict[str, CityConfig]:
    """Load and validate the canonical registry keyed by city id."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"city registry not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid city registry JSON at {path}: {exc}") from exc

    if not isinstance(raw, Mapping):
        raise ValueError("city registry root must be an object")
    if raw.get("schema_version") != 1 or not isinstance(raw.get("cities"), list):
        raise ValueError("city registry must use schema_version 1 and contain a cities array")

    cities: dict[str, CityConfig] = {}
    lookup_names: set[str] = set()
    file_prefixes: set[str] = set()
    for index, item in enumerate(raw["cities"]):
        if not isinstance(item, Mapping):
            raise ValueError(f"city entry {index} must be an object")
        try:
            city = CityConfig.from_mapping(item)
        except ValueError as exc:
            raise ValueError(f"invalid city entry {index}: {exc}") from exc
        names = {city.id, *city.aliases}
        duplicate_names = names & lookup_names
        if duplicate_names:
            raise ValueError(f"duplicate city id or alias: {sorted(duplicate_names)[0]}")
        if city.file_prefix in file_prefixes:
            raise ValueError(f"duplicate city file prefix: {city.file_prefix}")
        cities[city.id] = city
        lookup_names.update(names)
        file_prefixes.add(city.file_prefix)

    if DEFAULT_CITY_ID not in cities:
        raise ValueError(f"city registry must contain the default city {DEFAULT_CITY_ID!r}")
    return cities


def find_city(registry: Mapping[str, CityConfig], city_id_or_alias: str) -> CityConfig:
    """Resolve a canonical city id or configured alias."""
    key = city_id_or_alias.strip().lower()
    for city in registry.values():
        if key == city.id or key in city.aliases:
            return city
    available = ", ".join(sorted(registry))
    raise ValueError(f"unknown city {city_id_or_alias!r}; available cities: {available}")


def _coordinate_slug(lat: float, lon: float) -> str:
    lat_part = f"{'n' if lat >= 0 else 's'}{abs(lat):08.4f}".replace(".", "p")
    lon_part = f"{'e' if lon >= 0 else 'w'}{abs(lon):09.4f}".replace(".", "p")
    return f"custom-{lat_part}-{lon_part}"


def make_custom_city(
    *,
    lat: float,
    lon: float,
    timezone_name: str,
    name: str | None = None,
    city_id: str | None = None,
) -> CityConfig:
    """Create a validated ad-hoc city configuration from CLI values."""
    display_name = (name or "Custom location").strip()
    if not display_name:
        raise ValueError("custom city name cannot be empty")
    candidate = slugify(city_id) if city_id else ""
    if city_id and not candidate:
        raise ValueError("custom city id must contain a letter or number")
    identifier = candidate or _coordinate_slug(lat, lon)
    return CityConfig(
        id=identifier,
        name=display_name,
        center_lat=float(lat),
        center_lon=float(lon),
        timezone=timezone_name,
        file_prefix=identifier,
        custom=True,
    )


def resolve_city_options(
    registry: Mapping[str, CityConfig],
    *,
    city: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    timezone_name: str | None = None,
    name: str | None = None,
    city_id: str | None = None,
) -> CityConfig:
    """Resolve mutually exclusive preset or custom-location CLI options."""
    custom_values = (lat, lon, timezone_name, name, city_id)
    has_custom_value = any(value is not None for value in custom_values)
    if city is not None and has_custom_value:
        raise ValueError("--city cannot be combined with custom location options")
    if city is not None:
        return find_city(registry, city)
    if not has_custom_value:
        return find_city(registry, DEFAULT_CITY_ID)
    if lat is None or lon is None:
        raise ValueError("custom locations require both --lat and --lon")
    if timezone_name is None:
        raise ValueError("custom locations require --timezone with an IANA name")
    return make_custom_city(
        lat=lat,
        lon=lon,
        timezone_name=timezone_name,
        name=name,
        city_id=city_id,
    )


def local_datetimes_utc(
    timezone_name: str,
    dates: Iterable[str],
    hours: Sequence[int],
    *,
    year: int,
) -> dict[str, list[datetime]]:
    """Convert local civil-time samples to UTC using historical IANA rules."""
    _validate_timezone(timezone_name)
    zone = ZoneInfo(timezone_name)
    result: dict[str, list[datetime]] = {}
    for date in dates:
        try:
            month, day = (int(part) for part in date.split("-"))
        except (ValueError, TypeError) as exc:
            raise ValueError(f"date must use MM-DD format: {date!r}") from exc
        samples = []
        for hour in hours:
            if not 0 <= hour <= 23:
                raise ValueError(f"hour must be between 0 and 23: {hour}")
            local = datetime(year, month, day, hour, tzinfo=zone)
            samples.append(local.astimezone(timezone.utc))
        result[date] = samples
    return result


def utc_offsets_hours(
    timezone_name: str,
    dates: Iterable[str],
    hours: Sequence[int],
    *,
    year: int,
) -> dict[str, list[float]]:
    """Return the UTC offset for every local sample (including DST changes)."""
    _validate_timezone(timezone_name)
    zone = ZoneInfo(timezone_name)
    result: dict[str, list[float]] = {}
    for date in dates:
        month, day = (int(part) for part in date.split("-"))
        offsets: list[float] = []
        for hour in hours:
            offset = datetime(year, month, day, hour, tzinfo=zone).utcoffset()
            if offset is None:  # pragma: no cover - ZoneInfo always has an offset
                raise ValueError(f"timezone has no UTC offset: {timezone_name}")
            offsets.append(offset.total_seconds() / 3600)
        result[date] = offsets
    return result


def current_utc_offset_hours(timezone_name: str, at: datetime | None = None) -> float:
    """Compatibility offset for clients that have not adopted the IANA field."""
    _validate_timezone(timezone_name)
    instant = at or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        raise ValueError("offset instant must be timezone-aware")
    offset = instant.astimezone(ZoneInfo(timezone_name)).utcoffset()
    if offset is None:  # pragma: no cover - ZoneInfo always has an offset
        raise ValueError(f"timezone has no UTC offset: {timezone_name}")
    return offset.total_seconds() / 3600


@dataclass(frozen=True)
class RunNames:
    """Stable output and cache stems for one precompute run."""

    output_base: str
    cache_base: str

    def output_key(self, meta_canopy: bool) -> str:
        return self.output_base + ("_canopy" if meta_canopy else "")


def build_run_names(
    city: CityConfig,
    *,
    test: bool,
    width_m: float,
    height_m: float,
    mesh_m: float,
) -> RunNames:
    """Build city-scoped names while retaining Singapore's legacy filenames."""
    if width_m <= 0 or height_m <= 0 or mesh_m <= 0:
        raise ValueError("width, height, and mesh must be positive")

    def number(value: float) -> str:
        return f"{value:g}"

    scope = "test" if test else "full"
    stem = (
        f"{city.file_prefix}_{scope}_{number(width_m)}x{number(height_m)}"
        f"_m{number(mesh_m)}"
    )
    cache_stem = stem
    if city.custom:
        identity = f"{city.center_lat:.8f}|{city.center_lon:.8f}|{city.timezone}"
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:10]
        cache_stem = f"{stem}_{digest}"
    return RunNames(output_base=stem, cache_base=cache_stem)
