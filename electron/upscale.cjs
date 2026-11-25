// Multi-clip Upscale & RefMod Face-Fix runner for Zaude.
// Supports two modes on Tranklena ComfyUI:
//   1. `refmod-refine`: H3 RefMod 2nd-Pass V2V at 640p/720p using each clip's auto-recovered
//      sidecar RefMods + prompt to crisply redraw faces, eyes, and hair without temporal flicker.
//   2. `esrgan-2x`: Fast 2x RealESRGAN_x2plus video upscale preserving exact original audio.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const comfyLive = require('./comfy-live.cjs');

const DEFAULT_ESRGAN_MODEL = 'RealESRGAN_x2plus.pth';

// Reads a clip's Mannimmate sidecar JSON (or embedded ComfyUI MP4 metadata!) to recover its RefMods, prompt, and duration.
function readClipMeta(videoPath) {
  const out = { refmods: [], prompt: '', duration: 0 };
  if (!videoPath || typeof videoPath !== 'string') return out;
  const parsed = path.parse(videoPath);
  const jsonPath = path.join(parsed.dir, `${parsed.name}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const rawChars = Array.isArray(data.refmods)
        ? data.refmods
        : (Array.isArray(data.characters) ? data.characters.map((c) => ({ file: c && c.mod, name: c && c.name })) : []);
      out.refmods = rawChars
        .filter((r) => r && r.file)
        .map((r, i) => ({
          file: String(r.file),
          name: String(r.name || `Subject ${i + 1}`),
          identityStrength: 1.0,
          voiceStrength: 0.0,
        }));
      const rawPrompt = String(data.prompt || '')
        .replace(/subject_definitions:[\s\S]*?\n\n/i, '')
        .trim();
      out.prompt = rawPrompt;
      if (Number(data.seconds) > 0) out.duration = Number(data.seconds);
    } catch { /* ignore */ }
  }
  if (fs.existsSync(videoPath) && (!out.duration || !out.refmods.length)) {
    try {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', videoPath], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const probeData = JSON.parse(String(r.stdout || '{}'));
      const d = Number(probeData && probeData.format && probeData.format.duration);
      if (!out.duration && d > 0) out.duration = d;
      const rawGraphStr = probeData && probeData.format && probeData.format.tags && probeData.format.tags.prompt;
      if (!out.refmods.length && rawGraphStr) {
        const sanitized = String(rawGraphStr).replace(/\bNaN\b/g, 'null').replace(/\b-?Infinity\b/g, 'null');
        const g = JSON.parse(sanitized);
        for (const node of Object.values(g)) {
          if (node && /RefModsLoader/i.test(String(node.class_type || '')) && node.inputs) {
            for (let i = 1; i <= 8; i++) {
              const mod = node.inputs[`mod_${i}`];
              if (mod && !/^\(?none\)?$/i.test(String(mod).trim())) {
                const cleanFile = String(mod).replace(/\\/g, '/').replace(/\.safetensors$/i, '');
                const baseName = cleanFile.split('/').pop().replace(/_(?:cbphoto|photo|2d).*$/i, '');
                out.refmods.push({
                  file: cleanFile,
                  name: baseName ? baseName[0].toUpperCase() + baseName.slice(1) : `Subject ${i}`,
                  identityStrength: 1.0,
                  voiceStrength: 0.0,
                });
              }
            }
          }
          if (!out.prompt && node && /MiniMaxH3Easy_SatoDive/i.test(String(node.class_type || '')) && node.inputs && node.inputs.prompt) {
            out.prompt = String(node.inputs.prompt).replace(/subject_definitions:[\s\S]*?\n\n/i, '').trim();
          }
        }
      }
    } catch { /* ignore */ }
  }
  return out;
}

// Extracts a crisp reference keyframe PNG for external clips that have no RefMods so mannimmate render never rejects them.
function extractFallbackRefFrame(videoPath, outDir, timeSec = 0.5) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const outPng = path.join(outDir, `upscale_ref_${Date.now()}.png`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-y', '-ss', String(Math.max(0, Number(timeSec) || 0.5)), '-i', videoPath, '-frames:v', '1', outPng], { timeout: 15000, windowsHide: true });
    if (r.status === 0 && fs.existsSync(outPng)) return outPng;
  } catch { /* ignore */ }
  return '';
}

// Builds a face & detail refinement prompt that preserves original motion while fixing faces via RefMods.
function buildRefinePrompt(meta = {}) {
  const base = 'Upscale and refine fine facial details, crisp eyes, sharp hair strands, clean skin texture, and sharp edges while strictly preserving the exact motion, framing, lighting, wardrobe, and choreography of the original video.';
  const scene = String(meta.prompt || '').trim();
  return scene ? `${base}\n\nOriginal scene context: ${scene.slice(0, 1200)}` : base;
}

// Pure ComfyUI graph builder for fast 2x RealESRGAN video upscaling with original audio preserved.
function buildEsrganGraph({ videoName, modelName = DEFAULT_ESRGAN_MODEL, prefix = 'Zaude/upscale_2x' }) {
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: videoName } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'UpscaleModelLoader', inputs: { model_name: modelName } },
    '4': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['3', 0], image: ['2', 0] } },
    '5': { class_type: 'CreateVideo', inputs: { images: ['4', 0], audio: ['2', 1], fps: ['2', 2], bit_depth: 'auto', color_space: 'sRGB' } },
    '6': { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'h264' } },
  };
}

async function uploadVideoToComfy(baseUrl, filePath) {
  const bytes = fs.readFileSync(filePath);
  const name = `zaude_up_${Date.now()}_${path.basename(filePath)}`;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'video/mp4' }), name);
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI video upload failed (${res.status})`);
  const data = await res.json();
  return data.name || name;
}

function runEsrganUpscale({
  videoPath,
  modelName = DEFAULT_ESRGAN_MODEL,
  baseUrl = comfyLive.comfyBaseUrl(),
  outDir,
  previewDir = '',
  jobId = 'upscale',
  onEvent = () => {},
}) {
  let cancelled = false;
  let promptId = null;
  let watcher = null;
  const base = String(baseUrl || comfyLive.comfyBaseUrl()).replace(/\/+$/, '');

  const cancel = async () => {
    cancelled = true;
    try { if (watcher) watcher.close(); } catch { /* ignore */ }
    await comfyLive.cancelComfyPrompt({ baseUrl: base, promptId }).catch(() => {});
  };

  const promise = (async () => {
    try {
      if (!videoPath || !fs.existsSync(videoPath)) {
        return { ok: false, error: `Source clip not found: ${videoPath}` };
      }
      onEvent({ type: 'progress', progress: 0.1, label: `Uploading ${path.basename(videoPath)} for 2× upscale…` });
      const uploadedName = await uploadVideoToComfy(base, videoPath);
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      const graph = buildEsrganGraph({ videoName: uploadedName, modelName, prefix: `Zaude/up2x_${Date.now()}` });
      const clientId = `zaude-up-${jobId || Date.now()}`;
      watcher = comfyLive.watchComfyJob({
        baseUrl: base,
        clientId,
        previewDir: previewDir || outDir,
        jobId,
        onStep: ({ step, totalSteps, progress }) => {
          onEvent({ type: 'progress', progress, step, totalSteps, label: `2× Upscale frame ${step}/${totalSteps}…` });
        },
        onPreview: ({ previewPath, step, totalSteps }) => {
          onEvent({ type: 'preview', previewPath, step, totalSteps });
        },
      });

      const submitRes = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      if (!submitRes.ok) {
        return { ok: false, error: `ComfyUI rejected upscale graph (${submitRes.status}): ${(await submitRes.text()).slice(0, 260)}` };
      }
      const subData = await submitRes.json();
      promptId = subData.prompt_id;
      if (!promptId) return { ok: false, error: 'ComfyUI did not return a prompt_id.' };
      if (watcher) watcher.setPromptId(promptId);
      onEvent({ type: 'progress', progress: 0.25, label: 'Running RealESRGAN 2× upscale on Tranklena…' });

      let fileEntry = null;
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        const hRes = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
        if (!hRes.ok) continue;
        const hist = await hRes.json();
        const item = hist[promptId];
        if (!item) continue;
        if (item.status && item.status.status_str === 'error') {
          return { ok: false, error: `ComfyUI upscale error: ${JSON.stringify(item.status.messages || '').slice(0, 260)}` };
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
      if (!fileEntry) return { ok: false, error: 'ComfyUI upscale finished without a video output.' };

      fs.mkdirSync(outDir, { recursive: true });
      const dlUrl = `${base}/view?filename=${encodeURIComponent(fileEntry.filename)}&subfolder=${encodeURIComponent(fileEntry.subfolder || '')}&type=${encodeURIComponent(fileEntry.type || 'output')}`;
      const dlRes = await fetch(dlUrl);
      if (!dlRes.ok) return { ok: false, error: `Failed to download upscaled video (${dlRes.status})` };
      const parsed = path.parse(videoPath);
      const outPath = path.join(outDir, `${parsed.name}_2x_${Date.now()}.mp4`);
      fs.writeFileSync(outPath, Buffer.from(await dlRes.arrayBuffer()));

      // Preserve original sidecar JSON (saved_latent / characters / prompt) so FrameContinue keeps working!
      const origJson = path.join(parsed.dir, `${parsed.name}.json`);
      if (fs.existsSync(origJson)) {
        try { fs.copyFileSync(origJson, outPath.replace(/\.mp4$/i, '.json')); } catch { /* ignore */ }
      }

      onEvent({ type: 'progress', progress: 1, label: '2× Upscale complete' });
      return { ok: true, path: outPath };
    } catch (err) {
      try { if (watcher) watcher.close(); } catch { /* ignore */ }
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      return { ok: false, error: err.message || String(err) };
    }
  })();

  return { promise, cancel };
}

module.exports = {
  DEFAULT_ESRGAN_MODEL,
  readClipMeta,
  extractFallbackRefFrame,
  buildRefinePrompt,
  buildEsrganGraph,
  runEsrganUpscale,
};
