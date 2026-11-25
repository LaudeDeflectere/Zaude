// Interactive Motion Analysis & Character A/B Cast Picker UI inside AI Studio's Stylize tab.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const PIN_COLORS = { A: '#38bdf8', B: '#f472b6', C: '#34d399', D: '#fbbf24' };

(function initRecastUI() {
  const api = window.zaudeAI || null;
  const analyzeBtn = $('ai-recast-analyze-btn');
  const drawer = $('ai-recast-drawer');
  if (!analyzeBtn || !drawer) return;

  let characters = []; // [{ id, label, x, y, description, refmod, refmodName, refImage, outfit, strength }]
  let activePinId = 'A';
  let refmodList = [];
  let analyzedMeta = null;

  async function ensureRefmods() {
    if (refmodList.length || !api || !api.refmodsList) return;
    try {
      const res = await api.refmodsList();
      if (res && res.ok && Array.isArray(res.refmods)) refmodList = res.refmods;
    } catch { /* ignore */ }
  }

  function renderPins() {
    const pinsEl = $('recast-pins');
    const barEl = $('recast-pin-bar');
    if (!pinsEl || !barEl) return;
    pinsEl.innerHTML = characters.map((c) => {
      const col = PIN_COLORS[c.id] || '#a78bfa';
      const activeCls = c.id === activePinId ? ' active' : '';
      return `<button type="button" class="recast-pin${activeCls}" data-pin-select="${esc(c.id)}"
        style="left:${(c.x * 100).toFixed(1)}%;top:${(c.y * 100).toFixed(1)}%;--pin-col:${col}"
        title="Character ${esc(c.id)} — click to select, then click anywhere on the frame to reposition">${esc(c.id)}</button>`;
    }).join('');
    barEl.innerHTML = characters.map((c) => {
      const col = PIN_COLORS[c.id] || '#a78bfa';
      const on = c.id === activePinId ? ' on' : '';
      return `<button type="button" class="recast-pin-pill${on}" data-pin-select="${esc(c.id)}" style="border-color:${col}">📍 Place Pin ${esc(c.id)}</button>`;
    }).join('');
  }

  function renderCharCards() {
    const cardsEl = $('recast-char-cards');
    if (!cardsEl) return;
    const optsHtml = '<option value="">— Keep / Skip —</option>' +
      refmodList.map((m) => `<option value="${esc(m.file)}">${esc(m.name || m.firstName || m.file)} (${esc(m.category || 'Characters')})</option>`).join('');

    cardsEl.innerHTML = characters.map((c) => {
      const col = PIN_COLORS[c.id] || '#a78bfa';
      return `<div class="recast-char-card" data-char-id="${esc(c.id)}" style="border-left:3px solid ${col}">
        <div class="recast-char-head">
          <b style="color:${col}">Character ${esc(c.id)}</b>
          <span class="muted" style="font-size:11px">${esc(c.description || (c.x < 0.5 ? 'Screen-left' : 'Screen-right'))}</span>
          ${characters.length > 1 ? `<button type="button" class="recast-rm" data-char-rm="${esc(c.id)}" title="Remove">×</button>` : ''}
        </div>
        <div class="recast-char-row">
          <select data-char-refmod="${esc(c.id)}">${optsHtml}</select>
          <button type="button" data-char-pic="${esc(c.id)}" title="Or pick a reference picture for Character ${esc(c.id)}">${c.refImage ? '🖼️ Pic ✓' : '🖼️ Pic'}</button>
        </div>
        <div class="recast-char-row">
          <input type="text" data-char-outfit="${esc(c.id)}" value="${esc(c.outfit || '')}" placeholder="Optional clothes / hair / damage override (e.g. no coat, zapped hair)">
          <span class="muted" style="font-size:10px;white-space:nowrap">Lock <b data-char-lock-lbl="${esc(c.id)}">${Number(c.strength ?? 1).toFixed(2)}</b></span>
          <input type="range" min="0.40" max="1.00" step="0.05" value="${Number(c.strength ?? 1).toFixed(2)}" data-char-strength="${esc(c.id)}" style="width:62px">
        </div>
      </div>`;
    }).join('');

    // Restore selected dropdown values
    for (const c of characters) {
      const sel = cardsEl.querySelector(`[data-char-refmod="${CSS.escape(c.id)}"]`);
      if (sel && c.refmod) sel.value = c.refmod;
    }
  }

  analyzeBtn.addEventListener('click', async () => {
    if (!api || !api.analyzeVideoMotion) return;
    const form = $('t2v-form');
    let videoPath = form && form.elements.video ? form.elements.video.value.trim() : '';
    let start = form && form.elements.start ? Number(form.elements.start.value) || 0 : 0;
    let end = form && form.elements.end ? Number(form.elements.end.value) || 5 : 5;

    // Auto-pick from timeline if no source video loaded yet
    if (!videoPath && window.__zaudeGetStylizeSource) {
      const src = await window.__zaudeGetStylizeSource();
      if (src && src.path) {
        videoPath = src.path;
        start = src.start;
        end = src.end;
        if (form) {
          form.elements.video.value = src.path;
          form.elements.start.value = String(src.start.toFixed(1));
          form.elements.end.value = String(src.end.toFixed(1));
        }
      }
    }
    if (!videoPath) {
      const st = $('recast-status');
      drawer.hidden = false;
      if (st) st.textContent = 'Pick a source video first (click "🎯 Pick from Timeline" or browse a video).';
      return;
    }

    drawer.hidden = false;
    const st = $('recast-status');
    const tag = $('recast-analyzer-tag');
    analyzeBtn.disabled = true;
    if (st) st.textContent = 'Extracting keyframes & analyzing movement / characters…';

    try {
      await ensureRefmods();
      const res = await api.analyzeVideoMotion({ videoPath, start, end });
      if (!res || !res.ok) {
        if (st) st.textContent = `Analysis failed: ${(res && res.error) || 'unknown error'}`;
        return;
      }
      analyzedMeta = { videoPath, start: res.start, end: res.end };
      characters = (res.characters || []).map((c) => ({
        ...c,
        refmod: '',
        refmodName: '',
        refImage: '',
        outfit: '',
        strength: 1.0,
      }));
      activePinId = characters[0] ? characters[0].id : 'A';
      const heroImg = $('recast-hero-img');
      if (heroImg && res.heroUrl) heroImg.src = res.heroUrl;
      const motionTa = $('recast-motion');
      if (motionTa) motionTa.value = res.motionSummary || '';
      if (tag) tag.textContent = `· ${res.analyzer || 'Analyzed'} · Click frame to adjust Pin ${activePinId}`;
      renderPins();
      renderCharCards();
      if (st) st.textContent = '✓ Ready! Click Character A / B on the frame, assign RefMods, set your new background, and click Generate.';
    } catch (e) {
      if (st) st.textContent = `Error: ${e.message || e}`;
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  // Click on the hero frame to place/move the active character pin
  $('recast-stage')?.addEventListener('click', (e) => {
    const pinBtn = e.target.closest('[data-pin-select]');
    if (pinBtn) {
      activePinId = pinBtn.dataset.pinSelect;
      renderPins();
      return;
    }
    const img = $('recast-hero-img');
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0.08, Math.min(0.92, (e.clientY - rect.top) / rect.height));
    const target = characters.find((c) => c.id === activePinId);
    if (target) {
      target.x = x;
      target.y = y;
      renderPins();
    }
  });

  drawer.addEventListener('click', async (e) => {
    if (e.target.closest('#recast-close')) { drawer.hidden = true; return; }
    if (e.target.closest('#recast-add-char')) {
      const nextLetter = ['A', 'B', 'C', 'D'].find((l) => !characters.some((c) => c.id === l));
      if (!nextLetter) return;
      characters.push({ id: nextLetter, label: `Character ${nextLetter}`, description: 'Custom pin', x: 0.5, y: 0.45, refmod: '', refmodName: '', refImage: '', outfit: '', strength: 1.0 });
      activePinId = nextLetter;
      renderPins();
      renderCharCards();
      return;
    }
    const pinSel = e.target.closest('[data-pin-select]');
    if (pinSel) { activePinId = pinSel.dataset.pinSelect; renderPins(); return; }

    const rm = e.target.closest('[data-char-rm]');
    if (rm) {
      characters = characters.filter((c) => c.id !== rm.dataset.charRm);
      if (!characters.some((c) => c.id === activePinId) && characters[0]) activePinId = characters[0].id;
      renderPins();
      renderCharCards();
      return;
    }

    const picBtn = e.target.closest('[data-char-pic]');
    if (picBtn && api && api.pickFile) {
      const picked = await api.pickFile('image');
      if (picked && !picked.canceled && picked.path) {
        const c = characters.find((x) => x.id === picBtn.dataset.charPic);
        if (c) { c.refImage = picked.path; renderCharCards(); }
      }
      return;
    }

    if (e.target.closest('#recast-generate-btn')) {
      if (!api || !api.buildRecastRequest || !api.generate) return;
      const st = $('recast-status');
      const hasCast = characters.some((c) => c.refmod || c.refImage);
      if (!hasCast) {
        if (st) st.textContent = 'Assign at least one RefMod or Picture to Character A or B first.';
        return;
      }
      const form = $('t2v-form');
      const resolution = form && form.elements.resolution ? Number(form.elements.resolution.value) : 480;
      const steps = form && form.elements.steps ? Number(form.elements.steps.value) || 6 : 6;
      const bgImage = form && form.elements.backgroundImage ? form.elements.backgroundImage.value.trim() : '';
      const built = await api.buildRecastRequest({
        videoPath: analyzedMeta ? analyzedMeta.videoPath : (form?.elements.video?.value || ''),
        start: analyzedMeta ? analyzedMeta.start : 0,
        end: analyzedMeta ? analyzedMeta.end : 5,
        characters,
        motionSummary: $('recast-motion')?.value || '',
        cameraMotion: '',
        newBackground: $('recast-bg')?.value || '',
        backgroundImage: bgImage,
        motionMode: $('recast-motion-mode')?.value || 'loose',
        resolution,
        steps,
        backend: 'remote',
      });
      if (!built || !built.ok) {
        if (st) st.textContent = `Could not build recast job: ${(built && built.error) || 'unknown'}`;
        return;
      }
      if (st) st.textContent = '🚀 Queuing Recast video on Tranklena…';
      const genRes = await api.generate(built);
      if (genRes && genRes.ok) {
        if (st) st.textContent = `✓ Queued recast job (${built.mode === 'refmod' ? 'General Motion' : 'Tight RV2V'})!`;
        const dlg = $('t2v-dialog');
        if (dlg) dlg.hidden = true;
      } else {
        if (st) st.textContent = `Failed: ${(genRes && genRes.error) || 'unknown error'}`;
      }
    }
  });

  drawer.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-char-refmod]');
    if (sel) {
      const c = characters.find((x) => x.id === sel.dataset.charRefmod);
      if (c) {
        c.refmod = sel.value;
        const m = refmodList.find((x) => x.file === sel.value);
        c.refmodName = m ? (m.name || m.firstName || m.file) : '';
      }
    }
  });

  drawer.addEventListener('input', (e) => {
    const outEl = e.target.closest('[data-char-outfit]');
    if (outEl) {
      const c = characters.find((x) => x.id === outEl.dataset.charOutfit);
      if (c) {
        const had = Boolean(c.outfit);
        c.outfit = outEl.value.trim();
        if (!had && c.outfit && c.strength >= 0.95) {
          c.strength = 0.70;
          const sl = drawer.querySelector(`[data-char-strength="${CSS.escape(c.id)}"]`);
          const lb = drawer.querySelector(`[data-char-lock-lbl="${CSS.escape(c.id)}"]`);
          if (sl) sl.value = '0.70';
          if (lb) lb.textContent = '0.70';
        }
      }
    }
    const strEl = e.target.closest('[data-char-strength]');
    if (strEl) {
      const c = characters.find((x) => x.id === strEl.dataset.charStrength);
      if (c) {
        c.strength = Number(strEl.value) || 0.7;
        const lb = drawer.querySelector(`[data-char-lock-lbl="${CSS.escape(c.id)}"]`);
        if (lb) lb.textContent = c.strength.toFixed(2);
      }
    }
  });
})();
