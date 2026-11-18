# Benchmark results

**No generation has been run, so there are no results yet.** This file is the table that will be filled in once tasks 3.6 and 4.7 run. No success rate is reported anywhere in the project until a measured run exists.

## Columns

| Column | Meaning |
|---|---|
| Instruction | The natural-language or scene-file request |
| Control method | None (text only), pose, depth, camera, reference image, and so on |
| Model | Model name and version |
| Seed | Random seed (repeat each test with several seeds) |
| Expected | What the scene asks for, in measurable terms |
| Actual | What the generated clip shows, from the metrics |
| Metrics | Camera trajectory error, pose error, spatial, temporal, identity, visual quality |
| Gen time | Seconds to generate |
| VRAM | Peak GPU memory, GB |
| Result | Success or failure, judged against the metric thresholds |

## Metric types

- **Objective:** camera trajectory error (metres and degrees against the engine's sampled path), keypoint error against pose sequences, frame count and duration, generation time, VRAM.
- **Model-based (labelled as such):** identity similarity from a face embedding, semantic adherence from a captioning or evaluation model. These are estimates and must be reported as such.
- **Subjective:** visual quality rated by a person. Report separately, with the rater count.

## Results

| Instruction | Control method | Model | Seed | Expected | Actual | Metrics | Gen time | VRAM | Result |
|---|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | | |
