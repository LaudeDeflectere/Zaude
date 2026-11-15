#!/usr/bin/env node
// Zaude without the window: the same project file, timeline tools and renderer as the desktop app,
// run from a terminal. A folder of footage is a project; its timeline is in zaude-project.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as T from '../src/timeline.js';
import { applyOps, describeTimeline, OPS } from '../src/ops.js';

const require = createRequire(import.meta.url);
const project = require('../electron/project.cjs');
const analysis = require('../electron/analysis.cjs');
const render = require('../electron/render.cjs');

const HELP = `Zaude command line

  zaude scan <folder>                      List the media files in a project folder
  zaude transcribe <folder> [file ...]     Speech to text for every file (or the ones named)
        --whisper <program>  --model <name or file>  --language <code>  --force
  zaude transcript <folder> [file ...]     Print saved transcripts
  zaude silence <folder> [file ...]        Find the silent parts of every file
        --noise <dB, default -35>  --min <seconds, default 0.6>  --force
  zaude show <folder>                      Print the timeline
  zaude edit <folder> <steps.json>         Run edit steps on the timeline ("-" reads the steps from input)
  zaude undo <folder>                      Take back the last edit
  zaude render <folder>                    Render the timeline to an MP4
        --out <file>  --resolution <720|1080|2160>  --fps <number>  --cpu
  zaude help ops                           List the edit steps

Every command accepts --json for output a program can read.`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  const bare = new Set(['json', 'force', 'cpu']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bare.has(key)) flags[key] = true;
      else flags[key] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function needFolder(folder) {
  if (!folder) fail('Give the project folder.\n\n' + HELP);
  const full = path.resolve(folder);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) fail(`"${folder}" is not a folder.`);
  return full;
}

async function scan(folder) {
  const res = await project.scanFolder(folder);
  if (!res.ok) fail(res.error);
  return res.media;
}

function pick(media, names) {
  if (!names.length) return media;
  return names.map((n) => {
    const hit = media.find((m) => m.name === n) || media.find((m) => m.name.toLowerCase() === n.toLowerCase());
    if (!hit) fail(`"${n}" is not a media file in this folder.`);
    return hit;
  });
}

function loadTimeline(folder) {
  const res = project.loadProject(folder);
  if (!res.ok) fail(res.error);
  const data = res.data || { version: 1, name: path.basename(folder), format: 'MP4', resolution: '1920 × 1080', clips: [] };
  if (!Array.isArray(data.clips)) data.clips = [];
  return data;
}

const historyDir = (folder) => path.join(folder, analysis.ANALYSIS_DIR, 'history');

function saveTimeline(folder, data, previous) {
  if (previous) {
    fs.mkdirSync(historyDir(folder), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(historyDir(folder), stamp + '.json'), JSON.stringify(previous));
  }
  const res = project.saveProject(folder, data, [folder]);
  if (!res.ok) fail('Could not save the project: ' + res.error);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const commands = {
  async scan({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const media = await scan(folder);
    if (flags.json) return console.log(JSON.stringify(media, null, 2));
    for (const m of media) {
      const size = m.width ? `${m.width}×${m.height}` : '';
      const done = ['transcript', 'silence'].filter((w) => analysis.readAnalysis(folder, m.path, w)).join(', ');
      console.log(`${m.name.padEnd(36)} ${m.kind.padEnd(5)} ${(m.duration == null ? '?' : mmss(m.duration)).padStart(7)}  ${size.padEnd(10)} ${m.fps ? m.fps + ' fps' : ''}${done ? '  [' + done + ']' : ''}`);
    }
    const total = media.reduce((sum, m) => sum + (m.duration || 0), 0);
    console.log(`${media.length} files, ${mmss(total)} in total`);
  },

  async transcribe({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const files = pick((await scan(folder)).filter((m) => m.hasAudio !== false), rest.slice(1));
    const out = [];
    for (const m of files) {
      let saved = flags.force ? null : analysis.readAnalysis(folder, m.path, 'transcript');
      if (!saved) {
        if (!flags.json) console.error(`Transcribing ${m.name} (${mmss(m.duration || 0)})…`);
        const res = await analysis.transcribeFile(m.path, { command: flags.whisper || process.env.ZAUDE_WHISPER || null, model: flags.model || null, language: flags.language || null });
        if (!res.ok) fail(`${m.name}: ${res.error}`);
        saved = res.transcript;
        analysis.writeAnalysis(folder, m.path, 'transcript', saved);
      }
      out.push(saved);
      if (!flags.json) console.log(`\n== ${m.name} ==\n${analysis.transcriptText(saved)}`);
    }
    if (flags.json) console.log(JSON.stringify(out, null, 2));
  },

  async transcript({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const files = pick(await scan(folder), rest.slice(1));
    const out = [];
    for (const m of files) {
      const saved = analysis.readAnalysis(folder, m.path, 'transcript');
      if (!saved) continue;
      out.push(saved);
      if (!flags.json) console.log(`\n== ${m.name} ==\n${analysis.transcriptText(saved)}`);
    }
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else if (!out.length) console.log('No transcripts saved yet. Run "zaude transcribe" on the folder.');
  },

  async silence({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const files = pick((await scan(folder)).filter((m) => m.hasAudio !== false), rest.slice(1));
    const out = [];
    for (const m of files) {
      let saved = flags.force ? null : analysis.readAnalysis(folder, m.path, 'silence');
      if (!saved) {
        const noiseDb = flags.noise == null ? -35 : Number(flags.noise);
        const minSilence = flags.min == null ? 0.6 : Number(flags.min);
        const res = await analysis.detectSilence(m.path, { noiseDb, minSilence, duration: m.duration });
        if (!res.ok) fail(`${m.name}: ${res.error}`);
        saved = { file: m.name, noiseDb, minSilence, duration: m.duration, silences: res.silences };
        analysis.writeAnalysis(folder, m.path, 'silence', saved);
      }
      out.push(saved);
      const quiet = saved.silences.reduce((sum, s) => sum + (s.to - s.from), 0);
      if (!flags.json) console.log(`${m.name.padEnd(36)} ${saved.silences.length} silent parts, ${mmss(quiet)} of ${mmss(m.duration || 0)}`);
    }
    if (flags.json) console.log(JSON.stringify(out, null, 2));
  },

  async show({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const data = loadTimeline(folder);
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    console.log(describeTimeline(data.clips));
  },

  async edit({ rest, flags }) {
    const folder = needFolder(rest[0]);
    if (!rest[1]) fail('Give the file with the edit steps, or "-" to read them from input.');
    let ops;
    try {
      ops = JSON.parse(fs.readFileSync(rest[1] === '-' ? 0 : rest[1], 'utf8'));
    } catch (e) {
      fail('Could not read the edit steps: ' + e.message);
    }
    const media = await scan(folder);
    const silences = {};
    for (const m of media) {
      const saved = analysis.readAnalysis(folder, m.path, 'silence');
      if (saved) silences[m.path] = saved.silences;
    }
    const data = loadTimeline(folder);
    const res = applyOps(data.clips, ops, { media, silences, names: data.names || {} });
    if (!res.ok) fail(res.error + '\nNothing was changed.');
    const fps = data.fps || media.find((m) => m.kind === 'video' && m.fps)?.fps || null;
    saveTimeline(folder, { ...data, clips: res.clips, names: res.names, ...(fps ? { fps } : {}) }, data);
    if (flags.json) return console.log(JSON.stringify({ ok: true, log: res.log, names: res.names, clips: res.clips }, null, 2));
    console.log(res.log.join('\n'));
    console.log('\n' + describeTimeline(res.clips));
  },

  async undo({ rest }) {
    const folder = needFolder(rest[0]);
    const dir = historyDir(folder);
    const saved = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
    if (!saved.length) fail('Nothing to undo.');
    const last = path.join(dir, saved[saved.length - 1]);
    saveTimeline(folder, JSON.parse(fs.readFileSync(last, 'utf8')), null);
    fs.rmSync(last);
    console.log('Took back the last edit.\n\n' + describeTimeline(loadTimeline(folder).clips));
  },

  async render({ rest, flags }) {
    const folder = needFolder(rest[0]);
    const data = loadTimeline(folder);
    const sizes = { 720: '1280 × 720', 1080: '1920 × 1080', 2160: '3840 × 2160' };
    const resolution = flags.resolution ? sizes[flags.resolution] : data.resolution;
    if (!resolution || !render.PRESETS[resolution]) fail('Resolution must be 720, 1080 or 2160.');
    const fps = Math.round(Number(flags.fps || data.fps || 30));
    if (!(fps >= 1 && fps <= 120)) fail('Frames per second must be between 1 and 120.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(data.name || 'zaude').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 60) || 'zaude';
    const output = path.resolve(flags.out || path.join(folder, `${safe}-${stamp}.mp4`));
    let shown = -1;
    const res = await render.renderTimeline({
      clips: data.clips, resolution, fps, output, encoder: flags.cpu ? 'libx264' : null,
      onProgress: (p) => {
        const pct = Math.floor(p * 100);
        if (!flags.json && pct !== shown && pct % 5 === 0) { shown = pct; console.error(`Rendering ${pct}%`); }
      },
    });
    if (flags.json) return console.log(JSON.stringify(res, null, 2));
    if (!res.ok) fail('Render failed: ' + res.error);
    console.log(`Rendered ${res.path} (${res.encoder === 'h264_nvenc' ? 'NVIDIA NVENC' : 'CPU'}, ${resolution}, ${fps} fps)`);
  },

  async help({ rest }) {
    if (rest[0] !== 'ops') return console.log(HELP);
    console.log('Edit steps, written as a JSON list, for example:\n');
    console.log(JSON.stringify([
      { op: 'add', file: 'IMG_0001.MOV', in: 12.5, out: 31, as: 'intro' },
      { op: 'add', file: 'IMG_0002.MOV', in: 60, out: 420, speed: 20, muted: true },
      { op: 'title', text: 'The leak', over: 'intro', dur: 3 },
      { op: 'removeSilence' },
    ], null, 2));
    console.log('\nTracks: ' + T.TRACK_IDS.join(', ') + '. Times are in seconds.\n');
    for (const [name, text] of Object.entries(OPS)) console.log(`${name.padEnd(14)} ${text}`);
  },
};

const { flags, rest } = parseArgs(process.argv.slice(2));
const name = rest.shift();
if (!name || !commands[name]) {
  console.log(HELP);
  process.exit(name ? 1 : 0);
}
await commands[name]({ flags, rest });
