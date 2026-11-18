# Zaude scene engine roadmap

The full task list is in `TASKS.json`. Status is in `PROGRESS.md`. This file explains the order.

## Principle

Build the simplest working component first, then add one verified step at a time. A task is marked complete only when its acceptance criteria are demonstrated by a test.

Difficulty is **implementation** difficulty, not research difficulty. Tasks are ordered by difficulty (1 to 5) and by dependency: a task waits for what it needs.

## Difficulty levels

| Level | Meaning | Where it runs |
|---|---|---|
| 1 | Very easy: scripts, data formats, geometry | This container (CPU, Python) |
| 2 | Easy: Blender scene building, placeholder characters, renders | Needs Blender |
| 3 | Moderate: parsers, pose sequences, first AI backend | Needs the GPU host |
| 4 | Hard: multiple controls, identity, interactions, evaluation | GPU host |
| 5 | Very hard: automatic correction, continuity, optimisation, UI | GPU host and Zaude |

## Milestones

### M1: describe scenes mathematically (Level 1), done
Tasks 1.1–1.7. The engine validates scene files, computes timelines, coordinates, and camera paths, and ships the MVP scene. No rendering. Tests: 39 passing.

### M2: Blender scene generator (Level 2), blocked on Blender
Tasks 2.1–2.7. Needs Blender, which is not installed in this container. Next step is to decide whether to install the apt `blender` package here or to run Blender on tranklena.

### M3: first controlled generation (Level 3), blocked on the GPU host
Tasks 3.1–3.7. The first AI backend (VACE on Wan2.1-1.3B) runs on tranklena. Needs the host inventory (GPU, VRAM, ComfyUI, weights).

### M4: complex scenes with measurements (Level 4)
Tasks 4.1–4.7. Multiple controls, identity, interactions, automated evaluation, benchmarking.

### M5: semi-autonomous filmmaking engine (Level 5)
Tasks 5.1–5.7. Error detection and correction, multi-shot continuity, UI in Zaude.

## Dependency highlights

- 1.6 (camera) feeds 2.2 (Blender camera).
- 2.5 (animation) and 2.7 (passes) feed 3.4 (pose sequences).
- 3.6 (first generation) gates identity (4.3), efficiency (5.6), and reproducibility (3.7).
- 4.6 (evaluation) gates benchmarking (4.7), error detection (5.1), and the correction loop.

## Next task

The next unblocked, easiest task is **none at Level 1**, which is complete. The next available task that does not need a new tool is **3.1 natural-language parser** (rules first), which needs only Python. It is at Level 3, so it is a judgement call; it is listed as the next step in `PROGRESS.md`.
