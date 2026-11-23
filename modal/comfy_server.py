"""
Serverless ComfyUI GPU backend for Zaude on Modal.com.
Supports L40S (48 GB), A100-80GB, and H100 (80 GB) with persistent model storage,
--preview-method auto (live step-by-step WebSocket previews), and scale-to-zero ($0 idle).

Quick start:
  1. pip install modal && modal setup
  2. MODAL_GPU=L40S modal deploy modal/comfy_server.py
  3. (Optional) Download open video models directly onto the Modal Volume:
     modal run modal/comfy_server.py::download_open_models
  4. Paste the printed https://...modal.run URL into Zaude -> AI Studio -> Modal Cloud Final.
"""
import os
import subprocess
import modal

GPU_TYPE = os.environ.get("MODAL_GPU", "H100")  # L40S | A100-80GB | H100
APP_NAME = os.environ.get("MODAL_APP_NAME", "zaude-comfy")
VOLUME_NAME = os.environ.get("MODAL_VOLUME_NAME", "zaude-comfy-models")

app = modal.App(APP_NAME)
models_vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

comfy_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "curl", "wget")
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


@app.function(
    image=comfy_image,
    gpu=GPU_TYPE,
    volumes={"/root/ComfyUI/models": models_vol},
    scaledown_window=180,
    timeout=1800,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(8188, startup_timeout=180)
def comfy_web():
    """Starts ComfyUI on port 8188 with live step previews enabled."""
    for sub in ("unet", "diffusion_models", "vae", "clip", "text_encoders", "loras", "upscale_models", "checkpoints", "refmods"):
        os.makedirs(f"/root/ComfyUI/models/{sub}", exist_ok=True)
    cmd = [
        "python3",
        "/root/ComfyUI/main.py",
        "--listen", "0.0.0.0",
        "--port", "8188",
        "--preview-method", "auto",
    ]
    subprocess.Popen(cmd, cwd="/root/ComfyUI")


@app.function(
    image=comfy_image,
    volumes={"/root/ComfyUI/models": models_vol},
    timeout=1800,
)
def download_open_models():
    """Downloads fast open final-pass models (LTX 0.9.8, Wan 2.1 14B FLF2V, RealESRGAN 2x) onto the Modal Volume."""
    downloads = [
        (
            "https://huggingface.co/calcuis/ltxv-gguf/resolve/main/ltxv-2b-0.9.8-distilled-q4_k_m.gguf",
            "/root/ComfyUI/models/unet/ltxv-2b-0.9.8-distilled-q4_k_m.gguf",
        ),
        (
            "https://huggingface.co/calcuis/ltxv-gguf/resolve/main/ltxv_0.9.5_vae_fp16.safetensors",
            "/root/ComfyUI/models/vae/ltxv_0.9.5_vae_fp16.safetensors",
        ),
        (
            "https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf",
            "/root/ComfyUI/models/clip/t5-v1_1-xxl-encoder-Q4_K_M.gguf",
        ),
        (
            "https://huggingface.co/city96/Wan2.1-FLF2V-14B-720P-gguf/resolve/main/wan2.1-flf2v-14b-720p-Q4_K_S.gguf",
            "/root/ComfyUI/models/unet/wan2.1-flf2v-14b-720p-Q4_K_S.gguf",
        ),
        (
            "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors",
            "/root/ComfyUI/models/vae/wan_2.1_vae.safetensors",
        ),
        (
            "https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf",
            "/root/ComfyUI/models/clip/umt5-xxl-encoder-Q4_K_M.gguf",
        ),
        (
            "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
            "/root/ComfyUI/models/loras/lightx2v_I2V_14B_480p_rank64_bf16.safetensors",
        ),
        (
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
            "/root/ComfyUI/models/upscale_models/RealESRGAN_x2plus.pth",
        ),
    ]
    for url, dest in downloads:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest) and os.path.getsize(dest) > 1024:
            print(f"[skip] {dest} already exists")
            continue
        print(f"[download] {url} -> {dest}")
        subprocess.run(["curl", "-L", "-C", "-", "--fail", "-o", dest, url], check=True)
    models_vol.commit()
    print("All open models downloaded and committed to Modal Volume.")


@app.function(
    image=comfy_image,
    volumes={"/root/ComfyUI/models": models_vol},
    timeout=3600,
)
def download_minimax_h3():
    """Downloads MiniMax-H3 Ref2VA (FP8 scaled) + Qwen3VL-32B + VAEs + 4-step Turbo LoRA onto Modal Volume."""
    downloads = [
        (
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
            "/root/ComfyUI/models/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
        ),
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
    ]
    for url, dest in downloads:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest) and os.path.getsize(dest) > 1024 * 1024:
            print(f"[skip] {dest} already exists")
            continue
        print(f"[download] {url} -> {dest}")
        subprocess.run(["curl", "-L", "-C", "-", "--fail", "-o", dest, url], check=True)
    models_vol.commit()
    print("MiniMax-H3 Ref2VA suite downloaded and committed to Modal Volume.")
