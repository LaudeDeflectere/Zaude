"""
3-Tier Serverless ComfyUI GPU Backend for Zaude on Modal.com.
Credit-optimized (scaledown_window=60s -> $0/hr idle) with three independent GPU tiers sharing
one persistent model volume (`zaude-comfy-models`):

  - comfy_fast     (L40S 48 GB,  ~$1.95/hr): Fast & Cheap drafts (Singularity v2 pruned INT8 4-step / LTX-2B)
  - comfy_balanced (H100 80 GB,  ~$3.95/hr): RTX 3090 baseline quality at ~7x speed (Singularity v2 pruned INT8 6-step)
  - comfy_ultra    (H200 141 GB, ~$4.54/hr): Maximum quality & prompt adherence (Singularity v2 FULL BF16 + Qwen3VL BF16 + VAE FP16)

Deploy all 3 tiers at once:
  modal deploy modal/comfy_server.py
Download Singularity v2 tiers (Balanced + Ultra BF16) onto the volume:
  modal run modal/comfy_server.py::download_singularity_tiers
"""
import os
import subprocess
import modal

APP_NAME = os.environ.get("MODAL_APP_NAME", "zaude-comfy")
VOLUME_NAME = os.environ.get("MODAL_VOLUME_NAME", "zaude-comfy-models")

app = modal.App(APP_NAME)
models_vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

comfy_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "curl", "wget", "aria2")
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /root/ComfyUI",
        "pip install -r /root/ComfyUI/requirements.txt",
        "git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git /root/ComfyUI/custom_nodes/ComfyUI-GGUF",
        "pip install -r /root/ComfyUI/custom_nodes/ComfyUI-GGUF/requirements.txt",
        "git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git /root/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite",
        "pip install -r /root/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt",
        "git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo.git /root/ComfyUI/custom_nodes/ComfyUI-LTXVideo",
        "pip install -r /root/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt || true",
        "git clone --depth 1 https://github.com/welltop-cn/ComfyUI-TeaCache.git /root/ComfyUI/custom_nodes/ComfyUI-TeaCache",
        "git clone --depth 1 https://github.com/kijai/ComfyUI-KJNodes.git /root/ComfyUI/custom_nodes/comfyui-kjnodes",
        "pip install -r /root/ComfyUI/custom_nodes/comfyui-kjnodes/requirements.txt || true",
        "git clone --depth 1 https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod /root/ComfyUI/custom_nodes/ComfyUI-MiniMaxH3Mod",
        "git clone --depth 1 https://github.com/SatoDive/Minimax-H3-Latent-Continuation.git /root/ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Latent-Continuation",
        "git clone --depth 1 https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo /root/ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Turbo",
        "pip install sageattention triton || true",
        "rm -rf /root/ComfyUI/models && mkdir -p /root/ComfyUI/models",
    )
)


def _launch_comfy():
    for sub in ("unet", "diffusion_models", "vae", "clip", "text_encoders", "loras", "upscale_models", "checkpoints", "refmods"):
        os.makedirs(f"/root/ComfyUI/models/{sub}", exist_ok=True)
    subprocess.Popen(
        ["python3", "/root/ComfyUI/main.py", "--listen", "0.0.0.0", "--port", "8188", "--preview-method", "auto"],
        cwd="/root/ComfyUI",
    )


# Tier 1: Fast & Cheap (L40S 48 GB, 60s idle scale-to-zero)
@app.function(image=comfy_image, gpu="L40S", volumes={"/root/ComfyUI/models": models_vol}, scaledown_window=60, timeout=1800)
@modal.concurrent(max_inputs=8)
@modal.web_server(8188, startup_timeout=180)
def comfy_fast():
    _launch_comfy()


# Tier 2: Balanced — RTX 3090 Baseline Quality at ~7x Speed (H100 80 GB, 60s idle scale-to-zero)
@app.function(image=comfy_image, gpu="H100", volumes={"/root/ComfyUI/models": models_vol}, scaledown_window=60, timeout=1800)
@modal.concurrent(max_inputs=8)
@modal.web_server(8188, startup_timeout=180)
def comfy_balanced():
    _launch_comfy()


# Tier 3: High Quality Ultra — Full Unquantized BF16 Singularity v2 + Qwen3VL BF16 + VAE FP16 (H200 141 GB, 60s idle scale-to-zero)
@app.function(image=comfy_image, gpu="H200", volumes={"/root/ComfyUI/models": models_vol}, scaledown_window=60, timeout=1800)
@modal.concurrent(max_inputs=4)
@modal.web_server(8188, startup_timeout=180)
def comfy_ultra():
    _launch_comfy()


# Backwards-compatible default alias (Balanced H100)
@app.function(image=comfy_image, gpu="H100", volumes={"/root/ComfyUI/models": models_vol}, scaledown_window=60, timeout=1800)
@modal.concurrent(max_inputs=8)
@modal.web_server(8188, startup_timeout=180)
def comfy_web():
    _launch_comfy()


def _download_list(downloads):
    for url, dest in downloads:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest) and os.path.getsize(dest) > 1024 * 1024:
            print(f"[skip] {dest} ({os.path.getsize(dest) / 1e9:.2f} GB) already exists")
            continue
        print(f"[download] {url} -> {dest}")
        # 8-connection aria2c downloads HuggingFace weights 5-8x faster than single-stream curl
        res = subprocess.run(
            ["aria2c", "-x", "8", "-s", "8", "-k", "16M", "-c", "--summary-interval=10",
             "-d", os.path.dirname(dest), "-o", os.path.basename(dest), url],
        )
        if res.returncode != 0:
            subprocess.run(
                ["curl", "-L", "-C", "-", "--retry", "5", "--retry-all-errors", "--fail", "-o", dest, url],
                check=True,
            )
        models_vol.commit()
        print(f"[committed] {dest} ({os.path.getsize(dest) / 1e9:.2f} GB)")


@app.function(image=comfy_image, volumes={"/root/ComfyUI/models": models_vol}, timeout=3600)
def download_singularity_tiers():
    """Downloads Singularity v2 Balanced (pruned INT8) + Ultra (full BF16 + Qwen3VL BF16 + VAE FP16)."""
    _download_list([
        # Balanced (RTX 3090 baseline upgraded to Singularity v2 pruned INT8)
        (
            "https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/resolve/main/Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors",
            "/root/ComfyUI/models/diffusion_models/Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors",
        ),
        # Ultra (Full unpruned, unquantized Singularity v2 BF16 + Full BF16 Qwen3VL + Full FP16 Video VAE)
        (
            "https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/resolve/main/Minimax-h3_Singularity_ref2va_v2_bf16.safetensors",
            "/root/ComfyUI/models/diffusion_models/Minimax-h3_Singularity_ref2va_v2_bf16.safetensors",
        ),
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_bf16.safetensors",
            "/root/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_bf16.safetensors",
        ),
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
            "/root/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors",
        ),
        # Ensure base INT8 encoder + VAEs + Turbo LoRA are present too
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
            "/root/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        ),
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors",
            "/root/ComfyUI/models/vae/minimax_h3_video_vae_int8_convrot.safetensors",
        ),
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
            "/root/ComfyUI/models/vae/minimax_h3_audio_vae_fp32.safetensors",
        ),
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
            "/root/ComfyUI/models/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        ),
    ])
    print("All Singularity v2 Balanced + Ultra BF16 models committed to Modal Volume.")
