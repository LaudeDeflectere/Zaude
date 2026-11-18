# Architecture

The scene engine turns a structured scene file into deterministic data: timelines, camera poses, and (later) character poses and conditioning sequences. Video models sit at the end of the pipeline and consume that data. The parts are kept separate so each can be tested alone.

```
scene.json
   │
   ▼
scene.py ── validate_scene ──► errors (with paths)
   │
   ├─► timeline.py  Timeline (duration, fps, frames), Track (keyframes, easing)
   ├─► coords.py    Z-up convention, yaw/pitch, look-at, Y-up conversion
   └─► camera.py    Pose, Motion (orbit, pan, tilt, dolly, track, zoom, hold), CameraPath
   │
   ▼
sample_cameras ──► per-frame poses (JSON)         [Level 1, done]
   │
   ├─► Blender builder (Level 2)                  blender/ (not yet)
   │       └─► control passes: depth, normal, segmentation, pose
   ├─► pose sequences (Level 3)                   keypoints per frame
   └─► video backend (Level 3)                    backends/ (dry-run first)
            └─► run record (seed, versions, inputs)  (Level 3)
```

## Components

| Module | Responsibility | Depends on |
|---|---|---|
| `coords.py` | Vectors, rotations, look-at, coordinate conversion | nothing |
| `timeline.py` | Frame timing and keyframe interpolation | nothing |
| `camera.py` | Camera poses and motion chaining | `coords`, `timeline` |
| `scene.py` | Validation, loading, building camera paths, sampling | `coords`, `timeline`, `camera` |
| `cli.py` | `validate` and `cameras` commands | `scene` |
| `schemas/scene.schema.json` | Structural description of a scene | none (documentation; checked in tests when `jsonschema` is installed) |

No component imports Blender, torch, or any model. That keeps Level 1 testable anywhere, and lets the Blender code (Level 2) import the same pure modules.

## Conventions

- **Units:** metres and seconds. Angles in degrees in the scene file.
- **Coordinates:** right-handed, Z up, X right, forward +Y. Yaw is counter-clockwise from above.
- **Y-up export:** `coords.to_y_up`. Forward +Y becomes -Z, the OpenGL convention.
- **Frames:** frame `i` is at time `i / fps`. A 5-second clip at 24 fps has 120 frames.
- **Motions:** a camera's motions must not overlap. Between motions the camera holds its last pose.

## Interfaces planned for later levels

- **Animation library (3.3):** clip name → per-frame joint angles, validated against `KNOWN_CLIPS` in `scene.py`.
- **Video backend (3.5):** `generate(scene, conditioning, params) -> (video_path, run_record)`. A dry-run backend writes the run record without a model, so the pipeline can be tested before any GPU work.
- **Run record (3.7):** seed, model name and version, config, conditioning file hashes, generation parameters, software versions.

## What is not decided yet

- Character rigs and keyframed positions (Level 2). `build_character_position` currently holds a fixed position.
- The natural-language parser (3.1) and whether it produces scene files directly or through a separate intermediate format.
- Whether the Blender builder runs in this container (after installing Blender) or only on tranklena.
