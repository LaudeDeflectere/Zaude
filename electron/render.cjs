// Renders the timeline to an MP4 with ffmpeg. Uses NVIDIA NVENC for encoding when ffmpeg has it,
// and CUDA decoding for the inputs, otherwise libx264 on the CPU.
const { spawn, spawnSync } = require('node:child_process');

const PRESETS = {
  '1280 × 720': { w: 1280, h: 720 },
  '1920 × 1080': { w: 1920, h: 1080 },
  '3840 × 2160': { w: 3840, h: 2160 },
};
const FPS = 24;

let encoderCache = null;
// Returns { encoder: 'h264_nvenc' | 'libx264', cuda: boolean }. Result is cached for the session.
function detectEncoder(run = spawnSync) {
  if (encoderCache) return encoderCache;
  let encoders = '';
  try {
    encoders = String(run('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
  } catch {
    encoders = '';
  }
  const nvenc = /\bh264_nvenc\b/.test(encoders);
  encoderCache = { encoder: nvenc ? 'h264_nvenc' : 'libx264', cuda: nvenc };
  return encoderCache;
}

// ffmpeg's atempo only accepts 0.5 to 2 per filter, so larger changes are chained.
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${Number(p.toFixed(6))}`).join(',');
}

const r3 = (n) => Number(Number(n).toFixed(3));

// Builds the ffmpeg arguments for the timeline. Pure: no files are read.
// Clips without a file (titles, placeholders still generating) are skipped.
function buildRenderArgs({ clips, resolution, output, encoder = 'libx264', cuda = false }) {
  const size = PRESETS[resolution] || PRESETS['1920 × 1080'];
  const media = clips.filter((c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio'));
  if (!media.length) return { error: 'The timeline has no media clips to render.' };
  const total = Math.max(...media.map((c) => c.start + c.dur));

  const inputs = [];
  const graph = [];
  const videoClips = media.filter((c) => c.kind === 'video').sort((a, b) => a.track.localeCompare(b.track));
  const audioClips = media.filter((c) => c.hasAudio !== false && !c.muted && (c.kind === 'audio' || c.hasAudio === true));

  // one input per clip, so each clip uses its own streams
  const inputIndex = new Map();
  let count = 0;
  const addInput = (c) => {
    const key = c.id;
    if (!inputIndex.has(key)) {
      inputIndex.set(key, count++);
      if (cuda) inputs.push('-hwaccel', 'cuda');
      inputs.push('-i', c.path);
    }
    return inputIndex.get(key);
  };

  let base = `color=c=black:s=${size.w}x${size.h}:r=${FPS}:d=${r3(total)}[base0]`;
  graph.push(base);
  let last = 'base0';
  videoClips.forEach((c, k) => {
    const idx = addInput(c);
    const used = r3(c.dur * (c.speed || 1));
    const opacity = typeof c.opacity === 'number' ? c.opacity : 1;
    const fx = [];
    if (c.flipH) fx.push('hflip');
    if (c.flipV) fx.push('vflip');

    const brightInt = typeof c.brightness === 'number' ? c.brightness : 50;
    const contrastInt = typeof c.contrast === 'number' ? c.contrast : 50;
    const satInt = typeof c.saturation === 'number' ? c.saturation : 50;
    const brightness = (brightInt / 50) + ((Number(c.exposure) || 0) / 100) * 0.5 - 1;
    const contrast = (contrastInt / 50) + ((Number(c.dynamics) || 0) / 100) * 0.35;
    const saturation = (satInt / 50) + ((Number(c.dynamics) || 0) / 100) * 0.25;
    if (Math.abs(brightness) > 0.01 || Math.abs(contrast - 1) > 0.01 || Math.abs(saturation - 1) > 0.01) {
      fx.push(`eq=brightness=${r3(Math.max(-1, Math.min(1, brightness)))}:contrast=${r3(Math.max(0.1, Math.min(3, contrast)))}:saturation=${r3(Math.max(0, Math.min(3, saturation)))}`);
    }
    const hueDeg = (Number(c.hue) || 0) + ((Number(c.tint) || 0) / 100) * 45 - ((Number(c.temperature) || 0) / 100) * 12;
    if (Math.abs(hueDeg) > 0.5) fx.push(`hue=h=${r3(hueDeg)}`);
    if (Number(c.denoise) > 0) {
      const d = r3((Number(c.denoise) / 100) * 6);
      fx.push(`hqdn3d=${d}:${d}:${d}:${d}`);
    }
    if (Number(c.sharpen) > 0) {
      fx.push(`unsharp=5:5:${r3((Number(c.sharpen) / 100) * 1.5)}:5:5:0`);
    }
    if (Number(c.blur) > 0) {
      fx.push(`gblur=sigma=${r3((Number(c.blur) / 100) * 20)}`);
    }
    if (Number(c.vignette) > 0) {
      fx.push(`vignette=angle=${r3(0.2 + (Number(c.vignette) / 100) * 1.1)}`);
    }
    const trDur = Number(c.transition) || 0;
    const trType = c.transitionType || (trDur > 0 ? 'dissolve' : 'none');
    if (trDur > 0 && (trType === 'fade-black' || trType === 'fade-white')) {
      const col = trType === 'fade-white' ? 'white' : 'black';
      fx.push(`fade=t=in:st=${r3(c.start)}:d=${r3(trDur)}:color=${col}`);
      fx.push(`fade=t=out:st=${r3(Math.max(c.start, c.start + c.dur - trDur))}:d=${r3(trDur)}:color=${col}`);
    }

    const fxChain = fx.length ? ',' + fx.join(',') : '';
    graph.push(
      `[${idx}:v]trim=start=${r3(c.srcIn || 0)}:duration=${used},setpts=(PTS-STARTPTS)/${c.speed || 1}+${r3(c.start)}/TB,` +
      `scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2:black${fxChain},` +
      `format=yuva420p,colorchannelmixer=aa=${r3(opacity)}[v${k}]`);
    graph.push(`[${last}][v${k}]overlay=eof_action=pass:shortest=0[base${k + 1}]`);
    last = `base${k + 1}`;
  });
  graph.push(`[${last}]format=yuv420p[vout]`);

  const audioLabels = [];
  audioClips.forEach((c, k) => {
    const idx = addInput(c);
    const used = r3(c.dur * (c.speed || 1));
    const vol = typeof c.volume === 'number' ? c.volume : 1;
    const tempo = (c.speed || 1) !== 1 ? atempoChain(c.speed) + ',' : '';
    graph.push(
      `[${idx}:a]atrim=start=${r3(c.srcIn || 0)}:duration=${used},asetpts=PTS-STARTPTS,${tempo}` +
      `volume=${r3(vol)},adelay=${Math.round(c.start * 1000)}:all=1[a${k}]`);
    audioLabels.push(`[a${k}]`);
  });
  let audioArgs = [];
  if (audioLabels.length) {
    graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
    audioArgs = ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'];
  }

  const encodeArgs = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '22', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];

  return {
    args: [
      '-hide_banner', '-y', '-progress', 'pipe:1', '-nostats',
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', '[vout]', ...audioArgs,
      ...encodeArgs,
      '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-t', String(r3(total)),
      '-movflags', '+faststart',
      output,
    ],
    total,
    size,
  };
}

// Runs the render. onProgress receives a fraction from 0 to 1. Resolves to { ok, path } or { ok: false, error }.
function renderTimeline({ clips, resolution, output, onProgress = () => {}, ffmpeg = 'ffmpeg' }) {
  const enc = detectEncoder();
  const built = buildRenderArgs({ clips, resolution, output, encoder: enc.encoder, cuda: enc.cuda });
  if (built.error) return Promise.resolve({ ok: false, error: built.error });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, built.args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message });
    }
    let errTail = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && built.total > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / built.total));
      }
    });
    child.stderr.on('data', (chunk) => {
      errTail = errTail.concat(String(chunk).split(/\r?\n/).filter(Boolean)).slice(-8);
    });
    child.on('error', (e) => resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, path: output, encoder: enc.encoder });
      resolve({ ok: false, error: errTail.slice(-2).join(' ') || `ffmpeg exited with code ${code}.` });
    });
  });
}

module.exports = { PRESETS, detectEncoder, atempoChain, buildRenderArgs, renderTimeline };
