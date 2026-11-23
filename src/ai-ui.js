// Interactive Visual Mannimmate AI Studio popup for Zaude.
// - Visual RefMod square grid (headshot + hover walk animation + translucent first-name overlay + "+" creator)
// - Square image/video preview inputs for all image/video slots
// - Closes automatically on Generate and supports queuing multiple generations with live step previews & ETA
// - Full Debug Console (command preview, stdout, stderr, dry-run, doctor)

const api = window.zaudeAI || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let currentMode = 'text-render';
let refmodEntries = [];
let selectedRefmods = []; // up to 2 refmod file slugs: [Subject 1, Subject 2]
let queuedRefmodSlugs = []; // [activeSlug, nextSlug, ...]
const trackedJobs = new Map(); // jobId -> { mode, dryRun, seconds }
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
  if (!el) return;
  el.textContent = text;
  el.className = 't2v-status' + (isError ? ' err' : '');
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

function syncHiddenRefmodInputs() {
  const f1 = $('ai-refmod-input');
  const f2 = $('ai-refmod2-input');
  if (f1) f1.value = selectedRefmods[0] || '';
  if (f2) f2.value = selectedRefmods[1] || '';
}

function updateMissingPreviewsButton() {
  const btn = $('ai-refmods-gen-missing');
  const stopBtn = $('ai-refmods-stop-queue');
  const missing = refmodEntries.filter((m) => !m.hasHeadshot || !m.hasWalk).length;
  if (btn) {
    btn.textContent = queuedRefmodSlugs.length
      ? `✨ Preview queue (${queuedRefmodSlugs.length} left)`
      : `✨ Generate missing (${missing})`;
    btn.disabled = missing === 0;
  }
  if (stopBtn) {
    stopBtn.hidden = queuedRefmodSlugs.length === 0;
  }
}

function renderRefModGrid() {
  const grid = $('ai-refmod-grid');
  if (!grid) return;
  syncHiddenRefmodInputs();
  updateMissingPreviewsButton();

  const cards = refmodEntries.map((item, idx) => {
    const selIdx = selectedRefmods.indexOf(item.file);
    const selCls = selIdx === 0 ? ' sel-1' : selIdx === 1 ? ' sel-2' : '';
    const badge = selIdx >= 0 ? `<span class="refmod-slot-badge">${selIdx + 1}</span>` : '';
    const label = item.firstName || `Subject ${idx + 1}`;
    const qPos = queuedRefmodSlugs.indexOf(item.slug);
    const genLabel = qPos === 0 ? '…' : (qPos > 0 ? `Q${qPos + 1}` : '✨');
    const avatarHtml = item.headshotUrl
      ? `<img class="refmod-headshot" src="${esc(item.headshotUrl)}" alt="${esc(label)}" loading="lazy">`
      : `<span class="refmod-monogram">${esc(label.slice(0, 2).toUpperCase())}</span>`;
    const walkHtml = item.walkUrl
      ? `<video class="refmod-walk" src="${esc(item.walkUrl)}" muted loop playsinline preload="none"></video>`
      : '';
    const genBtn = `<button type="button" class="refmod-gen-btn${qPos >= 0 ? ' busy' : ''}" data-gen-refmod="${esc(item.slug)}" title="${item.hasWalk ? 'Regenerate headshot & walk preview' : 'Queue headshot & walk preview'}">${genLabel}</button>`;
    return `<div class="refmod-tile${selCls}${item.hasWalk ? ' has-walk' : ''}" data-refmod-tile="${esc(item.file)}" title="${esc(item.name || item.file)}${item.hasWalk ? ' · Hover to preview walk' : ' · Click ✨ to generate headshot & walk'}">
      ${avatarHtml}${walkHtml}${badge}${genBtn}
      <span class="refmod-name">${esc(label)}</span>
    </div>`;
  }).join('');

  const addTile = `<button type="button" class="refmod-tile refmod-add-tile" id="ai-refmod-add-btn" title="Add a new RefMod character folder">
    <span class="refmod-plus">+</span>
    <span class="refmod-name">Add</span>
  </button>`;

  grid.innerHTML = cards + addTile;
}

function updateSquarePreview(slotName, filePath, url, isVideo = false) {
  const box = $(`ai-preview-${slotName}`);
  const form = $('t2v-form');
  const clearBtn = document.querySelector(`[data-clear-slot="${slotName}"]`);
  if (form && form.elements[slotName]) form.elements[slotName].value = filePath || '';
  if (!box) return;
  if (!filePath) {
    const emptyLabel = slotName === 'video' ? '🎬<br>Source Video' : slotName === 'image' ? '🖼️<br>Scene Image' : '🖼️<br>Ref Image';
    box.innerHTML = `<span class="ai-square-empty">${emptyLabel}</span>`;
    if (clearBtn) clearBtn.hidden = true;
    return;
  }
  const shortName = filePath.split(/[\\/]/).pop();
  if (isVideo && url) {
    box.innerHTML = `<video src="${esc(url)}" muted loop autoplay playsinline></video><span class="ai-square-cap">${esc(shortName)}</span>`;
  } else if (url) {
    box.innerHTML = `<img src="${esc(url)}" alt="${esc(shortName)}"><span class="ai-square-cap">${esc(shortName)}</span>`;
  } else {
    box.innerHTML = `<span class="ai-square-empty">📄</span><span class="ai-square-cap">${esc(shortName)}</span>`;
  }
  if (clearBtn) clearBtn.hidden = false;
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

  populateSelect($('ai-lora-select'), cachedOptions.loras || [], {
    emptyLabel: 'Auto / None',
    defaultVal: isText ? '' : (cachedOptions.default_lora || ''),
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
  const refmodFile = selectedRefmods[0] || '';
  const refmod2File = selectedRefmods[1] || '';
  const m1 = refmodEntries.find((m) => m.file === refmodFile);
  const m2 = refmodEntries.find((m) => m.file === refmod2File);
  return {
    mode: currentMode,
    mannimmateDir: String(fd.get('mannimmateDir') || '').trim(),
    prompt: String(fd.get('prompt') || '').trim(),
    seconds: Number(fd.get('seconds') || 7),
    quality: String(fd.get('resolution') || '640'),
    preset: String(fd.get('quality') || 'normal'),
    aspect: String(fd.get('aspect') || '16:9'),
    fps: Number(fd.get('fps') || 24),
    steps: fd.get('steps') !== '' ? Number(fd.get('steps')) : null,
    seed: fd.get('seed') !== '' ? Number(fd.get('seed')) : null,
    model: String(fd.get('model') || '').trim(),
    lora: String(fd.get('lora') || '').trim(),
    ref: String(fd.get('ref') || '').trim(),
    refmod: refmodFile,
    refmodName: m1 ? (m1.name || m1.firstName) : '',
    refmod2: refmod2File,
    refmod2Name: m2 ? (m2.name || m2.firstName) : '',
    refmodMode: String(fd.get('refmodMode') || 'generate'),
    identityStrength: fd.get('identityStrength') !== '' ? Number(fd.get('identityStrength')) : 1.0,
    voiceStrength: fd.get('voiceStrength') !== '' ? Number(fd.get('voiceStrength')) : 1.0,
    latent: String(fd.get('latent') || '').trim(),
    video: String(fd.get('video') || '').trim(),
    start: Number(fd.get('start') ?? 0),
    end: Number(fd.get('end') ?? 7),
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
    parts.push('--mode', req.refmodMode, '--refmod', `"${req.refmod || '<refmod>'}|${req.refmodName || 'Subject 1'}|${req.identityStrength}|${req.voiceStrength}"`);
    if (req.refmod2) parts.push('--refmod', `"${req.refmod2}|${req.refmod2Name || 'Subject 2'}|1|1"`);
    parts.push('--quality', req.quality, '--seconds', String(req.seconds), '--fps', String(req.fps), '--save-latent');
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

async function loadOptionsAndRefMods() {
  if (!api || !api.refmodsList) return;
  const dir = $('t2v-form').elements.mannimmateDir.value.trim();
  setStatus('Loading RefMods & Mannimmate models…');
  appendLog('INFO', 'Syncing Zaude refmods/ library & Mannimmate options…');
  const res = await api.refmodsList(dir);
  if (!res || !res.ok) {
    const err = (res && res.error) || 'Could not load RefMods';
    setStatus(err, true);
    appendLog('ERR', err);
    return;
  }
  refmodEntries = res.refmods || [];
  if ($('ai-refmods-dir') && res.refmodsDir) {
    $('ai-refmods-dir').textContent = res.refmodsDir;
  }
  if (res.options) {
    cachedOptions = {
      mods: res.options.mods || [],
      models: res.options.models || [],
      text_models: res.options.text_models || [],
      loras: res.options.loras || [],
      latents: res.options.latents || [],
      default_model: res.options.default_model || '',
      default_lora: res.options.default_lora || '',
    };
  }
  renderRefModGrid();
  updateModelRouting();
  updateCommandPreview();
  const msg = `Loaded ${refmodEntries.length} RefMods, ${cachedOptions.models.length} Ref2VA, ${cachedOptions.text_models.length} FL2VA models.`;
  setStatus(res.optionsError ? `${msg} (${res.optionsError})` : msg, Boolean(res.optionsError));
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
  try {
    const settings = await api.getSettings();
    $('t2v-form').elements.mannimmateDir.value = settings.mannimmateDir;
  } catch (err) {
    setStatus('Could not read settings: ' + err.message, true);
  }
  applyModeVisibility();
  renderRefModGrid();
  if (!refmodEntries.length && !cachedOptions.models.length) {
    loadOptionsAndRefMods();
  }
}

function close() {
  $('t2v-dialog').hidden = true;
}

function notifyEditor(detail) {
  window.dispatchEvent(new CustomEvent('zaude:t2v', { detail }));
}

async function onSubmit() {
  const req = collectRequest();
  if (req.mannimmateDir) await api.setSettings({ mannimmateDir: req.mannimmateDir });

  // Basic client-side check before closing so errors show right inside the popup
  if ((req.mode === 'text-render' || req.mode === 'refmod') && !req.prompt) {
    return setStatus('Write a prompt first.', true);
  }
  if (req.mode === 'refmod' && !req.refmod) {
    return setStatus('Click a RefMod character square first.', true);
  }
  if (req.mode === 'auto' && !req.video) {
    return setStatus('Pick a source video first.', true);
  }
  if (req.mode === 'coverage' && !req.image) {
    return setStatus('Pick a scene reference image first.', true);
  }

  const result = await api.mannimmateStart(req);
  if (!result || !result.ok) {
    const err = (result && result.error) || 'Could not queue Mannimmate job.';
    setStatus(err, true);
    appendLog('ERR', err);
    return;
  }

  const secs = req.mode === 'auto'
    ? Math.max(1, Math.round(req.end - req.start))
    : (Number(req.seconds) || 7);
  trackedJobs.set(result.id, { mode: req.mode, dryRun: req.dryRun, seconds: secs });
  notifyEditor({
    type: 'start',
    id: result.id,
    seconds: secs,
    queuePos: result.queuePos || 1,
    etaSec: result.etaSec || 60,
    totalSteps: Number(req.steps) || 6,
    label: req.mode === 'refmod' ? (req.refmodName || 'RefMod') : req.mode,
  });
  appendLog('QUEUE', `Queued job #${result.queuePos || 1} (${req.mode}, ~${Math.round((result.etaSec || 60) / 60)}m)`);

  // Close the window immediately when pressing Generate so the user sees the live clip on the timeline!
  close();
}

function onJob(payload) {
  const info = trackedJobs.get(payload.id);
  if (!info) return;
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
  notifyEditor({ ...payload, dryRun: info.dryRun });
  if (payload.type === 'done' || payload.type === 'cancelled' || payload.type === 'error') {
    appendLog(payload.type.toUpperCase(), `job=${payload.id.slice(0, 6)} ${payload.path || payload.message || ''}`);
    trackedJobs.delete(payload.id);
  }
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
  $('ai-refresh').addEventListener('click', loadOptionsAndRefMods);
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
    if (!btn) return;
    currentMode = btn.dataset.aiMode;
    applyModeVisibility();
  });

  // Hover walk animation playback on RefMod square tiles
  const grid = $('ai-refmod-grid');
  grid.addEventListener('pointerenter', (e) => {
    const tile = e.target.closest('.refmod-tile[data-refmod-tile]');
    const vid = tile && tile.querySelector('.refmod-walk');
    if (vid) { vid.currentTime = 0; vid.play().catch(() => {}); }
  }, true);
  grid.addEventListener('pointerleave', (e) => {
    const tile = e.target.closest('.refmod-tile[data-refmod-tile]');
    const vid = tile && tile.querySelector('.refmod-walk');
    if (vid) { vid.pause(); }
  }, true);

  $('ai-new-refmod-cancel').addEventListener('click', () => {
    $('ai-refmod-add-form').hidden = true;
  });
  $('ai-new-refmod-save').addEventListener('click', async () => {
    const name = $('ai-new-refmod-name').value.trim();
    const file = $('ai-new-refmod-file').value.trim();
    const res = await api.refmodsAdd({ name, file });
    if (res && res.ok && res.entry) {
      refmodEntries.push(res.entry);
      $('ai-new-refmod-name').value = '';
      $('ai-new-refmod-file').value = '';
      $('ai-refmod-add-form').hidden = true;
      renderRefModGrid();
      setStatus(`Created RefMod folder: ${res.entry.slug}`);
    }
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

    // "+" add RefMod button
    if (e.target.closest('#ai-refmod-add-btn')) {
      $('ai-refmod-add-form').hidden = !$('ai-refmod-add-form').hidden;
      if (!$('ai-refmod-add-form').hidden) $('ai-new-refmod-name').focus();
      return;
    }

    // "Generate missing" button: queues all RefMods lacking a headshot or walk preview
    if (e.target.closest('#ai-refmods-gen-missing')) {
      const missing = refmodEntries.filter((m) => !m.hasHeadshot || !m.hasWalk);
      if (!missing.length) return setStatus('All RefMods already have previews.');
      const res = await api.refmodsGenerateMissing({
        mannimmateDir: $('t2v-form').elements.mannimmateDir.value.trim(),
        mods: missing,
      });
      if (res && res.ok) {
        setStatus(`Queued ${res.queued} RefMod preview${res.queued === 1 ? '' : 's'} (${res.total} total in queue).`);
        appendLog('REFMOD', `Queued ${res.queued} missing RefMod previews.`);
      }
      return;
    }

    if (e.target.closest('#ai-refmods-stop-queue')) {
      await api.refmodsCancelQueue();
      setStatus('Stopped RefMod preview queue.');
      appendLog('REFMOD', 'Preview queue cancelled.');
      return;
    }

    // Per-tile "✨" generate headshot & walk preview button (queues cleanly)
    const genRefBtn = e.target.closest('[data-gen-refmod]');
    if (genRefBtn) {
      e.stopPropagation();
      const slug = genRefBtn.dataset.genRefmod;
      const mod = refmodEntries.find((m) => m.slug === slug);
      if (!mod) return;
      setStatus(`Queued headshot & walk preview for ${mod.firstName}…`);
      appendLog('REFMOD', `Queued walk.mp4 + headshot.jpg for ${mod.file}…`);
      await api.refmodsGeneratePreview({
        mannimmateDir: $('t2v-form').elements.mannimmateDir.value.trim(),
        mod,
      });
      return;
    }

    // RefMod square tile selection (Subject 1 / Subject 2)
    const refTile = e.target.closest('.refmod-tile[data-refmod-tile]');
    if (refTile) {
      const file = refTile.dataset.refmodTile;
      const idx = selectedRefmods.indexOf(file);
      if (idx >= 0) {
        selectedRefmods.splice(idx, 1);
      } else if (currentMode === 'auto') {
        selectedRefmods = [file];
      } else {
        if (selectedRefmods.length >= 2) selectedRefmods.shift();
        selectedRefmods.push(file);
      }
      renderRefModGrid();
      updateCommandPreview();
      return;
    }

    // Clear square media preview
    const clearBtn = e.target.closest('[data-clear-slot]');
    if (clearBtn) {
      e.stopPropagation();
      updateSquarePreview(clearBtn.dataset.clearSlot, '', null);
      updateCommandPreview();
      return;
    }

    // Production presets
    const presetBtn = e.target.closest('[data-ai-preset]');
    if (presetBtn) {
      const form = $('t2v-form');
      const id = presetBtn.dataset.aiPreset;
      if (id === 'prod-16x9') {
        form.elements.resolution.value = '640';
        form.elements.steps.value = '6';
        form.elements.seconds.value = '7';
        form.elements.quality.value = 'normal';
        form.elements.aspect.value = '16:9';
        form.elements.fps.value = '24';
        setStatus('Applied Production 16:9 preset (640p · 6 steps · 7s · 24fps).');
      } else if (id === 'prod-9x16') {
        form.elements.resolution.value = '640';
        form.elements.steps.value = '6';
        form.elements.seconds.value = '7';
        form.elements.quality.value = 'normal';
        form.elements.aspect.value = '9:16';
        form.elements.fps.value = '24';
        setStatus('Applied Portrait Short preset (9:16 · 640p · 6 steps · 7s).');
      } else if (id === 'fast-draft') {
        form.elements.resolution.value = '480';
        form.elements.steps.value = '4';
        form.elements.seconds.value = '4';
        form.elements.quality.value = 'draft';
        form.elements.fps.value = '12';
        setStatus('Applied Fast Draft preset (480p · 4 steps · 4s · 12fps).');
      }
      updateCommandPreview();
      return;
    }

    // Prompt helper snippets
    const snipBtn = e.target.closest('[data-prompt-snip]');
    if (snipBtn) {
      const ta = $('t2v-form').elements.prompt;
      const req = collectRequest();
      const s1 = req.refmodName || 'Subject 1';
      const s2 = req.refmod2Name || '';
      const vis = s2 ? `${s1}, ${s2}` : s1;
      const snips = {
        dialogue: `\nDialogue window [0.5-3.5s] ${s1} says: "..."\nRefMod usage: visible=${vis}; speaking=${s1}`,
        outfit: `\nNOT in default outfit, instead wearing `,
        screen: `\nThe television screen stays brightly lit and ON the entire time showing the live program, never turning dark or off.`,
        room: `\nConsistent room anchor: `,
      };
      const text = snips[snipBtn.dataset.promptSnip] || '';
      if (ta && text) {
        ta.value = (ta.value.trimEnd() + text).trimStart();
        ta.focus();
        updateCommandPreview();
      }
      return;
    }

    // Square image/video file picker
    const pick = e.target.closest('[data-pick-file]');
    if (pick && api.mannimmatePickFile) {
      const kind = pick.dataset.pickFile;
      const targetName = pick.dataset.pickTarget || kind;
      const chosen = await api.mannimmatePickFile(kind);
      if (chosen && chosen.path) {
        updateSquarePreview(targetName, chosen.path, chosen.url, kind === 'video');
        updateCommandPreview();
      }
    }
  });

  $('t2v-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });

  api.onJob(onJob);
  if (api.onRefmodProgress) {
    api.onRefmodProgress((ev) => {
      if (ev.type === 'queue') {
        queuedRefmodSlugs = Array.isArray(ev.queuedSlugs) ? ev.queuedSlugs : [];
        renderRefModGrid();
        return;
      }
      if (ev.type === 'done' && ev.entry) {
        const bust = `?v=${Date.now()}`;
        const updated = {
          ...ev.entry,
          headshotUrl: ev.entry.headshotUrl ? ev.entry.headshotUrl + bust : null,
          walkUrl: ev.entry.walkUrl ? ev.entry.walkUrl + bust : null,
        };
        refmodEntries = refmodEntries.map((m) => (m.slug === updated.slug ? updated : m));
        renderRefModGrid();
        setStatus(`Preview ready for ${updated.firstName}!`);
        appendLog('OK', `RefMod preview saved: ${updated.slug}`);
        return;
      }
      if (ev.type === 'error') {
        setStatus(`RefMod ${ev.slug}: ${ev.error || 'failed'}`, true);
        appendLog('ERR', `RefMod ${ev.slug}: ${ev.error || 'failed'}`);
        return;
      }
      if (ev.label) setStatus(`RefMod ${ev.slug}: ${ev.label}`);
      if (ev.text) appendLog('REFMOD', ev.text);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('t2v-dialog').hidden) close();
  });
}

init();
