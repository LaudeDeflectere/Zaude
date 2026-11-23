// First-Frame to Last-Frame (FL2VA) ComfyUI runner for Zaude.
// Uses ComfyUI's native MiniMaxH3ImageToVideo node (which accepts both `first_frame` and `last_frame`),
// optional MiniMaxH3RefModsLoader/Apply when RefMod characters are selected, and streams live step-by-step
// denoising previews via comfy-live.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const comfyLive = require('./comfy-live.cjs');

const DEFAULT_FL2V_MODEL = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const DEFAULT_FL2V_LORA = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors';
const DEFAULT_CLIP = 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors';
const DEFAULT_VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors';
const DEFAULT_AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors';

// Snaps requested seconds at 24fps onto H3's 17k+5 frame grid (e.g. 56, 73, 90, 107, 124).
function snapH3Frames(seconds, fps = 24) {
  const raw = Math.max(24, Math.min(240, Math.round((Number(seconds) || 4) * fps)));
  const k = Math.max(1, Math.round((raw - 5) / 17));
  return k * 17 + 5;
}

function dimsForQuality(quality, aspect = '16:9') {
  const q = Number(quality) || 480;
  const table = {
    320: [576, 320],
    480: [864, 480],
    640: [1120, 640],
    720: [1280, 704],
  };
  const [w, h] = table[q] || table[480];
  return aspect === '9:16' ? { width: h, height: w } : { width: w, height: h };
}

// Pure ComfyUI graph builder for First/Last Frame H3 FL2VA (+ optional RefMods).
function buildFl2vGraph({
  prompt,
  firstFrameName = null,
  lastFrameName = null,
  width = 864,
  height = 480,
  frames = 90,
  steps = 8,
  seed = 1001,
  model = DEFAULT_FL2V_MODEL,
  lora = DEFAULT_FL2V_LORA,
  refmods = [],
  prefix = 'Zaude/fl2v',
}) {
  const fullPromptLines = [];
  const validMods = (refmods || []).filter((r) => r && r.file).slice(0, 8);
  if (validMods.length) {
    fullPromptLines.push('subject_definitions:');
    validMods.forEach((r, i) => {
      fullPromptLines.push(`<Subject ${i + 1}> is ${r.name || `Subject ${i + 1}`}, using the stable identity, face, hair and distinguishing features of <Subject ${i + 1}>'s reference.`);
    });
    fullPromptLines.push('');
  }
  fullPromptLines.push(String(prompt || '').trim());

  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model || DEFAULT_FL2V_MODEL, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: DEFAULT_CLIP, type: 'minimax' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: DEFAULT_VIDEO_VAE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: DEFAULT_AUDIO_VAE } },
    '5': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt: fullPromptLines.join('\n'),
        width,
        height,
        length: frames,
      },
    },
    '6': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['1', 0], shift_video: 12.0, shift_audio: 3.0 } },
    '7': { class_type: 'RandomNoise', inputs: { noise_seed: Math.abs(Math.round(Number(seed) || 1001)) } },
    '8': { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['5', 0] } },
    '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '10': { class_type: 'BasicScheduler', inputs: { model: ['6', 0], scheduler: 'simple', steps: Math.max(1, Math.round(Number(steps) || 8)), denoise: 1.0 } },
    '11': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['7', 0], guider: ['8', 0], sampler: ['9', 0], sigmas: ['10', 0], latent_image: ['5', 1] },
    },
    '12': {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['11', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    '13': { class_type: 'VAEDecodeAudio', inputs: { samples: ['11', 0], vae: ['4', 0] } },
    '14': {
      class_type: 'CreateVideo',
      inputs: { images: ['12', 0], audio: ['13', 0], fps: 24.0, bit_depth: 'auto', color_space: 'sRGB', codec: 'none' },
    },
    '15': {
      class_type: 'SaveVideo',
      inputs: { video: ['14', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'h264' },
    },
  };

  if (lora) {
    graph['26'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: 1.0 } };
    graph['6'].inputs.model = ['26', 0];
  }

  if (firstFrameName) {
    graph['20'] = { class_type: 'LoadImage', inputs: { image: firstFrameName } };
    graph['21'] = {
      class_type: 'ImageResizeKJv2',
      inputs: {
        image: ['20', 0], width, height,
        upscale_method: 'lanczos', keep_proportion: 'crop',
        pad_color: '0, 0, 0', crop_position: 'center', divisible_by: 2, device: 'cpu',
      },
    };
    graph['5'].inputs.first_frame = ['21', 0];
  }

  if (lastFrameName) {
    graph['22'] = { class_type: 'LoadImage', inputs: { image: lastFrameName } };
    graph['23'] = {
      class_type: 'ImageResizeKJv2',
      inputs: {
        image: ['22', 0], width, height,
        upscale_method: 'lanczos', keep_proportion: 'crop',
        pad_color: '0, 0, 0', crop_position: 'center', divisible_by: 2, device: 'cpu',
      },
    };
    graph['5'].inputs.last_frame = ['23', 0];
  }

  if (validMods.length) {
    const loaderInputs = { show_info: false };
    for (let slot = 1; slot <= 8; slot++) {
      const r = validMods[slot - 1];
      const stem = r ? String(r.file).replace(/\.safetensors$/i, '') : '(none)';
      loaderInputs[`mod_${slot}`] = stem;
      loaderInputs[`strength_${slot}`] = r && r.identityStrength != null ? Number(r.identityStrength) : 1.0;
      loaderInputs[`copies_${slot}`] = 1;
      loaderInputs[`audio_strength_${slot}`] = r && r.voiceStrength != null ? Number(r.voiceStrength) : 0.0;
    }
    graph['30'] = { class_type: 'MiniMaxH3RefModsLoader', inputs: loaderInputs };
    graph['31'] = {
      class_type: 'MiniMaxH3RefModApply',
      inputs: {
        conditioning: ['5', 0],
        mods: ['30', 0],
        override: false,
        retention: 1.0,
        curve_direction: 'constant',
        curve_shape: 'linear',
        curve_value: 1.0,
        scramble_seed: -1,
      },
    };
    graph['8'].inputs.conditioning = ['31', 0];
  }

  return graph;
}

function extractFrameAt(videoPath, timeSec, outPng, ffmpeg = 'ffmpeg') {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    const t = Math.max(0, Number(timeSec) || 0);
    const child = spawn(ffmpeg, [
      '-y', '-v', 'error',
      '-ss', t.toFixed(3),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outPng,
    ], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPng)) return resolve({ ok: true, path: outPng });
      resolve({ ok: false, error: err.trim() || `ffmpeg exited with code ${code}` });
    });
  });
}

async function uploadImageToComfy(baseUrl, filePath) {
  const bytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const name = `zaude_fl2v_${Date.now()}_${path.basename(filePath)}`;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mime }), name);
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI image upload failed (${res.status})`);
  const data = await res.json();
  return data.name || name;
}

function runFrameToFrame({ request, previewDir, jobId = '', outDir, onEvent = () => {} }) {
  const baseUrl = comfyLive.comfyBaseUrl();
  let cancelled = false;
  let activePromptId = null;
  let watcher = { setPromptId() {}, close() {} };

  const promise = (async () => {
    try {
      const prompt = String((request && request.prompt) || '').trim();
      if (!prompt) return { ok: false, error: 'Write a prompt describing the transition between the first and last frame.' };
      const firstPath = String((request && request.firstFrame) || '').trim();
      const lastPath = String((request && request.lastFrame) || '').trim();
      if (!firstPath && !lastPath) return { ok: false, error: 'Provide at least a First Frame or Last Frame.' };

      const frames = snapH3Frames(request.seconds || 4, 24);
      const { width, height } = dimsForQuality(request.quality || 480, request.aspect || '16:9');
      const steps = Math.max(1, Number(request.steps) || 8);
      const seed = request.seed != null && request.seed !== '' ? Number(request.seed) : Math.floor(Math.random() * 1e9);
      const fl2vModel = (request.model && /fl2va/i.test(request.model)) ? request.model : DEFAULT_FL2V_MODEL;
      const fl2vLora = (request.lora && /fl2v/i.test(request.lora)) ? request.lora : DEFAULT_FL2V_LORA;

      onEvent({ type: 'cmd', cmd: `ComfyUI FL2VA (${width}x${height}, ${frames}f, ${steps} steps) first=${path.basename(firstPath || 'none')} last=${path.basename(lastPath || 'none')}` });

      if (request.dryRun) {
        const dryGraph = buildFl2vGraph({
          prompt,
          firstFrameName: firstPath ? path.basename(firstPath) : null,
          lastFrameName: lastPath ? path.basename(lastPath) : null,
          width, height, frames, steps, seed, model: fl2vModel, lora: fl2vLora,
          refmods: request.refmods || [],
        });
        onEvent({ type: 'stdout', text: JSON.stringify({ event: 'dry_run', width, height, frames, steps, model: fl2vModel, nodes: Object.keys(dryGraph).length }) });
        return { ok: true, dryRun: true, code: 0 };
      }

      onEvent({ type: 'progress', progress: 0.05, label: 'Uploading First & Last frames to ComfyUI…' });
      const firstName = firstPath && fs.existsSync(firstPath) ? await uploadImageToComfy(baseUrl, firstPath) : null;
      const lastName = lastPath && fs.existsSync(lastPath) ? await uploadImageToComfy(baseUrl, lastPath) : null;
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

      const graph = buildFl2vGraph({
        prompt,
        firstFrameName: firstName,
        lastFrameName: lastName,
        width, height, frames, steps, seed, model: fl2vModel, lora: fl2vLora,
        refmods: request.refmods || [],
        prefix: `Zaude/fl2v_${Date.now()}`,
      });

      const startedAt = Date.now();
      const baseEstSec = Math.round(steps * (Number(request.quality) >= 640 ? 45 : 22));
      const calcEta = (prog) => {
        const elapsed = (Date.now() - startedAt) / 1000;
        if (typeof prog === 'number' && prog > 0.04 && prog < 1) return Math.max(1, Math.round((elapsed / prog) * (1 - prog)));
        return Math.max(1, Math.round(baseEstSec - elapsed));
      };

      const clientId = `zaude-fl2v-${jobId || Date.now()}`;
      watcher = comfyLive.watchComfyJob({
        baseUrl,
        clientId,
        previewDir,
        jobId,
        onStep: ({ step, totalSteps, progress }) => {
          onEvent({ type: 'progress', progress, step, totalSteps, etaSec: calcEta(progress), label: `FrameToFrame step ${step}/${totalSteps}…` });
        },
        onPreview: ({ previewPath, step, totalSteps }) => {
          const prog = totalSteps > 0 ? Math.min(0.99, step / totalSteps) : null;
          onEvent({ type: 'preview', previewPath, step, totalSteps, progress: prog, etaSec: calcEta(prog) });
        },
      });

      const submitRes = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      if (!submitRes.ok) throw new Error(`ComfyUI rejected FL2VA graph (${submitRes.status}): ${await submitRes.text()}`);
      const subData = await submitRes.json();
      activePromptId = subData.prompt_id;
      watcher.setPromptId(activePromptId);
      onEvent({ type: 'stdout', text: JSON.stringify({ event: 'submitted', prompt_id: activePromptId, width, height, frames }) });
      onEvent({ type: 'progress', progress: 0.1, label: 'Queued on ComfyUI (FrameToFrame)…', etaSec: baseEstSec });

      // Poll /history until output video appears
      let videoInfo = null;
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelled) break;
        const hRes = await fetch(`${baseUrl}/history/${encodeURIComponent(activePromptId)}`);
        if (!hRes.ok) continue;
        const hist = await hRes.json();
        const entry = hist && hist[activePromptId];
        if (!entry) continue;
        if (entry.status && entry.status.status_str === 'error') {
          throw new Error('ComfyUI execution error during FrameToFrame render.');
        }
        const outs = entry.outputs || {};
        for (const nodeOut of Object.values(outs)) {
          const list = nodeOut.videos || nodeOut.gifs || nodeOut.images || [];
          const vid = list.find((f) => f && f.filename && /\.(mp4|webm|mov)$/i.test(f.filename));
          if (vid) { videoInfo = vid; break; }
        }
        if (videoInfo) break;
      }

      watcher.close();
      if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      if (!videoInfo) return { ok: false, error: 'ComfyUI finished without producing a video file.' };

      fs.mkdirSync(outDir, { recursive: true });
      const dlUrl = `${baseUrl}/view?filename=${encodeURIComponent(videoInfo.filename)}&subfolder=${encodeURIComponent(videoInfo.subfolder || '')}&type=${encodeURIComponent(videoInfo.type || 'output')}`;
      const dlRes = await fetch(dlUrl);
      if (!dlRes.ok) throw new Error(`Could not download rendered video (${dlRes.status})`);
      const outPath = path.join(outDir, `fl2v_${Date.now()}.mp4`);
      fs.writeFileSync(outPath, Buffer.from(await dlRes.arrayBuffer()));
      return { ok: true, path: outPath, code: 0 };
    } catch (err) {
      watcher.close();
      return { ok: false, error: err.message || String(err), code: 1 };
    }
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      watcher.close();
      comfyLive.cancelComfyPrompt({ baseUrl, promptId: activePromptId }).catch(() => {});
    },
  };
}

module.exports = { snapH3Frames, dimsForQuality, buildFl2vGraph, extractFrameAt, runFrameToFrame };
