// Unified Mannimmate AI runner for Zaude.
// Supports model routing and debug-friendly execution across:
//   - text-render (Text -> Video, native H3 FL2VA models)
//   - refmod      (RefMod -> Video, H3 Ref2VA models + character identity/voice RefMods)
//   - auto        (Video Restyle, H3 Ref2VA models + driving source video + ref image/RefMod)
//   - coverage    (Multishot Coverage, H3 Ref2VA models + single reference image -> 8 views)
// Plus live option discovery (`refmod-options --json`) and diagnostics (`doctor --json`).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildPromptFile } = require('./text-to-video.cjs');
const comfyLive = require('./comfy-live.cjs');

const MODES = ['text-render', 'refmod', 'auto', 'coverage'];

function parseJsonLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// Pure validation + CLI argument builder for all 4 Mannimmate modes.
// Returns { ok: true, mode, args, promptContent? } or { ok: false, error }.
function buildCommand(input, { promptFile = null, outDir = '' } = {}) {
  const mode = String((input && input.mode) || 'text-render').trim();
  if (!MODES.includes(mode)) {
    return { ok: false, error: `Unknown Mannimmate mode "${mode}".` };
  }

  const dryRun = Boolean(input && input.dryRun);
  const model = String((input && input.model) || '').trim();
  const lora = String((input && input.lora) || '').trim();
  const steps = input && input.steps !== '' && input.steps != null ? Number(input.steps) : null;
  const seed = input && input.seed !== '' && input.seed != null ? Number(input.seed) : null;

  if (steps !== null && (!Number.isInteger(steps) || steps < 1 || steps > 100)) {
    return { ok: false, error: 'Steps must be a whole number from 1 to 100.' };
  }

  const commonTail = () => {
    const t = [];
    if (model) t.push('--model', model);
    if (lora) t.push('--lora', lora);
    if (steps !== null) t.push('--steps', String(steps));
    if (seed !== null && Number.isFinite(seed)) t.push('--seed', String(Math.round(seed)));
    if (outDir) t.push('--out-dir', outDir);
    t.push('--gpu-wait', '30');
    if (dryRun) t.push('--dry-run');
    t.push('--json');
    return t;
  };

  if (mode === 'text-render') {
    const prompt = String((input && input.prompt) || '').trim();
    const seconds = Number((input && input.seconds) || 7);
    const quality = String((input && input.quality) || '640');
    const preset = String((input && input.preset) || 'normal');
    const aspect = input && input.aspect === '9:16' ? '9:16' : '16:9';
    const ref = String((input && input.ref) || '').trim();
    const bgImage = String((input && input.backgroundImage) || '').trim();
    if (!prompt) return { ok: false, error: 'Write a prompt describing the video.' };
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
      return { ok: false, error: 'Seconds must be between 1 and 60.' };
    }
    const args = [
      'text-render',
      '--prompt-file', promptFile || '<prompt.txt>',
      '--aspect', aspect,
      '--quality', quality,
      '--preset', preset,
      '--fps', '24',
    ];
    const effectiveRef = ref || bgImage;
    if (effectiveRef) args.push('--ref', effectiveRef);
    const finalPrompt = (!ref && bgImage)
      ? `${prompt}\nSet & Background Reference: strictly match the room, architecture, props, and lighting shown in <Picture 1>.`
      : prompt;
    args.push(...commonTail());
    return { ok: true, mode, args, promptContent: buildPromptFile(finalPrompt, Math.round(seconds)) };
  }

  if (mode === 'refmod') {
    const prompt = String((input && input.prompt) || '').trim();
    const idStrength = input && input.identityStrength != null && input.identityStrength !== '' ? Number(input.identityStrength) : 1.0;
    const voiceStrength = input && input.voiceStrength != null && input.voiceStrength !== '' ? Number(input.voiceStrength) : 1.0;
    const subMode = input && input.refmodMode === 'continue' ? 'continue' : 'generate';
    const quality = String((input && input.quality) || '640');
    const seconds = Number((input && input.seconds) || 7);
    const fps = [6, 12, 24].includes(Number(input && input.fps)) ? Number(input.fps) : 24;
    const latent = String((input && input.latent) || '').trim();
    const seedVideo = String((input && input.seedVideo) || '').trim();
    const bgRefmod = String((input && input.backgroundRefmod) || '').trim();

    // Support repeatable `refmods: [{ file, name, identityStrength?, voiceStrength? }, ...]`
    // as well as legacy `refmod` / `refmod2` fields.
    const slots = [];
    if (Array.isArray(input && input.refmods) && input.refmods.length) {
      input.refmods.forEach((r, idx) => {
        const f = String((r && r.file) || '').trim();
        if (!f) return;
        const n = String((r && r.name) || f.split(/[\\/]/).pop() || `Subject ${idx + 1}`).trim();
        const idS = r && r.identityStrength != null ? Number(r.identityStrength) : idStrength;
        const vS = r && r.voiceStrength != null ? Number(r.voiceStrength) : voiceStrength;
        slots.push(`${f}|${n}|${Math.max(0, Math.min(1, idS))}|${Math.max(0, Math.min(1, vS))}`);
      });
    } else {
      const f1 = String((input && input.refmod) || '').trim();
      if (f1) {
        const n1 = String((input && input.refmodName) || f1.split(/[\\/]/).pop() || 'Subject 1').trim();
        slots.push(`${f1}|${n1}|${Math.max(0, Math.min(1, idStrength))}|${Math.max(0, Math.min(1, voiceStrength))}`);
      }
      const f2 = String((input && input.refmod2) || '').trim();
      if (f2) {
        const n2 = String((input && input.refmod2Name) || f2.split(/[\\/]/).pop() || 'Subject 2').trim();
        const id2 = input && input.identity2Strength != null && input.identity2Strength !== '' ? Number(input.identity2Strength) : idStrength;
        const v2 = input && input.voice2Strength != null && input.voice2Strength !== '' ? Number(input.voice2Strength) : voiceStrength;
        slots.push(`${f2}|${n2}|${Math.max(0, Math.min(1, id2))}|${Math.max(0, Math.min(1, v2))}`);
      }
    }

    let finalPrompt = prompt;
    if (bgRefmod) {
      const bgSlotNum = slots.length + 1;
      slots.push(`${bgRefmod}|Background Set|1.0|0.0`);
      if (finalPrompt) {
        finalPrompt = `${finalPrompt}\nSet & Background Reference: strictly match the exact room, architecture, props, and lighting of <Subject ${bgSlotNum}> (Background Set).`;
      }
    }

    if (!slots.length && subMode !== 'continue') {
      return { ok: false, error: 'Pick at least one RefMod character from the grid.' };
    }
    if (subMode === 'continue' && !latent && !seedVideo) {
      return { ok: false, error: 'Continue mode needs a saved latent or a seed video clip.' };
    }
    if (!prompt) return { ok: false, error: 'Write a scene prompt for the RefMod clip.' };
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) {
      return { ok: false, error: 'Seconds must be between 1 and 30.' };
    }
    const args = ['refmod', '--mode', subMode];
    for (const slot of slots) args.push('--refmod', slot);
    args.push(
      '--prompt', finalPrompt,
      '--quality', quality,
      '--seconds', String(seconds),
      '--fps', String(fps),
      '--save-latent',
    );
    if (subMode === 'continue') {
      if (latent) args.push('--latent', latent);
      else if (seedVideo) args.push('--seed-video', seedVideo, '--tail-seconds', '2.0');
    }
    args.push(...commonTail());
    return { ok: true, mode, args };
  }

  if (mode === 'auto' || mode === 'stylize') {
    const video = String((input && input.video) || '').trim();
    const ref = String((input && input.ref) || '').trim();
    const start = Number((input && input.start) ?? 0);
    const end = Number((input && input.end) ?? 7);
    const quality = String((input && input.quality) || '480');
    const preset = String((input && input.preset) || 'draft');
    const action = ['replace', 'background', 'object', 'both'].includes(input && input.stylizeAction)
      ? input.stylizeAction
      : ((input && input.objectPrompt) ? ((input && (input.refmod || (input.refmods && input.refmods.length))) ? 'both' : 'object') : 'replace');
    const objectPrompt = String((input && input.objectPrompt) || '').trim();
    const bgImage = String((input && input.backgroundImage) || '').trim();
    const bgRefmod = String((input && input.backgroundRefmod) || '').trim();
    const bgMode = ['keep', 'sheet', 'scene', 'image'].includes(input && input.backgroundMode) ? input.backgroundMode : 'keep';

    // Collect repeatable RefMods (supports both `refmods: [...]` and single `refmod`)
    const rmList = [];
    if (Array.isArray(input && input.refmods) && input.refmods.length) {
      input.refmods.forEach((r, idx) => {
        const f = String((r && r.file) || '').trim();
        if (!f) return;
        const n = String((r && r.name) || f.split(/[\\/]/).pop() || `Subject ${idx + 1}`).trim();
        rmList.push({ file: f, name: n });
      });
    } else if (input && input.refmod) {
      const f = String(input.refmod).trim();
      const n = String(input.refmodName || f.split(/[\\/]/).pop() || 'Subject 1').trim();
      rmList.push({ file: f, name: n });
    }

    if (!video) return { ok: false, error: 'Pick a source video (or click "Pick from Timeline").' };
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { ok: false, error: 'End time must be greater than Start time.' };
    }
    if ((action === 'replace' || action === 'both') && !rmList.length && !ref) {
      return { ok: false, error: 'Select a RefMod character (or reference image) to replace the character.' };
    }
    if ((action === 'object' || action === 'both') && !objectPrompt && !ref) {
      return { ok: false, error: 'Describe the object or scene change you want to add.' };
    }
    if (action === 'background' && !objectPrompt && !ref && !bgImage && !bgRefmod) {
      return { ok: false, error: 'Describe the new background environment or pick a Background Picture / RefMod.' };
    }

    // Build a clean unified RV2V prompt file for `mannimmate_cli.py render` so character replacement,
    // background swaps, and object/scene insertion work cleanly.
    const promptLines = [];
    if (rmList.length && (action === 'replace' || action === 'both')) {
      promptLines.push('subject_definitions:');
      rmList.forEach((r, i) => {
        promptLines.push(`<Subject ${i + 1}> is ${r.name}, using the stable identity, face, hair, and clothing of <Subject ${i + 1}>'s reference.`);
      });
      promptLines.push('');
    }
    const parts = [];
    if (action === 'background') {
      parts.push('Edit <Video 1> frame by frame: strictly preserve the original performer from <Video 1> including their exact face, hair, clothing, body proportions, choreography, poses, timing, and camera trajectory.');
      parts.push(`Replace ONLY the background and surrounding environment with: ${objectPrompt || 'the environment and backdrop shown in <Picture 1>'}. Match rim lighting, ambient color bounce, and grounded floor contact shadows onto the performer so they blend seamlessly into the new location.`);
    } else {
      parts.push('Edit <Video 1> frame by frame: preserve the camera framing, lighting, room/background, and exact choreography, poses, and timing of <Video 1>.');
      if (action === 'replace' || action === 'both') {
        const subjectNames = rmList.length
          ? rmList.map((r, i) => `<Subject ${i + 1}> (${r.name})`).join(' and ')
          : '<Picture 1>';
        parts.push(`Replace the original performer completely with ${subjectNames}, keeping their exact face, hair, and clothing; the original performer of <Video 1> does not appear.`);
      }
      if (action === 'object' || action === 'both') {
        parts.push(`ALSO add and animate in the scene: ${objectPrompt || 'the added element from the reference image'}. Keep the added element naturally lit, physically grounded, and casting realistic shadows throughout the clip.`);
      }
      if (bgMode === 'sheet') {
        parts.push('Adopt the visual style and backdrop of the reference.');
      }
    }
    promptLines.push(parts.join(' '));
    const promptContent = promptLines.join('\n') + '\n';

    const args = [
      'render',
      '--video', video,
      '--start', String(start),
      '--end', String(end),
      '--quality', quality,
      '--preset', preset,
      '--prompt-file', promptFile || '<stylize_prompt.txt>',
    ];
    if (action === 'replace' || action === 'both') {
      for (const r of rmList) {
        args.push('--refmod', `${r.file}|${r.name}|1.0|0.0`);
      }
    }
    if (bgRefmod) {
      args.push('--refmod', `${bgRefmod}|Background Set|1.0|0.0`);
    }
    if (bgImage) {
      args.push('--background', bgImage);
      if (objectPrompt) args.push('--background-text', objectPrompt);
    }
    if (ref) {
      args.push('--ref', ref);
      if ((action === 'object' || action === 'both') && objectPrompt) {
        args.push('--subject', objectPrompt);
      }
    }
    args.push(...commonTail());
    return { ok: true, mode: 'auto', args, promptContent };
  }

  // coverage
  const image = String((input && input.image) || '').trim();
  const target = String((input && input.coverageTarget) || '').trim();
  if (!image) return { ok: false, error: 'Pick a scene reference image for Coverage.' };
  const args = ['coverage', '--image', image];
  if (target) args.push('--coverage-target', target);
  args.push(...commonTail());
  return { ok: true, mode, args };
}

function runCliJson({ mannimmateDir, python, cliArgs, timeoutMs = 20000 }) {
  const cliPath = path.join(mannimmateDir, 'mannimmate_cli.py');
  if (!fs.existsSync(cliPath)) {
    return Promise.resolve({ ok: false, error: `mannimmate_cli.py not found in ${mannimmateDir}` });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python || 'python3', [cliPath, ...cliArgs], { cwd: mannimmateDir, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start Python: ' + e.message });
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish({ ok: false, error: 'Mannimmate timed out.', stdout: out, stderr: err });
    }, timeoutMs);

    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const obj = parseJsonLine(lines[i]);
        if (obj) { parsed = obj; break; }
      }
      if (parsed) return finish({ ok: code === 0, code, data: parsed, stdout: out, stderr: err });
      finish({ ok: code === 0, code, error: err.trim() || out.trim() || `Exited with code ${code}`, stdout: out, stderr: err });
    });
  });
}

function fetchOptions({ mannimmateDir, python }) {
  return runCliJson({ mannimmateDir, python, cliArgs: ['refmod-options', '--json'], timeoutMs: 20000 });
}

function runDoctor({ mannimmateDir, python }) {
  return runCliJson({ mannimmateDir, python, cliArgs: ['doctor', '--json'], timeoutMs: 20000 });
}

// Estimates job duration in seconds (RTX 3090 baseline: ~55s/step at 640p, ~28s/step at 480p).
function estimateJobSeconds(request) {
  if (request && request.dryRun) return 5;
  const steps = Math.max(1, Number(request && request.steps) || 6);
  const q = Number(request && request.quality) || 640;
  const secs = Math.max(1, Number(request && request.seconds) || 7);
  const perStep = q >= 640 ? 55 : q >= 480 ? 28 : 16;
  const lenFactor = Math.max(0.5, secs / 7);
  return Math.round(steps * perStep * lenFactor);
}

// Extracts a preview frame JPG from a chunk/output video for live timeline preview.
function extractPreviewFrame(videoPath, outJpg, ffmpeg = 'ffmpeg') {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(outJpg), { recursive: true });
      const child = spawn(ffmpeg, [
        '-y', '-v', 'error',
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=480:-2',
        '-q:v', '4',
        outJpg,
      ], { windowsHide: true });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 && fs.existsSync(outJpg) ? outJpg : null));
    } catch {
      resolve(null);
    }
  });
}

// Runs a Mannimmate job and streams full debug output (cmd, stdout, stderr, JSON events, step previews, ETA, exit code).
function runJob({ mannimmateDir, python, request, promptDir, previewDir, jobId = '', outDir, onEvent }) {
  const cliPath = path.join(mannimmateDir, 'mannimmate_cli.py');
  if (!fs.existsSync(cliPath)) {
    return {
      promise: Promise.resolve({ ok: false, error: `mannimmate_cli.py not found in ${mannimmateDir}` }),
      cancel: () => {},
    };
  }

  fs.mkdirSync(promptDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const promptFile = path.join(promptDir, `job-${Date.now()}.txt`);
  const built = buildCommand(request, { promptFile, outDir });
  if (!built.ok) {
    return { promise: Promise.resolve(built), cancel: () => {} };
  }
  if (built.promptContent) {
    fs.writeFileSync(promptFile, built.promptContent, 'utf8');
  }

  const py = python || 'python3';
  const fullArgs = [cliPath, ...built.args];
  const cmdStr = [py, ...fullArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
  onEvent({ type: 'cmd', cmd: cmdStr, mode: built.mode });

  let child;
  try {
    child = spawn(py, fullArgs, { cwd: mannimmateDir, windowsHide: true });
  } catch (e) {
    return {
      promise: Promise.resolve({ ok: false, error: 'Could not start Python: ' + e.message }),
      cancel: () => {},
    };
  }

  const startedAt = Date.now();
  const baseEstSec = estimateJobSeconds(request);
  let totalSteps = Math.max(1, Number(request && request.steps) || 6);
  let lastStep = 0;
  let activePromptId = null;
  let savedPath = null;
  let savedLatent = null;
  let cancelled = false;
  let outBuf = '';
  let stderrTail = [];

  const calcEta = (prog) => {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (typeof prog === 'number' && prog > 0.04 && prog < 1) {
      return Math.max(1, Math.round((elapsed / prog) * (1 - prog)));
    }
    return Math.max(1, Math.round(baseEstSec - elapsed));
  };

  // Connect to ComfyUI's live WebSocket so every denoising step streams its preview image & progress
  const comfyWatcher = !(request && request.dryRun)
    ? comfyLive.watchComfyJob({
        previewDir,
        jobId,
        onStep: ({ step, totalSteps: ts, progress }) => {
          if (ts > 0) totalSteps = ts;
          if (step > lastStep) lastStep = step;
          onEvent({
            type: 'progress',
            progress,
            step: lastStep,
            totalSteps,
            etaSec: calcEta(progress),
            label: `Step ${lastStep}/${totalSteps} (denoising…)`,
          });
        },
        onPreview: ({ previewPath, step, totalSteps: ts }) => {
          if (ts > 0) totalSteps = ts;
          if (step > lastStep) lastStep = step;
          const prog = totalSteps > 0 ? Math.min(0.99, lastStep / totalSteps) : null;
          onEvent({
            type: 'preview',
            previewPath,
            step: Math.max(1, lastStep),
            totalSteps,
            progress: prog,
            etaSec: calcEta(prog),
          });
        },
      })
    : { setPromptId() {}, close() {} };

  const handleStdoutLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    onEvent({ type: 'stdout', text: trimmed });
    const ev = parseJsonLine(trimmed);
    if (!ev) return;

    if (ev.prompt_id && typeof ev.prompt_id === 'string') {
      activePromptId = ev.prompt_id;
      comfyWatcher.setPromptId(ev.prompt_id);
    }

    const p = ev.path || ev.output || ev.video || ev.contact_sheet || null;
    if ((ev.event === 'saved' || ev.event === 'done' || ev.event === 'refmod_saved' || ev.event === 'coverage_saved') && p) {
      savedPath = p;
    }
    if (ev.saved_latent && typeof ev.saved_latent === 'string') {
      savedLatent = ev.saved_latent;
    } else if (ev.latent && typeof ev.latent === 'string') {
      savedLatent = ev.latent;
    } else if (ev.latent_file && typeof ev.latent_file === 'string') {
      savedLatent = ev.latent_file;
    }

    // Track step progress (either explicit `step` or inferred from `progress`)
    let prog = typeof ev.progress === 'number' ? Math.max(0, Math.min(1, ev.progress)) : null;
    let step = Number.isFinite(Number(ev.step)) ? Number(ev.step) : null;
    const evTotal = Number.isFinite(Number(ev.total_steps || ev.steps)) ? Number(ev.total_steps || ev.steps) : totalSteps;
    if (step === null && prog !== null && evTotal > 0) {
      step = Math.min(evTotal, Math.floor(prog * evTotal));
    }
    if (prog === null && step !== null && evTotal > 0) {
      prog = Math.max(0, Math.min(1, step / evTotal));
    }
    if (step !== null && step > lastStep) lastStep = step;

    const etaSec = calcEta(prog);

    // Emit live preview image whenever Mannimmate/ComfyUI reports a preview image or a saved intermediate chunk
    const directPreview = ev.preview_path || ev.preview || ev.frame_path || null;
    if (directPreview && typeof directPreview === 'string' && fs.existsSync(directPreview)) {
      onEvent({ type: 'preview', previewPath: directPreview, step: lastStep, totalSteps: evTotal, progress: prog, etaSec });
    } else if ((ev.event === 'clip_saved' || ev.event === 'chunk_saved') && p && fs.existsSync(p) && previewDir) {
      const outJpg = path.join(previewDir, `preview-${jobId || Date.now()}.jpg`);
      extractPreviewFrame(p, outJpg).then((jpg) => {
        if (jpg) onEvent({ type: 'preview', previewPath: jpg, step: Math.max(1, lastStep), totalSteps: evTotal, progress: prog, etaSec: calcEta(prog) });
      });
    }

    if (prog !== null || ev.event) {
      onEvent({
        type: 'progress',
        progress: prog,
        step: lastStep,
        totalSteps: evTotal,
        etaSec,
        label: ev.label || ev.stage || ev.message || (lastStep >= 1 ? `Step ${lastStep}/${evTotal}` : `${ev.event || 'Working'}…`),
      });
    }
  };

  child.stdout.on('data', (chunk) => {
    outBuf += String(chunk);
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      handleStdoutLine(outBuf.slice(0, idx));
      outBuf = outBuf.slice(idx + 1);
    }
  });

  child.stderr.on('data', (chunk) => {
    const lines = String(chunk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      stderrTail.push(l);
      onEvent({ type: 'stderr', text: l });
    }
    stderrTail = stderrTail.slice(-20);
  });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => {
      comfyWatcher.close();
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      comfyWatcher.close();
      if (outBuf.trim()) handleStdoutLine(outBuf);
      if (cancelled) return resolve({ ok: false, cancelled: true, code, error: 'Cancelled' });
      if (code === 0) {
        if (!savedLatent && savedPath) {
          const fromSidecar = require('./latents.cjs').findClipLatent(savedPath);
          if (fromSidecar && fromSidecar.latent) savedLatent = fromSidecar.latent;
        }
        // When continuing from --seed-video (no saved H3 latent), Mannimmate stitches the entire
        // original source clip onto the front of the output MP4. Trim off the prepended source
        // duration so Zaude only inserts the brand-new continuation segment onto the timeline.
        const usedSeedVideo = Boolean(
          request && request.mode === 'refmod' && request.refmodMode === 'continue'
          && !request.latent && request.seedVideo && !request.dryRun && savedPath && fs.existsSync(savedPath)
        );
        if (usedSeedVideo && fs.existsSync(request.seedVideo)) {
          try {
            const probeDur = (p) => {
              const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8', timeout: 8000, windowsHide: true });
              return Number(String(r.stdout || '').trim()) || 0;
            };
            const srcDur = probeDur(request.seedVideo);
            const outDur = probeDur(savedPath);
            if (srcDur > 0.5 && outDur > srcDur + 0.5) {
              const parsed = path.parse(savedPath);
              const trimmedPath = path.join(parsed.dir, `${parsed.name}_next.mp4`);
              const trimRes = spawnSync('ffmpeg', [
                '-y', '-ss', srcDur.toFixed(3), '-i', savedPath,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
                trimmedPath,
              ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
              if (trimRes.status === 0 && fs.existsSync(trimmedPath) && fs.statSync(trimmedPath).size > 1024) {
                const origSidecar = path.join(parsed.dir, `${parsed.name}.json`);
                const nextSidecar = path.join(parsed.dir, `${parsed.name}_next.json`);
                if (fs.existsSync(origSidecar)) {
                  try { fs.copyFileSync(origSidecar, nextSidecar); } catch { /* ignore */ }
                }
                savedPath = trimmedPath;
              }
            }
          } catch { /* keep stitched output if trim fails */ }
        }
        return resolve({ ok: true, code, path: savedPath, latent: savedLatent, dryRun: Boolean(request && request.dryRun) });
      }
      const errMsg = stderrTail[stderrTail.length - 1] || `Mannimmate exited with code ${code}`;
      resolve({ ok: false, code, error: errMsg });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      comfyWatcher.close();
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (!(request && request.dryRun)) {
        comfyLive.cancelComfyPrompt({ promptId: activePromptId }).catch(() => {});
      }
    },
  };
}

module.exports = { MODES, buildCommand, estimateJobSeconds, fetchOptions, runDoctor, runJob };
