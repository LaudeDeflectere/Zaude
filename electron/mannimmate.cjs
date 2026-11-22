// Unified Mannimmate AI runner for Zaude.
// Supports model routing and debug-friendly execution across:
//   - text-render (Text -> Video, native H3 FL2VA models)
//   - refmod      (RefMod -> Video, H3 Ref2VA models + character identity/voice RefMods)
//   - auto        (Video Restyle, H3 Ref2VA models + driving source video + ref image/RefMod)
//   - coverage    (Multishot Coverage, H3 Ref2VA models + single reference image -> 8 views)
// Plus live option discovery (`refmod-options --json`) and diagnostics (`doctor --json`).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildPromptFile } = require('./text-to-video.cjs');

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
    const seconds = Number((input && input.seconds) || 4);
    const quality = String((input && input.quality) || '480');
    const preset = String((input && input.preset) || 'normal');
    const aspect = input && input.aspect === '9:16' ? '9:16' : '16:9';
    const ref = String((input && input.ref) || '').trim();
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
    if (ref) args.push('--ref', ref);
    args.push(...commonTail());
    return { ok: true, mode, args, promptContent: buildPromptFile(prompt, Math.round(seconds)) };
  }

  if (mode === 'refmod') {
    const prompt = String((input && input.prompt) || '').trim();
    const refmodFile = String((input && input.refmod) || '').trim();
    const refmodName = String((input && input.refmodName) || refmodFile.split(/[\\/]/).pop() || 'Subject').trim();
    const idStrength = input && input.identityStrength != null && input.identityStrength !== '' ? Number(input.identityStrength) : 1.0;
    const voiceStrength = input && input.voiceStrength != null && input.voiceStrength !== '' ? Number(input.voiceStrength) : 1.0;
    const subMode = input && input.refmodMode === 'continue' ? 'continue' : 'generate';
    const quality = String((input && input.quality) || '480');
    const seconds = Number((input && input.seconds) || 5);
    const fps = [6, 12, 24].includes(Number(input && input.fps)) ? Number(input.fps) : 24;
    const latent = String((input && input.latent) || '').trim();

    if (!refmodFile) return { ok: false, error: 'Pick a RefMod character from the list.' };
    if (!prompt) return { ok: false, error: 'Write a scene prompt for the RefMod clip.' };
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) {
      return { ok: false, error: 'Seconds must be between 1 and 30.' };
    }
    const slot = `${refmodFile}|${refmodName}|${Math.max(0, Math.min(1, idStrength))}|${Math.max(0, Math.min(1, voiceStrength))}`;
    const args = [
      'refmod',
      '--mode', subMode,
      '--refmod', slot,
      '--prompt', prompt,
      '--quality', quality,
      '--seconds', String(seconds),
      '--fps', String(fps),
      '--save-latent',
    ];
    if (subMode === 'continue' && latent) args.push('--latent', latent);
    args.push(...commonTail());
    return { ok: true, mode, args };
  }

  if (mode === 'auto') {
    const video = String((input && input.video) || '').trim();
    const ref = String((input && input.ref) || '').trim();
    const refmodFile = String((input && input.refmod) || '').trim();
    const refmodName = String((input && input.refmodName) || refmodFile.split(/[\\/]/).pop() || 'Subject').trim();
    const start = Number((input && input.start) ?? 0);
    const end = Number((input && input.end) ?? 5);
    const quality = String((input && input.quality) || '480');
    const preset = String((input && input.preset) || 'normal');
    const bgMode = ['keep', 'sheet', 'scene', 'image'].includes(input && input.backgroundMode) ? input.backgroundMode : 'keep';

    if (!video) return { ok: false, error: 'Pick a source driving video.' };
    if (!ref && !refmodFile) return { ok: false, error: 'Provide either a reference image or a RefMod.' };
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { ok: false, error: 'End time must be greater than Start time.' };
    }
    const args = [
      'auto',
      '--video', video,
      '--start', String(start),
      '--end', String(end),
      '--quality', quality,
      '--preset', preset,
      '--background-mode', bgMode,
    ];
    if (ref) args.push('--ref', ref);
    if (refmodFile) args.push('--refmod', `${refmodFile}|${refmodName}|1.0|1.0`);
    args.push(...commonTail());
    return { ok: true, mode, args };
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

// Runs a Mannimmate job and streams full debug output (cmd, stdout, stderr, JSON events, exit code).
function runJob({ mannimmateDir, python, request, promptDir, outDir, onEvent }) {
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

  let savedPath = null;
  let cancelled = false;
  let outBuf = '';
  let stderrTail = [];

  const handleStdoutLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    onEvent({ type: 'stdout', text: trimmed });
    const ev = parseJsonLine(trimmed);
    if (!ev) return;
    const p = ev.path || ev.output || ev.video || ev.contact_sheet || null;
    if ((ev.event === 'saved' || ev.event === 'done' || ev.event === 'refmod_saved' || ev.event === 'coverage_saved') && p) {
      savedPath = p;
    }
    if (typeof ev.progress === 'number') {
      onEvent({ type: 'progress', progress: Math.max(0, Math.min(1, ev.progress)), label: ev.label || ev.stage || ev.event || 'Working…' });
    } else if (ev.event) {
      onEvent({ type: 'progress', progress: null, label: ev.label || ev.message || `${ev.event}…` });
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
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (outBuf.trim()) handleStdoutLine(outBuf);
      if (cancelled) return resolve({ ok: false, cancelled: true, code, error: 'Cancelled' });
      if (code === 0) {
        return resolve({ ok: true, code, path: savedPath, dryRun: Boolean(request && request.dryRun) });
      }
      const errMsg = stderrTail[stderrTail.length - 1] || `Mannimmate exited with code ${code}`;
      resolve({ ok: false, code, error: errMsg });
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

module.exports = { MODES, buildCommand, fetchOptions, runDoctor, runJob };
