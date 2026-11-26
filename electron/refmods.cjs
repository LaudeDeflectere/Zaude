// Visual RefMod library stored inside Zaude's program folder (`<appRoot>/refmods/`).
// Each RefMod has its own folder containing:
//   - meta.json    ({ file, name, firstName, slug })
//   - headshot.jpg (character headshot preview generated using the RefMod)
//   - walk.mp4     (short walking animation generated using the RefMod, played on hover)
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REFMOD_CATEGORIES = [
  'Photoreal',
  '2D / Anime',
  'Characters',
  'Locations',
  'Styles',
  'Voices',
];

function inferCategory(file = '', name = '') {
  const hay = `${file} ${name}`.toLowerCase();
  if (/location|set3d|room|bar_loc|alley|background/.test(hay)) return 'Locations';
  if (/style_v\d|shared.*style|_style\b/.test(hay)) return 'Styles';
  if (/(?:_audio\b|_voice\b|voices[\\/])/.test(hay)) return 'Voices';
  if (/(?:cbphoto|photo_v\d|_photo\b)/.test(hay)) return 'Photoreal';
  if (/(?:_2d_|2d_v\d|changebang|anime)/.test(hay)) return '2D / Anime';
  return 'Characters';
}

function deletedFile(refmodsRoot) {
  return path.join(refmodsRoot, '.deleted.json');
}

function loadDeletedSlugs(refmodsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(deletedFile(refmodsRoot), 'utf8'));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveDeletedSlugs(refmodsRoot, set) {
  fs.mkdirSync(refmodsRoot, { recursive: true });
  fs.writeFileSync(deletedFile(refmodsRoot), JSON.stringify(Array.from(set), null, 2), 'utf8');
}

function slugForRefMod(file) {
  return String(file || 'subject')
    .trim()
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'subject';
}

const PACK_PREFIXES = new Set(['cb', 'changebang', 'salabin', 'mannimmate', 'photo', 'cbphoto', 'visual', 'audio', 'bundle', '2d', 'v1', 'v2']);

// Extracts only the first name (skipping pack prefixes like "cb_" or "changebang_");
// falls back to "Subject <index>" when no name is present.
function displayFirstName(name, index = 1) {
  const cleaned = String(name || '')
    .replace(/.*[\\/]/, '')
    .replace(/\.safetensors$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) return `Subject ${index}`;
  const tokens = cleaned.split(/\s+/).filter((t) => t && !/^\d+$/.test(t));
  const meaningful = tokens.find((t) => !PACK_PREFIXES.has(t.toLowerCase())) || tokens[0];
  if (!meaningful || /^\d+$/.test(meaningful)) return `Subject ${index}`;
  return meaningful.charAt(0).toUpperCase() + meaningful.slice(1).toLowerCase();
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

function inferFolder(file = '', name = '') {
  const s = `${file} ${name}`.toLowerCase();
  if (/salabin/.test(s)) return 'Stories/Salabin';
  if (/changebang|cb_|cbphoto/.test(s)) return 'Stories/Changebang';
  if (/locations?[\\/]|_location\b/.test(s)) return 'Locations';
  if (/2d|anime|cartoon|mannimmate_2d/.test(s)) return 'Styles/2D';
  if (/photo|real/.test(s)) return 'Styles/Photoreal';
  return 'General';
}

function inspectEntry(dir, fallback = {}, index = 1) {
  const meta = readMeta(dir) || {};
  const file = meta.file || fallback.file || path.basename(dir);
  const name = meta.name !== undefined ? meta.name : (fallback.name || '');
  const firstName = displayFirstName(name, index);
  const headshotPath = path.join(dir, 'headshot.jpg');
  const headshotPng = path.join(dir, 'headshot.png');
  const walkPath = path.join(dir, 'walk.mp4');
  const voiceCandidates = ['voice.wav', 'voice.mp3', 'voice.ogg', 'voice.m4a'].map((f) => path.join(dir, f));
  const resolvedVoice = voiceCandidates.find((p) => fs.existsSync(p)) || null;
  const hasHeadshot = fs.existsSync(headshotPath) || fs.existsSync(headshotPng);
  const resolvedHeadshot = fs.existsSync(headshotPath) ? headshotPath : (fs.existsSync(headshotPng) ? headshotPng : null);
  const hasWalk = fs.existsSync(walkPath);
  const isVisualOnly = /_visual$/i.test(file) || meta.hasVoice === false;
  const hasVoice = Boolean(resolvedVoice) && !isVisualOnly;
  const category = String(meta.category || '').trim() || inferCategory(file, name);
  const folder = String(meta.folder || '').trim() || inferFolder(file, name);
  return {
    file,
    name,
    firstName,
    category,
    folder,
    slug: path.basename(dir),
    dir,
    headshotPath: resolvedHeadshot,
    walkPath: hasWalk ? walkPath : null,
    voicePath: hasVoice ? resolvedVoice : null,
    hasHeadshot,
    hasWalk,
    hasVoice,
  };
}

// Ensures `<refmodsRoot>/<slug>/` exists for every discovered Mannimmate RefMod and any custom folders.
function syncRefMods(refmodsRoot, mods = []) {
  fs.mkdirSync(refmodsRoot, { recursive: true });
  const deleted = loadDeletedSlugs(refmodsRoot);
  const bySlug = new Map();

  let idx = 1;
  for (const mod of (mods || [])) {
    if (!mod || !mod.file) continue;
    const slug = slugForRefMod(mod.file);
    if (deleted.has(slug)) continue;
    const dir = path.join(refmodsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const existing = readMeta(dir);
    if (!existing) {
      writeMeta(dir, {
        file: mod.file,
        name: mod.name || '',
        firstName: displayFirstName(mod.name || '', idx),
        category: inferCategory(mod.file, mod.name || ''),
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
      if (bySlug.has(entry.name) || deleted.has(entry.name)) continue;
      const dir = path.join(refmodsRoot, entry.name);
      bySlug.set(entry.name, inspectEntry(dir, { file: entry.name, name: '' }, idx));
      idx++;
    }
  } catch { /* ignore */ }

  return Array.from(bySlug.values());
}

function setRefModFolder(refmodsRoot, { slug, folder }) {
  const cleanSlug = String(slug || '').trim();
  const cleanFolder = String(folder || '').trim() || 'General';
  if (!cleanSlug) return { ok: false, error: 'RefMod slug is required.' };
  const dir = path.join(refmodsRoot, cleanSlug);
  if (!fs.existsSync(dir)) return { ok: false, error: 'RefMod folder not found.' };
  const existing = readMeta(dir) || { file: cleanSlug, name: cleanSlug, firstName: displayFirstName(cleanSlug), slug: cleanSlug };
  const updated = { ...existing, folder: cleanFolder, updatedAt: new Date().toISOString() };
  writeMeta(dir, updated);
  return { ok: true, entry: inspectEntry(dir, updated) };
}

function setRefModCategory(refmodsRoot, { slug, category }) {
  const cleanSlug = String(slug || '').trim();
  const cleanCat = String(category || '').trim() || 'Characters';
  if (!cleanSlug) return { ok: false, error: 'RefMod slug is required.' };
  const dir = path.join(refmodsRoot, cleanSlug);
  if (!fs.existsSync(dir)) return { ok: false, error: 'RefMod folder not found.' };
  const existing = readMeta(dir) || { file: cleanSlug, name: cleanSlug, firstName: displayFirstName(cleanSlug), slug: cleanSlug };
  const updated = { ...existing, category: cleanCat, updatedAt: new Date().toISOString() };
  writeMeta(dir, updated);
  return { ok: true, entry: inspectEntry(dir, updated) };
}

function deleteRefMod(refmodsRoot, { slug }) {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug) return { ok: false, error: 'RefMod slug is required.' };
  const dir = path.join(refmodsRoot, cleanSlug);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: e.message || 'Could not remove RefMod folder.' };
  }
  const deleted = loadDeletedSlugs(refmodsRoot);
  deleted.add(cleanSlug);
  saveDeletedSlugs(refmodsRoot, deleted);
  return { ok: true, slug: cleanSlug };
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
  const isVisualOnly = /_visual$/i.test(String(mod.file || ''));
  const walkPrompt = isVisualOnly
    ? `Medium close-up studio portrait of ${subjectName} from the chest up, full head and face centered in frame with generous headroom, looking directly at the camera with a calm natural expression, subtle gentle head turn and relaxed shoulder movement, clean neutral dark studio backdrop, soft cinematic key light, sharp facial detail, locked tripod camera.`
    : `Medium close-up studio portrait of ${subjectName} from the chest up, full head and face centered in frame with generous headroom, looking directly at the camera and speaking clearly: 0.3s–2.6s: ${subjectName} says warmly, <d>[English] Hi, I'm ${subjectName}, ready for the scene.</d> Clean neutral dark studio backdrop, soft cinematic key light, sharp facial detail, locked tripod camera. overall_soundscape: Clean studio voice, zero music. non_diegetic_music: None.`;

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
      if (!isVisualOnly) {
        const voiceTarget = path.join(dir, 'voice.wav');
        await new Promise((resVoice) => {
          const ff = spawn('ffmpeg', ['-y', '-i', walkTarget, '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', voiceTarget], { windowsHide: true });
          ff.on('error', () => resVoice());
          ff.on('close', () => resVoice());
        });
      }
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

// Builds a zero-training ComfyUI-MiniMaxH3Mod graph that encodes 1-16 multi-angle set PNGs
// into a tiny (~1.5 MB) consensus Location/Background RefMod (.safetensors) in models/refmods/.
function buildLocationRefModGraph({
  name = 'set_location',
  imageNames = [],
  vaeName = 'minimax_h3_video_vae_int8_convrot.safetensors',
  mode = 'Compressed Reference',
  merge = true,
  poolH = 16,
  poolW = 16,
  refResolution = 1024,
  refinementSteps = 300,
  subfolder = 'locations',
} = {}) {
  const cleanName = slugForRefMod(name).replace(/_location$/i, '') + '_location';
  const imgs = (Array.isArray(imageNames) ? imageNames : []).filter(Boolean).slice(0, 16);
  const graph = {
    '1': { class_type: 'VAELoader', inputs: { vae_name: vaeName } },
  };
  const extractInputs = {
    name: cleanName,
    mode,
    concept_type: 'background',
    background_retention: 1.0,
    ref_resolution: Math.max(256, Math.min(2048, Number(refResolution) || 1024)),
    pool_h: Math.max(2, Math.min(64, Number(poolH) || 16)),
    pool_w: Math.max(2, Math.min(64, Number(poolW) || 16)),
    latent_frames: 1,
    identity: Math.max(0, Number(refinementSteps) || 300),
    merge: Boolean(merge),
    motion_only: false,
    multiplier: 1,
    max_tokens: 5120,
    description: '',
    save: true,
    audio_max_seconds: 30.0,
    audio_max_tokens: 5120,
    audio_budget_policy: 'truncate',
    audio_concept_type: 'voice',
    max_total_tokens: 0,
    vae: ['1', 0],
    extraction_preset: 'manual',
    subfolder: String(subfolder || '').trim(),
    budget_policy: 'truncate',
    save_layout: 'separate_files',
  };
  imgs.forEach((imgName, idx) => {
    const nodeId = String(10 + idx);
    graph[nodeId] = { class_type: 'LoadImage', inputs: { image: imgName } };
    extractInputs[`refs_image.ref_image_${idx}`] = [nodeId, 0];
  });
  graph['50'] = { class_type: 'MiniMaxH3RefModMasterExtract', inputs: extractInputs };
  return { graph, modName: cleanName, refmodFile: subfolder ? `${subfolder}/${cleanName}` : cleanName };
}

async function buildLocationRefModOnComfy({
  name = 'set_location',
  imagePaths = [],
  baseUrl = 'http://127.0.0.1:8189',
  subfolder = 'locations',
  onEvent = () => {},
} = {}) {
  const validPaths = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => p && fs.existsSync(p)).slice(0, 16);
  if (!validPaths.length) return { ok: false, error: 'At least one angle PNG is required to build a Location RefMod.' };
  const base = String(baseUrl || 'http://127.0.0.1:8189').replace(/\/+$/, '');

  try {
    const oi = await fetch(`${base}/object_info/MiniMaxH3RefModMasterExtract`, { signal: AbortSignal.timeout(6000) });
    if (!oi.ok) return { ok: false, error: `Could not reach ComfyUI (${base}) to build Location RefMod.` };
    const info = await oi.json();
    if (!info || !info.MiniMaxH3RefModMasterExtract) {
      return { ok: false, error: 'MiniMaxH3RefModMasterExtract node is not installed on this ComfyUI server.' };
    }

    onEvent({ type: 'status', message: `Uploading ${validPaths.length} angle views to ComfyUI…` });
    const uploadedNames = [];
    for (const p of validPaths) {
      const form = new FormData();
      form.append('image', new Blob([fs.readFileSync(p)], { type: 'image/png' }), path.basename(p));
      form.append('overwrite', 'true');
      const up = await fetch(`${base}/upload/image`, { method: 'POST', body: form });
      if (!up.ok) throw new Error(`Image upload failed (${up.status})`);
      const d = await up.json();
      uploadedNames.push(d.name || path.basename(p));
    }

    const { graph, modName, refmodFile } = buildLocationRefModGraph({ name, imageNames: uploadedNames, subfolder });
    onEvent({ type: 'status', message: `Encoding zero-training Location RefMod "${modName}"…` });
    const sub = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: `zaude-locref-${Date.now()}` }),
    });
    if (!sub.ok) {
      let detail = '';
      try {
        const j = await sub.json();
        detail = j?.error?.details || j?.error?.message || JSON.stringify(j).slice(0, 300);
      } catch {
        try { detail = (await sub.text()).slice(0, 300); } catch { /* ignore */ }
      }
      return { ok: false, error: `ComfyUI rejected Location RefMod graph (${sub.status})${detail ? `: ${detail}` : ''}` };
    }
    const { prompt_id: promptId } = await sub.json();

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const hr = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
      if (!hr.ok) continue;
      const hist = await hr.json();
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') {
        return { ok: false, error: `Location RefMod extraction failed: ${JSON.stringify(entry.status.messages || '').slice(0, 220)}` };
      }
      if (entry.status && entry.status.completed) {
        return { ok: true, modName, refmodFile, subfolder, viewsUsed: uploadedNames.length };
      }
    }
    return { ok: false, error: 'Timed out waiting for Location RefMod extraction.' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// General zero-training RefMod builder supporting images (1-16), optional voice audio,
// optional video refs, concept types (identity/background/style/clothing/voice), and bundle/separate save layout.
function buildRefModExtractGraph({
  name = 'custom_refmod',
  conceptType = 'identity',
  mode = 'Full Reference',
  imageNames = [],
  videoNames = [],
  audioName = '',
  videoVae = 'minimax_h3_video_vae_int8_convrot.safetensors',
  audioVae = 'minimax_h3_audio_vae_fp32.safetensors',
  refResolution = 1024,
  poolH = 16,
  poolW = 16,
  refinementSteps = 0,
  merge = false,
  saveLayout = 'bundle',
  subfolder = '',
} = {}) {
  const cleanName = slugForRefMod(name) || 'custom_refmod';
  const imgs = (Array.isArray(imageNames) ? imageNames : []).filter(Boolean).slice(0, 16);
  const vids = (Array.isArray(videoNames) ? videoNames : []).filter(Boolean).slice(0, 8);
  const hasAudio = Boolean(String(audioName || '').trim());

  const graph = {
    '1': { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
  };
  const extractInputs = {
    name: cleanName,
    mode: mode === 'Compressed Reference' ? 'Compressed Reference' : 'Full Reference',
    concept_type: String(conceptType || 'identity'),
    background_retention: 1.0,
    ref_resolution: Math.max(256, Math.min(2048, Number(refResolution) || 1024)),
    pool_h: Math.max(2, Math.min(64, Number(poolH) || 16)),
    pool_w: Math.max(2, Math.min(64, Number(poolW) || 16)),
    latent_frames: vids.length ? 16 : 1,
    identity: mode === 'Compressed Reference' ? Math.max(0, Number(refinementSteps) || 300) : 0,
    merge: Boolean(merge),
    motion_only: false,
    multiplier: 1,
    max_tokens: 5120,
    description: '',
    save: true,
    audio_max_seconds: 30.0,
    audio_max_tokens: 5120,
    audio_budget_policy: 'truncate',
    audio_concept_type: 'voice',
    max_total_tokens: 0,
    vae: ['1', 0],
    extraction_preset: 'manual',
    subfolder: String(subfolder || '').trim(),
    budget_policy: 'truncate',
    save_layout: saveLayout === 'bundle' ? 'bundle' : 'separate_files',
  };

  imgs.forEach((imgName, idx) => {
    const nodeId = String(10 + idx);
    graph[nodeId] = { class_type: 'LoadImage', inputs: { image: imgName } };
    extractInputs[`refs_image.ref_image_${idx}`] = [nodeId, 0];
  });
  vids.forEach((vidName, idx) => {
    const nodeId = String(30 + idx);
    graph[nodeId] = {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: vidName,
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 16,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };
    extractInputs[`refs_video.ref_video_${idx}`] = [nodeId, 0];
  });
  if (hasAudio) {
    graph['2'] = { class_type: 'VAELoader', inputs: { vae_name: audioVae } };
    graph['3'] = { class_type: 'LoadAudio', inputs: { audio: String(audioName).trim() } };
    extractInputs.audio = ['3', 0];
    extractInputs.audio_vae = ['2', 0];
  }

  graph['50'] = { class_type: 'MiniMaxH3RefModMasterExtract', inputs: extractInputs };
  const sub = String(subfolder || '').trim();
  return { graph, modName: cleanName, refmodFile: sub ? `${sub}/${cleanName}` : cleanName };
}

async function buildRefModOnComfy({
  refmodsRoot,
  name = 'custom_refmod',
  displayName = '',
  category = 'Characters',
  conceptType = 'identity',
  mode = 'Full Reference',
  imagePaths = [],
  videoPaths = [],
  audioPath = '',
  refResolution = 1024,
  merge = false,
  saveLayout = 'bundle',
  subfolder = '',
  baseUrl = 'http://127.0.0.1:8189',
  onEvent = () => {},
} = {}) {
  const validImgs = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => p && fs.existsSync(p)).slice(0, 16);
  const validVids = (Array.isArray(videoPaths) ? videoPaths : []).filter((p) => p && fs.existsSync(p)).slice(0, 8);
  const validAudio = audioPath && fs.existsSync(audioPath) ? audioPath : '';
  if (!validImgs.length && !validVids.length && !validAudio) {
    return { ok: false, error: 'Pick at least one reference image, video, or audio clip.' };
  }
  const base = String(baseUrl || 'http://127.0.0.1:8189').replace(/\/+$/, '');

  async function uploadFile(filePath, mime = 'application/octet-stream') {
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
    form.append('overwrite', 'true');
    const up = await fetch(`${base}/upload/image`, { method: 'POST', body: form });
    if (!up.ok) throw new Error(`Upload failed (${up.status}) for ${path.basename(filePath)}`);
    const d = await up.json();
    return d.name || path.basename(filePath);
  }

  try {
    const oi = await fetch(`${base}/object_info/MiniMaxH3RefModMasterExtract`, { signal: AbortSignal.timeout(6000) });
    if (!oi.ok) return { ok: false, error: `Could not reach ComfyUI (${base}) to build RefMod.` };
    const info = await oi.json();
    if (!info || !info.MiniMaxH3RefModMasterExtract) {
      return { ok: false, error: 'MiniMaxH3RefModMasterExtract node is not installed on this ComfyUI server.' };
    }

    onEvent({ type: 'status', message: `Uploading ${validImgs.length} image(s)${validAudio ? ' + voice audio' : ''}${validVids.length ? ` + ${validVids.length} video(s)` : ''}…` });
    const uploadedImgs = [];
    for (const p of validImgs) uploadedImgs.push(await uploadFile(p, 'image/png'));
    const uploadedVids = [];
    for (const p of validVids) uploadedVids.push(await uploadFile(p, 'video/mp4'));
    const uploadedAudio = validAudio ? await uploadFile(validAudio, 'audio/wav') : '';

    const { graph, modName, refmodFile } = buildRefModExtractGraph({
      name,
      conceptType,
      mode,
      imageNames: uploadedImgs,
      videoNames: uploadedVids,
      audioName: uploadedAudio,
      refResolution,
      merge,
      saveLayout,
      subfolder,
    });
    onEvent({ type: 'status', message: `Encoding RefMod "${modName}" on Tranklena (zero training)…` });
    const sub = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: `zaude-refmod-${Date.now()}` }),
    });
    if (!sub.ok) {
      let detail = '';
      try {
        const j = await sub.json();
        detail = j?.error?.details || j?.error?.message || JSON.stringify(j).slice(0, 300);
      } catch {
        try { detail = (await sub.text()).slice(0, 300); } catch { /* ignore */ }
      }
      return { ok: false, error: `ComfyUI rejected RefMod graph (${sub.status})${detail ? `: ${detail}` : ''}` };
    }
    const { prompt_id: promptId } = await sub.json();

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const hr = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
      if (!hr.ok) continue;
      const hist = await hr.json();
      const entry = hist && hist[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') {
        return { ok: false, error: `RefMod extraction failed: ${JSON.stringify(entry.status.messages || '').slice(0, 220)}` };
      }
      if (entry.status && entry.status.completed) {
        // Persist local Zaude RefMod folder with category & first image as immediate headshot preview
        let localEntry = null;
        if (refmodsRoot) {
          const slug = slugForRefMod(refmodFile);
          const deleted = loadDeletedSlugs(refmodsRoot);
          if (deleted.has(slug)) {
            deleted.delete(slug);
            saveDeletedSlugs(refmodsRoot, deleted);
          }
          const dir = path.join(refmodsRoot, slug);
          fs.mkdirSync(dir, { recursive: true });
          const cleanDisp = String(displayName || name || modName).trim();
          writeMeta(dir, {
            file: refmodFile,
            name: cleanDisp,
            firstName: displayFirstName(cleanDisp),
            category: String(category || inferCategory(refmodFile, cleanDisp)),
            conceptType,
            slug,
            createdAt: new Date().toISOString(),
          });
          if (validImgs[0]) {
            try { fs.copyFileSync(validImgs[0], path.join(dir, 'headshot.jpg')); } catch { /* ignore */ }
          }
          if (validAudio) {
            try {
              const ext = path.extname(validAudio).toLowerCase() || '.wav';
              fs.copyFileSync(validAudio, path.join(dir, `voice${ext}`));
            } catch { /* ignore */ }
          }
          localEntry = inspectEntry(dir);
        }
        return { ok: true, modName, refmodFile, subfolder, entry: localEntry };
      }
    }
    return { ok: false, error: 'Timed out waiting for RefMod extraction.' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  REFMOD_CATEGORIES,
  inferCategory,
  inferFolder,
  slugForRefMod,
  displayFirstName,
  syncRefMods,
  createRefModFolder,
  setRefModCategory,
  setRefModFolder,
  deleteRefMod,
  extractHeadshotFromVideo,
  generateRefModAssets,
  buildLocationRefModGraph,
  buildLocationRefModOnComfy,
  buildRefModExtractGraph,
  buildRefModOnComfy,
};
