// Visual RefMod library stored inside Zaude's program folder (`<appRoot>/refmods/`).
// Each RefMod has its own folder containing:
//   - meta.json    ({ file, name, firstName, slug })
//   - headshot.jpg (character headshot preview generated using the RefMod)
//   - walk.mp4     (short walking animation generated using the RefMod, played on hover)
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function slugForRefMod(file) {
  return String(file || 'subject')
    .trim()
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'subject';
}

// Extracts only the first name; falls back to "Subject <index>" when no name is present.
function displayFirstName(name, index = 1) {
  const cleaned = String(name || '')
    .replace(/.*[\\/]/, '')
    .replace(/\.safetensors$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) return `Subject ${index}`;
  const first = cleaned.split(/\s+/)[0];
  if (!first || /^\d+$/.test(first)) return `Subject ${index}`;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function inspectEntry(dir, fallback = {}, index = 1) {
  const meta = readMeta(dir) || {};
  const file = meta.file || fallback.file || path.basename(dir);
  const name = meta.name !== undefined ? meta.name : (fallback.name || '');
  const firstName = displayFirstName(name, index);
  const headshotPath = path.join(dir, 'headshot.jpg');
  const headshotPng = path.join(dir, 'headshot.png');
  const walkPath = path.join(dir, 'walk.mp4');
  const hasHeadshot = fs.existsSync(headshotPath) || fs.existsSync(headshotPng);
  const resolvedHeadshot = fs.existsSync(headshotPath) ? headshotPath : (fs.existsSync(headshotPng) ? headshotPng : null);
  const hasWalk = fs.existsSync(walkPath);
  return {
    file,
    name,
    firstName,
    slug: path.basename(dir),
    dir,
    headshotPath: resolvedHeadshot,
    walkPath: hasWalk ? walkPath : null,
    hasHeadshot,
    hasWalk,
  };
}

// Ensures `<refmodsRoot>/<slug>/` exists for every discovered Mannimmate RefMod and any custom folders.
function syncRefMods(refmodsRoot, mods = []) {
  fs.mkdirSync(refmodsRoot, { recursive: true });
  const bySlug = new Map();

  let idx = 1;
  for (const mod of (mods || [])) {
    if (!mod || !mod.file) continue;
    const slug = slugForRefMod(mod.file);
    const dir = path.join(refmodsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const existing = readMeta(dir);
    if (!existing) {
      writeMeta(dir, {
        file: mod.file,
        name: mod.name || '',
        firstName: displayFirstName(mod.name || '', idx),
        slug,
        createdAt: new Date().toISOString(),
      });
    }
    bySlug.set(slug, inspectEntry(dir, mod, idx));
    idx++;
  }

  // Also include any locally created RefMod folders already in `<refmodsRoot>/`
  try {
    for (const entry of fs.readdirSync(refmodsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (bySlug.has(entry.name)) continue;
      const dir = path.join(refmodsRoot, entry.name);
      bySlug.set(entry.name, inspectEntry(dir, { file: entry.name, name: '' }, idx));
      idx++;
    }
  } catch { /* ignore */ }

  return Array.from(bySlug.values());
}

function createRefModFolder(refmodsRoot, { name = '', file = '' } = {}) {
  fs.mkdirSync(refmodsRoot, { recursive: true });
  const existingCount = fs.readdirSync(refmodsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  const trimmedName = String(name || '').trim();
  const trimmedFile = String(file || '').trim() || slugForRefMod(trimmedName || `subject_${existingCount + 1}`);
  const slug = slugForRefMod(trimmedFile);
  const dir = path.join(refmodsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    file: trimmedFile,
    name: trimmedName,
    firstName: displayFirstName(trimmedName, existingCount + 1),
    slug,
    createdAt: new Date().toISOString(),
  };
  writeMeta(dir, meta);
  return inspectEntry(dir, meta, existingCount + 1);
}

// Extracts a square center-cropped headshot JPG from a video file using ffmpeg.
function extractHeadshotFromVideo(videoPath, outJpg, { ffmpeg = 'ffmpeg', timeSec = 0.8 } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(outJpg), { recursive: true });
    const child = spawn(ffmpeg, [
      '-y', '-v', 'error',
      '-ss', String(timeSec),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=384:384:flags=lanczos',
      '-q:v', '3',
      outJpg,
    ], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outJpg)) return resolve({ ok: true, path: outJpg });
      resolve({ ok: false, error: err.trim() || `ffmpeg exited with code ${code}` });
    });
  });
}

// Generates both `walk.mp4` (short walking clip via Mannimmate refmod) and `headshot.jpg` into `refmods/<slug>/`.
function generateRefModAssets({ refmodsRoot, mannimmateDir, python = 'python3', mod, onEvent = () => {} }) {
  const cliPath = path.join(mannimmateDir, 'mannimmate_cli.py');
  if (!fs.existsSync(cliPath)) {
    return { ok: false, promise: Promise.resolve({ ok: false, error: `mannimmate_cli.py not found in ${mannimmateDir}` }), cancel: () => {} };
  }
  const slug = slugForRefMod(mod.file);
  const dir = path.join(refmodsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  const subjectName = mod.name || displayFirstName(mod.name, 1);
  const slot = `${mod.file}|${subjectName}|1.0|1.0`;
  const walkPrompt = `Medium-full studio shot of ${subjectName} walking naturally forward toward the camera on a clean neutral dark studio floor, soft key light, clear face, smooth relaxed walking loop.`;

  const args = [
    cliPath,
    'refmod',
    '--mode', 'generate',
    '--refmod', slot,
    '--prompt', walkPrompt,
    '--quality', '480',
    '--seconds', '3',
    '--fps', '24',
    '--steps', '4',
    '--out-dir', dir,
    '--gpu-wait', '30',
    '--json',
  ];

  let child;
  try {
    child = spawn(python, args, { cwd: mannimmateDir, windowsHide: true });
  } catch (e) {
    return { ok: false, promise: Promise.resolve({ ok: false, error: e.message }), cancel: () => {} };
  }

  let savedVideo = null;
  let outBuf = '';
  let errTail = [];
  let cancelled = false;

  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
    onEvent({ type: 'stdout', text: t });
    if (!t.startsWith('{')) return;
    try {
      const ev = JSON.parse(t);
      const p = ev.path || ev.output || ev.video || null;
      if ((ev.event === 'saved' || ev.event === 'done' || ev.event === 'refmod_saved') && p) savedVideo = p;
      if (typeof ev.progress === 'number') onEvent({ type: 'progress', progress: ev.progress, label: ev.label || ev.stage || 'Generating RefMod preview…' });
    } catch { /* ignore */ }
  };

  child.stdout.on('data', (c) => {
    outBuf += String(c);
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      handleLine(outBuf.slice(0, idx));
      outBuf = outBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (c) => {
    errTail = errTail.concat(String(c).split(/\r?\n/).filter(Boolean)).slice(-10);
  });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', async (code) => {
      if (outBuf.trim()) handleLine(outBuf);
      if (cancelled) return resolve({ ok: false, cancelled: true, error: 'Cancelled' });
      if (code !== 0 || !savedVideo || !fs.existsSync(savedVideo)) {
        return resolve({ ok: false, error: errTail[errTail.length - 1] || `RefMod preview failed (code ${code})` });
      }
      const walkTarget = path.join(dir, 'walk.mp4');
      try {
        if (path.resolve(savedVideo) !== path.resolve(walkTarget)) {
          fs.copyFileSync(savedVideo, walkTarget);
        }
      } catch { /* keep savedVideo */ }
      const headshotTarget = path.join(dir, 'headshot.jpg');
      await extractHeadshotFromVideo(walkTarget, headshotTarget);
      resolve({ ok: true, entry: inspectEntry(dir, mod) });
    });
  });

  return {
    ok: true,
    promise,
    cancel() {
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  slugForRefMod,
  displayFirstName,
  syncRefMods,
  createRefModFolder,
  extractHeadshotFromVideo,
  generateRefModAssets,
};
