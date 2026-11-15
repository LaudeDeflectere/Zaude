// Renders the timeline to an MP4 with ffmpeg. Uses NVIDIA NVENC for encoding when ffmpeg has it,
// and CUDA decoding for the inputs, otherwise libx264 on the CPU.
const fs = require('node:fs');
const path = require('node:path');
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
  // ffmpeg can list NVENC on a computer with no NVIDIA card, so a listed encoder is tried once for real.
  let nvenc = /\bh264_nvenc\b/.test(encoders);
  if (nvenc) {
    try {
      const trial = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=24:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
      nvenc = trial.status === 0;
    } catch {
      nvenc = false;
    }
  }
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
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const EPS = 1e-6;
const CHUNK_SECONDS = 30;

// A path as ffmpeg filter options want it: forward slashes, and the drive colon escaped.
function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

// A bold system font for titles, or null to let ffmpeg choose.
function defaultFont(platform = process.platform, exists = fs.existsSync) {
  const candidates = platform === 'win32'
    ? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arial.ttf']
    : platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'];
  return candidates.find((f) => exists(f)) || null;
}

const isMedia = (c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio');
const isTitle = (c) => c.kind === 'title' && typeof c.text === 'string' && c.text.trim();

// End of the last clip that will appear in the render.
function renderEnd(clips) {
  return clips.filter((c) => isMedia(c) || isTitle(c)).reduce((m, c) => Math.max(m, c.start + c.dur), 0);
}

// The part of the timeline between from and to, with times counted from `from`.
function windowClips(clips, from, to) {
  const out = [];
  for (const c of clips) {
    const a = Math.max(c.start, from);
    const b = Math.min(c.start + c.dur, to);
    if (b <= a + EPS) continue;
    out.push({ ...c, start: a - from, dur: b - a, srcIn: (c.srcIn || 0) + (a - c.start) * (c.speed || 1) });
  }
  return out;
}

// Splits 0..total into pieces of about `seconds`, so a long timeline is rendered a piece at a time.
function planChunks(total, seconds = CHUNK_SECONDS) {
  const count = Math.max(1, Math.ceil((total - EPS) / seconds));
  const out = [];
  for (let k = 0; k < count; k++) out.push({ from: r3(k * seconds), to: r3(Math.min(total, (k + 1) * seconds)) });
  return out;
}

// Builds the ffmpeg arguments for the timeline. Pure: no files are read or written.
// Every clip is opened at its own source position, so long source files are not decoded from the start.
// Titles are drawn from text files; the caller writes `textFiles` before running ffmpeg.
// intermediate: true makes a piece for joining later (uncompressed audio), and allows an empty piece.
function buildRenderArgs({ clips, resolution, output, encoder = 'libx264', cuda = false, fps = FPS, font = null, textDir = '', intermediate = false, total: fixedTotal = null }) {
  const size = PRESETS[resolution] || PRESETS['1920 × 1080'];
  const media = clips.filter(isMedia);
  const titles = clips.filter(isTitle);
  if (!media.length && !titles.length && !intermediate) return { error: 'The timeline has no media clips to render.' };
  const total = fixedTotal !== null ? fixedTotal : renderEnd(clips);

  const inputs = [];
  const graph = [];
  const videoClips = media.filter((c) => c.kind === 'video').sort((a, b) => a.track.localeCompare(b.track));
  const audioClips = media.filter((c) => c.hasAudio !== false && !c.muted && (c.kind === 'audio' || c.hasAudio === true));

  // one input per clip, opened at the clip's source position
  const inputIndex = new Map();
  let count = 0;
  const addInput = (c) => {
    if (!inputIndex.has(c.id)) {
      inputIndex.set(c.id, count++);
      const used = c.dur * (c.speed || 1);
      if (cuda && c.kind === 'video') inputs.push('-hwaccel', 'cuda');
      inputs.push('-ss', String(r3(c.srcIn || 0)), '-t', String(r3(used + 0.5)), '-i', c.path);
    }
    return inputIndex.get(c.id);
  };

  graph.push(`color=c=black:s=${size.w}x${size.h}:r=${fps}:d=${r3(total)}[base0]`);
  let last = 'base0';
  videoClips.forEach((c, k) => {
    const idx = addInput(c);
    const speed = c.speed || 1;
    const used = r3(c.dur * speed);
    const opacity = typeof c.opacity === 'number' ? c.opacity : 1;
    const zoom = typeof c.zoom === 'number' && c.zoom > 1 ? c.zoom : 1;
    const zw = even(size.w * zoom);
    const zh = even(size.h * zoom);
    const crop = zoom > 1 ? `,crop=${size.w}:${size.h}` : '';
    graph.push(
      `[${idx}:v]trim=duration=${used},setpts=(PTS-STARTPTS)/${speed},fps=${fps},` +
      `scale=${zw}:${zh}:force_original_aspect_ratio=decrease,pad=${zw}:${zh}:(ow-iw)/2:(oh-ih)/2:black${crop},` +
      `format=yuva420p,colorchannelmixer=aa=${r3(opacity)},setpts=PTS+${r3(c.start)}/TB[v${k}]`);
    graph.push(`[${last}][v${k}]overlay=eof_action=pass:shortest=0[base${k + 1}]`);
    last = `base${k + 1}`;
  });

  const textFiles = [];
  const draws = titles.map((c, k) => {
    const file = (textDir ? textDir.replace(/[\\/]$/, '') + '/' : '') + `title-${k}.txt`;
    textFiles.push({ path: file, text: c.text.trim() });
    const px = Math.max(8, Math.round((Number(c.size) || 64) * size.h / 1080));
    const y = c.position === 'top' ? 'h*0.08' : c.position === 'center' ? '(h-text_h)/2' : 'h*0.92-text_h';
    const alpha = r3(typeof c.opacity === 'number' ? c.opacity : 1);
    return `drawtext=textfile='${filterPath(file)}':expansion=none` + (font ? `:fontfile='${filterPath(font)}'` : '') +
      `:fontsize=${px}:fontcolor=${String(c.color || 'white').replace(/[^A-Za-z0-9#]/g, '')}@${alpha}:x=(w-text_w)/2:y=${y}` +
      `:box=1:boxcolor=black@${r3(0.55 * alpha)}:boxborderw=${Math.round(px * 0.3)}` +
      `:enable='between(t,${r3(c.start)},${r3(c.start + c.dur)})'`;
  });
  graph.push(`[${last}]${draws.length ? draws.join(',') + ',' : ''}format=yuv420p[vout]`);

  // audio: a silent bed for the whole length, with every clip mixed over it
  graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${r3(total)}[a_bed]`);
  const audioLabels = ['[a_bed]'];
  audioClips.forEach((c, k) => {
    const idx = addInput(c);
    const speed = c.speed || 1;
    const used = r3(c.dur * speed);
    const vol = typeof c.volume === 'number' ? c.volume : 1;
    const tempo = speed !== 1 ? atempoChain(speed) + ',' : '';
    graph.push(
      `[${idx}:a]atrim=duration=${used},asetpts=PTS-STARTPTS,${tempo}` +
      `aformat=sample_rates=48000:channel_layouts=stereo,volume=${r3(vol)},adelay=${Math.round(c.start * 1000)}:all=1[a${k}]`);
    audioLabels.push(`[a${k}]`);
  });
  graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:normalize=0[aout]`);
  const audioArgs = intermediate
    ? ['-map', '[aout]', '-c:a', 'pcm_s16le']
    : ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'];

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
      '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-t', String(r3(total)),
      ...(intermediate ? [] : ['-movflags', '+faststart']),
      output,
    ],
    total,
    size,
    textFiles,
  };
}

// Runs ffmpeg once. onTime receives the seconds written so far. Resolves to { ok } or { ok: false, error }.
function runFfmpeg(ffmpeg, args, onTime = () => {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true });
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
        if (m) onTime(Number(m[1]) / 1e6);
      }
    });
    child.stderr.on('data', (chunk) => {
      errTail = errTail.concat(String(chunk).split(/\r?\n/).filter(Boolean)).slice(-8);
    });
    child.on('error', (e) => resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: errTail.slice(-2).join(' ') || `ffmpeg exited with code ${code}.` });
    });
  });
}

// Runs the render. A timeline longer than one piece is rendered piece by piece and joined, so the
// number of files open at once stays small however long the edit is.
// onProgress receives a fraction from 0 to 1. Resolves to { ok, path, encoder } or { ok: false, error }.
async function renderTimeline({ clips, resolution, output, fps = FPS, onProgress = () => {}, ffmpeg = 'ffmpeg', chunkSeconds = CHUNK_SECONDS, encoder = null }) {
  const enc = encoder ? { encoder, cuda: encoder === 'h264_nvenc' } : detectEncoder();
  const total = renderEnd(clips);
  if (!(total > 0)) return { ok: false, error: 'The timeline has no media clips to render.' };
  const font = defaultFont();
  const work = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), '.zaude-render-'));
  const common = { resolution, encoder: enc.encoder, cuda: enc.cuda, fps, font };
  const build = (opts) => {
    const built = buildRenderArgs({ ...common, ...opts });
    if (!built.error) for (const t of built.textFiles) fs.writeFileSync(t.path, t.text);
    return built;
  };
  try {
    const chunks = planChunks(total, chunkSeconds);
    if (chunks.length === 1) {
      const built = build({ clips, output, textDir: work });
      if (built.error) return { ok: false, error: built.error };
      const res = await runFfmpeg(ffmpeg, built.args, (t) => onProgress(Math.min(1, t / total)));
      return res.ok ? { ok: true, path: output, encoder: enc.encoder } : res;
    }
    const parts = [];
    for (let k = 0; k < chunks.length; k++) {
      const { from, to } = chunks[k];
      const dir = path.join(work, 'p' + k);
      fs.mkdirSync(dir);
      const part = path.join(work, `part-${String(k).padStart(5, '0')}.mkv`);
      const built = build({ clips: windowClips(clips, from, to), output: part, textDir: dir, intermediate: true, total: to - from });
      if (built.error) return { ok: false, error: built.error };
      const res = await runFfmpeg(ffmpeg, built.args, (t) => onProgress(Math.min(0.98, (from + t) / total * 0.98)));
      if (!res.ok) return { ok: false, error: `Rendering ${from}–${to} s failed: ${res.error}` };
      parts.push(part);
    }
    const list = path.join(work, 'parts.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = await runFfmpeg(ffmpeg, ['-hide_banner', '-y', '-nostats', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]);
    if (!joined.ok) return { ok: false, error: 'Joining the rendered pieces failed: ' + joined.error };
    onProgress(1);
    return { ok: true, path: output, encoder: enc.encoder };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { PRESETS, detectEncoder, atempoChain, buildRenderArgs, renderTimeline, windowClips, planChunks, renderEnd, filterPath, defaultFont };
