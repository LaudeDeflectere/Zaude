# Environment report

Inspected on 2026-11-18 from the Zaude cloud container. Commands were read-only except for installing nothing.

## This container (where the engine code runs)

| Item | Finding |
|---|---|
| OS | Ubuntu 24.04.5 LTS, kernel 6.18 (VM) |
| CPU | 4 cores |
| RAM | 15 GiB, about 15 GiB free |
| Disk | 252 GB volume, 22 % used (30 GB available) |
| GPU | **None.** `nvidia-smi` not found. No CUDA. |
| Python | 3.13.18 at `/usr/local/bin/python3` |
| Python packages | numpy 2.5.3, jsonschema 4.26.0. **No torch. No pytest.** |
| Blender | **Not installed.** |
| ComfyUI | **Not installed** (no `~/ComfyUI`, `/opt/ComfyUI`). |
| Video models | None on disk. |
| ffmpeg | 6.1.1 installed (ffprobe available). |
| Node | 22.23.4 (used by the Zaude desktop app). |
| ssh client | **Not installed.** |
| Repositories | `/home/user/Zaude` (this repo). No other project was touched. |

Consequence: the engine's Level 1 work (pure Python geometry) runs here. Anything needing a GPU, Blender, or a diffusion model cannot run in this container.

## The GPU host `witzp@tranklena` (named by the user)

The user said the compute runs on `witzp@tranklena` over ssh. From this container:

- `tranklena` does **not resolve** in DNS.
- There is **no ssh client** installed, and **no key** in `/root/.ssh`.

So this container cannot inspect that host. The inspection must be run from a machine that can reach it. The Zaude desktop app's "Remote machines" feature already does this: it runs `ssh` from the user's computer, where keys and `~/.ssh/config` live, and stores the report.

Still to confirm on tranklena (the first ones matter for model choice):

- `nvidia-smi`: GPU name and VRAM. Wan2.1-1.3B needs roughly 8 GB; the 14B models need far more.
- `python3 -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- Whether ComfyUI is installed and where, and which Wan / VACE weights exist under its `models/` folder.
- Whether Blender is installed (`blender --version`).
- Free disk space.
- Any existing repositories (for example a Uni3C or VACE checkout) that should be reused rather than reinstalled.

The user mentioned Hermes memory on this machine as well. No Hermes files exist in this container, so that information has to come from tranklena or from the user.

## Decisions based on this inventory

1. The engine is pure Python with no third-party dependencies, so it runs in any environment, including Blender's bundled Python.
2. Nothing is installed in this container until it is needed. Blender (Level 2) is the first candidate, and the apt package install needs approval.
3. Model work (Level 3 and up) waits for the GPU host inventory above.
