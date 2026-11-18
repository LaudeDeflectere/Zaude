# Progress

Last updated 2026-11-18. Source of truth for each task is `TASKS.json`. This file summarises it.

## Project status

**Completed tasks:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7 (Level 1, milestone M1).

**In-progress task:** none.

**Blocked tasks:**
- 2.1 Blender integration: Blender is not installed in this container. Install needs approval, or run on tranklena.
- 3.6 First controlled generation: needs the GPU host (`witzp@tranklena`), which this container cannot reach (no ssh client, no DNS, no key).

**Latest implementation:**
- `engine/zaude_engine/`: coordinates, timeline and tracks, camera poses and motions, scene validation, sampling, and a CLI.
- `engine/schemas/scene.schema.json`: structural scene format.
- `engine/examples/`: MVP scene (orbit and raised arm), dolly/pan/tilt/zoom, sideways track.
- `engine/tests/`: 39 unit tests.
- Documents: `ROADMAP.md`, `TASKS.json`, `ARCHITECTURE.md`, `docs/environment_report.md`, `docs/technology_comparison.md`, `docs/benchmark_results.md`.

**Tests performed:**
- `python3 -m unittest discover -s tests -p 'test_*.py'` from `engine/`.
- `python3 -m zaude_engine validate` on each example.
- `python3 -m zaude_engine cameras examples/mvp_orbit_arm.json` (120 frames, starts at (0, -3, 1.6), ends at angle −0.75° ≈ 89.25° of orbit).

**Test results:** 39 of 39 passing.

## Next easiest available task

**3.1 Natural-language parser (rules first).** Pure Python, no GPU, no Blender. It is Level 3 by the roadmap's difficulty table, so it is a judgement call: the next Level 2 task is blocked, and Level 3 rules-only work is the only unblocked option that needs nothing outside this container.

Alternative: **3.5 Video-model interface with a dry-run backend.** Also pure Python, Level 3, and useful for the pipeline before any model runs.

Reason for selecting: both are testable here, neither needs an install, and both sit on the MVP path.

## Current limitations

- No GPU, Blender, or model in this container. Levels 2–5 cannot be run here.
- The GPU host (`witzp@tranklena`) is unreachable from this container. The user must run the inventory on it or provide access.
- Hermes memory was mentioned by the user. No Hermes files exist here; the location of that memory is unknown.
- Character animation is not implemented: the MVP's raised arm is recorded in the scene file and validated, but no skeleton moves yet.
- `build_character_position` holds characters at a fixed position.
- Changes are not committed. The branch `workspace-layout-vybfgp` has the engine work in the working tree.
