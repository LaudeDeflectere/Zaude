"""Coordinate conventions and small vector helpers.

Convention used everywhere in the engine ("Z-up"):
  - Right-handed, Z up, 1 unit = 1 metre.
  - X points right, Y points forward, Z points up.
  - Yaw is a rotation about +Z. Positive yaw turns counter-clockwise when seen from above.
    At yaw 0 the forward direction is +Y; yaw +90 turns it to -X.
  - Pitch is a rotation that raises the forward direction. Positive pitch looks up.

Y-up (glTF, OpenGL, most depth-map tools) is supported through to_y_up / from_y_up.
Under that mapping a camera's forward +Y becomes -Z, which is the OpenGL convention.

Pure Python, no dependencies, so the same code runs in tests, in Blender scripts, and on the CLI.
"""
import math

Vec3 = tuple

COORDINATE_SYSTEM = "z_up_right_handed_metres"
WORLD_UP = (0.0, 0.0, 1.0)


def vec(x, y, z):
    return (float(x), float(y), float(z))


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def length(a):
    return math.sqrt(dot(a, a))


def normalize(a):
    n = length(a)
    if n < 1e-12:
        raise ValueError("cannot normalise a zero-length vector")
    return scale(a, 1.0 / n)


def lerp(a, b, u):
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def rotate_axis(v, axis, degrees):
    """Rotate v about a unit axis by degrees (right-hand rule, Rodrigues' formula)."""
    k = normalize(axis)
    t = math.radians(degrees)
    c, s = math.cos(t), math.sin(t)
    kv = cross(k, v)
    kd = dot(k, v)
    return (
        v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
        v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
        v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
    )


def rotate_z(v, degrees):
    return rotate_axis(v, WORLD_UP, degrees)


def forward_from_yaw_pitch(yaw_deg, pitch_deg):
    """Unit forward vector for a yaw (about Z) and pitch (up is positive)."""
    y = math.radians(yaw_deg)
    p = math.radians(pitch_deg)
    return (-math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p))


def yaw_pitch_from_forward(f):
    """Yaw and pitch in degrees for a forward vector. Inverse of forward_from_yaw_pitch."""
    f = normalize(f)
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, f[2]))))
    yaw = math.degrees(math.atan2(-f[0], f[1]))
    return yaw, pitch


def look_at_basis(eye, target, up=WORLD_UP):
    """Returns (forward, right, camera_up) unit vectors for a camera at eye looking at target."""
    forward = normalize(sub(target, eye))
    right = normalize(cross(forward, up))
    camera_up = cross(right, forward)
    return forward, right, camera_up


def to_y_up(v):
    """Z-up to Y-up: (x, y, z) -> (x, z, -y)."""
    return (v[0], v[2], -v[1])


def from_y_up(v):
    """Y-up to Z-up: (x, y, z) -> (x, -z, y). The inverse of to_y_up."""
    return (v[0], -v[2], v[1])
