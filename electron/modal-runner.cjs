// Modal.com Serverless Cloud GPU Runner & AI Final-Pass Planner for Zaude.
// Lets the user draft on laptop (Rizzar) / RTX 3090 (Tranklena) and switch in 1 click to Modal
// for final-pass 720p renders & upscaling, with Zaude's integrated AI picking the optimal Modal
// GPU (L40S / A100-80GB / H100) and final-pass settings.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const aiChat = require('./ai-chat.cjs');
const comfyLive = require('./comfy-live.cjs');
const localRunner = require('./local-runner.cjs');
const frameToFrame = require('./frame-to-frame.cjs');

const DEFAULT_MODAL_SCRIPT = path.join(__dirname, '..', 'modal', 'comfy_server.py');

const MODAL_GPUS = {
  L40S: {
    id: 'L40S',
    label: 'L40S (48 GB)',
    vramGb: 48,
    hourlyUsd: 1.95,
    bestFor: 'Fast & cheap 480p drafts, LTX-2B, and RealESRGAN 2× upscales',
  },
  'A100-80GB': {
    id: 'A100-80GB',
    label: 'A100 (80 GB)',
    vramGb: 80,
    hourlyUsd: 2.50,
    bestFor: 'Balanced 640p–720p renders',
  },
  H100: {
    id: 'H100',
    label: 'H100 (80 GB)',
    vramGb: 80,
    hourlyUsd: 3.95,
    bestFor: 'RTX 3090 baseline quality (Singularity v2 INT8) at ~7× speed',
  },
  H200: {
    id: 'H200',
    label: 'H200 (141 GB)',
    vramGb: 141,
    hourlyUsd: 4.54,
    bestFor: 'Full unquantized BF16 Singularity v2 + Qwen3VL BF16 + Video VAE FP16',
  },
};

const MODAL_TIERS = {
  fast: {
    id: 'fast',
    label: '⚡ Fast & Cheap',
    gpu: 'L40S',
    endpointSuffix: 'comfy-fast',
    defaultRes: 480,
    defaultSteps: 4,
    defaultSeconds: 5,
    secPerStep640: 5.5,
    modelSummary: 'Singularity v2 INT8 (4-step) / LTX-2B',
    description: 'Cheapest rapid drafts on L40S 48 GB (60s auto-sleep).',
  },
  balanced: {
    id: 'balanced',
    label: '⚖️ Balanced',
    gpu: 'H100',
    endpointSuffix: 'comfy-balanced',
    defaultRes: 640,
    defaultSteps: 6,
    defaultSeconds: 7,
    secPerStep640: 7.2,
    modelSummary: 'Singularity v2 Pruned INT8 + Qwen3VL INT8',
    description: 'Matches your RTX 3090 baseline quality (upgraded to v2) at ~7× speed.',
  },
  ultra: {
    id: 'ultra',
    label: '💎 High Quality',
    gpu: 'H200',
    endpointSuffix: 'comfy-ultra',
    defaultRes: 720,
    defaultSteps: 10,
    defaultSeconds: 7,
    secPerStep640: 11.5,
    modelSummary: 'Singularity v2 FULL BF16 + Qwen3VL BF16 + VAE FP16',
    description: 'Maximum fidelity & prompt adherence on H200 141 GB (zero quantization).',
  },
};

function deriveTierEndpoint(baseUrl, tier = 'balanced') {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  const t = MODAL_TIERS[tier] || MODAL_TIERS.balanced;
  return clean.replace(/comfy-(?:web|fast|balanced|ultra)(?=\.)/i, t.endpointSuffix);
}

// Per-generation time & credit cost estimate tailored to tier, resolution, seconds, and steps.
function estimateModalCost({ tier = 'balanced', resolution, seconds, steps } = {}) {
  const t = MODAL_TIERS[tier] || MODAL_TIERS.balanced;
  const gpuInfo = MODAL_GPUS[t.gpu] || MODAL_GPUS.H100;
  const res = Number(resolution) || t.defaultRes;
  const secs = Math.max(1, Math.min(20, Number(seconds) || t.defaultSeconds));
  const st = Math.max(1, Math.min(25, Number(steps) || t.defaultSteps));

  const resScale = res <= 320 ? 0.38 : (res <= 480 ? 0.62 : (res <= 640 ? 1.0 : 1.38));
  const lenScale = secs / 6.0;
  const computeSec = Math.max(8, Math.round(st * t.secPerStep640 * resScale * lenScale + 6));
  const estCostUsd = Math.round(((computeSec / 3600) * gpuInfo.hourlyUsd) * 1000) / 1000;

  return {
    ok: true,
    tier: t.id,
    tierLabel: t.label,
    gpu: t.gpu,
    gpuLabel: gpuInfo.label,
    hourlyUsd: gpuInfo.hourlyUsd,
    resolution: res,
    seconds: secs,
    steps: st,
    estSec: computeSec,
    estCostUsd,
    modelSummary: t.modelSummary,
    description: t.description,
  };
}

function safeRun(cmd, args, timeoutMs = 4000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (r.status === 0) return String(r.stdout || '').trim();
  } catch { /* ignore */ }
  return '';
}

// Fast deterministic Modal GPU & final-pass settings recommendation (always instant fallback).
function recommendModalPlan(req = {}) {
  const mode = String(req.mode || 'text-render');
  const seconds = Math.max(1, Math.min(20, Number(req.seconds) || 7));
  const refCount = Array.isArray(req.refmods) ? req.refmods.length : (req.refmod ? 1 : 0);
  const hasFl2v = Boolean(req.firstFrame && req.lastFrame);
  const isFinalHeavy = Number(req.resolution) >= 720 || seconds >= 7 || refCount >= 2 || hasFl2v;

  let gpu = 'L40S';
  let resolution = 640;
  let steps = 8;
  let estSec = 45;
  let reason = 'Fast, cost-effective 48 GB GPU for standard final-pass clips.';

  if (mode === 'upscale-esrgan') {
    gpu = 'L40S';
    resolution = Number(req.resolution) || 720;
    steps = 1;
    estSec = 12;
    reason = 'L40S 48 GB handles RealESRGAN 2× upscaling in ~10–15s at lowest cost.';
  } else if (refCount >= 3 || (Number(req.resolution) >= 720 && seconds >= 7)) {
    gpu = 'H100';
    resolution = 720;
    steps = 8;
    estSec = 75;
    reason = 'Hero 720p / multi-RefMod final pass benefits most from H100 80 GB throughput.';
  } else if (isFinalHeavy) {
    gpu = 'A100-80GB';
    resolution = 720;
    steps = 8;
    estSec = 95;
    reason = '80 GB VRAM gives clean 720p final-pass headroom without offloading.';
  } else {
    gpu = 'L40S';
    resolution = 640;
    steps = 8;
    estSec = 40;
    reason = 'L40S 48 GB gives best speed-per-dollar for 4–6s 640p final shots.';
  }

  const info = MODAL_GPUS[gpu] || MODAL_GPUS.L40S;
  const estCostUsd = Math.round(((estSec / 3600) * info.hourlyUsd) * 1000) / 1000;
  return {
    ok: true,
    source: 'heuristic',
    gpu,
    gpuLabel: info.label,
    resolution,
    steps,
    fps: 24,
    estSec,
    estCostUsd,
    reason,
  };
}

// Uses Zaude's integrated AI CLI (Claude / Codex / OpenCode) to pick the optimal Modal GPU & final-pass settings.
function askAiForModalPlan({ request = {}, provider = 'auto' } = {}) {
  const baseline = recommendModalPlan(request);
  const det = aiChat.detectProviders();
  const list = Array.isArray(det && det.providers) ? det.providers : [];
  let chosen = provider;
  if (!chosen || chosen === 'auto') {
    const order = ['claude', 'codex', 'opencode'];
    chosen = order.find((id) => list.some((p) => p.id === id && p.available)) || '';
  }
  if (!chosen) {
    return { promise: Promise.resolve(baseline), cancel: () => {} };
  }

  const prompt = [
    'You are Zaude\'s Cloud GPU Director for Modal.com.',
    'The user drafts ideas on their laptop/RTX 3090 and uses Modal for the FINAL PASS.',
    'Available Modal GPUs:',
    '- L40S (48 GB VRAM, ~$1.95/hr): best value for 480p-640p, Wan 14B, LTX-2B, RealESRGAN 2x.',
    '- A100-80GB (80 GB VRAM, ~$2.50/hr): great for 720p long clips, 2+ RefMods, heavy V2V refine.',
    '- H100 (80 GB VRAM, ~$3.95/hr): fastest for hero 720p BF16/FP8 shots, complex fights/motion, multi-RefMod final passes.',
    '',
    'Current Shot Request:',
    `- Mode: ${request.mode || 'text-render'}`,
    `- Prompt: ${String(request.prompt || request.objectPrompt || '').slice(0, 400)}`,
    `- Seconds: ${request.seconds || 7}`,
    `- Requested Resolution: ${request.resolution || 640}p`,
    `- RefMods count: ${Array.isArray(request.refmods) ? request.refmods.length : 0}`,
    `- First/Last Frame: ${Boolean(request.firstFrame)} / ${Boolean(request.lastFrame)}`,
    '',
    'Return ONLY a JSON object in a ```json block with:',
    '{ "gpu": "L40S" | "A100-80GB" | "H100", "resolution": 480 | 640 | 720, "steps": 6 | 8 | 10 | 12, "fps": 24, "estSec": <int>, "reason": "<concise 1-sentence justification>" }',
  ].join('\n');

  const built = aiChat.buildCliCommand({ provider: chosen, prompt, mcpConfigPath: null });
  if (!built || !built.bin) {
    return { promise: Promise.resolve(baseline), cancel: () => {} };
  }

  let child;
  try {
    child = spawn(built.bin, built.args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return { promise: Promise.resolve(baseline), cancel: () => {} };
  }

  let out = '';
  let cancelled = false;
  child.stdout.on('data', (c) => { out += String(c); });

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(baseline);
    }, 35000);
    child.on('error', () => { clearTimeout(timer); resolve(baseline); });
    child.on('close', () => {
      clearTimeout(timer);
      if (cancelled) return resolve({ ok: false, cancelled: true, error: 'Cancelled' });
      const fenced = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const raw = fenced ? fenced[1] : out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      try {
        const obj = JSON.parse(raw);
        const gpu = MODAL_GPUS[obj.gpu] ? obj.gpu : baseline.gpu;
        const info = MODAL_GPUS[gpu];
        const resolution = [480, 640, 720].includes(Number(obj.resolution)) ? Number(obj.resolution) : baseline.resolution;
        const steps = Math.max(4, Math.min(20, Math.round(Number(obj.steps) || baseline.steps)));
        const estSec = Math.max(10, Math.min(600, Math.round(Number(obj.estSec) || baseline.estSec)));
        const estCostUsd = Math.round(((estSec / 3600) * info.hourlyUsd) * 1000) / 1000;
        return resolve({
          ok: true,
          source: chosen,
          gpu,
          gpuLabel: info.label,
          resolution,
          steps,
          fps: Number(obj.fps) || 24,
          estSec,
          estCostUsd,
          reason: String(obj.reason || baseline.reason).trim().slice(0, 220),
        });
      } catch {
        return resolve(baseline);
      }
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

async function checkModalStatus({ endpointUrl = '' } = {}) {
  const cliInstalled = Boolean(safeRun('modal', ['--version']));
  const tokenFile = path.join(os.homedir(), '.modal.toml');
  const authenticated = fs.existsSync(tokenFile) || Boolean(process.env.MODAL_TOKEN_ID);
  const cleanUrl = String(endpointUrl || '').trim().replace(/\/+$/, '');

  // IMPORTANT: Never send an HTTP fetch to `cleanUrl` during status checks!
  // On Modal serverless, ANY HTTP request cold-boots a GPU container and starts billing.
  // Instead, inspect running containers via the zero-cost Modal control plane CLI.
  const usage = cliInstalled && authenticated ? getModalUsage() : { activeContainers: 0 };
  const reachable = Boolean(cleanUrl && usage.activeContainers > 0);

  return {
    ok: true,
    cliInstalled,
    authenticated,
    endpointUrl: cleanUrl,
    reachable,
    activeContainers: usage.activeContainers || 0,
    gpuName: '',
    installedModels: [],
    scriptPath: DEFAULT_MODAL_SCRIPT,
    gpus: Object.values(MODAL_GPUS),
  };
}

// 1-Click Deploy: runs `MODAL_GPU=<gpu> modal deploy modal/comfy_server.py` and extracts the live HTTPS URL.
function deployModalServer({ gpu = 'L40S', scriptPath = DEFAULT_MODAL_SCRIPT, onLog = () => {} } = {}) {
  const chosenGpu = MODAL_GPUS[gpu] ? gpu : 'L40S';
  let cancelled = false;
  let child = null;

  const promise = new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, error: `Modal server script not found at ${scriptPath}` });
    }
    onLog({ type: 'step', text: `▶ Deploying Zaude ComfyUI to Modal (${chosenGpu})…` });
    try {
      child = spawn('modal', ['deploy', scriptPath], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, MODAL_GPU: chosenGpu },
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: `Could not run modal CLI: ${e.message}. Run "pip install modal && modal setup" first.` });
    }

    let full = '';
    const handle = (chunk) => {
      const s = String(chunk);
      full += s;
      const t = s.trim();
      if (t) onLog({ type: 'log', text: t });
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (cancelled) return resolve({ ok: false, cancelled: true, error: 'Deploy cancelled' });
      const urlMatch = full.match(/https:\/\/[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+\.modal\.run/);
      const endpointUrl = urlMatch ? urlMatch[0] : '';
      if (code === 0) {
        onLog({ type: 'done', text: endpointUrl ? `Deployed! Endpoint: ${endpointUrl}` : 'Deployed to Modal.' });
        return resolve({ ok: true, gpu: chosenGpu, endpointUrl });
      }
      resolve({ ok: false, error: full.trim().slice(-300) || `modal deploy exited with code ${code}` });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      try { if (child) child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

// Pure ComfyUI graph builder for MiniMax-H3 Singularity (SatoDive EasyContextSegments + RefModContinuumBridge).
function buildSingularityGraph({
  prompt,
  model,
  clip,
  videoVae,
  audioVae = 'minimax_h3_audio_vae_fp32.safetensors',
  lora = '',
  refmods = [],
  locationRefMod = '',
  useStepCurve = false,
  width = 1120,
  height = 640,
  aspect = '16:9',
  resolution = 640,
  seconds = 7,
  steps = 6,
  seed = 1001,
  prefix = 'Zaude/modal_h3',
}) {
  const validMods = (refmods || []).filter((r) => r && r.file).slice(0, 8);
  const cleanLoc = String(locationRefMod || '').trim();
  if (cleanLoc && validMods.length < 8 && !validMods.some((r) => r.file === cleanLoc)) {
    validMods.push({
      file: cleanLoc,
      name: 'Location Set',
      identityStrength: 1.0,
      voiceStrength: 0.0,
      isLocation: true,
    });
  }
  const fullPromptLines = [];
  if (validMods.length && !/subject_definitions:/i.test(String(prompt || ''))) {
    fullPromptLines.push('subject_definitions:');
    validMods.forEach((r, i) => {
      fullPromptLines.push(`<Subject ${i + 1}> is ${r.name || `Subject ${i + 1}`}, using the stable identity, face, hair and distinguishing features of <Subject ${i + 1}>'s reference.`);
    });
    fullPromptLines.push('');
  }
  fullPromptLines.push(String(prompt || '').trim());

  const resTag = Number(resolution) >= 720 ? '720P' : (Number(resolution) >= 640 ? '640P' : (Number(resolution) >= 480 ? '480P' : '320P'));
  const loaderInputs = { show_info: false };
  for (let i = 1; i <= 8; i++) {
    const r = validMods[i - 1];
    loaderInputs[`mod_${i}`] = r ? r.file : '(none)';
    loaderInputs[`strength_${i}`] = r ? (Number(r.identityStrength) || 1.0) : 1.0;
    loaderInputs[`copies_${i}`] = 1;
    loaderInputs[`audio_strength_${i}`] = r ? (Number(r.voiceStrength ?? 1.0)) : 0.0;
  }

  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  };

  let modelRef = ['1', 0];
  if (lora) {
    graph['5'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: lora, strength_model: 1.0 } };
    modelRef = ['5', 0];
  }
  if (validMods.length) {
    graph['10'] = { class_type: 'MiniMaxH3RefModsLoader', inputs: loaderInputs };
    graph['11'] = {
      class_type: 'MiniMaxH3RefModContinuumBridge',
      inputs: {
        model: modelRef, mods: ['10', 0], enable: true, retention: 1.0,
        curve_direction: 'constant', curve_shape: 'linear', curve_value: 1.0, scramble_seed: -1,
      },
    };
    modelRef = ['11', 0];
    if (cleanLoc && useStepCurve) {
      // Stronger early high-sigma steps lock room architecture; tapered late steps allow natural character lighting.
      graph['11b'] = {
        class_type: 'MiniMaxH3RefModStepCurve',
        inputs: {
          model: modelRef,
          override: false,
          curve_direction: 'concept_at_start',
          curve_shape: 'ease',
          curve_value: 0.9,
          mods: ['10', 0],
        },
      };
      modelRef = ['11b', 0];
    }
  }

  graph['12'] = {
    class_type: 'MiniMaxH3EasyModelAdapter_SatoDive',
    inputs: { text_encoder: ['2', 0], video_vae: ['3', 0], audio_vae: ['4', 0], ref2va_model: modelRef },
  };
  graph['13'] = {
    class_type: 'MiniMaxH3EasyContextSegments_SatoDive',
    inputs: {
      h3_bundle: ['12', 0],
      mode: 'context_segments',
      audio_mode: 'generated',
      prompt: fullPromptLines.join('\n'),
      resolution: resTag,
      aspect_ratio: aspect === '9:16' ? '9:16' : '16:9',
      custom_ratio: aspect === '9:16' ? '9:16' : '16:9',
      width,
      height,
      seconds: Number(seconds) || 7.0,
      segment_seconds: '',
      context_length: 22,
      continuity_mode: 'native_guide',
      transition_seconds: 0.0,
      advanced: false,
      fps: 24.0,
      keyframe_role: 'first',
      ref_image_size: 'match',
      reference_mention_mode: 'index',
      prompt_optimizer_settings: false,
      prompt_optimizer_scene_guide: 'none',
      context_prompt_optimizer_mode: '1',
      context_prompt_optimizer_concurrency: 1,
      enable_detail_daemon: false,
      detail_strength: 0.0,
      ref_image_strength: 1.0,
      ref_video_strength: 1.0,
      ref_video1_strength: 1.0,
      ref_video2_strength: 1.0,
      ref_video3_strength: 1.0,
      ref_video1_range: '',
      ref_video2_range: '',
      ref_video3_range: '',
      seed_video_strength: 1.0,
      seed_video_reserved_seconds: 1.0,
    },
  };
  graph['15'] = { class_type: 'BasicScheduler', inputs: { model: ['13', 0], scheduler: 'simple', steps: Math.max(1, Math.round(Number(steps) || 6)), denoise: 1.0 } };
  graph['16'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } };
  graph['17'] = {
    class_type: 'MiniMaxH3EasySegmentRender_SatoDive',
    inputs: { h3_context: ['13', 1], model: ['13', 0], sampler: ['16', 0], sigmas: ['15', 0], seed: Math.abs(Math.round(Number(seed) || 1001)), segment_seeds: 'default' },
  };
  graph['18'] = { class_type: 'MiniMaxH3EasySegmentDecode_SatoDive', inputs: { segments: ['17', 0] } };
  graph['22'] = { class_type: 'SaveVideo', inputs: { video: ['18', 0], filename_prefix: prefix, format: 'mp4', codec: 'h264' } };
  return graph;
}

// Runs a video generation job against the user's Modal ComfyUI HTTPS endpoint using the chosen quality tier.
function runModalVideo({
  endpointUrl = '',
  tier = 'balanced',
  token = '',
  prompt = '',
  firstFrame = '',
  lastFrame = '',
  refmods = [],
  seconds = 7,
  resolution = 640,
  aspect = '16:9',
  steps = 6,
  seed = 1001,
  outDir,
  previewDir = '',
  jobId = 'modal',
  onEvent = () => {},
}) {
  const base = deriveTierEndpoint(endpointUrl, tier);
  if (!base) {
    return {
      promise: Promise.resolve({ ok: false, error: 'Modal endpoint URL is not set. Click "🚀 Deploy to Modal" or paste your https://...modal.run URL.' }),
      cancel: () => {},
    };
  }

  let cancelled = false;
  let promptId = null;
  let watcher = null;
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const cancel = async () => {
    cancelled = true;
    try { if (watcher) watcher.close(); } catch { /* ignore */ }
    await comfyLive.cancelComfyPrompt({ baseUrl: base, promptId }).catch(() => {});
  };

  const promise = (async () => {
    try {
      onEvent({ type: 'progress', progress: 0.05, label: '☁️ Waking Modal GPU container…' });
      // Detect available models on the Modal ComfyUI server (wakes container if scaled to 0).
      // ComfyUI 0.46+ serves GGUF UNets under /models/unet_gguf & safetensors under /models/diffusion_models,
      // and GGUF CLIPs under /models/clip_gguf & safetensors under /models/text_encoders.
      let unets = [];
      let vaes = [];
      let clips = [];
      let loras = [];
      let availableMods = [];
      const fetchList = async (ep, timeoutMs = 30000) => {
        try {
          const r = await fetch(`${base}${ep}`, { headers: authHeaders, signal: AbortSignal.timeout(timeoutMs) });
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j)) return j;
          }
        } catch { /* endpoint may not exist on older ComfyUI */ }
        return [];
      };
      try {
        // Wake container first with /system_stats (up to 120s cold start)
        const wake = await fetch(`${base}/system_stats`, { headers: authHeaders, signal: AbortSignal.timeout(120000) });
        if (!wake.ok) throw new Error(`HTTP ${wake.status}`);
        const [uGguf, uDiff, vList, cGguf, cText, lList] = await Promise.all([
          fetchList('/models/unet_gguf'),
          fetchList('/models/diffusion_models'),
          fetchList('/models/vae'),
          fetchList('/models/clip_gguf'),
          fetchList('/models/text_encoders'),
          fetchList('/models/loras'),
        ]);
        unets = [...uGguf, ...uDiff];
        vaes = vList;
        clips = [...cGguf, ...cText];
        loras = lList;
        try {
          const mInfoRes = await fetch(`${base}/object_info/MiniMaxH3RefModsLoader`, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
          if (mInfoRes.ok) {
            const mInfo = await mInfoRes.json();
            const list = mInfo && mInfo.MiniMaxH3RefModsLoader && mInfo.MiniMaxH3RefModsLoader.input
              && mInfo.MiniMaxH3RefModsLoader.input.required && mInfo.MiniMaxH3RefModsLoader.input.required.mod_1
              && mInfo.MiniMaxH3RefModsLoader.input.required.mod_1[0];
            if (Array.isArray(list)) availableMods = list;
          }
        } catch { /* ignore */ }
      } catch (e) {
        return { ok: false, error: `Could not reach Modal endpoint (${base}): ${e.message}` };
      }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      const uploadImg = async (filePath) => {
        const bytes = fs.readFileSync(filePath);
        const name = `zaude_modal_${Date.now()}_${path.basename(filePath)}`;
        const form = new FormData();
        form.append('image', new Blob([bytes], { type: 'image/png' }), name);
        form.append('overwrite', 'true');
        const res = await fetch(`${base}/upload/image`, { method: 'POST', headers: authHeaders, body: form });
        if (!res.ok) throw new Error(`Modal image upload failed (${res.status})`);
        const data = await res.json();
        return data.name || name;
      };

      let firstFrameName = null;
      let lastFrameName = null;
      if (firstFrame && fs.existsSync(firstFrame)) {
        onEvent({ type: 'progress', progress: 0.12, label: '☁️ Uploading first frame to Modal…' });
        firstFrameName = await uploadImg(firstFrame);
      }
      if (lastFrame && fs.existsSync(lastFrame)) {
        onEvent({ type: 'progress', progress: 0.16, label: '☁️ Uploading last frame to Modal…' });
        lastFrameName = await uploadImg(lastFrame);
      }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      // Tier-aware model selection:
      // - ultra:    Singularity v2 FULL BF16 + Qwen3VL BF16 + Video VAE FP16
      // - balanced: Singularity v2 Pruned INT8 + Qwen3VL INT8 + Video VAE INT8 (matches 3090 baseline!)
      // - fast:     Singularity v2 Pruned INT8 (4-step) or LTX-Video 2B
      const pickUnet = () => {
        if (tier === 'ultra') {
          return unets.find((u) => /singularity.*v2.*bf16/i.test(u))
            || unets.find((u) => /singularity.*bf16/i.test(u))
            || unets.find((u) => /singularity.*v2/i.test(u))
            || unets.find((u) => /minimax|h3/i.test(u));
        }
        return unets.find((u) => /singularity.*v2.*pruned.*int8/i.test(u))
          || unets.find((u) => /singularity.*int8/i.test(u))
          || unets.find((u) => /minimax|h3/i.test(u));
      };
      const h3Model = pickUnet();
      const wanT2vModel = (unets || []).find((u) => /wan/i.test(u) && /t2v/i.test(u));
      const ltxModel = (unets || []).find((u) => /ltx/i.test(u));
      let graph;
      let modelLabel;

      if (h3Model) {
        const { width, height } = frameToFrame.dimsForQuality(resolution, aspect);
        const frames = frameToFrame.snapH3Frames(seconds, 24);
        const h3Clip = tier === 'ultra'
          ? (clips.find((c) => /qwen3vl.*bf16/i.test(c)) || clips.find((c) => /qwen3vl/i.test(c)) || 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors')
          : (clips.find((c) => /qwen3vl.*int8/i.test(c)) || clips.find((c) => /qwen3vl/i.test(c)) || 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors');
        const h3VideoVae = tier === 'ultra'
          ? (vaes.find((v) => /video_vae_fp16/i.test(v)) || vaes.find((v) => /video_vae/i.test(v)) || 'minimax_h3_video_vae_int8_convrot.safetensors')
          : (vaes.find((v) => /video_vae_int8/i.test(v)) || vaes.find((v) => /video_vae/i.test(v)) || 'minimax_h3_video_vae_int8_convrot.safetensors');
        const h3Lora = (loras || []).find((l) => /minimax.*h3.*turbo/i.test(l)) || '';
        const resolveModFile = (rawFile) => {
          const norm = String(rawFile || '').replace(/\\/g, '/').replace(/\.safetensors$/i, '');
          if (!norm) return '';
          if (availableMods.length) {
            const exact = availableMods.find((m) => m.replace(/\\/g, '/').toLowerCase() === norm.toLowerCase());
            if (exact) return exact;
            const partial = availableMods.find((m) => m.replace(/\\/g, '/').toLowerCase().endsWith('/' + norm.toLowerCase()) || m.replace(/\\/g, '/').toLowerCase().includes(norm.toLowerCase()));
            if (partial) return partial;
          }
          return norm;
        };
        const resolvedRefmods = (refmods || [])
          .filter((r) => r && r.file)
          .map((r) => ({ ...r, file: resolveModFile(r.file) }));
        if (firstFrameName || lastFrameName) {
          graph = frameToFrame.buildFl2vGraph({
            prompt, firstFrameName, lastFrameName, width, height, frames, steps: steps || 6, seed,
            model: h3Model, lora: h3Lora, refmods: resolvedRefmods,
            prefix: `Zaude/modal_${tier}_${Date.now()}`,
          });
        } else {
          graph = buildSingularityGraph({
            prompt, model: h3Model, clip: h3Clip, videoVae: h3VideoVae, lora: h3Lora,
            refmods: resolvedRefmods, width, height, aspect, resolution, seconds, steps: steps || 6, seed,
            prefix: `Zaude/modal_${tier}_${Date.now()}`,
          });
        }
        const tMeta = MODAL_TIERS[tier] || MODAL_TIERS.balanced;
        modelLabel = `Modal ${tMeta.label} (${h3Model.includes('bf16') ? 'Singularity v2 BF16' : 'Singularity v2 INT8'})`;
      } else if (wanT2vModel && !firstFrameName && !lastFrameName) {
        const { width, height } = localRunner.dimsForLocal(resolution, aspect, 16);
        const frames = localRunner.snapWanFrames(seconds, 16);
        const vae = (vaes || []).find((v) => /wan/i.test(v)) || vaes[0] || 'wan_2.1_vae.safetensors';
        const clip = (clips || []).find((c) => /umt5/i.test(c)) || clips[0] || 'umt5-xxl-encoder-Q4_K_M.gguf';
        graph = localRunner.buildWanGraph({
          prompt, width, height, frames, steps: steps || 8, seed, unet: wanT2vModel, clip, vae,
          prefix: `Zaude/modal_wan_${Date.now()}`,
        });
        modelLabel = 'Modal Wan 2.1';
      } else if (ltxModel) {
        const { width, height } = localRunner.dimsForLocal(resolution, aspect, 32);
        const frames = localRunner.snapLtxFrames(seconds, 24);
        const vae = (vaes || []).find((v) => /ltx/i.test(v)) || vaes[0] || 'ltxv_0.9.5_vae_fp16.safetensors';
        const clip = (clips || []).find((c) => /t5/i.test(c) && !/umt5/i.test(c)) || clips[0] || 't5-v1_1-xxl-encoder-Q4_K_M.gguf';
        graph = localRunner.buildLtxGraph({
          prompt, firstFrameName, lastFrameName, width, height, frames, steps: steps || 8, seed, unet: ltxModel, clip, vae,
          prefix: `Zaude/modal_ltx_${Date.now()}`,
        });
        modelLabel = 'Modal LTX-Video 2B';
      } else {
        return { ok: false, error: 'No video models found on your Modal Volume yet. Run "modal run modal/comfy_server.py::download_open_models" to populate models.' };
      }

      const clientId = `zaude-modal-${jobId || Date.now()}`;
      watcher = comfyLive.watchComfyJob({
        baseUrl: base,
        clientId,
        previewDir: previewDir || outDir,
        jobId,
        onPreview: ({ previewPath, step, totalSteps }) => {
          const prog = totalSteps > 0 ? Math.min(0.99, step / totalSteps) : null;
          if (previewPath) onEvent({ type: 'preview', previewPath, step, totalSteps, progress: prog });
        },
        onStep: ({ step, totalSteps, progress }) => {
          onEvent({ type: 'progress', step, totalSteps, progress, label: `☁️ ${modelLabel}: step ${step}/${totalSteps}` });
        },
      });

      const subRes = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      if (!subRes.ok) {
        return { ok: false, error: `Modal ComfyUI rejected workflow (${subRes.status}): ${(await subRes.text()).slice(0, 260)}` };
      }
      const subData = await subRes.json();
      promptId = subData.prompt_id;
      if (!promptId) return { ok: false, error: 'Modal ComfyUI did not return a prompt_id.' };
      if (watcher) watcher.setPromptId(promptId);
      onEvent({ type: 'progress', progress: 0.2, label: `☁️ Running ${modelLabel} final pass on Modal…` });

      let fileEntry = null;
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        const hRes = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { headers: authHeaders });
        if (!hRes.ok) continue;
        const hist = await hRes.json();
        const item = hist[promptId];
        if (!item) continue;
        if (item.status && item.status.status_str === 'error') {
          return { ok: false, error: `Modal ComfyUI error: ${JSON.stringify(item.status.messages || '').slice(0, 260)}` };
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
      if (!fileEntry) return { ok: false, error: 'Modal ComfyUI finished without a video file.' };

      fs.mkdirSync(outDir, { recursive: true });
      const dlUrl = `${base}/view?filename=${encodeURIComponent(fileEntry.filename)}&subfolder=${encodeURIComponent(fileEntry.subfolder || '')}&type=${encodeURIComponent(fileEntry.type || 'output')}`;
      const dlRes = await fetch(dlUrl, { headers: authHeaders });
      if (!dlRes.ok) return { ok: false, error: `Failed to download Modal video (${dlRes.status})` };
      const outPath = path.join(outDir, `modal_final_${Date.now()}.mp4`);
      fs.writeFileSync(outPath, Buffer.from(await dlRes.arrayBuffer()));

      onEvent({ type: 'progress', progress: 1, label: `☁️ Saved Modal final pass` });
      return { ok: true, path: outPath, backend: 'modal', model: modelLabel };
    } catch (err) {
      try { if (watcher) watcher.close(); } catch { /* ignore */ }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      return { ok: false, error: err.message || String(err) };
    }
  })();

  return { promise, cancel };
}

// Reads live Modal workspace billing usage and running GPU containers via the `modal` CLI.
function getModalUsage() {
  const cliInstalled = Boolean(safeRun('modal', ['--version'], 3000));
  if (!cliInstalled) {
    return { ok: false, cliInstalled: false, activeContainers: 0, containers: [], meteredUsd: 0, billedUsd: 0, creditsUsd: 0 };
  }

  let containers = [];
  try {
    const raw = safeRun('modal', ['container', 'list', '--json'], 8000);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) containers = parsed;
    }
  } catch { /* ignore */ }

  let meteredUsd = 0;
  let billedUsd = 0;
  let creditsUsd = 0;
  let billingOk = false;
  try {
    const raw = safeRun('modal', ['billing', 'summary', '--json'], 8000);
    if (raw) {
      const b = JSON.parse(raw);
      meteredUsd = Number(b.metered_cost) || 0;
      billedUsd = Number(b.billed_cost) || 0;
      creditsUsd = Math.abs(Number(b.adjustments && b.adjustments.credits) || 0);
      billingOk = true;
    }
  } catch { /* ignore */ }

  return {
    ok: true,
    cliInstalled: true,
    billingOk,
    activeContainers: containers.length,
    containers: containers.map((c) => ({
      id: c.container_id || c.id || '',
      appName: c.app_name || '',
      startTime: c.start_time || '',
    })),
    meteredUsd,
    billedUsd,
    creditsUsd,
    checkedAt: new Date().toISOString(),
  };
}

// Emergency Kill-Switch: interrupts ComfyUI on Modal and terminates EVERY running Modal container
// so billing drops to $0 immediately (deployed app + model volume stay intact).
async function stopAllModal({ endpointUrl = '', token = '' } = {}) {
  const stopped = [];
  const errors = [];
  const base = String(endpointUrl || '').trim().replace(/\/+$/, '');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  // 1. Check active containers FIRST via zero-cost control plane.
  // Never hit the HTTP endpoint if 0 containers are running (otherwise Modal would wake one up!).
  const usage = getModalUsage();
  const active = Array.isArray(usage.containers) ? usage.containers : [];

  // 2. Interrupt & clear ComfyUI queue ONLY if a container is actually running
  if (base && active.length > 0) {
    try {
      await fetch(`${base}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ clear: true }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
      await fetch(`${base}/interrupt`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  // 3. Terminate all active Modal containers
  for (const c of active) {
    if (!c.id) continue;
    const r = spawnSync('modal', ['container', 'stop', '-y', c.id], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status === 0) stopped.push(c.id);
    else errors.push(`${c.id}: ${(r.stderr || r.stdout || 'failed').trim().slice(0, 120)}`);
  }

  return {
    ok: errors.length === 0,
    stoppedCount: stopped.length,
    stopped,
    errors,
  };
}

module.exports = {
  DEFAULT_MODAL_SCRIPT,
  MODAL_GPUS,
  MODAL_TIERS,
  deriveTierEndpoint,
  estimateModalCost,
  buildSingularityGraph,
  recommendModalPlan,
  askAiForModalPlan,
  checkModalStatus,
  getModalUsage,
  stopAllModal,
  deployModalServer,
  runModalVideo,
};
