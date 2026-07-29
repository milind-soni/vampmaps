from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from pipeline import precompute
from pipeline.cities import find_city, load_city_registry


class ObserverHeightTests(unittest.TestCase):
    def test_default_mesh_represents_pedestrian_above_ground(self):
        observer = precompute.observer_height_model(precompute.MESH)

        self.assertEqual(observer["requested_m"], 1.5)
        self.assertEqual(observer["voxel_offset"], 1)
        self.assertEqual(observer["modeled_m"], 2.0)
        self.assertEqual(
            int(observer["trace_parameter_m"] / precompute.MESH),
            observer["voxel_offset"],
        )

    def test_height_on_a_voxel_boundary_is_not_rounded_twice(self):
        observer = precompute.observer_height_model(0.5, requested_height=1.5)

        self.assertEqual(observer["voxel_offset"], 3)
        self.assertEqual(observer["modeled_m"], 1.5)

    def test_exposure_map_passes_representable_height_to_voxcity(self):
        vc = SimpleNamespace(
            voxels=SimpleNamespace(meta=SimpleNamespace(meshsize=2.0))
        )
        captured = {}

        def fake_irradiance(*args, **kwargs):
            captured.update(kwargs)
            return "exposure-grid"

        result = precompute.exposure_map(
            vc,
            120.0,
            30.0,
            irradiance_fn=fake_irradiance,
        )

        self.assertEqual(result, "exposure-grid")
        self.assertEqual(int(captured["view_point_height"] / 2.0), 1)
        self.assertAlmostEqual(captured["direct_normal_irradiance"], 2.0)


class EnclosedOsmEdgeTests(unittest.TestCase):
    def test_tunnel_covered_and_building_passage_are_direct_shade(self):
        cases = (
            ({"tunnel": "yes"}, "tunnel"),
            ({"covered": "yes"}, "covered"),
            ({"covered": True}, "covered"),
            ({"tunnel": "building_passage"}, "building_passage"),
            ({"building_passage": "yes"}, "building_passage"),
            ({"tunnel": "['no', 'yes']"}, "tunnel"),
        )
        for edge_data, expected in cases:
            with self.subTest(edge_data=edge_data):
                self.assertEqual(
                    precompute.direct_sun_block_reason(edge_data), expected
                )

    def test_explicit_negative_tags_remain_open_air(self):
        for edge_data in (
            {},
            {"tunnel": "no"},
            {"covered": False},
            {"tunnel": "0", "covered": "false"},
        ):
            with self.subTest(edge_data=edge_data):
                self.assertIsNone(precompute.direct_sun_block_reason(edge_data))

    def test_enclosed_edges_are_initialized_to_zero_for_every_sample(self):
        tunnel = (1, 2, 0)
        open_air = (2, 3, 0)
        exposure = precompute.initialize_edge_exposure(
            [tunnel, open_air], {tunnel: "tunnel"}
        )

        for date in precompute.DATES:
            self.assertEqual(
                exposure[date][tunnel], [0.0] * len(precompute.HOURS)
            )
            self.assertEqual(
                exposure[date][open_air], [None] * len(precompute.HOURS)
            )


class SolarStateAndQualityMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.city = find_city(load_city_registry(), "sg")
        cls.rect = precompute.rectangle_from_center(
            cls.city.center_lat, cls.city.center_lon, 600, 600
        )

    def test_below_horizon_and_low_sun_cutoff_are_distinct(self):
        self.assertEqual(
            precompute.classify_sun_elevation(-0.1),
            precompute.SUN_STATE_BELOW_HORIZON,
        )
        self.assertEqual(
            precompute.classify_sun_elevation(0.0),
            precompute.SUN_STATE_BELOW_HORIZON,
        )
        self.assertEqual(
            precompute.classify_sun_elevation(0.7),
            precompute.SUN_STATE_LOW_CUTOFF,
        )
        self.assertEqual(
            precompute.classify_sun_elevation(precompute.MIN_SUN_ELEV_DEG),
            precompute.SUN_STATE_MODELED,
        )

    def test_graph_summary_counts_unknown_edges_and_samples(self):
        tunnel = (1, 2, 0)
        open_air = (2, 3, 0)
        exposure = {
            "03-21": {
                tunnel: [0.0, 0.0],
                open_air: [0.5, None],
            },
            "06-21": {
                tunnel: [0.0, 0.0],
                open_air: [None, 1.0],
            },
        }

        summary = precompute.summarize_graph_exposure(
            exposure, {tunnel: "building_passage"}
        )

        self.assertEqual(summary["edge_count"], 2)
        self.assertEqual(summary["exposure_sample_count"], 8)
        self.assertEqual(summary["unknown_edge_count"], 1)
        self.assertEqual(summary["unknown_edge_sample_count"], 2)
        self.assertEqual(summary["unknown_edge_sample_fraction"], 0.25)
        self.assertEqual(summary["unknown_exposure_sentinel"], -1)
        self.assertEqual(summary["osm_enclosed_direct_sun_pct"], 0)
        self.assertEqual(summary["osm_enclosed_edge_count"], 1)
        self.assertEqual(
            summary["osm_enclosed_edge_counts"]["building_passage"], 1
        )

    def test_metadata_is_honest_about_height_sun_policy_and_limitations(self):
        elevations = [-1.0, 1.0, *([10.0] * (len(precompute.HOURS) - 2))]
        sun = {
            date: [
                (hour, 180.0, elevations[index])
                for index, hour in enumerate(precompute.HOURS)
            ]
            for date in precompute.DATES
        }
        graph = {
            "edge_count": 2,
            "unknown_edge_count": 1,
            "unknown_edge_sample_count": 2,
        }

        metadata = precompute.build_metadata(
            self.city,
            self.rect,
            2.0,
            sun,
            generated_at=datetime(2025, 7, 1, tzinfo=timezone.utc),
            meta_canopy=True,
            graph=graph,
        )

        self.assertEqual(metadata["requested_view_height_m"], 1.5)
        self.assertEqual(metadata["view_height_m"], 2.0)
        self.assertEqual(metadata["view_height_voxels"], 1)
        self.assertEqual(
            metadata["sun_model"]["sample_states"]["03-21"][:2],
            [
                precompute.SUN_STATE_BELOW_HORIZON,
                precompute.SUN_STATE_LOW_CUTOFF,
            ],
        )
        self.assertIs(metadata["model_quality"]["field_validated"], False)
        self.assertIn(
            "Meta/WRI", metadata["model_quality"]["sources"]["tree_canopy"]
        )
        self.assertGreater(len(metadata["model_quality"]["limitations"]), 0)
        self.assertIs(metadata["graph"], graph)


if __name__ == "__main__":
    unittest.main()
