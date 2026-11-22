// Interactive Mannimmate AI Studio popup for Zaude.
// Supports Text->Video (FL2VA), RefMod->Video (Ref2VA), Video Restyle (auto), and Multishot Coverage,
// with automatic model routing and a live debug console (command preview, stdout, stderr, dry-run, doctor).

const api = window.zaudeAI || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let jobId = null;
let running = false;
let currentMode = 'text-render';
let cachedOptions = {
  mods: [],
  models: [],
  text_models: [],
  loras: [],
  latents: [],
  default_model: '',
  default_lora: '',
};
const logLines = [];

function appendLog(prefix, text) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  logLines.push(`[${stamp}] ${prefix} ${text}`);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  const el = $('ai-debug-log');
  if (el) {
    el.textContent = logLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }
}

function setStatus(text, isError = false) {
  const el = $('t2v-status');
  el.textContent = text;
  el.className = 't2v-status' + (isError ? ' err' : '');
}

function setRunning(on) {
  running = on;
  $('t2v-generate').disabled = on;
  $('t2v-cancel').disabled = !on;
  $('ai-refresh').disabled = on;
  $('ai-doctor').disabled = on;
  $('ai-mode-tabs').querySelectorAll('button').forEach((b) => { b.disabled = on; });
  if (!on) $('t2v-progress').hidden = true;
}

function showProgress(progress) {
  const wrap = $('t2v-progress');
  wrap.hidden = false;
  if (typeof progress === 'number') {
    wrap.classList.remove('indeterminate');
    $('t2v-bar').style.width = Math.round(progress * 100) + '%';
  } else {
    wrap.classList.add('indeterminate');
  }
}

function showResult(path, dryRun) {
  if (dryRun) {
    $('t2v-result').innerHTML = `<div class="muted">Dry run completed cleanly (no GPU job submitted). Check Debug Console for manifest/graph details.</div>`;
    return;
  }
  if (!path) {
    $('t2v-result').innerHTML = `<div class="muted">Finished. Check Debug Console for output path.</div>`;
    return;
  }
  $('t2v-result').innerHTML = `
    <div>Saved clip:</div>
    <code>${esc(path)}</code>
    <div><button type="button" data-reveal="${esc(path)}">Show in folder</button></div>`;
}

function clearResult() {
  $('t2v-result').innerHTML = '';
}

function populateSelect(sel, items, { emptyLabel = 'Auto (Mannimmate default)', defaultVal = '', mapItem } = {}) {
  if (!sel) return;
  const prev = sel.value;
  const opts = [`<option value="">${esc(emptyLabel)}</option>`];
  for (const item of (items || [])) {
    const { value, label } = mapItem ? mapItem(item) : { value: String(item), label: String(item) };
    opts.push(`<option value="${esc(value)}">${esc(label)}</option>`);
  }
  sel.innerHTML = opts.join('');
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (defaultVal && Array.from(sel.options).some((o) => o.value === defaultVal)) {
    sel.value = defaultVal;
  }
}

function updateModelRouting() {
  const isText = currentMode === 'text-render';
  const badge = $('ai-route-badge');
  const routeModels = isText ? cachedOptions.text_models : cachedOptions.models;
  const routeFamily = isText ? 'FL2VA (text-to-video)' : 'Ref2VA (identity/reference video)';
  badge.textContent = `Route: mannimmate_cli.py ${currentMode} · ${routeFamily} (${routeModels.length} model${routeModels.length === 1 ? '' : 's'})`;

  populateSelect($('ai-model-select'), routeModels, {
    emptyLabel: isText ? 'Auto FL2VA default' : (cachedOptions.default_model ? `Default (${cachedOptions.default_model.split(/[\\/]/).pop()})` : 'Auto Ref2VA default'),
    defaultVal: isText ? '' : (cachedOptions.default_model || ''),
  });

  // Filter LoRAs lightly by mode relevance while keeping all accessible
  const loras = cachedOptions.loras || [];
  populateSelect($('ai-lora-select'), loras, {
    emptyLabel: 'Auto / None',
    defaultVal: isText ? '' : (cachedOptions.default_lora || ''),
  });

  populateSelect($('ai-refmod-select'), cachedOptions.mods || [], {
    emptyLabel: cachedOptions.mods.length ? '— Pick a RefMod character —' : '— No RefMods loaded (click ↻ Models) —',
    mapItem: (m) => ({ value: m.file, label: `${m.name} (${m.file})` }),
  });

  populateSelect($('ai-latent-select'), (cachedOptions.latents || []).slice(0, 60), {
    emptyLabel: '— Auto / latest latent —',
  });
}

function applyModeVisibility() {
  const form = $('t2v-form');
  $('ai-mode-tabs').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.aiMode === currentMode);
  });
  form.querySelectorAll('[data-modes]').forEach((el) => {
    const allowed = el.dataset.modes.split(',');
    el.hidden = !allowed.includes(currentMode);
  });
  const refmodMode = form.elements.refmodMode ? form.elements.refmodMode.value : 'generate';
  const latentWrap = $('ai-latent-wrap');
  if (latentWrap) latentWrap.hidden = !(currentMode === 'refmod' && refmodMode === 'continue');
  updateModelRouting();
  updateCommandPreview();
}

function collectRequest() {
  const form = $('t2v-form');
  const fd = new FormData(form);
  const refmodSel = $('ai-refmod-select');
  const refmodFile = String(fd.get('refmod') || '').trim();
  const matchedMod = (cachedOptions.mods || []).find((m) => m.file === refmodFile);
  return {
    mode: currentMode,
    mannimmateDir: String(fd.get('mannimmateDir') || '').trim(),
    prompt: String(fd.get('prompt') || '').trim(),
    seconds: Number(fd.get('seconds') || 4),
    quality: String(fd.get('resolution') || '480'),
    preset: String(fd.get('quality') || 'normal'),
    aspect: String(fd.get('aspect') || '16:9'),
    fps: Number(fd.get('fps') || 24),
    steps: fd.get('steps') !== '' ? Number(fd.get('steps')) : null,
    seed: fd.get('seed') !== '' ? Number(fd.get('seed')) : null,
    model: String(fd.get('model') || '').trim(),
    lora: String(fd.get('lora') || '').trim(),
    ref: String(fd.get('ref') || '').trim(),
    refmod: refmodFile,
    refmodName: matchedMod ? matchedMod.name : (refmodSel && refmodSel.selectedOptions[0] ? refmodSel.selectedOptions[0].textContent : ''),
    refmodMode: String(fd.get('refmodMode') || 'generate'),
    identityStrength: fd.get('identityStrength') !== '' ? Number(fd.get('identityStrength')) : 1.0,
    voiceStrength: fd.get('voiceStrength') !== '' ? Number(fd.get('voiceStrength')) : 1.0,
    latent: String(fd.get('latent') || '').trim(),
    video: String(fd.get('video') || '').trim(),
    start: Number(fd.get('start') ?? 0),
    end: Number(fd.get('end') ?? 5),
    backgroundMode: String(fd.get('backgroundMode') || 'keep'),
    image: String(fd.get('image') || '').trim(),
    coverageTarget: String(fd.get('coverageTarget') || '').trim(),
    dryRun: Boolean($('ai-dry-run') && $('ai-dry-run').checked),
  };
}

function updateCommandPreview() {
  const req = collectRequest();
  const parts = ['python3', 'mannimmate_cli.py', req.mode];
  if (req.mode === 'text-render') {
    parts.push('--prompt-file', '<prompt.txt>', '--aspect', req.aspect, '--quality', req.quality, '--preset', req.preset, '--fps', '24');
    if (req.ref) parts.push('--ref', req.ref);
  } else if (req.mode === 'refmod') {
    parts.push('--mode', req.refmodMode, '--refmod', `"${req.refmod || '<refmod>'}|${req.refmodName || 'Subject'}|${req.identityStrength}|${req.voiceStrength}"`, '--quality', req.quality, '--seconds', String(req.seconds), '--fps', String(req.fps), '--save-latent');
    if (req.refmodMode === 'continue' && req.latent) parts.push('--latent', req.latent);
  } else if (req.mode === 'auto') {
    parts.push('--video', req.video || '<video>', '--start', String(req.start), '--end', String(req.end), '--quality', req.quality, '--preset', req.preset, '--background-mode', req.backgroundMode);
    if (req.ref) parts.push('--ref', req.ref);
    if (req.refmod) parts.push('--refmod', `"${req.refmod}|${req.refmodName}|1.0|1.0"`);
  } else if (req.mode === 'coverage') {
    parts.push('--image', req.image || '<image>');
    if (req.coverageTarget) parts.push('--coverage-target', `"${req.coverageTarget}"`);
  }
  if (req.model) parts.push('--model', req.model);
  if (req.lora) parts.push('--lora', req.lora);
  if (req.steps) parts.push('--steps', String(req.steps));
  if (req.seed != null) parts.push('--seed', String(req.seed));
  if (req.dryRun) parts.push('--dry-run');
  parts.push('--json');
  const el = $('ai-cmd-preview');
  if (el) el.textContent = parts.join(' ');
}

async function loadOptions() {
  if (!api || !api.mannimmateOptions) return;
  const dir = $('t2v-form').elements.mannimmateDir.value.trim();
  setStatus('Loading Mannimmate models & RefMods…');
  appendLog('INFO', 'Running mannimmate_cli.py refmod-options --json…');
  const res = await api.mannimmateOptions(dir);
  if (!res || !res.ok || !res.data) {
    const err = (res && res.error) || 'Could not query Mannimmate options';
    setStatus(err, true);
    appendLog('ERR', err);
    return;
  }
  cachedOptions = {
    mods: res.data.mods || [],
    models: res.data.models || [],
    text_models: res.data.text_models || [],
    loras: res.data.loras || [],
    latents: res.data.latents || [],
    default_model: res.data.default_model || '',
    default_lora: res.data.default_lora || '',
  };
  updateModelRouting();
  updateCommandPreview();
  const msg = `Loaded ${cachedOptions.mods.length} RefMods, ${cachedOptions.models.length} Ref2VA models, ${cachedOptions.text_models.length} FL2VA models, ${cachedOptions.loras.length} LoRAs.`;
  setStatus(msg);
  appendLog('OK', msg);
}

async function runDoctor() {
  if (!api || !api.mannimmateDoctor) return;
  const dir = $('t2v-form').elements.mannimmateDir.value.trim();
  setStatus('Running Mannimmate doctor…');
  appendLog('INFO', 'Running mannimmate_cli.py doctor --json…');
  const res = await api.mannimmateDoctor(dir);
  if (res && res.data) {
    appendLog('DOCTOR', JSON.stringify(res.data, null, 2));
    setStatus(res.ok ? 'Doctor check passed (see Debug Console).' : 'Doctor reported issues (see Debug Console).', !res.ok);
  } else {
    const err = (res && res.error) || 'Doctor failed';
    appendLog('ERR', err);
    setStatus(err, true);
  }
}

async function open() {
  $('t2v-dialog').hidden = false;
  setStatus('');
  clearResult();
  try {
    const settings = await api.getSettings();
    $('t2v-form').elements.mannimmateDir.value = settings.mannimmateDir;
  } catch (err) {
    setStatus('Could not read settings: ' + err.message, true);
  }
  applyModeVisibility();
  if (!cachedOptions.models.length && !cachedOptions.mods.length) {
    loadOptions();
  }
}

function close() {
  $('t2v-dialog').hidden = true;
}

async function onSubmit() {
  if (running) return;
  const req = collectRequest();
  if (req.mannimmateDir) await api.setSettings({ mannimmateDir: req.mannimmateDir });

  const result = await api.mannimmateStart(req);
  if (!result || !result.ok) {
    const err = (result && result.error) || 'Could not start Mannimmate job.';
    setStatus(err, true);
    appendLog('ERR', err);
    return;
  }
  jobId = result.id;
  if (!req.dryRun && (req.mode === 'text-render' || req.mode === 'refmod')) {
    notifyEditor({ type: 'start', id: result.id, seconds: Number(req.seconds) || 4 });
  }
  clearResult();
  setRunning(true);
  showProgress(null);
  setStatus(`Running Mannimmate (${req.mode}${req.dryRun ? ' · dry-run' : ''})…`);
}

function notifyEditor(detail) {
  window.dispatchEvent(new CustomEvent('zaude:t2v', { detail }));
}

function onJob(payload) {
  if (!jobId || payload.id !== jobId) return;
  if (payload.type === 'cmd') {
    appendLog('CMD', payload.cmd);
    return;
  }
  if (payload.type === 'stdout') {
    appendLog('OUT', payload.text);
    return;
  }
  if (payload.type === 'stderr') {
    appendLog('ERR', payload.text);
    return;
  }
  if (!payload.dryRun) notifyEditor({ ...payload });
  switch (payload.type) {
    case 'progress':
      setStatus(payload.label || 'Working…');
      showProgress(payload.progress);
      break;
    case 'done':
      setRunning(false);
      jobId = null;
      appendLog('EXIT', `code=${payload.code ?? 0}${payload.path ? ' path=' + payload.path : ''}`);
      setStatus(payload.dryRun ? 'Dry run succeeded (exit 0).' : 'Done.');
      showResult(payload.path, payload.dryRun);
      break;
    case 'cancelled':
      setRunning(false);
      jobId = null;
      appendLog('CANCEL', 'Job cancelled by user.');
      setStatus('Cancelled.');
      break;
    case 'error':
      setRunning(false);
      jobId = null;
      appendLog('FAIL', `code=${payload.code ?? '?'} ${payload.message || 'Render failed'}`);
      setStatus(payload.message || 'The render failed.', true);
      break;
  }
}

async function onCancel() {
  if (!jobId) return;
  const res = await api.cancelTextToVideo(jobId);
  if (!res.ok) setStatus(res.error, true);
}

function init() {
  const openBtn = $('t2v-open');
  if (!api) {
    openBtn.disabled = true;
    openBtn.title = 'Mannimmate AI Studio is available in the desktop app';
    return;
  }
  openBtn.addEventListener('click', open);
  $('t2v-close').addEventListener('click', close);
  $('t2v-cancel').addEventListener('click', onCancel);
  $('ai-refresh').addEventListener('click', loadOptions);
  $('ai-doctor').addEventListener('click', runDoctor);
  $('ai-log-clear').addEventListener('click', () => {
    logLines.length = 0;
    $('ai-debug-log').textContent = '';
  });
  $('ai-log-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(logLines.join('\n')).then(() => setStatus('Copied debug log to clipboard.')).catch(() => {});
  });

  $('ai-mode-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ai-mode]');
    if (!btn || running) return;
    currentMode = btn.dataset.aiMode;
    applyModeVisibility();
  });

  $('t2v-form').addEventListener('input', () => {
    if ($('t2v-form').elements.refmodMode) {
      const latentWrap = $('ai-latent-wrap');
      if (latentWrap) latentWrap.hidden = !(currentMode === 'refmod' && $('t2v-form').elements.refmodMode.value === 'continue');
    }
    updateCommandPreview();
  });
  $('t2v-form').addEventListener('change', () => {
    if ($('t2v-form').elements.refmodMode) {
      const latentWrap = $('ai-latent-wrap');
      if (latentWrap) latentWrap.hidden = !(currentMode === 'refmod' && $('t2v-form').elements.refmodMode.value === 'continue');
    }
    updateCommandPreview();
  });

  $('t2v-dialog').addEventListener('click', async (e) => {
    if (e.target.id === 't2v-dialog') return close();
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) return api.reveal(reveal.dataset.reveal);
    const pick = e.target.closest('[data-pick-file]');
    if (pick && api.mannimmatePickFile) {
      const kind = pick.dataset.pickFile;
      const targetName = pick.dataset.pickTarget || kind;
      const chosen = await api.mannimmatePickFile(kind);
      if (chosen && $('t2v-form').elements[targetName]) {
        $('t2v-form').elements[targetName].value = chosen;
        updateCommandPreview();
      }
    }
  });

  $('t2v-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });

  api.onJob(onJob);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('t2v-dialog').hidden) close();
  });
}

init();
