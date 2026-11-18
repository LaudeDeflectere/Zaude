import unittest

from zaude_engine.timeline import Timeline, Track, smoothstep


class TimelineTest(unittest.TestCase):
    def test_five_seconds_at_24_fps_has_120_frames(self):
        tl = Timeline(5.0, 24)
        self.assertEqual(tl.frame_count, 120)
        self.assertAlmostEqual(tl.frame_time(0), 0.0)
        self.assertAlmostEqual(tl.frame_time(119), 119 / 24)
        with self.assertRaises(IndexError):
            tl.frame_time(120)

    def test_nearest_frame_is_clamped(self):
        tl = Timeline(2.0, 10)
        self.assertEqual(tl.nearest_frame(-5), 0)
        self.assertEqual(tl.nearest_frame(0.26), 3)
        self.assertEqual(tl.nearest_frame(99), tl.frame_count - 1)

    def test_invalid_timelines_are_rejected(self):
        for args in [(0, 24), (-1, 24), (5, 0), (float("nan"), 24)]:
            with self.assertRaises(ValueError):
                Timeline(*args)


class TrackTest(unittest.TestCase):
    def test_linear_interpolation_and_midpoint(self):
        tr = Track([(0, 0.0), (2, 10.0)])
        self.assertAlmostEqual(tr.sample(1.0), 5.0)
        self.assertAlmostEqual(tr.sample(0.5), 2.5)

    def test_vector_values_interpolate_per_component(self):
        tr = Track([(0, (0, 0, 0)), (4, (4, 8, -4))])
        self.assertEqual(tr.sample(2), (2.0, 4.0, -2.0))

    def test_values_are_held_outside_the_keys(self):
        tr = Track([(1, 5.0), (3, 9.0)])
        self.assertEqual(tr.sample(-10), 5.0)
        self.assertEqual(tr.sample(99), 9.0)

    def test_smooth_easing_starts_and_ends_slowly(self):
        self.assertAlmostEqual(smoothstep(0.5), 0.5)
        tr = Track([(0, 0.0), (1, 1.0)], interp="smooth")
        self.assertLess(tr.sample(0.1), 0.1)
        self.assertGreater(tr.sample(0.9), 0.9)

    def test_hold_keeps_the_earlier_value(self):
        tr = Track([(0, 1.0), (2, 7.0)], interp="hold")
        self.assertEqual(tr.sample(1.9), 1.0)
        self.assertEqual(tr.sample(2.0), 7.0)

    def test_keys_must_be_unique_and_finite(self):
        with self.assertRaises(ValueError):
            Track([(1, 0.0), (1, 2.0)])
        with self.assertRaises(ValueError):
            Track([(0, float("inf"))])
        with self.assertRaises(ValueError):
            Track([])


if __name__ == "__main__":
    unittest.main()
