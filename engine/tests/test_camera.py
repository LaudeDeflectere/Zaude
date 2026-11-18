import math
import unittest

from zaude_engine import coords as C
from zaude_engine.camera import CameraPath, Motion, Pose


def horizontal_radius(pos, centre):
    return math.hypot(pos[0] - centre[0], pos[1] - centre[1])


class CameraTest(unittest.TestCase):
    def setUp(self):
        self.start = Pose(position=(0.0, -3.0, 1.6), target=(0.0, 0.0, 1.2), focal_mm=35)

    def test_static_camera_without_motions_stays_put(self):
        path = CameraPath(self.start)
        self.assertEqual(path.sample(0), self.start)
        self.assertEqual(path.sample(99), self.start)

    def test_orbit_keeps_radius_and_height_and_sweeps_90_degrees(self):
        centre = self.start.target
        path = CameraPath(self.start, [Motion("orbit", 0, 5, {"degrees": 90})])
        r0 = horizontal_radius(self.start.position, centre)
        for t in [0, 1, 2.5, 4.9, 5]:
            p = path.sample(t)
            self.assertAlmostEqual(horizontal_radius(p.position, centre), r0, places=9)
            self.assertAlmostEqual(p.position[2], self.start.position[2], places=9)
        end = path.sample(5).position
        # 90 degrees counter-clockwise from (0, -3): (3, 0) relative to the centre, plus the centre
        self.assertAlmostEqual(end[0], 3.0, places=9)
        self.assertAlmostEqual(end[1], 0.0, places=9)

    def test_orbit_target_does_not_move(self):
        path = CameraPath(self.start, [Motion("orbit", 0, 5, {"degrees": 90})])
        self.assertEqual(path.sample(2.5).target, self.start.target)

    def test_pan_turns_the_view_but_not_the_position(self):
        path = CameraPath(self.start, [Motion("pan", 0, 2, {"degrees": 30})])
        p = path.sample(2)
        self.assertEqual(p.position, self.start.position)
        self.assertAlmostEqual(C.length(C.sub(p.target, p.position)), C.length(C.sub(self.start.target, self.start.position)), places=9)
        yaw0, _ = C.yaw_pitch_from_forward(C.sub(self.start.target, self.start.position))
        yaw1, _ = C.yaw_pitch_from_forward(C.sub(p.target, p.position))
        self.assertAlmostEqual(yaw1 - yaw0, 30, places=6)

    def test_tilt_changes_pitch_and_is_clamped(self):
        path = CameraPath(self.start, [Motion("tilt", 0, 1, {"degrees": 500})])
        p = path.sample(1)
        _, pitch = C.yaw_pitch_from_forward(C.sub(p.target, p.position))
        self.assertLessEqual(pitch, 89.0 + 1e-9)
        self.assertEqual(p.position, self.start.position)

    def test_dolly_moves_along_the_view_direction(self):
        forward = C.normalize(C.sub(self.start.target, self.start.position))
        path = CameraPath(self.start, [Motion("dolly", 0, 2, {"metres": 2.0})])
        p = path.sample(2)
        self.assertEqual(p.position, C.add(self.start.position, C.scale(forward, 2.0)))
        self.assertEqual(p.target, C.add(self.start.target, C.scale(forward, 2.0)))

    def test_track_moves_sideways_to_the_right(self):
        _, right, _ = self.start.basis()
        path = CameraPath(self.start, [Motion("track", 0, 1, {"metres": 1.0})])
        p = path.sample(1)
        for a, b in zip(p.position, C.add(self.start.position, right)):
            self.assertAlmostEqual(a, b, places=9)

    def test_zoom_changes_only_the_focal_length(self):
        path = CameraPath(self.start, [Motion("zoom", 0, 2, {"to_mm": 70})])
        p = path.sample(1)
        self.assertAlmostEqual(p.focal_mm, 52.5)
        self.assertEqual(p.position, self.start.position)

    def test_motions_chain_and_hold_between_them(self):
        path = CameraPath(self.start, [
            Motion("zoom", 0, 1, {"to_mm": 70}),
            Motion("zoom", 3, 4, {"to_mm": 20}),
        ])
        self.assertAlmostEqual(path.sample(2).focal_mm, 70)  # held between the two zooms
        self.assertAlmostEqual(path.sample(5).focal_mm, 20)  # held after the last
        self.assertAlmostEqual(path.sample(3.5).focal_mm, 45)  # 70 + (20 - 70) * 0.5

    def test_overlapping_motions_are_rejected(self):
        with self.assertRaises(ValueError):
            CameraPath(self.start, [Motion("pan", 0, 3, {"degrees": 10}), Motion("tilt", 2, 4, {"degrees": 5})])

    def test_unknown_kind_and_backwards_time_are_rejected(self):
        with self.assertRaises(ValueError):
            Motion("spin", 0, 1, {})
        with self.assertRaises(ValueError):
            Motion("pan", 2, 1, {"degrees": 5})

    def test_smooth_ease_reaches_the_same_end_pose(self):
        linear = CameraPath(self.start, [Motion("orbit", 0, 5, {"degrees": 90})]).sample(5).position
        smooth = CameraPath(self.start, [Motion("orbit", 0, 5, {"degrees": 90}, ease="smooth")]).sample(5).position
        for a, b in zip(linear, smooth):
            self.assertAlmostEqual(a, b, places=9)


if __name__ == "__main__":
    unittest.main()
