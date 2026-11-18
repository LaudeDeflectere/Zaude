import copy
import json
import unittest
from pathlib import Path

from zaude_engine.scene import sample_cameras, validate_scene

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def load(name):
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


class SceneValidationTest(unittest.TestCase):
    def setUp(self):
        self.base = load("mvp_orbit_arm.json")

    def test_mvp_scene_is_valid(self):
        self.assertEqual(validate_scene(self.base), [])

    def test_reports_every_problem_with_its_path(self):
        bad = copy.deepcopy(self.base)
        bad["fps"] = 0
        bad["characters"][0]["animations"][0]["clip"] = "moonwalk"
        bad["cameras"][0]["motions"][0]["degrees"] = "ninety"
        errors = validate_scene(bad)
        self.assertTrue(any(e.startswith("fps:") for e in errors))
        self.assertTrue(any("unknown clip 'moonwalk'" in e for e in errors))
        self.assertTrue(any("cameras[0].motions[0].degrees" in e for e in errors))
        self.assertGreaterEqual(len(errors), 3)

    def test_animation_must_fit_inside_the_scene(self):
        bad = copy.deepcopy(self.base)
        bad["characters"][0]["animations"][0]["end"] = 9.0
        self.assertTrue(any("after the scene duration" in e for e in validate_scene(bad)))

    def test_overlapping_camera_motions_are_reported(self):
        bad = copy.deepcopy(self.base)
        bad["cameras"][0]["motions"].append({"kind": "pan", "start": 1.0, "end": 3.0, "degrees": 10})
        self.assertTrue(any("overlaps" in e for e in validate_scene(bad)))

    def test_duplicate_ids_are_reported(self):
        bad = copy.deepcopy(self.base)
        bad["characters"].append(copy.deepcopy(bad["characters"][0]))
        self.assertTrue(any("already used" in e for e in validate_scene(bad)))

    def test_unknown_fields_are_reported(self):
        bad = copy.deepcopy(self.base)
        bad["fsp"] = 24
        self.assertTrue(any("unknown field 'fsp'" in e for e in validate_scene(bad)))

    def test_camera_position_and_target_must_differ(self):
        bad = copy.deepcopy(self.base)
        bad["cameras"][0]["start"]["target"] = bad["cameras"][0]["start"]["position"]
        self.assertTrue(any("must differ" in e for e in validate_scene(bad)))

    def test_wrong_coordinate_system_is_reported(self):
        bad = copy.deepcopy(self.base)
        bad["coordinate_system"] = "y_up"
        self.assertTrue(any("coordinate_system" in e for e in validate_scene(bad)))

    def test_non_object_is_rejected(self):
        self.assertEqual(len(validate_scene([1, 2])), 1)


class SceneExamplesTest(unittest.TestCase):
    def test_every_example_scene_validates(self):
        for path in sorted(EXAMPLES.glob("*.json")):
            with self.subTest(scene=path.name):
                self.assertEqual(validate_scene(json.loads(path.read_text(encoding="utf-8"))), [])

    def test_mvp_camera_starts_three_metres_from_the_character(self):
        scene = load("mvp_orbit_arm.json")
        frames = sample_cameras(scene)["main"]
        first = frames[0]["position"]
        self.assertAlmostEqual((first[0] ** 2 + first[1] ** 2) ** 0.5, 3.0, places=6)

    def test_mvp_frame_count_and_orbit_end(self):
        frames = sample_cameras(load("mvp_orbit_arm.json"))["main"]
        self.assertEqual(len(frames), 120)
        last = frames[-1]
        self.assertEqual(last["frame"], 119)
        # the camera starts at -90 degrees (at (0, -3)). The last frame is at 119/24 s, so it has
        # turned 119/120 of 90 degrees counter-clockwise: -90 + 89.25 = -0.75 degrees.
        import math
        angle = math.degrees(math.atan2(last["position"][1], last["position"][0]))
        self.assertAlmostEqual(angle, -90 + 90 * 119 / 120, places=2)


if __name__ == "__main__":
    unittest.main()
