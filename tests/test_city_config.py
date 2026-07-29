from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone

from pipeline.cities import (
    DEFAULT_CITY_ID,
    build_run_names,
    find_city,
    load_city_registry,
    local_datetimes_utc,
    make_custom_city,
    resolve_city_options,
    utc_offsets_hours,
)
from pipeline import precompute


class CityRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = load_city_registry()

    def test_default_preserves_singapore_configuration(self):
        city = self.registry[DEFAULT_CITY_ID]
        self.assertEqual(city.id, "singapore-cbd")
        self.assertEqual(city.file_prefix, "sg")
        self.assertEqual(city.center_lat, precompute.CENTER_LAT)
        self.assertEqual(city.center_lon, precompute.CENTER_LON)
        self.assertEqual(city.timezone, "Asia/Singapore")

    def test_aliases_resolve_to_canonical_entries(self):
        self.assertEqual(find_city(self.registry, "SG").id, "singapore-cbd")
        self.assertEqual(find_city(self.registry, "nyc").id, "new-york-midtown")

    def test_registry_covers_multiple_hemispheres_and_timezones(self):
        self.assertGreaterEqual(len(self.registry), 8)
        self.assertTrue(any(city.center_lat < 0 for city in self.registry.values()))
        self.assertTrue(any(city.center_lat > 0 for city in self.registry.values()))
        self.assertTrue(any(city.center_lon < 0 for city in self.registry.values()))
        self.assertTrue(any(city.center_lon > 0 for city in self.registry.values()))


class CitySelectionAndNamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = load_city_registry()

    def test_no_options_selects_default_city(self):
        city = resolve_city_options(self.registry)
        self.assertEqual(city.id, DEFAULT_CITY_ID)

    def test_legacy_singapore_names_are_byte_for_byte_compatible(self):
        names = build_run_names(
            self.registry[DEFAULT_CITY_ID],
            test=True,
            width_m=600,
            height_m=600,
            mesh_m=2,
        )
        self.assertEqual(names.cache_base, "sg_test_600x600_m2")
        self.assertEqual(names.output_key(False), "sg_test_600x600_m2")
        self.assertEqual(names.output_key(True), "sg_test_600x600_m2_canopy")

    def test_other_city_names_are_city_scoped(self):
        city = find_city(self.registry, "tokyo")
        names = build_run_names(
            city,
            test=False,
            width_m=2000,
            height_m=2000,
            mesh_m=2,
        )
        self.assertEqual(names.output_base, "tokyo-shibuya_full_2000x2000_m2")
        self.assertEqual(names.cache_base, names.output_base)

    def test_custom_cache_identity_changes_with_coordinates(self):
        first = make_custom_city(
            lat=40.7128,
            lon=-74.006,
            timezone_name="America/New_York",
            name="My test tile",
            city_id="my-tile",
        )
        second = make_custom_city(
            lat=40.7138,
            lon=-74.006,
            timezone_name="America/New_York",
            name="My test tile",
            city_id="my-tile",
        )
        first_names = build_run_names(
            first, test=True, width_m=600, height_m=600, mesh_m=2
        )
        second_names = build_run_names(
            second, test=True, width_m=600, height_m=600, mesh_m=2
        )
        self.assertEqual(first_names.output_base, second_names.output_base)
        self.assertNotEqual(first_names.cache_base, second_names.cache_base)

    def test_custom_location_requires_complete_coordinates_and_timezone(self):
        with self.assertRaisesRegex(ValueError, "both --lat and --lon"):
            resolve_city_options(self.registry, lat=40.0, timezone_name="UTC")
        with self.assertRaisesRegex(ValueError, "require --timezone"):
            resolve_city_options(self.registry, lat=40.0, lon=-74.0)
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            resolve_city_options(
                self.registry,
                city="singapore",
                lat=1.0,
                lon=2.0,
                timezone_name="UTC",
            )

    def test_unknown_timezone_is_rejected_before_pipeline_work(self):
        with self.assertRaisesRegex(ValueError, "unknown IANA timezone"):
            make_custom_city(
                lat=0,
                lon=0,
                timezone_name="Not/A_Timezone",
            )


class TimezoneTests(unittest.TestCase):
    def test_singapore_samples_match_the_legacy_fixed_offset_instants(self):
        samples = local_datetimes_utc(
            "Asia/Singapore", ["03-21"], precompute.HOURS, year=2025
        )
        self.assertEqual(
            samples["03-21"][0], datetime(2025, 3, 21, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            samples["03-21"][-1], datetime(2025, 3, 21, 11, tzinfo=timezone.utc)
        )

    def test_new_york_local_noon_uses_dst_rules(self):
        samples = local_datetimes_utc(
            "America/New_York", ["06-21", "12-21"], [12], year=2025
        )
        self.assertEqual(samples["06-21"][0].hour, 16)  # EDT = UTC-4
        self.assertEqual(samples["12-21"][0].hour, 17)  # EST = UTC-5

    def test_fractional_iana_offset_is_preserved(self):
        offsets = utc_offsets_hours("Asia/Kathmandu", ["03-21"], [8, 12], year=2025)
        self.assertEqual(offsets["03-21"], [5.75, 5.75])

    def test_southern_hemisphere_dst_seasons_are_not_reversed(self):
        offsets = utc_offsets_hours(
            "Australia/Sydney", ["06-21", "12-21"], [12], year=2025
        )
        self.assertEqual(offsets["06-21"], [10.0])
        self.assertEqual(offsets["12-21"], [11.0])


class MetadataAndCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = load_city_registry()

    def test_metadata_includes_human_name_and_authoritative_timezone(self):
        city = find_city(self.registry, "nyc")
        rect = precompute.rectangle_from_center(city.center_lat, city.center_lon, 600, 600)
        sun = {
            date: [(hour, 0.0, 0.0) for hour in precompute.HOURS]
            for date in precompute.DATES
        }
        meta = precompute.build_metadata(
            city,
            rect,
            2.0,
            sun,
            solar_year=2025,
            generated_at=datetime(2025, 7, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(meta["city"], "new-york-midtown")
        self.assertEqual(meta["city_name"], "New York — Midtown Manhattan")
        self.assertEqual(meta["timezone"], "America/New_York")
        self.assertEqual(meta["tz_offset_hours"], -4)  # legacy compatibility field
        self.assertEqual(set(meta["utc_offsets_hours"]["06-21"]), {-4})
        self.assertEqual(set(meta["utc_offsets_hours"]["12-21"]), {-5})

    def test_singapore_metadata_retains_existing_required_fields(self):
        city = find_city(self.registry, "sg")
        rect = precompute.rectangle_from_center(city.center_lat, city.center_lon, 600, 600)
        sun = {
            date: [(hour, 0.0, 0.0) for hour in precompute.HOURS]
            for date in precompute.DATES
        }
        meta = precompute.build_metadata(
            city,
            rect,
            2.0,
            sun,
            generated_at=datetime(2025, 7, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(meta["city"], "singapore-cbd")
        self.assertEqual(meta["hours"], precompute.HOURS)
        self.assertEqual(meta["dates"], precompute.DATES)
        self.assertEqual(meta["tz_offset_hours"], 8)
        self.assertEqual(meta["mesh_m"], 2.0)
        self.assertEqual(meta["requested_view_height_m"], precompute.VIEW_HEIGHT)
        self.assertEqual(meta["view_height_m"], 2.0)
        self.assertEqual(meta["view_height_voxels"], 1)

    def test_dry_run_resolves_city_without_voxcity_or_network(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = precompute.main(["--city", "london", "--test", "--dry-run"])
        self.assertEqual(result, 0)
        self.assertIn("London — Westminster", output.getvalue())
        self.assertIn("london-westminster_test_600x600_m2", output.getvalue())
        self.assertIn("12-21=[0]", output.getvalue())


if __name__ == "__main__":
    unittest.main()
