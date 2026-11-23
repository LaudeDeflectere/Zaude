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
    bestFor: 'Best value for 480p–640p, Wan 14B GGUF, LTX-2B, and fast RealESRGAN upscales',
  },
  'A100-80GB': {
    id: 'A100-80GB',
    label: 'A100 (80 GB)',
    vramGb: 80,
    hourlyUsd: 2.50,
    bestFor: '720p long shots, multi-RefMod H3 renders, and heavy V2V / SeedVR2 refinement',
  },
  H100: {
    id: 'H100',
    label: 'H100 (80 GB)',
    vramGb: 80,
    hourlyUsd: 3.95,
    bestFor: 'Fastest final-pass 720p hero shots (BF16 + FP8 + SageAttention)',
  },
};

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

async function checkModalStatus({ endpointUrl = '', token = '' } = {}) {
  const cliInstalled = Boolean(safeRun('modal', ['--version']));
  const tokenFile = path.join(os.homedir(), '.modal.toml');
  const authenticated = fs.existsSync(tokenFile) || Boolean(process.env.MODAL_TOKEN_ID);
  const cleanUrl = String(endpointUrl || '').trim().replace(/\/+$/, '');
  let reachable = false;
  let gpuName = '';
  let installedModels = [];

  if (cleanUrl) {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${cleanUrl}/system_stats`, { headers, signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        reachable = true;
        const stats = await res.json();
        const dev = stats && Array.isArray(stats.devices) && stats.devices[0];
        if (dev && dev.name) gpuName = dev.name;
      }
      if (reachable) {
        const mRes = await fetch(`${cleanUrl}/models/diffusion_models`, { headers, signal: AbortSignal.timeout(3000) });
        if (mRes.ok) {
          const list = await mRes.json();
          if (Array.isArray(list)) installedModels = list;
        }
      }
    } catch { /* container may be scaled to zero; that's normal on Modal */ }
  }

  return {
    ok: true,
    cliInstalled,
    authenticated,
    endpointUrl: cleanUrl,
    reachable,
    gpuName,
    installedModels,
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

// Runs a final-pass video generation job against the user's Modal ComfyUI HTTPS endpoint.
function runModalVideo({
  endpointUrl = '',
  token = '',
  prompt = '',
  firstFrame = '',
  lastFrame = '',
  refmods = [],
  seconds = 7,
  resolution = 720,
  aspect = '16:9',
  steps = 8,
  seed = 1001,
  outDir,
  previewDir = '',
  jobId = 'modal',
  onEvent = () => {},
}) {
  const base = String(endpointUrl || '').trim().replace(/\/+$/, '');
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
        const [uGguf, uDiff, vList, cGguf, cText] = await Promise.all([
          fetchList('/models/unet_gguf'),
          fetchList('/models/diffusion_models'),
          fetchList('/models/vae'),
          fetchList('/models/clip_gguf'),
          fetchList('/models/text_encoders'),
        ]);
        unets = [...uGguf, ...uDiff];
        vaes = vList;
        clips = [...cGguf, ...cText];
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

      // Auto-pick best installed video model on the Modal Volume (MiniMax-H3 > Wan T2V > LTX-Video)
      const h3Model = (unets || []).find((u) => /minimax|h3/i.test(u));
      const wanT2vModel = (unets || []).find((u) => /wan/i.test(u) && /t2v/i.test(u));
      const ltxModel = (unets || []).find((u) => /ltx/i.test(u));
      let graph;
      let modelLabel;

      if (h3Model) {
        const { width, height } = frameToFrame.dimsForQuality(resolution, aspect);
        const frames = frameToFrame.snapH3Frames(seconds, 24);
        graph = frameToFrame.buildFl2vGraph({
          prompt, firstFrameName, lastFrameName, width, height, frames, steps: steps || 8, seed, model: h3Model, refmods,
          prefix: `Zaude/modal_h3_${Date.now()}`,
        });
        modelLabel = 'Modal MiniMax-H3';
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

module.exports = {
  DEFAULT_MODAL_SCRIPT,
  MODAL_GPUS,
  recommendModalPlan,
  askAiForModalPlan,
  checkModalStatus,
  deployModalServer,
  runModalVideo,
};
