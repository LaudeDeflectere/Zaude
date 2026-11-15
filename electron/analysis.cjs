// Understanding footage: where the silences are, and what is said (speech to text through a Whisper
// program installed on this computer). Results are saved next to the project so they are made once.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ANALYSIS_DIR = '.zaude';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

// Runs a program and collects its output. Resolves to { code, stdout, stderr }; code is null when it could not start.
function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: e.message });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 4e6) stderr = stderr.slice(-2e6);
      if (onStderr) onStderr(String(d));
    });
    child.on('error', (e) => resolve({ code: null, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------- silence ----------

// Reads ffmpeg's silencedetect lines. Returns [{ from, to }] in seconds; a silence still open at the end runs to `duration`.
function parseSilence(text, duration = null) {
  const out = [];
  let open = null;
  for (const line of String(text).split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open !== null) {
      out.push({ from: r3(open), to: r3(Number(e[1])) });
      open = null;
    }
  }
  if (open !== null && duration && duration > open) out.push({ from: r3(open), to: r3(duration) });
  return out;
}

// Shrinks each silence by `pad` seconds on both sides, so words are not clipped, and drops what is left
// when it is shorter than `minCut`.
function padSilences(silences, pad = 0.15, minCut = 0.3, duration = null) {
  const out = [];
  for (const s of silences) {
    const from = s.from <= 0.001 ? 0 : s.from + pad;
    const to = duration && s.to >= duration - 0.001 ? s.to : s.to - pad;
    if (to - from >= minCut) out.push({ from: r3(from), to: r3(to) });
  }
  return out;
}

// The parts of 0..duration that are not in `silences`.
function invertRanges(silences, duration) {
  const out = [];
  let at = 0;
  for (const s of [...silences].sort((a, b) => a.from - b.from)) {
    if (s.from > at + 0.001) out.push({ from: r3(at), to: r3(s.from) });
    at = Math.max(at, s.to);
  }
  if (duration > at + 0.001) out.push({ from: r3(at), to: r3(duration) });
  return out;
}

// Finds the silences in a file's audio. Resolves to { ok, silences } or { ok: false, error }.
async function detectSilence(file, { noiseDb = -35, minSilence = 0.6, duration = null, ffmpeg = 'ffmpeg' } = {}) {
  const res = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-']);
  if (res.code === null) return { ok: false, error: 'Could not start ffmpeg: ' + res.stderr };
  if (res.code !== 0) return { ok: false, error: lastLines(res.stderr) || `ffmpeg exited with code ${res.code}.` };
  return { ok: true, silences: parseSilence(res.stderr, duration) };
}

function lastLines(text, n = 2) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-n).join(' ');
}

// ---------- speech to text ----------

// The Whisper programs Zaude knows how to call, in the order they are looked for.
const ENGINES = {
  'whisper-ctranslate2': { style: 'openai', defaultModel: 'small' },
  'faster-whisper': { style: 'openai', defaultModel: 'small' },
  whisper: { style: 'openai', defaultModel: 'small' },
  'whisper-cli': { style: 'cpp', defaultModel: null },
};

function engineStyle(command) {
  const base = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '');
  if (ENGINES[base]) return ENGINES[base].style;
  return /cpp|whisper-cli|main/.test(base) ? 'cpp' : 'openai';
}

// Finds an installed Whisper program. Returns its command name, or null.
function findEngine(probe = spawnSync) {
  for (const name of Object.keys(ENGINES)) {
    try {
      const res = probe(name, ['--help'], { encoding: 'utf8', windowsHide: true });
      if (!res.error && res.status !== null) return name;
    } catch { /* not installed */ }
  }
  return null;
}

// Arguments for one transcription run. Pure. Returns { args, jsonFile } or { error }.
function buildWhisperArgs({ command, wav, outDir, model, language }) {
  const style = engineStyle(command);
  const base = path.basename(wav, path.extname(wav));
  if (style === 'cpp') {
    if (!model) return { error: 'whisper.cpp needs a model file. Pass --model with the path to a ggml model.' };
    const outBase = path.join(outDir, base);
    return { args: ['-m', model, '-f', wav, '-oj', '-of', outBase, '-l', language || 'auto'], jsonFile: outBase + '.json' };
  }
  const args = [wav, '--model', model || 'small', '--output_format', 'json', '--output_dir', outDir];
  if (language) args.push('--language', language);
  return { args, jsonFile: path.join(outDir, base + '.json') };
}

// Reads the JSON of either Whisper family. Returns { language, segments: [{ start, end, text }] }.
function parseWhisperJson(json) {
  const segments = [];
  if (json && Array.isArray(json.transcription)) {
    for (const s of json.transcription) {
      const text = String(s.text || '').trim();
      if (!text || !s.offsets) continue;
      segments.push({ start: r3(s.offsets.from / 1000), end: r3(s.offsets.to / 1000), text });
    }
    return { language: (json.result && json.result.language) || null, segments };
  }
  for (const s of (json && json.segments) || []) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    segments.push({ start: r3(s.start), end: r3(s.end), text });
  }
  return { language: (json && json.language) || null, segments };
}

// Transcribes one media file. Resolves to { ok, transcript } or { ok: false, error }.
async function transcribeFile(file, { command = null, model = null, language = null, ffmpeg = 'ffmpeg', onLog = () => {} } = {}) {
  const engine = command || findEngine();
  if (!engine) {
    return { ok: false, error: 'No Whisper program was found. Install one (for example: pip install whisper-ctranslate2) or pass its path with --whisper.' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-stt-'));
  try {
    const wav = path.join(tmp, 'audio.wav');
    const cut = await run(ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    if (cut.code === null) return { ok: false, error: 'Could not start ffmpeg: ' + cut.stderr };
    if (cut.code !== 0) return { ok: false, error: 'Could not read the audio: ' + lastLines(cut.stderr) };
    const built = buildWhisperArgs({ command: engine, wav, outDir: tmp, model, language });
    if (built.error) return { ok: false, error: built.error };
    const res = await run(engine, built.args, { onStderr: onLog });
    if (res.code === null) return { ok: false, error: `Could not start ${engine}: ${res.stderr}` };
    if (res.code !== 0 || !fs.existsSync(built.jsonFile)) {
      return { ok: false, error: `${engine} failed: ` + (lastLines(res.stderr) || lastLines(res.stdout) || `exit code ${res.code}`) };
    }
    const parsed = parseWhisperJson(JSON.parse(fs.readFileSync(built.jsonFile, 'utf8')));
    return { ok: true, transcript: { file: path.basename(file), engine: path.basename(engine), ...parsed } };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- saved results ----------

// Where the analysis of one media file is kept: <project>/.zaude/<file name>.<what>.json
function analysisPath(folder, file, what) {
  return path.join(folder, ANALYSIS_DIR, path.basename(file) + '.' + what + '.json');
}

function readAnalysis(folder, file, what) {
  try {
    return JSON.parse(fs.readFileSync(analysisPath(folder, file, what), 'utf8'));
  } catch {
    return null;
  }
}

function writeAnalysis(folder, file, what, data) {
  const target = analysisPath(folder, file, what);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  return target;
}

// A transcript as plain lines, "[m:ss.s–m:ss.s] text", for reading.
function transcriptText(transcript) {
  const t = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  return transcript.segments.map((s) => `[${t(s.start)}–${t(s.end)}] ${s.text}`).join('\n');
}

module.exports = {
  ANALYSIS_DIR, parseSilence, padSilences, invertRanges, detectSilence,
  ENGINES, engineStyle, findEngine, buildWhisperArgs, parseWhisperJson, transcribeFile,
  analysisPath, readAnalysis, writeAnalysis, transcriptText,
};
