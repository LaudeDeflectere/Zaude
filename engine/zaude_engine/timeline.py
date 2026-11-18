"""Timeline and keyframe interpolation.

A timeline has a duration in seconds and a frame rate. Frame i happens at time i / fps.
A clip of duration 5 s at 24 fps has 120 frames, at times 0, 1/24, ..., 119/24 (so the
last frame is at 4.958 s, not 5.0 s). This matches how video files store frames.

A Track is a list of keyframes (time, value). Values are numbers or tuples of numbers.
Sampling between keys uses the track's interpolation: "linear", "smooth" (smoothstep easing),
or "hold" (keep the earlier value until the next key). Before the first key and after the last
key the value is held constant.
"""
import math


def smoothstep(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3.0 - 2.0 * u)


EASINGS = {
    "linear": lambda u: min(1.0, max(0.0, u)),
    "smooth": smoothstep,
    "hold": lambda u: 0.0,
}


class Timeline:
    def __init__(self, duration, fps):
        if not _finite_positive(duration):
            raise ValueError("duration must be a positive number of seconds")
        if not _finite_positive(fps):
            raise ValueError("fps must be a positive number")
        self.duration = float(duration)
        self.fps = float(fps)

    @property
    def frame_count(self):
        return max(1, int(round(self.duration * self.fps)))

    def frame_time(self, index):
        if not 0 <= index < self.frame_count:
            raise IndexError(f"frame {index} is outside 0..{self.frame_count - 1}")
        return index / self.fps

    def frame_times(self):
        return [i / self.fps for i in range(self.frame_count)]

    def nearest_frame(self, t):
        """Index of the frame closest to time t, clamped to the timeline."""
        index = int(round(t * self.fps))
        return min(self.frame_count - 1, max(0, index))

    def contains(self, t):
        return 0.0 <= t <= self.duration


class Track:
    """Keyframed value over time."""

    def __init__(self, keys, interp="linear"):
        if interp not in EASINGS:
            raise ValueError(f"unknown interpolation '{interp}'")
        if not keys:
            raise ValueError("a track needs at least one keyframe")
        ordered = sorted(keys, key=lambda k: k[0])
        for a, b in zip(ordered, ordered[1:]):
            if b[0] <= a[0]:
                raise ValueError(f"keyframe times must be unique (duplicate at {b[0]})")
        self.keys = [(float(t), _as_value(v)) for t, v in ordered]
        self.interp = interp

    def sample(self, t):
        keys = self.keys
        if t <= keys[0][0]:
            return keys[0][1]
        if t >= keys[-1][0]:
            return keys[-1][1]
        for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
            if t0 <= t <= t1:
                u = (t - t0) / (t1 - t0)
                e = EASINGS[self.interp](u)
                return _lerp_value(v0, v1, e)
        raise AssertionError("unreachable: t lies inside the track")


def _finite_positive(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(x) and x > 0


def _as_value(v):
    if isinstance(v, (list, tuple)):
        out = tuple(float(c) for c in v)
        if not all(math.isfinite(c) for c in out):
            raise ValueError("keyframe values must be finite")
        return out
    f = float(v)
    if not math.isfinite(f):
        raise ValueError("keyframe values must be finite")
    return f


def _lerp_value(a, b, u):
    if isinstance(a, tuple):
        return tuple(x + (y - x) * u for x, y in zip(a, b))
    return a + (b - a) * u
