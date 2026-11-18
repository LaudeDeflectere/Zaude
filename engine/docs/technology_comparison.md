# Technology comparison

Research pass on 2026-11-18. Two web searches confirmed repository locations and a few facts. Everything else is marked as **unverified**: it comes from prior knowledge, and no model weights were downloaded or run.

Legend: **Verified** = confirmed in a source listed below. **Unverified** = not checked in this pass. Status "maintained?" is the last activity I could confirm.

## Video generation (Level 3 and up)

### Wan 2.1 (Wan-Video)
- **Verified:** official repository `github.com/Wan-Video/Wan2.1`; weights on Hugging Face under `Wan-AI`. Includes a single-GPU example (`generate.py --task vace-1.3B`).
- **What it does:** text-to-video and image-to-video diffusion transformer. Wan 2.1 is a 14B model family, with a 1.3B variant.
- **Inputs / outputs:** text, optional image; outputs a short video clip.
- **Temporal conditioning:** yes (it is a video model).
- **Combines with other controls:** through VACE and Uni3C (below), not on its own.
- **VRAM:** 1.3B fits consumer GPUs. 14B needs a large card or offloading. Exact numbers to be measured on tranklena.
- **Install difficulty:** medium. **Implementation complexity:** medium. **Reliability:** unverified here.
- **Maintained?** Verified as active in the search results (Wan2.1 is the base for VACE and Uni3C).

### VACE (All-in-One Video Creation and Editing)
- **Verified:** official code at `github.com/ali-vilab/VACE` (ICCV 2025). Built on Wan2.1, which it asks you to install from the Wan-Video repo. Weights on Hugging Face: `Wan-AI/Wan2.1-VACE-1.3B` and `Wan2.1-VACE-14B`.
- **What it does:** one model for video generation and editing from text plus optional video, mask, or image inputs. This is the most useful candidate for our control inputs, because it accepts masks and reference frames.
- **Temporal conditioning:** yes.
- **VRAM:** same family as Wan; the 1.3B variant is the realistic starting point.
- **Known limitations:** unverified; to be measured in Level 3.
- **Maintained?** The repository is part of the ICCV 2025 release. Activity after that was not checked.
- **Recommended first generation backend** (task 3.6), because it accepts structured conditioning in one place.

### Wan Fun Control
- **Unverified.** Believed to be a Wan variant that accepts pose and depth control sequences. Confirm the repository and weights before use.

### ControlNet-style conditioning
- **Unverified in general.** Adapters that add pose, depth, or edge maps to a diffusion model. Works best with image models; video support depends on the model. Not chosen as the first backend.

## Camera control (Level 3 and 4)

### CameraCtrl
- **Verified:** ICLR 2025 paper, arXiv 2404.02101 (v2 revised March 2025). A plug-and-play camera-pose module applied to AnimateDiff (text-to-video) and Stable Video Diffusion (image-to-video).
- **What it does:** takes a camera trajectory (per-frame pose) and conditions the video on it.
- **Inputs / outputs:** camera pose sequence in, video out. Temporal: yes.
- **Code:** the paper page and project page have a "Code" link, but the repository address was not visible in the search result. Project page: `hehao13.github.io/projects-CameraCtrl`. **Repository not confirmed.**
- **Base model:** AnimateDiff / SVD, not Wan. Using it would mean a second model family.
- **Maintained?** Unverified.

### Uni3C
- **Verified:** `github.com/alibaba-damo-academy/Uni3C`, project page `alibaba-damo-academy.github.io/Uni3C`. From Alibaba DAMO Academy, Fudan University, and Hupan Lab (SIGGRAPH Asia 2025).
- **What it does:** camera control (a module called PCDController, which uses 3D point clouds unprojected from a depth scene) plus human motion control via SMPL-X characters in a shared 3D frame.
- **Built on:** Wan2.1 14B.
- **Inputs:** a camera trajectory, a point cloud or depth scene, and an SMPL-X motion sequence.
- **Temporal:** yes. **Combines with:** camera and human motion together, which is exactly what the project needs.
- **VRAM:** the 14B base model. Needs a large GPU.
- **Reliability and maintenance:** unverified (repository activity not checked). A second repository under a personal account also appeared; it is a mirror and should not be used.
- **Relevance:** the most complete fit for Level 4 (synchronised camera and character), but heavy.

### Blender camera trajectories (deterministic)
- **Verified in principle:** this is what Level 1 and Level 2 do. The engine computes camera poses exactly (see `engine/zaude_engine/camera.py`), and Blender only renders them.
- **Requires:** Blender, which is not installed here.

## Character motion (Level 3 and 4)

### DWPose (IDEA-Research)
- **Verified:** `github.com/IDEA-Research/DWPose`, ICCV 2023 workshop paper ("Effective Whole-body Pose Estimation with Two-stages Distillation"). Apache-2.0 licence. Models in several sizes. Built on MMPose.
- **What it does:** whole-body keypoints (body, hands, face) from images or video frames. Used to extract pose from reference video or to check generated frames.
- **Output:** keypoints per frame (OpenPose-style format).
- **Maintained?** The search listing showed the last push in **December 2023** and the default branch is `onnx`. Treat it as **not actively maintained**; expect to pin versions.

### OpenPose
- **Unverified in this pass.** The keypoint format most pose-conditioned models accept. Licence is restrictive for commercial use; check before depending on it.

### Blender skeletal animation
- **Unverified in this pass; standard Blender feature.** Armatures and actions give exact, repeatable joint angles. This is the deterministic path for Level 2 (task 2.5).

### Motion-capture retargeting and motion-generation models
- **Unverified.** Retargeting (for example to SMPL-X) and motion-generation models are Level 4 options. Not investigated further in this pass.

## Geometry (Level 2 and 4)

- **Depth, normal, segmentation, and optical flow:** Blender's compositor and Cycles render these passes exactly from the scene (task 2.7). This is deterministic and needs no AI.
- **3D scene reconstruction** (from video): **unverified.** Only needed if the scene must be built from existing footage. Not planned before Level 4.

## Character consistency (Level 4)

- **Reference-image conditioning, identity adapters, and character LoRAs:** **unverified** in this pass. These need a specific model family and the GPU host. Evaluation is task 4.3, after a working backend exists.

## Summary for the roadmap

| Need | Candidate | Verified | Start with |
|---|---|---|---|
| Exact camera motion | Our engine + Blender | Yes (math tested) | Level 1–2 |
| Video generation backend | VACE on Wan2.1-1.3B | Repos and weights confirmed | Task 3.6 |
| Camera conditioning for video | Uni3C (on Wan 14B) or CameraCtrl | Uni3C repo confirmed; CameraCtrl repo not | Task 4.2 |
| Pose conditioning | DWPose or OpenPose format | DWPose repo confirmed, low maintenance | Task 3.4 |
| Identity | Reference adapters or LoRA | Not checked | Task 4.3 |

## Sources

- VACE and Wan2.1 repositories and Hugging Face weights: `github.com/ali-vilab/VACE`, `github.com/Wan-Video/Wan2.1`, `huggingface.co/Wan-AI/Wan2.1-VACE-14B` (search results, 2026-11-18).
- CameraCtrl: arXiv 2404.02101, ICLR 2025 proceedings, project page `hehao13.github.io/projects-CameraCtrl` (search results).
- Uni3C: `github.com/alibaba-damo-academy/Uni3C`, `arxiv.org/abs/2504.14899` (search results).
- DWPose: `github.com/IDEA-Research/DWPose`, arXiv 2307.15880 (search results, including a listing that showed the last push date).
