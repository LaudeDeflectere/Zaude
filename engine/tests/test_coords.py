import math
import unittest

from zaude_engine import coords as C


class CoordsTest(unittest.TestCase):
    def close(self, a, b, tol=1e-9):
        self.assertTrue(all(abs(x - y) < tol for x, y in zip(a, b)), f"{a} != {b}")

    def test_yaw_positive_turns_counter_clockwise_from_above(self):
        self.close(C.rotate_z((0, 1, 0), 90), (-1, 0, 0))
        self.close(C.rotate_z((1, 0, 0), 90), (0, 1, 0))

    def test_forward_at_zero_yaw_is_plus_y(self):
        self.close(C.forward_from_yaw_pitch(0, 0), (0, 1, 0))
        self.close(C.forward_from_yaw_pitch(90, 0), (-1, 0, 0))

    def test_yaw_pitch_round_trip(self):
        for yaw, pitch in [(0, 0), (37, -12), (-170, 45), (250, 80)]:
            f = C.forward_from_yaw_pitch(yaw, pitch)
            y2, p2 = C.yaw_pitch_from_forward(f)
            self.assertAlmostEqual(p2, pitch, places=6)
            self.assertAlmostEqual(math.cos(math.radians(y2 - yaw)), 1.0, places=6)

    def test_look_at_basis_is_right_handed_and_orthonormal(self):
        f, r, u = C.look_at_basis((0, -3, 1.6), (0, 0, 1.2))
        self.assertAlmostEqual(C.length(f), 1.0)
        self.assertAlmostEqual(C.dot(f, r), 0.0)
        self.assertAlmostEqual(C.dot(r, u), 0.0)
        self.assertAlmostEqual(C.dot(f, u), 0.0)
        # looking along +Y, the right-hand side is +X and up is +Z
        f2, r2, u2 = C.look_at_basis((0, 0, 0), (0, 1, 0))
        self.close(r2, (1, 0, 0))
        self.close(u2, (0, 0, 1))

    def test_y_up_conversion_round_trips_and_maps_forward_to_minus_z(self):
        v = (1.5, -2.0, 3.25)
        self.close(C.from_y_up(C.to_y_up(v)), v)
        self.close(C.to_y_up((0, 1, 0)), (0, 0, -1))  # forward (+Y) becomes -Z in OpenGL terms
        self.close(C.to_y_up((0, 0, 1)), (0, 1, 0))  # up (+Z) becomes +Y

    def test_zero_vector_cannot_be_normalised(self):
        with self.assertRaises(ValueError):
            C.normalize((0, 0, 0))


if __name__ == "__main__":
    unittest.main()
