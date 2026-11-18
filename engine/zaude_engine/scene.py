"""Scene files: validation, loading, and sampling.

A scene is a JSON object. The structure is described by engine/schemas/scene.schema.json, and the
rules that JSON Schema cannot express (overlapping motions, clips outside the duration, unique ids,
known clip names) are checked here. validate_scene returns a list of human-readable errors, each
with the path to the bad field, so a file with several problems reports all of them at once.
"""
import json
import math
from pathlib import Path

from . import coords as C
from .camera import KINDS, CameraPath, Motion, Pose
from .timeline import EASINGS, Track, Timeline

SCENE_VERSION = 1
KNOWN_CLIPS = ("idle", "raise_right_arm")  # the animation library grows in Level 3 (task 3.3)
CHARACTER_TYPES = ("humanoid",)
TOP_KEYS = {"version", "name", "fps", "duration", "coordinate_system", "render", "characters", "cameras"}
CHARACTER_KEYS = {"id", "type", "position", "yaw_deg", "animations"}
CAMERA_KEYS = {"id", "start", "motions"}
START_KEYS = {"position", "target", "focal_mm"}
MOTION_KEYS = {"kind", "start", "end", "ease", "degrees", "centre", "metres", "to_mm"}
ANIMATION_KEYS = {"clip", "start", "end"}
REQUIRED_PARAMS = {
    "orbit": ("degrees",),
    "pan": ("degrees",),
    "tilt": ("degrees",),
    "dolly": ("metres",),
    "track": ("metres",),
    "zoom": ("to_mm",),
    "hold": (),
}
MAX_DURATION = 600.0
FOCAL_MM_RANGE = (1.0, 500.0)


class SceneError(ValueError):
    pass


def load_scene(path):
    with Path(path).open(encoding="utf-8") as f:
        return json.load(f)


def _is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _is_vec3(x):
    return isinstance(x, list) and len(x) == 3 and all(_is_number(c) for c in x)


def _check_unknown(obj, allowed, where, errors):
    for key in obj:
        if key not in allowed:
            errors.append(f"{where}: unknown field '{key}'")


def _check_window(obj, duration, where, errors):
    """Checks start/end of a timed item and returns (start, end) when they are valid."""
    start, end = obj.get("start"), obj.get("end")
    ok = True
    for name, val in (("start", start), ("end", end)):
        if not _is_number(val):
            errors.append(f"{where}.{name}: must be a number of seconds")
            ok = False
    if not ok:
        return None
    if not 0 <= start < end:
        errors.append(f"{where}: need 0 <= start < end (got {start} to {end})")
        return None
    if end > duration + 1e-9:
        errors.append(f"{where}: ends at {end} s, after the scene duration of {duration} s")
        return None
    return float(start), float(end)


def validate_scene(scene):
    """Returns a list of error strings. An empty list means the scene is valid."""
    errors = []
    if not isinstance(scene, dict):
        return ["scene: must be a JSON object"]
    _check_unknown(scene, TOP_KEYS, "scene", errors)

    if scene.get("version") != SCENE_VERSION:
        errors.append(f"version: must be {SCENE_VERSION}")
    if not isinstance(scene.get("name"), str) or not scene.get("name"):
        errors.append("name: must be a non-empty string")
    if scene.get("coordinate_system") != C.COORDINATE_SYSTEM:
        errors.append(f"coordinate_system: must be '{C.COORDINATE_SYSTEM}'")

    fps = scene.get("fps")
    if not _is_number(fps) or not 1 <= fps <= 120:
        errors.append("fps: must be a number from 1 to 120")
    duration = scene.get("duration")
    duration_ok = _is_number(duration) and 0 < duration <= MAX_DURATION
    if not duration_ok:
        errors.append(f"duration: must be a number of seconds above 0 and up to {MAX_DURATION:g}")

    render = scene.get("render")
    if render is not None:
        if not isinstance(render, dict):
            errors.append("render: must be an object")
        else:
            _check_unknown(render, {"width", "height"}, "render", errors)
            for k in ("width", "height"):
                if k in render and not (isinstance(render[k], int) and not isinstance(render[k], bool) and render[k] > 0):
                    errors.append(f"render.{k}: must be a positive integer")

    if duration_ok:
        _validate_characters(scene.get("characters", []), duration, errors)
        _validate_cameras(scene.get("cameras"), duration, errors)
    else:
        _validate_characters(scene.get("characters", []), None, errors)
        _validate_cameras(scene.get("cameras"), None, errors)
    return errors


def _validate_characters(characters, duration, errors):
    if not isinstance(characters, list):
        errors.append("characters: must be a list")
        return
    seen = set()
    for i, ch in enumerate(characters):
        where = f"characters[{i}]"
        if not isinstance(ch, dict):
            errors.append(f"{where}: must be an object")
            continue
        _check_unknown(ch, CHARACTER_KEYS, where, errors)
        cid = ch.get("id")
        if not isinstance(cid, str) or not cid:
            errors.append(f"{where}.id: must be a non-empty string")
        elif cid in seen:
            errors.append(f"{where}.id: '{cid}' is already used")
        seen.add(cid)
        if ch.get("type") not in CHARACTER_TYPES:
            errors.append(f"{where}.type: must be one of {', '.join(CHARACTER_TYPES)}")
        if not _is_vec3(ch.get("position", [0, 0, 0])):
            errors.append(f"{where}.position: must be [x, y, z] in metres")
        if not _is_number(ch.get("yaw_deg", 0)):
            errors.append(f"{where}.yaw_deg: must be a number of degrees")
        anims = ch.get("animations", [])
        if not isinstance(anims, list):
            errors.append(f"{where}.animations: must be a list")
            continue
        windows = []
        for j, a in enumerate(anims):
            aw = f"{where}.animations[{j}]"
            if not isinstance(a, dict):
                errors.append(f"{aw}: must be an object")
                continue
            _check_unknown(a, ANIMATION_KEYS, aw, errors)
            if a.get("clip") not in KNOWN_CLIPS:
                errors.append(f"{aw}.clip: unknown clip '{a.get('clip')}' (known: {', '.join(KNOWN_CLIPS)})")
            if duration is not None:
                win = _check_window(a, duration, aw, errors)
                if win:
                    for k, other in enumerate(windows):
                        if win[0] < other[1] and other[0] < win[1]:
                            errors.append(f"{aw}: overlaps animations[{k}] on the same character")
                    windows.append(win)


def _validate_cameras(cameras, duration, errors):
    if not isinstance(cameras, list) or not cameras:
        errors.append("cameras: must be a non-empty list")
        return
    seen = set()
    for i, cam in enumerate(cameras):
        where = f"cameras[{i}]"
        if not isinstance(cam, dict):
            errors.append(f"{where}: must be an object")
            continue
        _check_unknown(cam, CAMERA_KEYS, where, errors)
        cid = cam.get("id")
        if not isinstance(cid, str) or not cid:
            errors.append(f"{where}.id: must be a non-empty string")
        elif cid in seen:
            errors.append(f"{where}.id: '{cid}' is already used")
        seen.add(cid)
        _validate_start(cam.get("start"), f"{where}.start", errors)
        motions = cam.get("motions", [])
        if not isinstance(motions, list):
            errors.append(f"{where}.motions: must be a list")
            continue
        windows = []
        for j, m in enumerate(motions):
            mw = f"{where}.motions[{j}]"
            if not isinstance(m, dict):
                errors.append(f"{mw}: must be an object")
                continue
            _validate_motion(m, mw, duration, errors)
            if duration is not None and m.get("kind") in KINDS:
                win = _check_window(m, duration, mw, errors)
                if win:
                    for k, other in enumerate(windows):
                        if win[0] < other[1] and other[0] < win[1]:
                            errors.append(f"{mw}: overlaps motions[{k}]")
                    windows.append(win)


def _validate_start(start, where, errors):
    if not isinstance(start, dict):
        errors.append(f"{where}: must be an object with position and target")
        return
    _check_unknown(start, START_KEYS, where, errors)
    for k in ("position", "target"):
        if not _is_vec3(start.get(k)):
            errors.append(f"{where}.{k}: must be [x, y, z] in metres")
    if _is_vec3(start.get("position")) and _is_vec3(start.get("target")):
        if C.length(C.sub(tuple(start["target"]), tuple(start["position"]))) < 1e-6:
            errors.append(f"{where}: position and target must differ")
    f = start.get("focal_mm", 35)
    if not _is_number(f) or not FOCAL_MM_RANGE[0] <= f <= FOCAL_MM_RANGE[1]:
        errors.append(f"{where}.focal_mm: must be a number from {FOCAL_MM_RANGE[0]:g} to {FOCAL_MM_RANGE[1]:g}")


def _validate_motion(m, where, duration, errors):
    _check_unknown(m, MOTION_KEYS, where, errors)
    kind = m.get("kind")
    if kind not in KINDS:
        errors.append(f"{where}.kind: must be one of {', '.join(KINDS)}")
        return
    for key in REQUIRED_PARAMS[kind]:
        if not _is_number(m.get(key)):
            errors.append(f"{where}.{key}: required for a {kind} motion, as a number")
    if kind == "orbit" and "centre" in m and not _is_vec3(m["centre"]):
        errors.append(f"{where}.centre: must be [x, y, z] in metres")
    if kind == "tilt" and _is_number(m.get("degrees")) and abs(m["degrees"]) > 180:
        errors.append(f"{where}.degrees: a tilt must be between -180 and 180")
    if kind == "zoom" and _is_number(m.get("to_mm")) and not FOCAL_MM_RANGE[0] <= m["to_mm"] <= FOCAL_MM_RANGE[1]:
        errors.append(f"{where}.to_mm: must be from {FOCAL_MM_RANGE[0]:g} to {FOCAL_MM_RANGE[1]:g}")
    ease = m.get("ease", "linear")
    if ease not in EASINGS:
        errors.append(f"{where}.ease: must be one of {', '.join(EASINGS)}")


def build_timeline(scene):
    return Timeline(scene["duration"], scene["fps"])


def build_camera(cam_spec, fps=None):
    s = cam_spec["start"]
    start = Pose(
        position=C.vec(*s["position"]),
        target=C.vec(*s["target"]),
        focal_mm=float(s.get("focal_mm", 35)),
    )
    motions = [
        Motion(kind=m["kind"], start=float(m["start"]), end=float(m["end"]),
               params={k: (tuple(v) if isinstance(v, list) else v) for k, v in m.items()
                       if k not in ("kind", "start", "end", "ease")},
               ease=m.get("ease", "linear"))
        for m in cam_spec.get("motions", [])
    ]
    return CameraPath(start, motions)


def build_character_position(ch):
    """Character position as a function of time. Static for now; keyframes come in Level 2."""
    pos = C.vec(*ch.get("position", [0, 0, 0]))
    track = Track([(0.0, pos)])
    return track.sample


def require_valid(scene):
    errors = validate_scene(scene)
    if errors:
        raise SceneError("\n".join(errors))
    return scene


def sample_cameras(scene):
    """Per-frame camera poses for every camera in the scene: {camera_id: [frame dict, ...]}."""
    tl = build_timeline(require_valid(scene))
    out = {}
    for cam in scene["cameras"]:
        path = build_camera(cam)
        frames = []
        for i, t in enumerate(tl.frame_times()):
            pose = path.sample(t)
            frames.append({
                "frame": i,
                "time": round(t, 6),
                "position": [round(c, 6) for c in pose.position],
                "target": [round(c, 6) for c in pose.target],
                "focal_mm": round(pose.focal_mm, 4),
            })
        out[cam["id"]] = frames
    return out
