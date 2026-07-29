import copy
import unittest

from pipeline.migrate_unknown_exposure import migrate_graph


def legacy_graph(*, add_real_sunny_edge: bool = False):
    edges = [
        {"exp": {"03-21": [0, 100]}},
        {"exp": {"03-21": [0, 25]}},
    ]
    if add_real_sunny_edge:
        edges.append({"exp": {"03-21": [0, 100]}})
    return {
        "meta": {
            "dates": ["03-21"],
            "hours": [8, 9],
            "sun_model": {"sample_states": {"03-21": ["below_horizon", "modeled"]}},
            "graph": {
                "unknown_edge_count": 1,
                "unknown_edge_sample_count": 1,
                "unknown_exposure_fallback_pct": 100,
            },
        },
        "edges": edges,
    }


class UnknownExposureMigrationTests(unittest.TestCase):
    def test_strict_inference_replaces_legacy_fallback(self):
        graph = legacy_graph()
        self.assertEqual(migrate_graph(graph), 1)
        self.assertEqual(graph["edges"][0]["exp"]["03-21"], [0, -1])
        self.assertEqual(graph["meta"]["graph"]["unknown_exposure_sentinel"], -1)
        self.assertNotIn("unknown_exposure_fallback_pct", graph["meta"]["graph"])

    def test_ambiguous_always_sunny_edges_require_verified_indices(self):
        graph = legacy_graph(add_real_sunny_edge=True)
        with self.assertRaisesRegex(ValueError, "pass verified --indices"):
            migrate_graph(copy.deepcopy(graph))

        migrated = migrate_graph(graph, edge_indices=[0])
        self.assertEqual(migrated, 1)
        self.assertEqual(graph["edges"][0]["exp"]["03-21"], [0, -1])
        self.assertEqual(graph["edges"][2]["exp"]["03-21"], [0, 100])


if __name__ == "__main__":
    unittest.main()
