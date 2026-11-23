// Local ComfyUI Video Runner for Zaude (e.g. Rizzar laptop running LTX-Video 2B GGUF or Wan 2.1 1.3B GGUF).
// Auto-detects installed local video models in ~/ComfyUI, auto-starts local ComfyUI with GPU-matched
// flags when needed, builds native ComfyUI graphs (T2V, I2V, First & Last Frame), streams live
// step-by-step denoising previews via comfy-live.cjs, and downloads the resulting MP4.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const comfyLive = require('./comfy-live.cjs');
const systemAdvisor = require('./system-advisor.cjs');

const DEFAULT_LOCAL_COMFY_DIR = path.join(os.homedir(), 'ComfyUI');
const DEFAULT_LOCAL_COMFY_URL = 'http://127.0.0.1:8188';

let spawnedComfyChild = null;

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .sort();
  } catch {
    return [];
  }
}

async function isComfyAlive(comfyUrl = DEFAULT_LOCAL_COMFY_URL) {
  try {
    const res = await fetch(`${comfyUrl.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Scans ~/ComfyUI/models/{unet,vae,clip} to discover every runnable local video model.
function detectInstalledModels(comfyDir = DEFAULT_LOCAL_COMFY_DIR) {
  const unets = listFiles(path.join(comfyDir, 'models', 'unet'), ['.gguf', '.safetensors']);
  const vaes = listFiles(path.join(comfyDir, 'models', 'vae'), ['.safetensors', '.pt']);
  const clips = listFiles(path.join(comfyDir, 'models', 'clip'), ['.gguf', '.safetensors']);
  const loras = listFiles(path.join(comfyDir, 'models', 'loras'), ['.safetensors']);

  const models = [];
  for (const unet of unets) {
    const low = unet.toLowerCase();
    if (low.includes('ltx')) {
      const vae = vaes.find((v) => v.toLowerCase().includes('ltx')) || vaes[0] || '';
      const clip = clips.find((c) => c.toLowerCase().includes('t5') && !c.toLowerCase().includes('umt5')) || clips[0] || '';
      const distilled = low.includes('distill');
      models.push({
        id: `ltx:${unet}`,
        family: 'ltx',
        label: distilled ? 'LTX-Video 2B Distilled' : 'LTX-Video 2B',
        unet,
        vae,
        clip,
        distilled,
        defaultSteps: distilled ? 8 : 20,
        defaultCfg: distilled ? 1.0 : 3.0,
        supportsFl2v: true,
        ready: Boolean(unet && vae && clip),
      });
    } else if (low.includes('wan')) {
      const vae = vaes.find((v) => v.toLowerCase().includes('wan')) || vaes[0] || '';
      const clip = clips.find((c) => c.toLowerCase().includes('umt5')) || clips[0] || '';
      const turboLora = loras.find((l) => /causvid|lightx2v/i.test(l)) || '';
      models.push({
        id: `wan:${unet}`,
        family: 'wan',
        label: low.includes('1.3b') ? 'Wan 2.1 1.3B' : 'Wan 2.1',
        unet,
        vae,
        clip,
        lora: turboLora,
        distilled: Boolean(turboLora),
        defaultSteps: turboLora ? 8 : 20,
        defaultCfg: turboLora ? 1.0 : 5.0,
        supportsFl2v: false,
        ready: Boolean(unet && vae && clip),
      });
    }
  }
  return models;
}

async function detectLocalSetup({ comfyDir = DEFAULT_LOCAL_COMFY_DIR, comfyUrl = DEFAULT_LOCAL_COMFY_URL } = {}) {
  const hostname = os.hostname() || 'Local';
  const report = systemAdvisor.analyzeSystem({ comfyDir });
  const models = detectInstalledModels(comfyDir);
  const comfyInstalled = fs.existsSync(path.join(comfyDir, 'main.py'));
  const comfyRunning = await isComfyAlive(comfyUrl);
  const defaultModel = models.find((m) => m.ready) || models[0] || null;
  return {
    ok: true,
    hostname,
    gpu: report.gpu,
    optimizations: report.optimizations,
    comfyDir,
    comfyUrl,
    comfyInstalled,
    comfyRunning,
    models,
    defaultModel,
  };
}

// Auto-starts local ComfyUI if not running yet, using GPU-matched optimization flags.
async function ensureLocalComfy({ comfyDir = DEFAULT_LOCAL_COMFY_DIR, comfyUrl = DEFAULT_LOCAL_COMFY_URL, onEvent = () => {} } = {}) {
  if (await isComfyAlive(comfyUrl)) return { ok: true, started: false };
  const mainPy = path.join(comfyDir, 'main.py');
  if (!fs.existsSync(mainPy)) {
    return { ok: false, error: `Local ComfyUI not found at ${comfyDir}. Install a local model via "🖥️ Local GPU" first.` };
  }
  const venvPy = path.join(comfyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pythonBin = fs.existsSync(venvPy) ? venvPy : 'python3';
  const report = systemAdvisor.analyzeSystem({ comfyDir });
  const flags = (report.optimizations && report.optimizations.comfyFlags) || ['--use-pytorch-cross-attention', '--force-fp16', '--lowvram'];

  const u = new URL(comfyUrl);
  const args = [mainPy, '--listen', u.hostname || '127.0.0.1', '--port', String(u.port || 8188), ...flags];
  onEvent({ stage: 'boot', message: `Starting local ComfyUI on ${os.hostname()} (${flags.join(' ')})…` });

  if (!spawnedComfyChild || spawnedComfyChild.exitCode !== null) {
    spawnedComfyChild = spawn(pythonBin, args, {
      cwd: comfyDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    spawnedComfyChild.unref();
    spawnedComfyChild.on('exit', () => { spawnedComfyChild = null; });
  }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await isComfyAlive(comfyUrl)) {
      onEvent({ stage: 'boot', message: `Local ComfyUI ready on ${comfyUrl}` });
      return { ok: true, started: true };
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { ok: false, error: `Timed out waiting for local ComfyUI to start at ${comfyUrl}.` };
}

function snapLtxFrames(seconds, fps = 24) {
  const raw = Math.max(17, Math.min(161, Math.round((Number(seconds) || 4) * fps)));
  const k = Math.max(2, Math.round((raw - 1) / 8));
  return k * 8 + 1;
}

function snapWanFrames(seconds, fps = 16) {
  const raw = Math.max(17, Math.min(81, Math.round((Number(seconds) || 4) * fps)));
  const k = Math.max(4, Math.round((raw - 1) / 4));
  return k * 4 + 1;
}

function dimsForLocal(resolution, aspect = '16:9', multiple = 32) {
  const q = Number(resolution) || 480;
  const presets = {
    320: [576, 320],
    480: [768, 512],
    640: [960, 544],
    720: [1024, 576],
  };
  const [rw, rh] = presets[q] || presets[480];
  const snap = (v) => Math.max(multiple * 4, Math.round(v / multiple) * multiple);
  const w = snap(rw);
  const h = snap(rh);
  return aspect === '9:16' ? { width: h, height: w } : { width: w, height: h };
}

// Pure ComfyUI graph builder for LTX-Video 2B (GGUF or safetensors) with T2V, I2V, and First/Last Frame.
function buildLtxGraph({
  prompt,
  negativePrompt = 'low quality, worst quality, deformed, jittery, blurry, watermark, text',
  firstFrameName = null,
  lastFrameName = null,
  width = 768,
  height = 512,
  frames = 97,
  steps = 8,
  cfg = 1.0,
  seed = 1001,
  fps = 24,
  unet = 'ltxv-2b-0.9.8-distilled-q4_k_m.gguf',
  clip = 't5-v1_1-xxl-encoder-Q4_K_M.gguf',
  vae = 'ltxv_0.9.5_vae_fp16.safetensors',
  prefix = 'Zaude/local_ltx',
}) {
  const isGgufUnet = unet.toLowerCase().endsWith('.gguf');
  const isGgufClip = clip.toLowerCase().endsWith('.gguf');

  const graph = {
    '1': isGgufUnet
      ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: unet } }
      : { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': isGgufClip
      ? { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: clip, type: 'ltxv' } }
      : { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'ltxv' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt || '').trim(), clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['2', 0] } },
    '6': { class_type: 'LTXVConditioning', inputs: { positive: ['4', 0], negative: ['5', 0], frame_rate: Number(fps) || 24.0 } },
    '7': { class_type: 'EmptyLTXVLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
  };

  let posRef = ['6', 0];
  let negRef = ['6', 1];
  let latRef = ['7', 0];
  let hasGuides = false;

  if (firstFrameName) {
    graph['20'] = { class_type: 'LoadImage', inputs: { image: firstFrameName } };
    graph['21'] = {
      class_type: 'LTXVAddGuide',
      inputs: { positive: posRef, negative: negRef, vae: ['3', 0], latent: latRef, image: ['20', 0], frame_idx: 0, strength: 0.95 },
    };
    posRef = ['21', 0];
    negRef = ['21', 1];
    latRef = ['21', 2];
    hasGuides = true;
  }

  if (lastFrameName) {
    graph['22'] = { class_type: 'LoadImage', inputs: { image: lastFrameName } };
    graph['23'] = {
      class_type: 'LTXVAddGuide',
      inputs: { positive: posRef, negative: negRef, vae: ['3', 0], latent: latRef, image: ['22', 0], frame_idx: -1, strength: 0.95 },
    };
    posRef = ['23', 0];
    negRef = ['23', 1];
    latRef = ['23', 2];
    hasGuides = true;
  }

  graph['8'] = { class_type: 'RandomNoise', inputs: { noise_seed: Math.abs(Math.round(Number(seed) || 1001)) } };
  graph['9'] = { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: posRef, negative: negRef, cfg: Number(cfg) || 1.0 } };
  graph['10'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  graph['11'] = {
    class_type: 'LTXVScheduler',
    inputs: { steps: Math.max(1, Math.round(Number(steps) || 8)), max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: latRef },
  };
  graph['12'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['8', 0], guider: ['9', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: latRef },
  };

  let decodeLatentRef = ['12', 0];
  if (hasGuides) {
    graph['24'] = { class_type: 'LTXVCropGuides', inputs: { positive: posRef, negative: negRef, latent: ['12', 0] } };
    decodeLatentRef = ['24', 2];
  }

  graph['13'] = {
    class_type: 'VAEDecodeTiled',
    inputs: { samples: decodeLatentRef, vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
  };
  graph['14'] = {
    class_type: 'CreateVideo',
    inputs: { images: ['13', 0], fps: Number(fps) || 24.0, bit_depth: 'auto', color_space: 'sRGB' },
  };
  graph['15'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['14', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'h264' },
  };
  return graph;
}

// Pure ComfyUI graph builder for Wan 2.1 1.3B GGUF (+ optional CausVid/LightX2V turbo LoRA).
function buildWanGraph({
  prompt,
  negativePrompt = 'low quality, worst quality, blurry, distorted, watermark',
  width = 832,
  height = 480,
  frames = 65,
  steps = 8,
  cfg = 1.0,
  seed = 1001,
  fps = 16,
  unet = 'wan2.1_t2v_1.3b-q8_0.gguf',
  clip = 'umt5-xxl-encoder-Q4_K_M.gguf',
  vae = 'wan_2.1_vae.safetensors',
  lora = '',
  prefix = 'Zaude/local_wan',
}) {
  const isGgufUnet = unet.toLowerCase().endsWith('.gguf');
  const isGgufClip = clip.toLowerCase().endsWith('.gguf');
  const graph = {
    '1': isGgufUnet
      ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: unet } }
      : { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': isGgufClip
      ? { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: clip, type: 'wan' } }
      : { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt || '').trim(), clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['2', 0] } },
    '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed: Math.abs(Math.round(Number(seed) || 1001)),
        steps: Math.max(1, Math.round(Number(steps) || 8)),
        cfg: Number(cfg) || 1.0,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    '8': {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['7', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    '9': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: Number(fps) || 16.0, bit_depth: 'auto', color_space: 'sRGB' } },
    '10': { class_type: 'SaveVideo', inputs: { video: ['9', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'h264' } },
  };
  if (lora) {
    graph['20'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1.0 } };
    graph['7'].inputs.model = ['20', 0];
  }
  return graph;
}

async function uploadImageToComfy(comfyUrl, filePath) {
  const bytes = fs.readFileSync(filePath);
  const name = `zaude_local_${Date.now()}_${path.basename(filePath)}`;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), name);
  form.append('overwrite', 'true');
  const res = await fetch(`${comfyUrl.replace(/\/$/, '')}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Local ComfyUI image upload failed (${res.status})`);
  const data = await res.json();
  return data.name || name;
}

function runLocalVideo({
  comfyDir = DEFAULT_LOCAL_COMFY_DIR,
  comfyUrl = DEFAULT_LOCAL_COMFY_URL,
  modelId = '',
  prompt,
  firstFrame = '',
  lastFrame = '',
  seconds = 4,
  resolution = 480,
  aspect = '16:9',
  steps = 0,
  seed = 1001,
  outDir,
  previewDir = '',
  jobId = 'local',
  onEvent = () => {},
}) {
  let cancelled = false;
  let promptId = null;
  let watcher = null;

  const cancel = async () => {
    cancelled = true;
    try { if (watcher) watcher.close(); } catch { /* ignore */ }
    const base = comfyUrl.replace(/\/$/, '');
    try {
      if (promptId) {
        await fetch(`${base}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] }),
        });
      }
      await fetch(`${base}/interrupt`, { method: 'POST' });
    } catch { /* ignore */ }
  };

  const promise = (async () => {
    try {
      const setup = await detectLocalSetup({ comfyDir, comfyUrl });
      const model = (modelId && setup.models.find((m) => m.id === modelId)) || setup.defaultModel;
      if (!model || !model.ready) {
        return { ok: false, error: `No runnable local model found in ${comfyDir}. Open "🖥️ Local GPU" to install LTX-Video 2B or Wan 2.1 1.3B.` };
      }

      const boot = await ensureLocalComfy({
        comfyDir,
        comfyUrl,
        onEvent: (e) => onEvent({ type: 'progress', message: e.message, percent: 5 }),
      });
      if (!boot.ok) return { ok: false, error: boot.error };
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      const base = comfyUrl.replace(/\/$/, '');
      let firstFrameName = null;
      let lastFrameName = null;
      if (firstFrame && fs.existsSync(firstFrame)) {
        onEvent({ type: 'progress', message: 'Uploading first frame to local ComfyUI…', percent: 10 });
        firstFrameName = await uploadImageToComfy(base, firstFrame);
      }
      if (lastFrame && fs.existsSync(lastFrame)) {
        onEvent({ type: 'progress', message: 'Uploading last frame to local ComfyUI…', percent: 14 });
        lastFrameName = await uploadImageToComfy(base, lastFrame);
      }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      const chosenSteps = Number(steps) > 0 ? Number(steps) : model.defaultSteps;
      let graph;
      let width;
      let height;
      let frames;

      if (model.family === 'wan') {
        ({ width, height } = dimsForLocal(resolution, aspect, 16));
        frames = snapWanFrames(seconds, 16);
        graph = buildWanGraph({
          prompt, width, height, frames, steps: chosenSteps, cfg: model.defaultCfg,
          seed, unet: model.unet, clip: model.clip, vae: model.vae, lora: model.lora,
        });
      } else {
        ({ width, height } = dimsForLocal(resolution, aspect, 32));
        frames = snapLtxFrames(seconds, 24);
        graph = buildLtxGraph({
          prompt, firstFrameName, lastFrameName, width, height, frames, steps: chosenSteps, cfg: model.defaultCfg,
          seed, unet: model.unet, clip: model.clip, vae: model.vae,
        });
      }

      onEvent({ type: 'progress', message: `Queueing ${model.label} on ${setup.hostname} (${width}×${height}, ${frames}f, ${chosenSteps} steps)…`, percent: 18 });
      const clientId = `zaude-local-${Date.now()}`;
      watcher = comfyLive.watchComfyJob({
        baseUrl: base,
        previewDir: previewDir || outDir,
        jobId,
        onPreview: (previewPath) => {
          if (previewPath) onEvent({ type: 'preview', previewPath });
        },
        onStep: ({ step, totalSteps }) => {
          const pct = totalSteps ? Math.min(94, Math.round(20 + (step / totalSteps) * 72)) : 50;
          onEvent({ type: 'progress', step, maxSteps: totalSteps, percent: pct, message: `💻 ${setup.hostname} ${model.label}: step ${step}/${totalSteps}` });
        },
      });

      const submitRes = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      if (!submitRes.ok) {
        const txt = await submitRes.text().catch(() => '');
        return { ok: false, error: `Local ComfyUI rejected workflow (${submitRes.status}): ${txt.slice(0, 300)}` };
      }
      const submitJson = await submitRes.json();
      promptId = submitJson.prompt_id;
      if (!promptId) return { ok: false, error: 'Local ComfyUI did not return a prompt_id.' };
      if (watcher) watcher.setPromptId(promptId);

      // Poll history until finished
      let fileEntry = null;
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        const hRes = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
        if (!hRes.ok) continue;
        const hist = await hRes.json();
        const item = hist[promptId];
        if (!item) continue;
        if (item.status && item.status.status_str === 'error') {
          const errMsg = JSON.stringify(item.status.messages || '').slice(0, 300);
          return { ok: false, error: `Local ComfyUI execution error: ${errMsg}` };
        }
        if (item.outputs) {
          for (const nodeOut of Object.values(item.outputs)) {
            const list = nodeOut.videos || nodeOut.gifs || nodeOut.images;
            if (Array.isArray(list) && list.length) {
              fileEntry = list[0];
              break;
            }
          }
          if (fileEntry) break;
        }
      }
      try { if (watcher) watcher.close(); } catch { /* ignore */ }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      if (!fileEntry) return { ok: false, error: 'Local ComfyUI finished without producing a video file.' };

      // Download MP4 from local ComfyUI /view into Zaude's output directory
      fs.mkdirSync(outDir, { recursive: true });
      const dlUrl = `${base}/view?filename=${encodeURIComponent(fileEntry.filename)}&subfolder=${encodeURIComponent(fileEntry.subfolder || '')}&type=${encodeURIComponent(fileEntry.type || 'output')}`;
      const dlRes = await fetch(dlUrl);
      if (!dlRes.ok) return { ok: false, error: `Failed to fetch generated video (${dlRes.status})` };
      const outPath = path.join(outDir, `local_${model.family}_${Date.now()}.mp4`);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(outPath, buf);

      onEvent({ type: 'progress', message: `Saved local ${model.label} clip`, percent: 100 });
      return { ok: true, path: outPath, model: model.label, hostname: setup.hostname, backend: 'local' };
    } catch (err) {
      try { if (watcher) watcher.close(); } catch { /* ignore */ }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      return { ok: false, error: err.message || String(err) };
    }
  })();

  return { promise, cancel };
}

module.exports = {
  DEFAULT_LOCAL_COMFY_DIR,
  DEFAULT_LOCAL_COMFY_URL,
  detectInstalledModels,
  detectLocalSetup,
  ensureLocalComfy,
  snapLtxFrames,
  snapWanFrames,
  dimsForLocal,
  buildLtxGraph,
  buildWanGraph,
  runLocalVideo,
};
