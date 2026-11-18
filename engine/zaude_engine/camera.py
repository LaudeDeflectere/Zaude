"""Camera poses and camera motions.

A Pose is where the camera is (position), what it looks at (target), and its lens (focal length).
A CameraPath starts from an initial pose and applies motions one after another. Each motion has a
start time, an end time, and a kind:

  orbit   move around a centre point (default: the target) by `degrees`, keeping the distance
          and height from that centre. Positive is counter-clockwise seen from above.
  pan     turn the view left/right on the spot by `degrees` (positive is to the left).
  tilt    turn the view up/down by `degrees` (positive looks up). Clamped to +/-89 degrees.
  dolly   move the camera and its target forward by `metres` (negative moves back).
  track   move the camera and its target sideways by `metres` (positive moves right).
  zoom    change the focal length to `to_mm`. This changes the lens, not the camera position.
  hold    do nothing for the duration.

Between motions the camera keeps the last pose. Before the first motion it stays at the start pose.
Motions may not overlap in time, so the path is always well defined.
"""
from dataclasses import dataclass, replace

from . import coords as C
from .timeline import EASINGS

KINDS = ("orbit", "pan", "tilt", "dolly", "track", "zoom", "hold")
TILT_LIMIT_DEG = 89.0


@dataclass(frozen=True)
class Pose:
    position: tuple
    target: tuple
    focal_mm: float = 35.0

    def basis(self):
        return C.look_at_basis(self.position, self.target)

    @property
    def distance(self):
        return C.length(C.sub(self.target, self.position))


def _orbit(pose, u, p):
    centre = tuple(p["centre"]) if p.get("centre") else pose.target
    offset = C.sub(pose.position, centre)
    moved = C.rotate_z(offset, p["degrees"] * u)
    return replace(pose, position=C.add(centre, moved))


def _pan(pose, u, p):
    forward = C.normalize(C.sub(pose.target, pose.position))
    turned = C.rotate_z(forward, p["degrees"] * u)  # positive = counter-clockwise = left
    return replace(pose, target=C.add(pose.position, C.scale(turned, pose.distance)))


def _tilt(pose, u, p):
    forward = C.normalize(C.sub(pose.target, pose.position))
    yaw, pitch = C.yaw_pitch_from_forward(forward)
    new_pitch = max(-TILT_LIMIT_DEG, min(TILT_LIMIT_DEG, pitch + p["degrees"] * u))
    new_forward = C.forward_from_yaw_pitch(yaw, new_pitch)
    return replace(pose, target=C.add(pose.position, C.scale(new_forward, pose.distance)))


def _dolly(pose, u, p):
    forward, _, _ = pose.basis()
    step = C.scale(forward, p["metres"] * u)
    return replace(pose, position=C.add(pose.position, step), target=C.add(pose.target, step))


def _track(pose, u, p):
    _, right, _ = pose.basis()
    step = C.scale(right, p["metres"] * u)
    return replace(pose, position=C.add(pose.position, step), target=C.add(pose.target, step))


def _zoom(pose, u, p):
    f = pose.focal_mm + (p["to_mm"] - pose.focal_mm) * u
    return replace(pose, focal_mm=f)


def _hold(pose, u, p):
    return pose


APPLY = {"orbit": _orbit, "pan": _pan, "tilt": _tilt, "dolly": _dolly, "track": _track, "zoom": _zoom, "hold": _hold}


@dataclass(frozen=True)
class Motion:
    kind: str
    start: float
    end: float
    params: dict
    ease: str = "linear"

    def __post_init__(self):
        if self.kind not in KINDS:
            raise ValueError(f"unknown camera motion '{self.kind}'")
        if not self.end > self.start:
            raise ValueError("a motion must end after it starts")
        if self.ease not in EASINGS:
            raise ValueError(f"unknown ease '{self.ease}'")

    def apply(self, pose, t):
        """Pose at time t. Before the start the pose is unchanged; after the end it is the final pose."""
        if t <= self.start:
            u = 0.0
        elif t >= self.end:
            u = 1.0
        else:
            u = (t - self.start) / (self.end - self.start)
        return APPLY[self.kind](pose, EASINGS[self.ease](u), self.params)


class CameraPath:
    def __init__(self, start, motions=()):
        self.start = start
        self.motions = sorted(motions, key=lambda m: m.start)
        for a, b in zip(self.motions, self.motions[1:]):
            if b.start < a.end:
                raise ValueError(f"camera motion '{b.kind}' overlaps '{a.kind}'")

    def sample(self, t):
        pose = self.start
        for m in self.motions:
            if t < m.start:
                return pose
            if t <= m.end:
                return m.apply(pose, t)
            pose = m.apply(pose, m.end)
        return pose
