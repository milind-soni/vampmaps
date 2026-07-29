import hashlib
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from pipeline.publish_coverage import AreaSource, publish_coverage


def sample_graph(city_id: str = "test-area", city_name: str = "Test Area") -> dict:
    return {
        "meta": {
            "city": city_id,
            "city_name": city_name,
            "timezone": "Etc/UTC",
            "center": [10.005, 20.005],
            "bbox": [10.0, 20.0, 10.01, 20.01],
            "hours": [9, 10],
            "dates": ["03-21"],
            "tz_offset_hours": 0,
            "sun": {"03-21": [[9, 120, 30], [10, 135, 40]]},
        },
        "nodes": [[10.0, 20.0], [10.01, 20.01]],
        "edges": [
            {
                "u": 0,
                "v": 1,
                "len": 100.0,
                "pts": [[10.0, 20.0], [10.01, 20.01]],
                "exp": {"03-21": [25, 50]},
            }
        ],
    }


class PublishCoverageTests(unittest.TestCase):
    def write_graph(self, root: Path, name: str, graph: dict, *, pretty: bool = False) -> Path:
        path = root / name
        path.write_text(
            json.dumps(graph, indent=2 if pretty else None, ensure_ascii=False),
            encoding="utf-8",
        )
        return path

    def test_builds_relative_content_addressed_bundles_with_integrity_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            beta_path = self.write_graph(root, "beta.json", sample_graph("beta", "Beta"), pretty=True)
            alpha_path = self.write_graph(root, "alpha.json", sample_graph("alpha", "Alpha"))
            output = root / "public"

            manifest = publish_coverage(
                [
                    AreaSource(beta_path, district="North", search_bias="Beta center"),
                    AreaSource(alpha_path, coverage="Small test area"),
                ],
                output,
                generated_at="2026-07-10T12:34:56+00:00",
            )

            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["generatedAt"], "2026-07-10T12:34:56Z")
            self.assertEqual([area["id"] for area in manifest["areas"]], ["alpha", "beta"])
            self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)

            for area in manifest["areas"]:
                self.assertFalse(area["bundleUrl"].startswith("/"))
                bundle = output / area["bundleUrl"]
                payload = bundle.read_bytes()
                digest = hashlib.sha256(payload).hexdigest()
                self.assertEqual(area["bytes"], len(payload))
                self.assertEqual(area["sha256"], digest)
                self.assertEqual(area["version"], digest)
                self.assertIn(digest[:16], bundle.name)
                self.assertEqual(json.loads(payload), sample_graph(area["id"], area["name"]))

    def test_semantically_identical_formatting_produces_the_same_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph = sample_graph()
            compact = self.write_graph(root, "compact.json", graph)
            pretty = self.write_graph(root, "pretty.json", graph, pretty=True)

            first = publish_coverage(
                [AreaSource(compact)],
                root / "one",
                generated_at="2026-01-01T00:00:00Z",
            )
            second = publish_coverage(
                [AreaSource(pretty)],
                root / "two",
                generated_at="2026-01-01T00:00:00Z",
            )

            self.assertEqual(first, second)
            self.assertEqual(
                (root / "one" / first["areas"][0]["bundleUrl"]).read_bytes(),
                (root / "two" / second["areas"][0]["bundleUrl"]).read_bytes(),
            )

    def test_update_keeps_old_immutable_bundle_and_switches_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph_path = self.write_graph(root, "area.json", sample_graph())
            output = root / "public"
            first = publish_coverage(
                [AreaSource(graph_path)], output, generated_at="2026-01-01T00:00:00Z"
            )
            first_url = first["areas"][0]["bundleUrl"]
            first_payload = (output / first_url).read_bytes()

            changed = sample_graph()
            changed["edges"][0]["exp"]["03-21"][0] = 30
            self.write_graph(root, "area.json", changed)
            second = publish_coverage(
                [AreaSource(graph_path)], output, generated_at="2026-01-02T00:00:00Z"
            )

            second_url = second["areas"][0]["bundleUrl"]
            self.assertNotEqual(first_url, second_url)
            self.assertEqual((output / first_url).read_bytes(), first_payload)
            self.assertTrue((output / second_url).is_file())
            self.assertEqual(json.loads((output / "manifest.json").read_text()), second)

    def test_preserves_explicit_unknown_exposure_and_rejects_lower_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph = sample_graph()
            graph["edges"][0]["exp"]["03-21"][0] = -1
            graph_path = self.write_graph(root, "unknown.json", graph)
            manifest = publish_coverage([AreaSource(graph_path)], root / "valid")
            bundle = root / "valid" / manifest["areas"][0]["bundleUrl"]
            self.assertEqual(json.loads(bundle.read_text())["edges"][0]["exp"]["03-21"][0], -1)

            graph["edges"][0]["exp"]["03-21"][0] = -2
            invalid_path = self.write_graph(root, "invalid.json", graph)
            with self.assertRaisesRegex(ValueError, "must contain -1 for unknown"):
                publish_coverage([AreaSource(invalid_path)], root / "invalid")

    def test_invalid_input_does_not_replace_an_existing_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            valid_path = self.write_graph(root, "valid.json", sample_graph())
            output = root / "public"
            publish_coverage(
                [AreaSource(valid_path)], output, generated_at="2026-01-01T00:00:00Z"
            )
            original_manifest = (output / "manifest.json").read_bytes()

            invalid = deepcopy(sample_graph())
            invalid["edges"][0]["exp"]["03-21"] = [25]
            invalid_path = self.write_graph(root, "invalid.json", invalid)
            with self.assertRaisesRegex(ValueError, "must match meta.hours"):
                publish_coverage(
                    [AreaSource(invalid_path)],
                    output,
                    generated_at="2026-01-02T00:00:00Z",
                )

            self.assertEqual((output / "manifest.json").read_bytes(), original_manifest)

    def test_rejects_duplicate_ids_and_configured_id_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            one = self.write_graph(root, "one.json", sample_graph())
            two = self.write_graph(root, "two.json", sample_graph())

            with self.assertRaisesRegex(ValueError, "duplicate coverage area id"):
                publish_coverage([AreaSource(one), AreaSource(two)], root / "duplicate")
            with self.assertRaisesRegex(ValueError, "expected 'another-area'"):
                publish_coverage(
                    [AreaSource(one, id="another-area")], root / "mismatch"
                )


if __name__ == "__main__":
    unittest.main()
