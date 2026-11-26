// Interactive Visual Mannimmate AI Studio popup for Zaude.
// - Visual RefMod square grid (headshot + hover walk animation + translucent first-name overlay + "+" creator)
// - Square image/video preview inputs for all image/video slots
// - Closes automatically on Generate and supports queuing multiple generations with live step previews & ETA
// - Full Debug Console (command preview, stdout, stderr, dry-run, doctor)

const api = window.zaudeAI || null;
const modalApi = window.zaudeModal || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let currentMode = 'text-render';
let currentBackend = 'remote'; // 'remote' (Tranklena) | 'local' (Rizzar) | 'modal' (Modal Cloud Final)
let currentModalTier = 'balanced'; // 'fast' | 'balanced' | 'ultra'
let localSetup = null;
let modalStatus = null;
let lastModalPlan = null;
let stylizeAction = 'both'; // 'replace' | 'object' | 'both'
let stylizeSrcDur = 15;
let pendingInsertAt = null;
let pendingSeedVideo = '';
let pendingClipLatent = null; // { value, label, quality } pinned for the clip being continued
let latentNames = {}; // latent filename -> friendly "E+N · short scene desc"
let refmodEntries = [];
let selectedRefmods = []; // selected refmod file slugs: [Subject 1, Subject 2, ...]
const refmodOutfits = {}; // refmod file slug -> custom clothes / hair / state override text
const refmodStrengths = {}; // refmod file slug -> per-subject RefMod lock strength (0.35..1.0)
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

function renderRefmodOutfits() {
  const wrap = $('ai-refmod-outfits');
  if (!wrap) return;
  if (!selectedRefmods.length) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = selectedRefmods.map((file, idx) => {
    const m = refmodEntries.find((x) => x.file === file);
    const label = m ? (m.firstName || m.name || `Subject ${idx + 1}`) : `Subject ${idx + 1}`;
    const val = refmodOutfits[file] || '';
    const str = refmodStrengths[file] != null ? refmodStrengths[file] : (val ? 0.70 : 1.0);
    return `<div class="refmod-outfit-row">
      <span class="refmod-outfit-lbl">👕 S${idx + 1} · ${esc(label)}</span>
      <input type="text" data-refmod-outfit="${esc(file)}" value="${esc(val)}" placeholder="Clothes / hair / battle damage override (e.g. no jacket, torn shirt, hair zapped spiky by lightning)">
      <label class="refmod-lock-ctl" title="RefMod Lock Strength: 1.0 = strict coat/hair lock, 0.65–0.75 = keeps face while obeying coat removal / zapped hair overrides">
        <span class="muted" style="font-size:10px;white-space:nowrap">Lock <b data-refmod-lock-val="${esc(file)}">${Number(str).toFixed(2)}</b></span>
        <input type="range" min="0.40" max="1.00" step="0.05" value="${Number(str).toFixed(2)}" data-refmod-strength="${esc(file)}" style="width:68px">
      </label>
    </div>`;
  }).join('');
}

function syncHiddenRefmodInputs() {
  const f1 = $('ai-refmod-input');
  const f2 = $('ai-refmod2-input');
  if (f1) f1.value = selectedRefmods[0] || '';
  if (f2) f2.value = selectedRefmods[1] || '';
  renderRefmodOutfits();
  document.dispatchEvent(new CustomEvent('zaude:refmods-changed', {
    detail: { count: selectedRefmods.length, selected: [...selectedRefmods] },
  }));
}

function populateBackgroundRefmodSelect() {
  const sel = $('ai-bg-refmod');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">— None (prompt / picture only) —</option>` +
    refmodEntries.map((m) => `<option value="${esc(m.file)}">${esc(m.name || m.firstName || m.file)} (${esc(m.file)})</option>`).join('');
  if (prev && refmodEntries.some((m) => m.file === prev)) sel.value = prev;
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

let activeRefmodCat = 'All';
let activeRefmodFolder = 'All';
const REFMOD_CAT_ORDER = ['Photoreal', '2D / Anime', 'Characters', 'Locations', 'Styles', 'Voices'];
const REFMOD_FOLDER_ORDER = ['Stories/Salabin', 'Stories/Changebang', 'Styles/2D', 'Styles/Photoreal', 'Locations', 'General'];

function renderRefModGrid() {
  populateBackgroundRefmodSelect();
  const grid = $('ai-refmod-grid');
  if (!grid) return;
  syncHiddenRefmodInputs();
  updateMissingPreviewsButton();

  // Render Story/Style Folder Filter Pills
  const foldersEl = $('ai-refmod-folders');
  if (foldersEl) {
    const fCounts = new Map();
    for (const m of refmodEntries) {
      const f = m.folder || 'General';
      fCounts.set(f, (fCounts.get(f) || 0) + 1);
    }
    const orderedFolders = Array.from(new Set([...REFMOD_FOLDER_ORDER, ...fCounts.keys()])).filter((f) => fCounts.get(f) > 0);
    if (activeRefmodFolder !== 'All' && !fCounts.has(activeRefmodFolder)) activeRefmodFolder = 'All';
    foldersEl.innerHTML = [
      `<button type="button" class="refmod-folder-pill ${activeRefmodFolder === 'All' ? 'on' : ''}" data-refmod-folder="All">📁 All Folders (${refmodEntries.length})</button>`,
      ...orderedFolders.map((f) => `<button type="button" class="refmod-folder-pill ${activeRefmodFolder === f ? 'on' : ''}" data-refmod-folder="${esc(f)}">📁 ${esc(f)} (${fCounts.get(f)})</button>`),
    ].join('');
  }

  const folderScoped = activeRefmodFolder === 'All'
    ? refmodEntries
    : refmodEntries.filter((m) => (m.folder || 'General') === activeRefmodFolder);

  // Render Category Filter Pills
  const catsEl = $('ai-refmod-cats');
  if (catsEl) {
    const counts = new Map();
    for (const m of folderScoped) {
      const cat = m.category || 'Characters';
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    const orderedCats = Array.from(new Set([...REFMOD_CAT_ORDER, ...counts.keys()])).filter((c) => counts.get(c) > 0);
    if (activeRefmodCat !== 'All' && !counts.has(activeRefmodCat)) activeRefmodCat = 'All';
    catsEl.innerHTML = [
      `<button type="button" class="pa-lib-cat ${activeRefmodCat === 'All' ? 'on' : ''}" data-refmod-cat="All">All (${folderScoped.length})</button>`,
      ...orderedCats.map((c) => `<button type="button" class="pa-lib-cat ${activeRefmodCat === c ? 'on' : ''}" data-refmod-cat="${esc(c)}">${esc(c)} (${counts.get(c)})</button>`),
    ].join('');
  }

  const visibleEntries = activeRefmodCat === 'All'
    ? folderScoped
    : folderScoped.filter((m) => (m.category || 'Characters') === activeRefmodCat);

  const cards = visibleEntries.map((item, idx) => {
    const selIdx = selectedRefmods.indexOf(item.file);
    const selCls = selIdx >= 0 ? ` sel-any sel-${(selIdx % 4) + 1}` : '';
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
    const voiceBtn = item.hasVoice && item.voiceUrl
      ? `<button type="button" class="refmod-mini-btn" data-voice-refmod="${esc(item.voiceUrl)}" title="Hear ${esc(label)}'s voice">🔊</button>`
      : `<button type="button" class="refmod-mini-btn no-voice" disabled style="opacity:.35;cursor:not-allowed" title="No voice in this RefMod">🔇</button>`;
    const manageBtns = `<span class="refmod-tile-actions">
      ${voiceBtn}
      <button type="button" class="refmod-mini-btn" data-folder-refmod="${esc(item.slug)}" title="Move to folder (current: ${esc(item.folder || 'General')})">📁</button>
      <button type="button" class="refmod-mini-btn" data-cat-refmod="${esc(item.slug)}" title="Change category (current: ${esc(item.category || 'Characters')})">🏷️</button>
      <button type="button" class="refmod-mini-btn del" data-del-refmod="${esc(item.slug)}" title="Delete ${esc(label)} from Zaude RefMod library">✕</button>
    </span>`;
    return `<div class="refmod-tile${selCls}${item.hasWalk ? ' has-walk' : ''}" data-refmod-tile="${esc(item.file)}" title="${esc(item.name || item.file)} [${esc(item.folder || 'General')} · ${esc(item.category || 'Characters')}]${item.hasWalk ? ' · Hover to preview walk' : ' · Click ✨ to generate headshot & walk'}">
      ${avatarHtml}${walkHtml}${badge}${manageBtns}${genBtn}
      <span class="refmod-name">${esc(label)}</span>
    </div>`;
  }).join('');

  const addTile = `<button type="button" class="refmod-tile refmod-add-tile" id="ai-refmod-add-btn" title="Open Create RefMod window (with Tony Sheen example guide)">
    <span class="refmod-plus">+</span>
    <span class="refmod-name">Create</span>
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
    const emptyMap = {
      video: '🎬<br>Source Video',
      image: '🖼️<br>Scene Image',
      firstFrame: '⏮️<br>First Frame',
      lastFrame: '⏭️<br>Last Frame',
    };
    const emptyLabel = emptyMap[slotName] || '🖼️<br>Ref Image';
    box.innerHTML = `<span class="ai-square-empty">${emptyLabel}</span>`;
    if (clearBtn) clearBtn.hidden = true;
    if (slotName === 'video') {
      const stage = $('ai-stylize-scrub-stage');
      const vid = $('ai-stylize-preview');
      if (stage) stage.hidden = true;
      if (vid) { vid.removeAttribute('src'); vid.load(); }
    }
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
  if (slotName === 'video') {
    const stage = $('ai-stylize-scrub-stage');
    const vid = $('ai-stylize-preview');
    if (stage && vid) {
      if (url) {
        vid.src = url;
        stage.hidden = false;
        vid.onloadedmetadata = () => {
          if (Number.isFinite(vid.duration) && vid.duration > 0.5) {
            stylizeSrcDur = vid.duration;
            const formEl = $('t2v-form');
            if (formEl && Number(formEl.elements.end.value) > stylizeSrcDur) {
              formEl.elements.end.value = String(Math.min(stylizeSrcDur, 7).toFixed(1));
            }
            updateStylizeRangeUI();
          }
        };
      } else {
        vid.removeAttribute('src');
        vid.load();
        stage.hidden = true;
      }
    }
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

  populateSelect($('ai-lora-select'), cachedOptions.loras || [], {
    emptyLabel: 'Auto / None',
    defaultVal: isText ? '' : (cachedOptions.default_lora || ''),
  });

  const latentItems = [];
  if (pendingClipLatent) {
    latentItems.push({ value: pendingClipLatent.value, label: pendingClipLatent.label });
  }
  for (const lf of (cachedOptions.latents || []).slice(0, 60)) {
    if (pendingClipLatent && pendingClipLatent.value === lf) continue;
    const friendly = latentNames[lf];
    const shortHash = lf.replace(/^Mannimmaterefmod_/i, '').replace(/latent_00001\.h3latent\.safetensors$/i, '');
    latentItems.push({
      value: lf,
      label: friendly ? `${friendly} (${shortHash.slice(0, 8)})` : lf,
    });
  }
  populateSelect($('ai-latent-select'), latentItems, {
    emptyLabel: pendingClipLatent ? pendingClipLatent.label : '— Select a saved latent —',
    defaultVal: pendingClipLatent ? pendingClipLatent.value : '',
    mapItem: (x) => x,
  });
  if (pendingClipLatent && $('ai-latent-select')) {
    $('ai-latent-select').value = pendingClipLatent.value;
  }
}

function updateStylizeRangeUI() {
  const form = $('t2v-form');
  const fill = $('ai-stylize-fill');
  const lbl = $('ai-stylize-label');
  if (!form || !fill || !lbl) return;
  const maxDur = Math.max(1, stylizeSrcDur || 15);
  let start = Math.max(0, Math.min(maxDur - 0.5, Number(form.elements.start.value) || 0));
  let end = Math.max(start + 0.5, Math.min(maxDur, Number(form.elements.end.value) || 5));
  const leftPct = (start / maxDur) * 100;
  const widthPct = Math.max(2, ((end - start) / maxDur) * 100);
  fill.style.left = `${leftPct}%`;
  fill.style.width = `${widthPct}%`;
  lbl.textContent = `${start.toFixed(2)}s – ${end.toFixed(2)}s (${(end - start).toFixed(2)}s)`;

  const sd = $('ai-stylize-start-dial');
  const ed = $('ai-stylize-end-dial');
  const sdv = $('ai-stylize-start-dial-val');
  const edv = $('ai-stylize-end-dial-val');
  if (sd) { sd.max = String(maxDur.toFixed(1)); sd.value = String(start.toFixed(1)); }
  if (ed) { ed.max = String(maxDur.toFixed(1)); ed.value = String(end.toFixed(1)); }
  if (sdv) sdv.textContent = `${start.toFixed(1)}s`;
  if (edv) edv.textContent = `${end.toFixed(1)}s`;
}

function applyStylizeActionVisibility() {
  const pills = $('ai-stylize-pills');
  if (pills) {
    pills.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.stylizeAct === stylizeAction);
    });
  }
  const showcase = $('ai-stylize-showcase');
  if (showcase) {
    showcase.querySelectorAll('.sty-ba-card').forEach((card) => {
      card.classList.toggle('on', card.dataset.stylizeAct === stylizeAction);
    });
  }
  const bgRecipes = $('ai-bg-recipes');
  if (bgRecipes) bgRecipes.hidden = stylizeAction !== 'background';

  const objWrap = $('ai-object-prompt-wrap');
  if (objWrap) objWrap.hidden = stylizeAction === 'replace';

  const objLabel = $('ai-object-prompt-label');
  const form = $('t2v-form');
  const objTa = form && form.elements.objectPrompt;
  if (objLabel) {
    objLabel.textContent = stylizeAction === 'background'
      ? 'New Background / Environment (keeps exact performer, pose & timing from video)'
      : 'Object / Scene Addition (e.g. a moving cat, prop, effect)';
  }
  if (objTa) {
    objTa.placeholder = stylizeAction === 'background'
      ? 'e.g. A rain-drenched cyberpunk Tokyo alleyway at midnight with glowing cyan/magenta neon signs and matching rim light'
      : 'e.g. A fluffy orange and white tabby cat walks playfully across the floor around the dancer\'s feet, tail raised and swishing';
  }

  const refmodSec = $('ai-refmod-section');
  if (refmodSec && currentMode === 'auto') {
    // Keep RefMod picker accessible in all Stylize modes (required for replace/both, optional performer lock for background/object)
    refmodSec.hidden = currentBackend === 'local';
  }

  const guide = $('ai-stylize-guide');
  if (guide) {
    const GUIDES = {
      replace: {
        title: '🧑 How Replace Character Works',
        body: 'Keeps the exact choreography, camera move, and timing from your source video while swapping the performer. For best likeness, pick a <b>RefMod</b> OR drop a multi-angle <b>Character Sheet</b> (front + 3/4 + profile) into Ref Image.',
        showSheetBtn: true,
      },
      background: {
        title: '🌆 How Change Background Works',
        body: 'Locks your original performer’s pose and motion while replacing the room/environment. Describe the new background below OR drop a <b>BG Picture</b> / 3D Set Snapshot.',
        showSheetBtn: false,
      },
      object: {
        title: '🐱 How Add Object Works',
        body: 'Inserts a moving prop, pet, or VFX into your existing clip while keeping the scene and actor intact. Describe the object and how it interacts with the room.',
        showSheetBtn: false,
      },
      both: {
        title: '✨ How Both (Swap + Object) Works',
        body: 'Replaces the performer with your selected <b>RefMod / Character Sheet</b> AND adds your custom prop/object or environment twist in one pass.',
        showSheetBtn: true,
      },
    };
    const g = GUIDES[stylizeAction] || GUIDES.both;
    guide.innerHTML = `
      <div class="stylize-guide-hdr">
        <strong>📘 ${g.title}</strong>
        ${g.showSheetBtn ? `<button type="button" class="ai-btn-purple" id="ai-make-charsheet-btn" title="Generate a clean multi-angle Character Sheet from a single portrait photo using Codex / Qwen Image 2.1">🪄 Make Character Sheet (Codex)</button>` : ''}
      </div>
      <div class="stylize-guide-body">${g.body}</div>`;
  }
}

function applyModeVisibility() {
  const form = $('t2v-form');
  const isLocal = currentBackend === 'local';
  const tabs = $('ai-mode-tabs');
  if (tabs) tabs.hidden = isLocal;
  $('ai-mode-tabs').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.aiMode === currentMode);
  });
  form.querySelectorAll('[data-modes]').forEach((el) => {
    const allowed = el.dataset.modes.split(',');
    el.hidden = !allowed.includes(currentMode);
  });
  // In Local LTX mode, hide MiniMax-H3-only controls and reveal LTX-specific controls (LoRA, LTX presets)
  form.querySelectorAll('[data-minimax-only]').forEach((el) => {
    if (isLocal) el.hidden = true;
  });
  form.querySelectorAll('[data-local-only]').forEach((el) => {
    el.hidden = !isLocal;
  });
  const refmodMode = form.elements.refmodMode ? form.elements.refmodMode.value : 'generate';
  const latentWrap = $('ai-latent-wrap');
  if (latentWrap) latentWrap.hidden = isLocal || !(currentMode === 'refmod' && refmodMode === 'continue');
  applyStylizeActionVisibility();
  updateStylizeRangeUI();
  updateModelRouting();
  updateCommandPreview();
}

function collectRequest() {
  const form = $('t2v-form');
  const fd = new FormData(form);
  const idStrength = fd.get('identityStrength') !== '' ? Number(fd.get('identityStrength')) : 1.0;
  const voiceStrength = fd.get('voiceStrength') !== '' ? Number(fd.get('voiceStrength')) : 1.0;
  const refmods = selectedRefmods.map((file, idx) => {
    const m = refmodEntries.find((x) => x.file === file);
    const outfit = String(refmodOutfits[file] || '').trim();
    const perStr = refmodStrengths[file] != null ? Number(refmodStrengths[file]) : (outfit ? 0.70 : idStrength);
    return {
      file,
      name: m ? (m.name || m.firstName) : `Subject ${idx + 1}`,
      identityStrength: perStr,
      voiceStrength,
      outfit,
    };
  });
  const first = refmods[0] || null;
  const second = refmods[1] || null;
  const rawLatent = String(fd.get('latent') || '').trim();
  const isSeedSentinel = rawLatent === '__seed_video__';
  const reqQuality = String(fd.get('resolution') || (currentBackend === 'local' ? '480' : '640'));
  // If user intentionally changed resolution from the saved latent's resolution (e.g. 480p -> 640p),
  // switch cleanly to --seed-video (pixel-space re-encode) instead of crashing ComfyUI on latent size mismatch.
  const latentResMismatch = Boolean(
    !isSeedSentinel && rawLatent && pendingClipLatent && pendingClipLatent.value === rawLatent
    && pendingClipLatent.quality && String(pendingClipLatent.quality) !== reqQuality && pendingSeedVideo
  );
  return {
    backend: currentBackend,
    localModelId: ($('ai-local-model') && $('ai-local-model').value) || (localSetup && localSetup.defaultModel ? localSetup.defaultModel.id : ''),
    localLora: String(fd.get('localLora') || '').trim(),
    localLoraStrength: Number(fd.get('localLoraStrength') || 1.0),
    modalEndpoint: ($('ai-modal-url') && $('ai-modal-url').value.trim()) || (modalStatus && modalStatus.endpointUrl) || '',
    modalTier: currentModalTier,
    mode: currentMode,
    mannimmateDir: String(fd.get('mannimmateDir') || '').trim(),
    prompt: String(fd.get('prompt') || '').trim(),
    seconds: Number(fd.get('seconds') || (currentBackend === 'local' ? 4 : 7)),
    resolution: Number(fd.get('resolution') || (currentBackend === 'local' ? 480 : 640)),
    quality: reqQuality,
    preset: String(fd.get('quality') || 'normal'),
    aspect: String(fd.get('aspect') || '16:9'),
    fps: Number(fd.get('fps') || 24),
    steps: fd.get('steps') !== '' ? Number(fd.get('steps')) : null,
    seed: fd.get('seed') !== '' ? Number(fd.get('seed')) : null,
    model: String(fd.get('model') || '').trim(),
    lora: String(fd.get('lora') || '').trim(),
    ref: String(fd.get('ref') || '').trim(),
    backgroundImage: String(fd.get('backgroundImage') || '').trim(),
    backgroundRefmod: String(fd.get('backgroundRefmod') || '').trim(),
    firstFrame: String(fd.get('firstFrame') || '').trim(),
    lastFrame: String(fd.get('lastFrame') || '').trim(),
    refmods,
    refmod: first ? first.file : '',
    refmodName: first ? first.name : '',
    refmod2: second ? second.file : '',
    refmod2Name: second ? second.name : '',
    refmodMode: String(fd.get('refmodMode') || 'generate'),
    identityStrength: idStrength,
    voiceStrength,
    latent: (isSeedSentinel || latentResMismatch) ? '' : rawLatent,
    seedVideo: (isSeedSentinel || latentResMismatch || !rawLatent) ? (pendingSeedVideo || '') : '',
    video: String(fd.get('video') || '').trim(),
    start: Number(fd.get('start') ?? 0),
    end: Number(fd.get('end') ?? 7),
    stylizeAction,
    objectPrompt: String(fd.get('objectPrompt') || '').trim(),
    backgroundMode: String(fd.get('backgroundMode') || 'keep'),
    outpaintAspect: String(fd.get('outpaintAspect') || 'keep'),
    cameraPullback: Number(fd.get('cameraPullback') || 1.0),
    image: String(fd.get('image') || '').trim(),
    coverageTarget: String(fd.get('coverageTarget') || '').trim(),
    dryRun: Boolean($('ai-dry-run') && $('ai-dry-run').checked),
  };
}

function updateCommandPreview() {
  const req = collectRequest();
  if (req.backend === 'modal') {
    const tierNames = { fast: '⚡ Fast & Cheap (L40S)', balanced: '⚖️ Balanced (H100)', ultra: '💎 High Quality (H200 BF16)' };
    const tLabel = tierNames[currentModalTier] || '⚖️ Balanced (H100)';
    const badge = $('ai-route-badge');
    if (badge) {
      badge.textContent = `Route: ☁️ Modal · ${tLabel} · ${req.resolution}p · ${req.steps || 6} steps${req.modalEndpoint ? '' : ' · Click 🚀 Deploy or paste URL'}`;
    }
    const el = $('ai-cmd-preview');
    if (el) {
      el.textContent = `Modal ComfyUI (${tLabel}) --res ${req.resolution}p --seconds ${req.seconds} --steps ${req.steps || 6}`;
    }
    updateModalEstimate();
    return;
  }
  if (req.backend === 'local') {
    const host = (localSetup && localSetup.hostname) || 'Local';
    const selId = req.localModelId;
    const mod = (localSetup && localSetup.models && localSetup.models.find((m) => m.id === selId)) || (localSetup && localSetup.defaultModel);
    const modLabel = mod ? `${mod.label} (${mod.unet})` : 'No local model installed';
    const badge = $('ai-route-badge');
    if (badge) {
      const fl2vNote = (req.firstFrame || req.lastFrame) ? ' · First/Last Frame' : '';
      badge.textContent = `Route: 💻 ${host} Local · ${modLabel}${fl2vNote}${localSetup && localSetup.comfyRunning ? ' · ComfyUI running' : ' · auto-starts ComfyUI'}`;
    }
    const parts = [`ComfyUI (${host} Local)`, mod ? mod.unet : '<install-local-model>', `--res ${req.resolution}p`, `--seconds ${req.seconds}`, `--steps ${req.steps || (mod ? mod.defaultSteps : 8)}`];
    if (req.firstFrame) parts.push('--first-frame', req.firstFrame.split(/[\\/]/).pop());
    if (req.lastFrame) parts.push('--last-frame', req.lastFrame.split(/[\\/]/).pop());
    const el = $('ai-cmd-preview');
    if (el) el.textContent = parts.join(' ');
    return;
  }
  const parts = ['python3', 'mannimmate_cli.py', req.mode];
  if (req.mode === 'text-render') {
    parts.push('--prompt-file', '<prompt.txt>', '--aspect', req.aspect, '--quality', req.quality, '--preset', req.preset, '--fps', '24');
    if (req.ref) parts.push('--ref', req.ref);
  } else if (req.mode === 'refmod') {
    if (req.refmodMode !== 'continue' && (req.firstFrame || req.lastFrame)) {
      parts.length = 0;
      parts.push('ComfyUI', 'MiniMaxH3ImageToVideo (FL2VA)', `--quality ${req.quality}`, `--seconds ${req.seconds}`);
      if (req.firstFrame) parts.push('--first-frame', req.firstFrame.split(/[\\/]/).pop());
      if (req.lastFrame) parts.push('--last-frame', req.lastFrame.split(/[\\/]/).pop());
      if (req.refmods && req.refmods.length) {
        parts.push(`--refmods (${req.refmods.map((r) => r.name).join(', ')})`);
      }
    } else {
      parts.push('--mode', req.refmodMode);
      if (req.refmods && req.refmods.length) {
        for (const r of req.refmods) {
          parts.push('--refmod', `"${r.file}|${r.name}|${r.identityStrength}|${r.voiceStrength}"`);
        }
      } else {
        parts.push('--refmod', `"<refmod>|Subject 1|${req.identityStrength}|${req.voiceStrength}"`);
      }
      parts.push('--quality', req.quality, '--seconds', String(req.seconds), '--fps', String(req.fps), '--save-latent');
      if (req.refmodMode === 'continue') {
        if (req.latent) parts.push('--latent', req.latent);
        else if (req.seedVideo) parts.push('--seed-video', req.seedVideo.split(/[\\/]/).pop());
      }
    }
  } else if (req.mode === 'auto') {
    parts[2] = 'render';
    parts.push('--video', req.video || '<video>', '--start', String(req.start), '--end', String(req.end), '--quality', req.quality, '--preset', req.preset, '--prompt-file', '<stylize_prompt.txt>');
    if ((req.stylizeAction === 'replace' || req.stylizeAction === 'both') && req.refmods && req.refmods.length) {
      for (const r of req.refmods) parts.push('--refmod', `"${r.file}|${r.name}|1.0|0.0"`);
    }
    if (req.ref) parts.push('--ref', req.ref);
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

async function refreshLocalInfo() {
  if (!api || !api.localInfo) return;
  try {
    localSetup = await api.localInfo();
  } catch {
    localSetup = null;
  }
  const btn = $('ai-backend-local');
  const sel = $('ai-local-model');
  if (!btn) return;
  const host = (localSetup && localSetup.hostname) || 'Local';
  const def = localSetup && localSetup.defaultModel;
  btn.textContent = def ? `💻 ${host} · ${def.label}` : `💻 ${host} · No Local Model`;
  if (sel) {
    const readyModels = (localSetup && localSetup.models ? localSetup.models.filter((m) => m.ready) : []);
    sel.innerHTML = readyModels.map((m) => `<option value="${esc(m.id)}">${esc(m.label)} (${esc(m.unet)})</option>`).join('');
    sel.hidden = currentBackend !== 'local' || readyModels.length <= 1;
  }
  const loraSel = $('ai-local-lora');
  if (loraSel) {
    const prev = loraSel.value;
    const loras = (localSetup && Array.isArray(localSetup.loras) ? localSetup.loras : []);
    loraSel.innerHTML = '<option value="">— None (Base LTX model) —</option>'
      + loras.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    if (prev && loras.includes(prev)) loraSel.value = prev;
  }
  if (currentBackend === 'local') applyModeVisibility();
}

async function refreshModalInfo() {
  if (!modalApi || !modalApi.status) return;
  try {
    modalStatus = await modalApi.status();
  } catch {
    modalStatus = null;
  }
  const urlEl = $('ai-modal-url');
  const gpuEl = $('ai-modal-gpu');
  if (urlEl && modalStatus && modalStatus.endpointUrl && !urlEl.value) {
    urlEl.value = modalStatus.endpointUrl;
  }
  if (gpuEl && modalStatus && modalStatus.savedGpu) {
    gpuEl.value = modalStatus.savedGpu;
  }
  if (currentBackend === 'modal') updateCommandPreview();
}

async function updateModalEstimate() {
  if (!modalApi || !modalApi.estimate || currentBackend !== 'modal') return;
  const form = $('t2v-form');
  const resolution = form && form.elements.resolution ? Number(form.elements.resolution.value) : 640;
  const seconds = form && form.elements.seconds ? Number(form.elements.seconds.value) : 7;
  const steps = form && form.elements.steps ? Number(form.elements.steps.value) : 6;
  const est = await modalApi.estimate({ tier: currentModalTier, resolution, seconds, steps });
  if (!est || !est.ok) return;
  const pill = $('ai-modal-cost-pill');
  const planEl = $('ai-modal-plan');
  if (pill) {
    pill.textContent = `💰 Est. ~$${est.estCostUsd.toFixed(3)} · ~${est.estSec}s`;
    pill.title = `${est.tierLabel} on ${est.gpuLabel} ($${est.hourlyUsd.toFixed(2)}/hr) · ${est.modelSummary}`;
  }
  if (planEl) {
    planEl.textContent = `${est.tierLabel}: ${est.gpuLabel} · ${est.modelSummary} · ${est.description}`;
  }
}

function setModalTier(tier) {
  currentModalTier = ['fast', 'balanced', 'ultra'].includes(tier) ? tier : 'balanced';
  document.querySelectorAll('[data-modal-tier]').forEach((b) => {
    b.classList.toggle('on', b.dataset.modalTier === currentModalTier);
  });
  const form = $('t2v-form');
  if (form) {
    if (currentModalTier === 'fast') {
      form.elements.resolution.value = '480';
      form.elements.steps.value = '4';
      form.elements.seconds.value = '5';
    } else if (currentModalTier === 'balanced') {
      form.elements.resolution.value = '640';
      form.elements.steps.value = '6';
      form.elements.seconds.value = '7';
    } else if (currentModalTier === 'ultra') {
      form.elements.resolution.value = '720';
      form.elements.steps.value = '10';
      form.elements.seconds.value = '7';
    }
  }
  updateCommandPreview();
}

async function applyModalPlan(useAi = false) {
  if (!modalApi || !modalApi.plan) return;
  const planEl = $('ai-modal-plan');
  const form = $('t2v-form');
  if (useAi && planEl) planEl.textContent = '🤖 Asking connected AI to pick the optimal Modal tier & settings…';
  const req = collectRequest();
  const plan = await modalApi.plan({ request: req, useAi });
  if (!plan || !plan.ok) return;
  lastModalPlan = plan;
  const mappedTier = plan.gpu === 'H200' || Number(plan.resolution) >= 720 ? 'ultra'
    : (plan.gpu === 'L40S' && Number(plan.resolution) <= 480 ? 'fast' : 'balanced');
  currentModalTier = mappedTier;
  document.querySelectorAll('[data-modal-tier]').forEach((b) => {
    b.classList.toggle('on', b.dataset.modalTier === currentModalTier);
  });
  if (form) {
    if (form.elements.resolution) form.elements.resolution.value = String(plan.resolution || 640);
    if (form.elements.steps) form.elements.steps.value = String(plan.steps || 6);
  }
  if (planEl) {
    const srcTag = plan.source && plan.source !== 'heuristic' ? `AI (${plan.source})` : 'Auto';
    planEl.textContent = `🤖 ${srcTag} Pick: ${plan.gpuLabel} · ${plan.resolution}p · ${plan.steps} steps · ~${plan.estSec}s (~$${plan.estCostUsd.toFixed(3)}) — ${plan.reason}`;
  }
  updateCommandPreview();
}

function setBackend(next) {
  currentBackend = next === 'local' ? 'local' : (next === 'modal' ? 'modal' : 'remote');
  document.querySelectorAll('[data-ai-backend]').forEach((b) => {
    b.classList.toggle('on', b.dataset.aiBackend === currentBackend);
  });
  const form = $('t2v-form');
  const sel = $('ai-local-model');
  const modalBar = $('ai-modal-bar');
  const readyModels = (localSetup && localSetup.models ? localSetup.models.filter((m) => m.ready) : []);
  if (sel) sel.hidden = currentBackend !== 'local' || readyModels.length <= 1;
  if (modalBar) modalBar.hidden = currentBackend !== 'modal';

  if (currentBackend === 'modal') {
    refreshModalInfo();
    applyModalPlan(false);
    setStatus('Switched to ☁️ Modal Cloud Final Pass — click "🤖 AI Pick GPU & Settings" or run at 720p.');
  } else if (currentBackend === 'local') {
    currentMode = 'text-render';
    const def = (localSetup && localSetup.defaultModel);
    if (form) {
      form.elements.resolution.value = '480';
      form.elements.seconds.value = '4';
      form.elements.steps.value = String(def ? def.defaultSteps : 8);
    }
    const host = (localSetup && localSetup.hostname) || 'Local';
    setStatus(def
      ? `Switched to 💻 ${host} Local (${def.label}) — LTX UI active (First/Last Frame + LoRA · 480p · 4s · ${def.defaultSteps} steps).`
      : `No local model detected on ${host}. Click "🖥️ Local GPU" to install one.`, !def);
  } else {
    if (form) {
      form.elements.resolution.value = '640';
      form.elements.seconds.value = '7';
      form.elements.steps.value = '6';
    }
    setStatus('Switched to 🌐 Tranklena · Draft (640p · 7s · 6 steps).');
  }
  applyModeVisibility();
}

async function loadOptionsAndRefMods() {
  refreshLocalInfo();
  refreshModalInfo();
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
  if (res.latentNames && typeof res.latentNames === 'object') {
    latentNames = { ...latentNames, ...res.latentNames };
  }
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
  if (req.backend === 'modal') {
    if (!req.prompt && !req.objectPrompt) {
      return setStatus('Write a prompt first.', true);
    }
    if (!req.modalEndpoint) {
      return setStatus('Paste your Modal https://...modal.run endpoint URL or click "🚀 Deploy" first.', true);
    }
    if (modalApi && modalApi.saveConfig) {
      await modalApi.saveConfig({ endpointUrl: req.modalEndpoint, gpu: req.modalGpu });
    }
  } else if (req.backend === 'local') {
    if (!req.prompt && !req.objectPrompt) {
      return setStatus('Write a prompt first.', true);
    }
    if (!localSetup || !localSetup.defaultModel || !localSetup.defaultModel.ready) {
      return setStatus('No local video model installed yet. Click "🖥️ Local GPU" in the top bar to install LTX-Video 2B.', true);
    }
  } else {
    if ((req.mode === 'text-render' || req.mode === 'refmod') && !req.prompt) {
      return setStatus('Write a prompt first.', true);
    }
    if (req.mode === 'refmod' && req.refmodMode !== 'continue' && !req.refmod && !req.firstFrame && !req.lastFrame) {
      return setStatus('Click a RefMod character square (or pick First/Last frames) first.', true);
    }
    if (req.mode === 'refmod' && req.refmodMode === 'continue' && !req.latent && !req.seedVideo) {
      return setStatus('Pick a saved latent or right-click a clip → FrameContinue.', true);
    }
    if (req.mode === 'auto' && !req.video) {
      return setStatus('Pick a source video (or click "🎯 Pick from Timeline") first.', true);
    }
    if (req.mode === 'auto' && (req.stylizeAction === 'replace' || req.stylizeAction === 'both') && !req.refmod && !req.ref) {
      return setStatus('Select a RefMod character square (or reference image) to replace the character.', true);
    }
    if (req.mode === 'auto' && (req.stylizeAction === 'object' || req.stylizeAction === 'both') && !req.objectPrompt && !req.ref) {
      return setStatus('Describe the object or scene change you want to add.', true);
    }
    if (req.mode === 'auto' && req.stylizeAction === 'background' && !req.objectPrompt && !req.ref && !req.backgroundImage && !req.backgroundRefmod) {
      return setStatus('Describe the new background, click a Background Recipe, or pick a BG Picture / Set RefMod.', true);
    }
    if (req.mode === 'coverage' && !req.image) {
      return setStatus('Pick a scene reference image first.', true);
    }
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
  const insertAt = pendingInsertAt;
  pendingInsertAt = null;
  pendingSeedVideo = '';
  pendingClipLatent = null;
  const firstImg = document.querySelector('#ai-preview-firstFrame img');
  const initialPreviewUrl = firstImg && firstImg.src ? firstImg.src : null;
  notifyEditor({
    type: 'start',
    id: result.id,
    seconds: secs,
    insertAt,
    queuePos: result.queuePos || 1,
    etaSec: result.etaSec || 60,
    totalSteps: Number(req.steps) || 6,
    previewUrl: initialPreviewUrl,
    label: (req.firstFrame || req.lastFrame)
      ? (req.refmodMode === 'continue' ? 'FrameContinue' : 'FrameToFrame')
      : (req.mode === 'refmod' && req.refmodMode === 'continue'
        ? 'FrameContinue'
        : (req.mode === 'refmod' ? (req.refmodName || 'RefMod') : req.mode)),
  });
  appendLog('QUEUE', `Queued job #${result.queuePos || 1} (${req.mode}, ~${Math.round((result.etaSec || 60) / 60)}m)`);

  // Close the window immediately when pressing Generate so the user sees the live clip on the timeline!
  close();
}

function onJob(payload) {
  const info = trackedJobs.get(payload.id);
  if (!info && !payload.replaceClipId) return;
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
  notifyEditor({ ...payload, dryRun: Boolean(info && info.dryRun) });
  if (payload.type === 'done' || payload.type === 'cancelled' || payload.type === 'error') {
    if (payload.type === 'done' && payload.latent && payload.latentLabel) {
      latentNames[payload.latent] = payload.latentLabel;
      if (!cachedOptions.latents.includes(payload.latent)) {
        cachedOptions.latents.unshift(payload.latent);
      }
    }
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
  openBtn.addEventListener('click', async () => {
    // Opening AI Studio normally always starts fresh for a NEW clip (not stuck in FrameContinue / FL2V)
    pendingInsertAt = null;
    pendingSeedVideo = '';
    pendingClipLatent = null;
    const form = $('t2v-form');
    if (form && form.elements.refmodMode) form.elements.refmodMode.value = 'generate';
    if (form && form.elements.steps) form.elements.steps.value = currentBackend === 'local' ? '8' : '6';
    updateSquarePreview('firstFrame', '', null, false);
    updateSquarePreview('lastFrame', '', null, false);
    await open();
    applyModeVisibility();
    updateCommandPreview();
  });
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

  // Interactive Start/End Frame Dials scrubbing the embedded Stylize <video> preview
  const startDial = $('ai-stylize-start-dial');
  const endDial = $('ai-stylize-end-dial');
  const syncDialScrub = (which) => {
    const form = $('t2v-form');
    const vid = $('ai-stylize-preview');
    if (!form) return;
    const maxDur = Math.max(1, stylizeSrcDur || 15);
    let s = Number(startDial ? startDial.value : form.elements.start.value) || 0;
    let en = Number(endDial ? endDial.value : form.elements.end.value) || 5;
    if (which === 'start') {
      s = Math.max(0, Math.min(en - 0.5, s));
      form.elements.start.value = s.toFixed(1);
      if (vid && Number.isFinite(vid.duration)) vid.currentTime = s;
    } else {
      en = Math.min(maxDur, Math.max(s + 0.5, en));
      form.elements.end.value = en.toFixed(1);
      if (vid && Number.isFinite(vid.duration)) vid.currentTime = en;
    }
    updateStylizeRangeUI();
    updateCommandPreview();
  };
  if (startDial) startDial.addEventListener('input', () => syncDialScrub('start'));
  if (endDial) endDial.addEventListener('input', () => syncDialScrub('end'));

  // Interactive dragging of segment start/end handles in Stylize tab
  const stylizeTrack = $('ai-stylize-track');
  if (stylizeTrack) {
    stylizeTrack.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('[data-seg-drag]');
      if (!handle) return;
      e.preventDefault();
      const edge = handle.dataset.segDrag;
      const form = $('t2v-form');
      const rect = stylizeTrack.getBoundingClientRect();
      const maxDur = Math.max(1, stylizeSrcDur || 15);
      const move = (ev) => {
        const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        const t = Math.round(frac * maxDur * 10) / 10;
        const curStart = Number(form.elements.start.value) || 0;
        const curEnd = Number(form.elements.end.value) || 5;
        if (edge === 'start') {
          form.elements.start.value = String(Math.max(0, Math.min(curEnd - 0.5, t)).toFixed(1));
        } else {
          form.elements.end.value = String(Math.min(maxDur, Math.max(curStart + 0.5, t)).toFixed(1));
        }
        updateStylizeRangeUI();
        updateCommandPreview();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  $('t2v-form').addEventListener('input', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.refmodOutfit) {
      const f = e.target.dataset.refmodOutfit;
      const hadPrev = Boolean((refmodOutfits[f] || '').trim());
      refmodOutfits[f] = e.target.value;
      const hasNow = Boolean(e.target.value.trim());
      // Auto-nudge RefMod lock from 1.0 -> 0.70 when typing an override (and back to 1.0 when cleared)
      if (!hadPrev && hasNow && (refmodStrengths[f] == null || refmodStrengths[f] >= 0.95)) {
        refmodStrengths[f] = 0.70;
        const sl = document.querySelector(`[data-refmod-strength="${CSS.escape(f)}"]`);
        const lb = document.querySelector(`[data-refmod-lock-val="${CSS.escape(f)}"]`);
        if (sl) sl.value = '0.70';
        if (lb) lb.textContent = '0.70';
      } else if (hadPrev && !hasNow && refmodStrengths[f] === 0.70) {
        delete refmodStrengths[f];
        const sl = document.querySelector(`[data-refmod-strength="${CSS.escape(f)}"]`);
        const lb = document.querySelector(`[data-refmod-lock-val="${CSS.escape(f)}"]`);
        if (sl) sl.value = '1.00';
        if (lb) lb.textContent = '1.00';
      }
    }
    if (e.target && e.target.dataset && e.target.dataset.refmodStrength) {
      const f = e.target.dataset.refmodStrength;
      const v = Number(e.target.value) || 0.7;
      refmodStrengths[f] = v;
      const lb = document.querySelector(`[data-refmod-lock-val="${CSS.escape(f)}"]`);
      if (lb) lb.textContent = v.toFixed(2);
    }
    if ($('t2v-form').elements.refmodMode) {
      const latentWrap = $('ai-latent-wrap');
      if (latentWrap) latentWrap.hidden = !(currentMode === 'refmod' && $('t2v-form').elements.refmodMode.value === 'continue');
    }
    updateStylizeRangeUI();
    updateCommandPreview();
  });
  $('t2v-form').addEventListener('change', () => {
    if ($('t2v-form').elements.refmodMode) {
      const latentWrap = $('ai-latent-wrap');
      if (latentWrap) latentWrap.hidden = !(currentMode === 'refmod' && $('t2v-form').elements.refmodMode.value === 'continue');
    }
    updateStylizeRangeUI();
    updateCommandPreview();
  });

  $('t2v-dialog').addEventListener('click', async (e) => {
    if (e.target.id === 't2v-dialog') return close();
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) return api.reveal(reveal.dataset.reveal);

    // Pick segment directly from the active timeline clip
    if (e.target.closest('#ai-pick-timeline')) {
      const src = window.__zaudeGetStylizeSource ? await window.__zaudeGetStylizeSource() : null;
      if (!src) return setStatus('No video clip found on the timeline. Import or select a video clip first.', true);
      const form = $('t2v-form');
      stylizeSrcDur = src.srcDur || 15;
      form.elements.start.value = String(src.start.toFixed(1));
      form.elements.end.value = String(src.end.toFixed(1));
      updateSquarePreview('video', src.path, src.url, true);
      const meta = $('ai-stylize-meta');
      if (meta) meta.textContent = `Loaded "${src.name}" (${stylizeSrcDur.toFixed(1)}s total). Drag handles or click ±0.5s to trim.`;
      updateStylizeRangeUI();
      updateCommandPreview();
      setStatus(`Loaded segment from timeline clip "${src.name}".`);
      return;
    }

    // Extend / shorten segment start or end by ±0.5s
    const nudgeBtn = e.target.closest('[data-seg-nudge]');
    if (nudgeBtn) {
      const [edge, deltaStr] = nudgeBtn.dataset.segNudge.split(':');
      const delta = Number(deltaStr) || 0;
      const form = $('t2v-form');
      const maxDur = Math.max(1, stylizeSrcDur || 60);
      const curStart = Number(form.elements.start.value) || 0;
      const curEnd = Number(form.elements.end.value) || 5;
      if (edge === 'start') {
        form.elements.start.value = String(Math.max(0, Math.min(curEnd - 0.5, curStart + delta)).toFixed(1));
      } else {
        form.elements.end.value = String(Math.min(maxDur, Math.max(curStart + 0.5, curEnd + delta)).toFixed(1));
      }
      updateStylizeRangeUI();
      updateCommandPreview();
      return;
    }

    // Stylize action pill: Replace Character | Add Object | Both
    const styAct = e.target.closest('[data-stylize-act]');
    if (styAct) {
      stylizeAction = styAct.dataset.stylizeAct;
      applyStylizeActionVisibility();
      updateCommandPreview();
      return;
    }

    // 1-click Make Character Sheet (Codex / Qwen Image 2.1)
    const sheetBtn = e.target.closest('#ai-make-charsheet-btn');
    if (sheetBtn && api.mannimmatePickFile && api.stylizeMakeCharSheet) {
      const chosen = await api.mannimmatePickFile('image');
      if (!chosen || !chosen.path) return;
      sheetBtn.disabled = true;
      sheetBtn.textContent = '⏳ Building Character Sheet…';
      setStatus('Generating multi-angle Character Sheet via Codex / Qwen Image 2.1…');
      const res = await api.stylizeMakeCharSheet({ imagePath: chosen.path }).catch((err) => ({ ok: false, error: err.message }));
      sheetBtn.disabled = false;
      sheetBtn.textContent = '🪄 Make Character Sheet (Codex)';
      if (res && res.ok && res.sheetPath) {
        updateSquarePreview('ref', res.sheetPath, res.sheetUrl, false);
        updateCommandPreview();
        setStatus(`✅ Character Sheet ready and loaded into Ref Image (${res.sheetPath.split(/[\\/]/).pop()}).`);
      } else {
        setStatus((res && res.error) || 'Character Sheet generation failed.', true);
      }
      return;
    }

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

    // RefMod square tile selection (unlimited <Subject 1..N> in refmod mode, 1 in auto mode)
    const refTile = e.target.closest('.refmod-tile[data-refmod-tile]');
    if (refTile) {
      const file = refTile.dataset.refmodTile;
      const idx = selectedRefmods.indexOf(file);
      if (idx >= 0) {
        selectedRefmods.splice(idx, 1);
      } else if (currentMode === 'auto') {
        selectedRefmods = [file];
      } else {
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

    // 1-click Remote (Tranklena) ↔ Local (Rizzar) ↔ Cloud (Modal) backend toggle
    const backendBtn = e.target.closest('[data-ai-backend]');
    if (backendBtn) {
      setBackend(backendBtn.dataset.aiBackend);
      return;
    }

    // 1-click Modal Quality Tier toggle (Fast & Cheap | Balanced | High Quality)
    const tierBtn = e.target.closest('[data-modal-tier]');
    if (tierBtn) {
      setModalTier(tierBtn.dataset.modalTier);
      return;
    }

    // Modal AI GPU & Settings Picker
    if (e.target.closest('#ai-modal-ai-pick')) {
      applyModalPlan(true);
      return;
    }

    // Modal 1-click Deploy
    if (e.target.closest('#ai-modal-deploy')) {
      if (!modalApi || !modalApi.deploy) return;
      const picked = ($('ai-modal-gpu') && $('ai-modal-gpu').value) || 'auto';
      const gpu = picked === 'auto' ? ((lastModalPlan && lastModalPlan.gpu) || 'L40S') : picked;
      const planEl = $('ai-modal-plan');
      if (planEl) planEl.textContent = `🚀 Deploying modal/comfy_server.py on ${gpu}… (check Debug Console for live logs)`;
      appendLog('MODAL', `Starting modal deploy (${gpu})…`);
      const res = await modalApi.deploy({ gpu });
      if (!res || !res.ok) {
        const err = (res && res.error) || 'Failed to start Modal deploy';
        if (planEl) planEl.textContent = err;
        setStatus(err, true);
      }
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
      } else if (id === 'ltx-fast') {
        form.elements.resolution.value = '320';
        form.elements.steps.value = '4';
        form.elements.seconds.value = '2';
        form.elements.aspect.value = '16:9';
        setStatus('Applied LTX Fast Sketch preset (320p · 4 steps · 2s).');
      } else if (id === 'ltx-480') {
        form.elements.resolution.value = '480';
        form.elements.steps.value = '8';
        form.elements.seconds.value = '4';
        form.elements.aspect.value = '16:9';
        setStatus('Applied LTX 480p preset (480p · 8 steps · 4s).');
      } else if (id === 'ltx-portrait') {
        form.elements.resolution.value = '480';
        form.elements.steps.value = '8';
        form.elements.seconds.value = '3';
        form.elements.aspect.value = '9:16';
        setStatus('Applied LTX Portrait preset (9:16 · 480p · 8 steps · 3s).');
      }
      updateCommandPreview();
      return;
    }

    // 3D Character Camera-Angle Gizmo toggle & apply
    if (e.target.closest('#ai-angle-gizmo-toggle')) {
      const dr = $('ai-angle-gizmo-drawer');
      if (dr) {
        dr.hidden = !dr.hidden;
        if (!dr.hidden && !window.__zaudeAngleGizmo) {
          import('./camera-gizmo-3d.js').then((mod) => {
            mod.mountCameraGizmo3D({
              container: $('ai-angle-gizmo-canvas'),
              labelEl: $('ai-angle-gizmo-label'),
              onApply: (d) => {
                const ta = $('t2v-form')?.elements.prompt;
                if (ta) {
                  const cur = ta.value.trim();
                  ta.value = cur ? `${d.promptSnippet}. ${cur}` : `${d.promptSnippet}, `;
                  ta.focus();
                  updateCommandPreview();
                }
              },
            }).then((ctrl) => { window.__zaudeAngleGizmo = ctrl; });
          });
        }
      }
      return;
    }
    if (e.target.closest('#ai-angle-gizmo-apply') && window.__zaudeAngleGizmo) {
      const d = window.__zaudeAngleGizmo.applyNow();
      setStatus(`Inserted camera angle: ${d.promptSnippet}`);
      return;
    }
    if (e.target.closest('#ai-angle-gizmo-reset') && window.__zaudeAngleGizmo) {
      window.__zaudeAngleGizmo.reset();
      return;
    }

    // Prompt helper snippets
    const snipBtn = e.target.closest('[data-prompt-snip]');
    if (snipBtn) {
      const ta = $('t2v-form').elements.prompt;
      const req = collectRequest();
      const names = (req.refmods && req.refmods.length ? req.refmods.map((r) => r.name) : ['Subject 1']);
      const s1 = names[0];
      const vis = names.join(', ');
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

    // Square image/video file picker (with Recent 3D Set Snapshots quick-picker for backgroundImage & firstFrame)
    const pick = e.target.closest('[data-pick-file]');
    if (pick && api.mannimmatePickFile) {
      const kind = pick.dataset.pickFile;
      const targetName = pick.dataset.pickTarget || kind;
      if (kind === 'image' && (targetName === 'backgroundImage' || targetName === 'firstFrame') && api.listCoverageAngles) {
        const res = await api.listCoverageAngles().catch(() => null);
        const angles = (res && Array.isArray(res.angles)) ? res.angles.slice(0, 9) : [];
        if (angles.length) {
          showSnapPickerPopover(pick, targetName, angles);
          return;
        }
      }
      const chosen = await api.mannimmatePickFile(kind);
      if (chosen && chosen.path) {
        updateSquarePreview(targetName, chosen.path, chosen.url, kind === 'video');
        updateCommandPreview();
      }
    }
  });

  // Universal HTML5 Drag-and-Drop onto any .ai-square-slot
  const t2vForm = $('t2v-form');
  if (t2vForm) {
    t2vForm.addEventListener('dragover', (e) => {
      const slot = e.target.closest('.ai-square-slot[data-pick-target]');
      if (!slot) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      slot.classList.add('drag-over');
    });
    t2vForm.addEventListener('dragleave', (e) => {
      const slot = e.target.closest('.ai-square-slot[data-pick-target]');
      if (slot) slot.classList.remove('drag-over');
    });
    t2vForm.addEventListener('drop', (e) => {
      const slot = e.target.closest('.ai-square-slot[data-pick-target]');
      if (!slot) return;
      e.preventDefault();
      slot.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const filePath = file.path || file.name;
      const kind = slot.dataset.pickFile || 'image';
      const targetName = slot.dataset.pickTarget || kind;
      const isVideo = kind === 'video' || /\.(mp4|mov|webm|mkv)$/i.test(filePath);
      const url = file.path ? `file://${file.path}` : URL.createObjectURL(file);
      updateSquarePreview(targetName, filePath, url, isVideo);
      updateCommandPreview();
      setStatus(`Dropped "${file.name}" into ${targetName}.`);
    });
  }

  function showSnapPickerPopover(anchorEl, targetName, angles) {
    let pop = document.getElementById('ai-snap-picker');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'ai-snap-picker';
      pop.className = 'ai-snap-picker';
      document.body.appendChild(pop);
    }
    pop.innerHTML = `
      <div class="ai-snap-picker-hdr">
        <span>📸 Recent 3D Snapshots &amp; Angles</span>
        <button type="button" class="ai-mini-btn" data-snap-close>✕</button>
      </div>
      <div class="ai-snap-picker-grid">
        ${angles.map((a) => `
          <button type="button" class="ai-snap-picker-item" data-snap-path="${esc(a.path)}" data-snap-url="${esc(a.url || '')}">
            <img src="${esc(a.url || '')}" alt="${esc(a.name)}">
            <span>${esc(a.name.replace(/\.[^.]+$/, ''))}</span>
          </button>`).join('')}
      </div>
      <div class="ai-snap-picker-foot">
        <button type="button" class="primary" data-snap-browse>📂 Browse Disk…</button>
        <button type="button" data-snap-close>Cancel</button>
      </div>`;
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - 356, r.left))}px`;
    pop.style.top = `${Math.max(12, Math.min(window.innerHeight - 280, r.bottom + 6))}px`;
    pop.hidden = false;
    pop.onclick = async (ev) => {
      if (ev.target.closest('[data-snap-close]')) { pop.hidden = true; return; }
      const item = ev.target.closest('.ai-snap-picker-item');
      if (item) {
        updateSquarePreview(targetName, item.dataset.snapPath, item.dataset.snapUrl, false);
        updateCommandPreview();
        pop.hidden = true;
        return;
      }
      if (ev.target.closest('[data-snap-browse]')) {
        pop.hidden = true;
        const chosen = await api.mannimmatePickFile('image');
        if (chosen && chosen.path) {
          updateSquarePreview(targetName, chosen.path, chosen.url, false);
          updateCommandPreview();
        }
      }
    };
  }

  $('t2v-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });

  api.onJob(onJob);
  if (modalApi && modalApi.onEvent) {
    modalApi.onEvent((ev) => {
      if (!ev) return;
      if (ev.text) appendLog('MODAL', ev.text);
      if (ev.type === 'finished') {
        const planEl = $('ai-modal-plan');
        if (ev.ok && ev.endpointUrl) {
          const urlEl = $('ai-modal-url');
          if (urlEl) urlEl.value = ev.endpointUrl;
          if (planEl) planEl.textContent = `✅ Deployed on Modal (${ev.gpu})! Endpoint saved: ${ev.endpointUrl}`;
          setStatus(`Modal deployed on ${ev.gpu}!`);
          updateCommandPreview();
        } else if (!ev.ok) {
          if (planEl) planEl.textContent = `Deploy failed: ${ev.error || 'Run "pip install modal && modal setup" first.'}`;
          setStatus(ev.error || 'Modal deploy failed', true);
        }
        refreshModalUsage();
      }
    });
  }

  // Live Modal usage & billing pill in the top bar + 1-click Stop All kill-switch
  async function refreshModalUsage() {
    if (!modalApi || !modalApi.usage) return;
    const grp = $('modal-usage-group');
    const txt = $('modal-usage-text');
    const dot = $('modal-usage-dot');
    const btn = $('modal-usage-btn');
    try {
      const u = await modalApi.usage();
      if (!u || !u.cliInstalled) {
        if (grp) grp.hidden = true;
        return;
      }
      if (grp) grp.hidden = false;
      const active = Number(u.activeContainers) || 0;
      const metered = Number(u.meteredUsd) || 0;
      const billed = Number(u.billedUsd) || 0;
      const credits = Number(u.creditsUsd) || 0;
      if (dot) dot.classList.toggle('active', active > 0);
      if (txt) {
        const stateStr = active > 0 ? `${active} GPU active` : 'idle $0';
        txt.textContent = `☁️ $${metered.toFixed(2)} · ${stateStr}`;
      }
      if (btn) {
        btn.title = `Modal Usage — Metered: $${metered.toFixed(2)} | Billed: $${billed.toFixed(2)} | Credits applied: $${credits.toFixed(2)} | Active containers: ${active} (click to refresh)`;
      }
    } catch { /* ignore */ }
  }

  async function triggerStopAllModal() {
    if (!modalApi || !modalApi.stopAll) return;
    const stopBtns = [$('modal-stop-all'), $('ai-modal-stop-all')].filter(Boolean);
    stopBtns.forEach((b) => { b.disabled = true; b.textContent = 'Stopping…'; });
    try {
      const res = await modalApi.stopAll();
      const msg = `Stopped ${res.stoppedCount || 0} Modal container(s) & ${res.cancelledJobs || 0} queued job(s).`;
      setStatus(msg);
      appendLog('MODAL', msg);
      const planEl = $('ai-modal-plan');
      if (planEl) planEl.textContent = `⏹ ${msg}`;
    } catch (err) {
      setStatus(`Stop All failed: ${err.message || err}`, true);
    } finally {
      stopBtns.forEach((b) => { b.disabled = false; b.textContent = '⏹ Stop All'; });
      refreshModalUsage();
    }
  }

  const usageBtn = $('modal-usage-btn');
  if (usageBtn) usageBtn.addEventListener('click', refreshModalUsage);
  const topStopBtn = $('modal-stop-all');
  if (topStopBtn) topStopBtn.addEventListener('click', triggerStopAllModal);
  const barStopBtn = $('ai-modal-stop-all');
  if (barStopBtn) barStopBtn.addEventListener('click', triggerStopAllModal);

  if (modalApi && modalApi.usage) {
    refreshModalUsage();
    setInterval(refreshModalUsage, 30000);
  }
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
  window.__zaudeOpenFrameToFrame = async ({ firstFrame, lastFrame, seconds, insertAt = null } = {}) => {
    currentMode = 'refmod';
    pendingInsertAt = insertAt;
    pendingSeedVideo = '';
    pendingClipLatent = null;
    await open();
    const form = $('t2v-form');
    if (form && form.elements.refmodMode) form.elements.refmodMode.value = 'generate';
    if (seconds && form && form.elements.seconds) {
      form.elements.seconds.value = String(Math.max(2, Math.min(15, Math.round(seconds))));
    }
    if (firstFrame && firstFrame.path) updateSquarePreview('firstFrame', firstFrame.path, firstFrame.url, false);
    if (lastFrame && lastFrame.path) updateSquarePreview('lastFrame', lastFrame.path, lastFrame.url, false);
    applyModeVisibility();
    updateCommandPreview();
    setStatus(`FrameToFrame ready (${Math.round(seconds || 4)}s) — write your prompt and click Run.`);
    if (form && form.elements.prompt) form.elements.prompt.focus();
  };

  window.__zaudeOpenFrameContinue = async ({ seedVideo = '', latent = '', latentLabel = '', quality = '', clipName = '', firstFrame = null, insertAt = null } = {}) => {
    currentMode = 'refmod';
    pendingInsertAt = insertAt;
    pendingSeedVideo = seedVideo || '';
    const cleanClipName = (clipName || 'clip').replace(/\.[^.]+$/, '');
    if (latent) {
      const friendly = latentLabel || latentNames[latent] || `${cleanClipName} (saved latent)`;
      latentNames[latent] = friendly;
      pendingClipLatent = { value: latent, label: `This clip · ${friendly}`, quality: quality ? String(quality) : '' };
    } else {
      pendingClipLatent = { value: '__seed_video__', label: `This clip · ${cleanClipName} (from video)`, quality: quality ? String(quality) : '' };
    }
    await open();
    const form = $('t2v-form');
    // Show the clip's exact ending frame inside the First Frame preview square!
    if (firstFrame && firstFrame.path) {
      updateSquarePreview('firstFrame', firstFrame.path, firstFrame.url, false);
    } else {
      updateSquarePreview('firstFrame', '', null, false);
    }
    updateSquarePreview('lastFrame', '', null, false);
    if (form && form.elements.refmodMode) form.elements.refmodMode.value = 'continue';
    if (form && form.elements.steps) form.elements.steps.value = '7';
    // Match the saved latent's exact resolution so H3 never throws a latent-size mismatch error!
    if (quality && form && form.elements.resolution) {
      const qOpt = Array.from(form.elements.resolution.options).find((o) => o.value === String(quality));
      if (qOpt) form.elements.resolution.value = String(quality);
    }
    applyModeVisibility();
    updateCommandPreview();
    const resNote = quality ? ` · locked to ${quality}p to match latent` : '';
    setStatus(`FrameContinue ready (${pendingClipLatent.label}${resNote}) — write what happens next and click Run.`);
    if (form && form.elements.prompt) form.elements.prompt.focus();
  };

  // Open Stylize tab directly from a right-clicked timeline video clip
  window.__zaudeOpenStylize = async (src) => {
    if (!src || !src.path) return;
    if (currentBackend === 'local') setBackend('remote');
    currentMode = 'auto';
    await open();
    const form = $('t2v-form');
    stylizeSrcDur = src.srcDur || 15;
    if (form && form.elements.start) form.elements.start.value = String((src.start ?? 0).toFixed(1));
    if (form && form.elements.end) form.elements.end.value = String((src.end ?? Math.min(stylizeSrcDur, 5)).toFixed(1));
    updateSquarePreview('video', src.path, src.url, true);
    const meta = $('ai-stylize-meta');
    if (meta) meta.textContent = `Loaded "${src.name}" (${stylizeSrcDur.toFixed(1)}s total). Drag handles or click ±0.5s to trim.`;
    applyModeVisibility();
    updateStylizeRangeUI();
    updateCommandPreview();
    setStatus(`Stylize ready for "${src.name}" — pick a RefMod, background, or object edit and click Run.`);
  };

  // Expose slot setter for 3D Set Viewport & Coverage Angle Picker
  window.__zaudeSetMediaSlot = (slot, filePath, url) => {
    updateSquarePreview(slot, filePath, url, false);
    updateCommandPreview();
  };

  // ---------- Multi-Shot Script (.md / .txt) Cast Picker, Live Prompt & Batch Queue ----------
  let parsedScriptShots = [];
  let msSelectedCast = []; // ordered refmod file slugs: [Subject 1, Subject 2, ...]
  let msBgPicture = '';
  let msLastBuiltPrompt = '';

  function renderMultiShotCastChips() {
    const chipsEl = $('ai-ms-cast-chips');
    const bgRmSel = $('ai-ms-bg-refmod');
    if (bgRmSel) {
      const prev = bgRmSel.value;
      bgRmSel.innerHTML = '<option value="">— None —</option>' +
        refmodEntries.map((m) => `<option value="${esc(m.file)}">${esc(m.name || m.firstName || m.file)}</option>`).join('');
      if (prev) bgRmSel.value = prev;
    }
    if (!chipsEl) return;
    if (!refmodEntries.length) {
      chipsEl.innerHTML = '<span class="muted" style="font-size:11px">Loading RefMods…</span>';
      return;
    }
    chipsEl.innerHTML = refmodEntries.map((m) => {
      const idx = msSelectedCast.indexOf(m.file);
      const onCls = idx >= 0 ? ' on' : '';
      const numBadge = idx >= 0 ? `<b style="background:#8b5cf6;color:#fff;border-radius:999px;padding:0 5px;margin-right:4px">${idx + 1}</b>` : '';
      const thumb = m.headshotUrl ? `<img src="${esc(m.headshotUrl)}" style="width:18px;height:18px;border-radius:4px;object-fit:cover;margin-right:4px">` : '';
      return `<button type="button" class="ms-cast-chip${onCls}" data-ms-cast="${esc(m.file)}" style="display:inline-flex;align-items:center;height:28px;padding:0 8px;border-radius:999px;font-size:11px;border:1px solid ${idx >= 0 ? '#a78bfa' : 'rgba(255,255,255,.16)'};background:${idx >= 0 ? 'rgba(139,92,246,.28)' : 'rgba(255,255,255,.05)'}">${numBadge}${thumb}${esc(m.firstName || m.name || m.file)}</button>`;
    }).join('');
  }

  async function refreshMultiShotAgentPrompt() {
    if (!api || !api.buildMultiShotPrompt) return '';
    const cast = msSelectedCast.map((file, idx) => {
      const m = refmodEntries.find((x) => x.file === file);
      return { file, name: m ? (m.name || m.firstName || `Subject ${idx + 1}`) : `Subject ${idx + 1}` };
    });
    const envPreset = $('ai-ms-env-preset')?.value || '';
    const envCustom = ($('ai-ms-env-desc')?.value || '').trim();
    const environment = envCustom || envPreset;
    const bgRefmod = $('ai-ms-bg-refmod')?.value || '';
    const res = await api.buildMultiShotPrompt({
      cast,
      environment,
      bgPicture: msBgPicture,
      bgRefmod,
      maxFrames: 124,
      fps: 24,
    });
    if (res && res.ok && res.prompt) {
      msLastBuiltPrompt = res.prompt;
      const pre = $('ai-ms-prompt-preview');
      if (pre) pre.textContent = msLastBuiltPrompt;
      const st = $('ai-ms-bg-status');
      if (st) {
        const castTxt = cast.length ? cast.map((c, i) => `${i + 1}:${c.name}`).join(', ') : 'No RefMods picked yet';
        const bgTxt = msBgPicture ? `BG Pic: ${msBgPicture.split(/[\\/]/).pop()}` : (bgRefmod ? `Set RefMod: ${bgRefmod}` : (environment ? `Env: ${environment.slice(0, 48)}` : 'No environment lock'));
        st.textContent = `Prompt ready → Cast [${castTxt}] · ${bgTxt} · Max 124f (5.1s) auto-continuation + dialogue-safe cuts.`;
      }
      return msLastBuiltPrompt;
    }
    return '';
  }

  function buildRequestForScriptShot(shot) {
    const form = $('t2v-form');
    const engineChoice = ($('ai-script-engine') && $('ai-script-engine').value) || 'current';
    let backend = currentBackend;
    let modalTier = currentModalTier;
    if (engineChoice === 'tranklena') backend = 'tranklena';
    else if (engineChoice === 'local') backend = 'local';
    else if (engineChoice === 'script' && shot.engine) {
      if (shot.engine.startsWith('modal')) {
        backend = 'modal';
        const parts = shot.engine.split(':');
        if (parts[1]) modalTier = parts[1];
      } else if (shot.engine === 'local') backend = 'local';
      else backend = 'tranklena';
    }
    const mode = shot.mode || (shot.refmods && shot.refmods.length ? 'refmod' : 'text-render');
    const first = (shot.refmods && shot.refmods[0]) || null;
    const second = (shot.refmods && shot.refmods[1]) || null;
    return {
      backend,
      localModelId: ($('ai-local-model') && $('ai-local-model').value) || (localSetup && localSetup.defaultModel ? localSetup.defaultModel.id : ''),
      localLora: String((form && form.elements.localLora && form.elements.localLora.value) || '').trim(),
      localLoraStrength: Number((form && form.elements.localLoraStrength && form.elements.localLoraStrength.value) || 1.0),
      modalEndpoint: ($('ai-modal-url') && $('ai-modal-url').value.trim()) || (modalStatus && modalStatus.endpointUrl) || '',
      modalTier,
      mode,
      mannimmateDir: String((form && form.elements.mannimmateDir && form.elements.mannimmateDir.value) || '').trim(),
      prompt: shot.prompt,
      seconds: shot.seconds || 5,
      resolution: shot.resolution || 640,
      quality: String(shot.resolution || 640),
      preset: 'normal',
      aspect: shot.aspect || '16:9',
      fps: shot.fps || 24,
      steps: shot.steps || null,
      seed: shot.seed || null,
      refmods: shot.refmods || [],
      refmod: first ? first.file : '',
      refmodName: first ? first.name : '',
      refmod2: second ? second.file : '',
      refmod2Name: second ? second.name : '',
      refmodMode: shot.refmodMode || 'generate',
      stylizeAction: shot.stylizeAction || 'replace',
      backgroundImage: shot.backgroundImage || '',
      backgroundRefmod: shot.backgroundRefmod || '',
      model: shot.model || '',
      lora: shot.lora || '',
      outpaintAspect: shot.outpaintAspect || 'keep',
      cameraPullback: shot.cameraPullback || 1.0,
      video: shot.file || '',
    };
  }

  function renderScriptShots(parsed, fileName = '') {
    const bar = $('ai-script-bar');
    const sumEl = $('ai-script-summary');
    const listEl = $('ai-script-list');
    if (!listEl) return;
    if (!parsed || !parsed.ok || !Array.isArray(parsed.shots) || !parsed.shots.length) {
      parsedScriptShots = [];
      if (bar) bar.hidden = true;
      listEl.innerHTML = `<div class="muted" style="padding:8px">${esc((parsed && parsed.error) || 'No shots parsed yet.')}</div>`;
      return;
    }
    parsedScriptShots = parsed.shots;
    if (bar) bar.hidden = false;
    const bgNote = parsed.backgroundLock && parsed.backgroundLock.type !== 'none'
      ? ` · BG Lock: ${parsed.backgroundLock.type} (${parsed.backgroundLock.value})`
      : '';
    if (sumEl) {
      sumEl.textContent = `${fileName ? `📄 ${fileName} · ` : ''}${parsed.shots.length} shot(s) parsed${bgNote}`;
    }
    listEl.innerHTML = parsed.shots.map((s, idx) => {
      const castText = (s.refmods && s.refmods.length)
        ? s.refmods.map((r) => r.name || r.file).join(', ')
        : (s.castSlots && s.castSlots.length ? s.castSlots.map((n) => `Subject ${n}`).join(', ') : 'No RefMod');
      const modeTag = s.refmodMode === 'continue' ? 'continue' : s.mode;
      return `
        <div class="ai-script-card" data-script-idx="${idx}">
          <label class="ai-script-check">
            <input type="checkbox" class="ai-script-cb" data-script-cb="${idx}" checked>
            <strong>Shot ${esc(s.shotNumber)}</strong>
          </label>
          <div class="ai-script-card-body">
            <div class="ai-script-card-top">
              <span class="ai-script-sum">${esc(s.summary)}</span>
              <span class="ai-script-pill">${esc(modeTag)}</span>
              <span class="ai-script-pill">${esc(s.resolution)}p · ${esc(s.seconds)}s · ${esc(s.aspect)}</span>
              <span class="ai-script-pill">🧑 ${esc(castText)}</span>
            </div>
            <div class="ai-script-preview muted">${esc(s.prompt.slice(0, 220))}${s.prompt.length > 220 ? '…' : ''}</div>
          </div>
          <div class="ai-script-card-btns">
            <button type="button" data-script-load="${idx}" title="Load this shot into AI Studio to tweak before rendering">Load</button>
            <button type="button" class="primary" data-script-run="${idx}" title="Queue just this shot">▶ Run</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function loadScriptShotIntoStudio(idx) {
    const shot = parsedScriptShots[idx];
    if (!shot) return;
    const form = $('t2v-form');
    currentMode = shot.mode === 'auto' ? 'auto' : (shot.refmods && shot.refmods.length ? 'refmod' : 'text-render');
    if (shot.refmods && shot.refmods.length) {
      selectedRefmods = shot.refmods.map((r) => r.file);
      renderRefModGrid();
    }
    if (form) {
      if (form.elements.prompt) form.elements.prompt.value = shot.prompt;
      if (form.elements.seconds) form.elements.seconds.value = String(shot.seconds || 5);
      if (form.elements.resolution) form.elements.resolution.value = String(shot.resolution || 640);
      if (form.elements.aspect) form.elements.aspect.value = shot.aspect || '16:9';
      if (form.elements.seed) form.elements.seed.value = shot.seed != null ? String(shot.seed) : '';
      if (form.elements.refmodMode) form.elements.refmodMode.value = shot.refmodMode || 'generate';
      if (form.elements.backgroundRefmod && shot.backgroundRefmod) {
        form.elements.backgroundRefmod.value = shot.backgroundRefmod;
      }
    }
    if (shot.backgroundImage) {
      updateSquarePreview('backgroundImage', shot.backgroundImage, null, false);
    }
    applyModeVisibility();
    updateCommandPreview();
    setStatus(`Loaded Shot ${shot.shotNumber} ("${shot.summary}") into AI Studio.`);
  }

  // Wire Multi-Shot Cast Chips, Environment Picker, BG Picture, & Live Copyable Agent Prompt
  const msPanel = $('ai-script-panel');
  if (msPanel) {
    msPanel.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-ms-cast]');
      if (chip) {
        const slug = chip.dataset.msCast;
        const i = msSelectedCast.indexOf(slug);
        if (i >= 0) msSelectedCast.splice(i, 1);
        else msSelectedCast.push(slug);
        renderMultiShotCastChips();
        await refreshMultiShotAgentPrompt();
        return;
      }
      if (e.target.closest('#ai-ms-clear-cast')) {
        msSelectedCast = [];
        msBgPicture = '';
        if ($('ai-ms-env-preset')) $('ai-ms-env-preset').value = '';
        if ($('ai-ms-env-desc')) $('ai-ms-env-desc').value = '';
        if ($('ai-ms-bg-refmod')) $('ai-ms-bg-refmod').value = '';
        renderMultiShotCastChips();
        await refreshMultiShotAgentPrompt();
        return;
      }
      if (e.target.closest('#ai-ms-bg-pick') && api && api.pickFile) {
        const picked = await api.pickFile('image');
        if (picked && !picked.canceled && picked.path) {
          msBgPicture = picked.path;
          await refreshMultiShotAgentPrompt();
        }
        return;
      }
      if (e.target.closest('#ai-ms-toggle-preview')) {
        const pre = $('ai-ms-prompt-preview');
        if (pre) {
          if (pre.hidden) await refreshMultiShotAgentPrompt();
          pre.hidden = !pre.hidden;
        }
        return;
      }
      if (e.target.closest('#ai-ms-copy-prompt')) {
        const btn = $('ai-ms-copy-prompt');
        const txt = (await refreshMultiShotAgentPrompt()) || msLastBuiltPrompt;
        if (txt && navigator.clipboard) {
          await navigator.clipboard.writeText(txt).catch(() => {});
          if (btn) {
            const prev = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = prev; }, 1400);
          }
          setStatus('Copied Multi-Shot Agent System Prompt (with your numbered RefMods, environment & 124-frame continuation rules)!');
        }
      }
    });
    $('ai-ms-env-preset')?.addEventListener('change', (e) => {
      if ($('ai-ms-env-desc') && e.target.value) $('ai-ms-env-desc').value = e.target.value;
      refreshMultiShotAgentPrompt();
    });
    $('ai-ms-env-desc')?.addEventListener('input', () => refreshMultiShotAgentPrompt());
    $('ai-ms-bg-refmod')?.addEventListener('change', () => refreshMultiShotAgentPrompt());
    $('ai-mode-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ai-mode="script"]');
      if (b) {
        renderMultiShotCastChips();
        refreshMultiShotAgentPrompt();
      }
    });
    document.addEventListener('zaude:refmods-changed', () => {
      if (currentMode === 'script') renderMultiShotCastChips();
    });
  }

  const uploadBtn = $('ai-script-upload');
  if (uploadBtn && api.pickScript) {
    uploadBtn.addEventListener('click', async () => {
      const res = await api.pickScript();
      if (!res || res.canceled) return;
      if ($('ai-script-text') && res.rawText) $('ai-script-text').value = res.rawText;
      renderScriptShots(res, res.fileName || '');
      if (res.ok) setStatus(`Imported ${res.shots.length} shot(s) from ${res.fileName}.`);
      else setStatus(res.error || 'Could not parse script file.', true);
    });
  }

  const parseBtn = $('ai-script-parse');
  if (parseBtn && api.parseScript) {
    parseBtn.addEventListener('click', async () => {
      const raw = String(($('ai-script-text') && $('ai-script-text').value) || '');
      const res = await api.parseScript(raw);
      renderScriptShots(res);
      if (res.ok) setStatus(`Parsed ${res.shots.length} shot(s) from pasted script.`);
      else setStatus(res.error || 'Could not parse script.', true);
    });
  }

  const clearScriptBtn = $('ai-script-clear');
  if (clearScriptBtn) {
    clearScriptBtn.addEventListener('click', () => {
      if ($('ai-script-text')) $('ai-script-text').value = '';
      renderScriptShots(null);
    });
  }

  // Drag-and-drop .md / .txt file straight onto the script textarea
  const dropZone = $('ai-script-drop');
  if (dropZone && api.parseScript) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const text = await file.text();
      if ($('ai-script-text')) $('ai-script-text').value = text;
      const res = await api.parseScript(text);
      renderScriptShots(res, file.name);
      if (res.ok) setStatus(`Dropped ${file.name} — parsed ${res.shots.length} shot(s).`);
      else setStatus(res.error || 'Could not parse dropped file.', true);
    });
  }

  const scriptListEl = $('ai-script-list');
  if (scriptListEl) {
    scriptListEl.addEventListener('click', async (e) => {
      const loadBtn = e.target.closest('[data-script-load]');
      if (loadBtn) {
        loadScriptShotIntoStudio(Number(loadBtn.dataset.scriptLoad));
        return;
      }
      const runBtn = e.target.closest('[data-script-run]');
      if (runBtn) {
        const shot = parsedScriptShots[Number(runBtn.dataset.scriptRun)];
        if (!shot) return;
        const req = buildRequestForScriptShot(shot);
        const r = await api.mannimmateStart(req);
        if (r && r.ok) setStatus(`Queued Shot ${shot.shotNumber} on ${req.backend}!`);
        else setStatus((r && r.error) || 'Failed to queue shot.', true);
      }
    });
  }

  const queueAllBtn = $('ai-script-queue-all');
  if (queueAllBtn) {
    queueAllBtn.addEventListener('click', async () => {
      const checked = Array.from(document.querySelectorAll('#ai-script-list .ai-script-cb:checked'))
        .map((cb) => Number(cb.dataset.scriptCb))
        .filter((idx) => parsedScriptShots[idx]);
      if (!checked.length) return setStatus('Check at least one shot to queue.', true);
      let queued = 0;
      for (const idx of checked) {
        const req = buildRequestForScriptShot(parsedScriptShots[idx]);
        const r = await api.mannimmateStart(req);
        if (r && r.ok) queued += 1;
        else appendLog('ERR', `Shot ${parsedScriptShots[idx].shotNumber}: ${(r && r.error) || 'failed'}`);
      }
      setStatus(`Queued ${queued}/${checked.length} multi-shot clips into Zaude's render queue!`);
    });
  }

  // ---------- Create / Categorize / Delete RefMod Manager (with Tony Sheen Example Guide) ----------
  const rmcDialog = $('refmod-creator-dialog');
  let rmcImages = []; // [{ path, name, url }]
  let rmcVideos = []; // [{ path, name, url }]
  let rmcAudio = null; // { path, name, url }

  function renderRmcInputs() {
    const strip = $('rmc-img-strip');
    const cnt = $('rmc-img-count');
    if (cnt) cnt.textContent = `(${rmcImages.length} selected)`;
    if (strip) {
      strip.innerHTML = rmcImages.length
        ? rmcImages.map((img, i) => `
            <div class="rmc-thumb" title="${esc(img.name)}">
              <img src="${esc(img.url || '')}" alt="${esc(img.name)}">
              <button type="button" data-rmc-del-img="${i}" title="Remove">×</button>
            </div>
          `).join('')
        : `<div class="muted" style="font-size:11px">Add 3–6 crisp character angles (like Tony Sheen: front, 3/4, profile) or 8 room views for a Location RefMod.</div>`;
    }
    const audEl = $('rmc-audio-label');
    if (audEl) audEl.textContent = rmcAudio ? `🎙️ ${rmcAudio.name}` : 'No audio selected (visual-only RefMod).';
    const vidEl = $('rmc-video-label');
    if (vidEl) vidEl.textContent = rmcVideos.length ? `🎬 ${rmcVideos.map((v) => v.name).join(', ')}` : 'No videos selected.';
  }

  function openRefModCreator() {
    if (!rmcDialog) return;
    // Populate Tony Sheen's real headshot in the example guide if present in refmodEntries
    const tony = refmodEntries.find((m) => /tony_sheen/i.test(m.slug || m.file || ''));
    const av = $('rmc-tony-avatar');
    if (av && tony && tony.headshotUrl) {
      av.innerHTML = `<img src="${esc(tony.headshotUrl)}" alt="Tony Sheen Example">`;
    }
    renderRmcInputs();
    rmcDialog.hidden = false;
  }

  document.addEventListener('click', async (e) => {
    const folderPill = e.target.closest('[data-refmod-folder]');
    if (folderPill) {
      activeRefmodFolder = folderPill.dataset.refmodFolder || 'All';
      renderRefModGrid();
      return;
    }
    const folderBtn = e.target.closest('[data-folder-refmod]');
    if (folderBtn && api.refmodsSetFolder) {
      e.stopPropagation();
      const slug = folderBtn.dataset.folderRefmod;
      const cur = refmodEntries.find((m) => m.slug === slug);
      const curFolder = (cur && cur.folder) || 'General';
      const next = window.prompt(
        `Move "${(cur && cur.firstName) || slug}" to folder (e.g. Stories/Salabin, Stories/Changebang, Styles/2D, Styles/Photoreal, Locations, General):`,
        curFolder
      );
      if (next && next.trim()) {
        const res = await api.refmodsSetFolder({ slug, folder: next.trim() });
        if (res && res.ok && res.entry) {
          const i = refmodEntries.findIndex((m) => m.slug === slug);
          if (i >= 0) refmodEntries[i] = res.entry;
          renderRefModGrid();
          setStatus(`Moved "${res.entry.firstName}" → 📁 ${res.entry.folder}`);
        }
      }
      return;
    }
    const catPill = e.target.closest('[data-refmod-cat]');
    if (catPill) {
      activeRefmodCat = catPill.dataset.refmodCat || 'All';
      renderRefModGrid();
      return;
    }
    const voiceBtn = e.target.closest('[data-voice-refmod]');
    if (voiceBtn) {
      e.stopPropagation();
      if (window.__zaudeRefmodVoiceAudio) { try { window.__zaudeRefmodVoiceAudio.pause(); } catch { /* ignore */ } }
      window.__zaudeRefmodVoiceAudio = new Audio(voiceBtn.dataset.voiceRefmod);
      window.__zaudeRefmodVoiceAudio.play().catch(() => {});
      return;
    }
    const catBtn = e.target.closest('[data-cat-refmod]');
    if (catBtn && api.refmodsSetCategory) {
      e.stopPropagation();
      const slug = catBtn.dataset.catRefmod;
      const cur = refmodEntries.find((m) => m.slug === slug);
      const curCat = (cur && cur.category) || 'Characters';
      const nextIdx = (REFMOD_CAT_ORDER.indexOf(curCat) + 1) % REFMOD_CAT_ORDER.length;
      const nextCat = REFMOD_CAT_ORDER[nextIdx];
      const res = await api.refmodsSetCategory({ slug, category: nextCat });
      if (res && res.ok && res.entry) {
        const i = refmodEntries.findIndex((m) => m.slug === slug);
        if (i >= 0) refmodEntries[i] = res.entry;
        renderRefModGrid();
        setStatus(`Categorized "${res.entry.firstName}" → ${nextCat}`);
      }
      return;
    }
    const delBtn = e.target.closest('[data-del-refmod]');
    if (delBtn && api.refmodsDelete) {
      e.stopPropagation();
      const slug = delBtn.dataset.delRefmod;
      const cur = refmodEntries.find((m) => m.slug === slug);
      const label = (cur && (cur.firstName || cur.name)) || slug;
      if (!window.confirm(`Delete RefMod "${label}" from Zaude's library?`)) return;
      const res = await api.refmodsDelete({ slug });
      if (res && res.ok) {
        refmodEntries = refmodEntries.filter((m) => m.slug !== slug);
        if (cur) selectedRefmods = selectedRefmods.filter((f) => f !== cur.file);
        renderRefModGrid();
        setStatus(`Deleted RefMod "${label}" from library.`);
      }
      return;
    }
    if (e.target.closest('#ai-refmod-create-open') || e.target.closest('#ai-refmod-add-btn')) {
      e.stopPropagation();
      openRefModCreator();
      return;
    }
    if (e.target.closest('#rmc-close')) {
      if (rmcDialog) rmcDialog.hidden = true;
      return;
    }
    if (e.target.closest('#rmc-fill-tony')) {
      if ($('rmc-name')) $('rmc-name').value = 'tony_sheen_custom';
      if ($('rmc-display')) $('rmc-display').value = 'Tony Sheen';
      if ($('rmc-category')) $('rmc-category').value = '2D / Anime';
      if ($('rmc-subfolder')) $('rmc-subfolder').value = 'mannimmate_2d_v1';
      if ($('rmc-concept')) $('rmc-concept').value = 'identity';
      if ($('rmc-mode')) $('rmc-mode').value = 'Full Reference';
      if ($('rmc-res')) $('rmc-res').value = '1024';
      if ($('rmc-layout')) $('rmc-layout').value = 'bundle';
      if ($('rmc-merge')) $('rmc-merge').checked = false;
      if ($('rmc-status')) $('rmc-status').textContent = 'Loaded Tony Sheen example settings! Now pick 3–6 images (+ optional voice audio) and click Build.';
      return;
    }
    if (e.target.closest('#rmc-pick-images') && api.refmodsPickFiles) {
      const r = await api.refmodsPickFiles('images');
      if (r && r.ok && r.files) {
        rmcImages = [...rmcImages, ...r.files].slice(0, 16);
        renderRmcInputs();
      }
      return;
    }
    if (e.target.closest('#rmc-clear-images')) {
      rmcImages = [];
      renderRmcInputs();
      return;
    }
    const delImgBtn = e.target.closest('[data-rmc-del-img]');
    if (delImgBtn) {
      rmcImages.splice(Number(delImgBtn.dataset.rmcDelImg), 1);
      renderRmcInputs();
      return;
    }
    if (e.target.closest('#rmc-pick-audio') && api.refmodsPickFiles) {
      const r = await api.refmodsPickFiles('audio');
      if (r && r.ok && r.files && r.files[0]) {
        rmcAudio = r.files[0];
        renderRmcInputs();
      }
      return;
    }
    if (e.target.closest('#rmc-clear-audio')) {
      rmcAudio = null;
      renderRmcInputs();
      return;
    }
    if (e.target.closest('#rmc-pick-videos') && api.refmodsPickFiles) {
      const r = await api.refmodsPickFiles('videos');
      if (r && r.ok && r.files) {
        rmcVideos = [...rmcVideos, ...r.files].slice(0, 8);
        renderRmcInputs();
      }
      return;
    }
    if (e.target.closest('#rmc-clear-videos')) {
      rmcVideos = [];
      renderRmcInputs();
    }
  });

  const rmcForm = $('rmc-form');
  if (rmcForm && api.refmodsBuild) {
    rmcForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const statusEl = $('rmc-status');
      const submitBtn = $('rmc-submit');
      if (!rmcImages.length && !rmcVideos.length && !rmcAudio) {
        if (statusEl) statusEl.textContent = 'Pick at least one reference image, video, or voice audio file first.';
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (statusEl) statusEl.textContent = '🧬 Encoding RefMod on Tranklena ComfyUI…';
      const res = await api.refmodsBuild({
        name: String(($('rmc-name') && $('rmc-name').value) || '').trim(),
        displayName: String(($('rmc-display') && $('rmc-display').value) || '').trim(),
        category: String(($('rmc-category') && $('rmc-category').value) || 'Characters'),
        subfolder: String(($('rmc-subfolder') && $('rmc-subfolder').value) || '').trim(),
        conceptType: String(($('rmc-concept') && $('rmc-concept').value) || 'identity'),
        mode: String(($('rmc-mode') && $('rmc-mode').value) || 'Full Reference'),
        refResolution: Number(($('rmc-res') && $('rmc-res').value) || 1024),
        saveLayout: String(($('rmc-layout') && $('rmc-layout').value) || 'bundle'),
        merge: Boolean($('rmc-merge') && $('rmc-merge').checked),
        imagePaths: rmcImages.map((x) => x.path),
        videoPaths: rmcVideos.map((x) => x.path),
        audioPath: rmcAudio ? rmcAudio.path : '',
      });
      if (submitBtn) submitBtn.disabled = false;
      if (!res || !res.ok) {
        if (statusEl) statusEl.textContent = `Build failed: ${(res && res.error) || 'unknown error'}`;
        return;
      }
      if (res.entry) {
        const idx = refmodEntries.findIndex((m) => m.slug === res.entry.slug);
        if (idx >= 0) refmodEntries[idx] = res.entry;
        else refmodEntries.unshift(res.entry);
        renderRefModGrid();
      }
      if (statusEl) statusEl.textContent = `✅ Built "${res.refmodFile}" and added to ${res.entry ? res.entry.category : 'RefMod library'}!`;
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rmcDialog && !rmcDialog.hidden) { rmcDialog.hidden = true; return; }
    if (e.key === 'Escape' && !$('t2v-dialog').hidden) close();
  });
}

init();
