// Model & Parameter Quality Showcase Modal + Hover Video Preview Tooltips.
(function () {
  const api = window.zaudeAI;
  if (!api) return;

  let cachedManifest = null;
  let activeGroupId = 'resolution';
  let hoverTip = null;
  let hoverHideTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function ensureManifest(force = false) {
    if (cachedManifest && !force) return cachedManifest;
    if (!api.showcaseLoad) return null;
    cachedManifest = await api.showcaseLoad().catch(() => null);
    return cachedManifest;
  }

  function ensureHoverTip() {
    if (hoverTip) return hoverTip;
    hoverTip = document.createElement('div');
    hoverTip.id = 'ai-param-hover-tip';
    hoverTip.className = 'ai-param-hover-tip';
    hoverTip.hidden = true;
    hoverTip.addEventListener('pointerenter', () => { clearTimeout(hoverHideTimer); });
    hoverTip.addEventListener('pointerleave', () => { scheduleHideTip(); });
    document.body.appendChild(hoverTip);
    return hoverTip;
  }

  function scheduleHideTip() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (hoverTip) {
        hoverTip.querySelectorAll('video').forEach((v) => v.pause());
        hoverTip.hidden = true;
      }
    }, 180);
  }

  async function showHoverTip(paramKey, anchorEl) {
    clearTimeout(hoverHideTimer);
    const manifest = await ensureManifest();
    if (!manifest || !manifest.groups) return;
    const group = manifest.groups.find((g) => g.id === paramKey);
    if (!group) return;
    const tip = ensureHoverTip();
    tip.innerHTML = `
      <div class="ai-hover-tip-hdr">
        <strong>📊 ${esc(group.label)} Comparison</strong>
        <button type="button" class="ai-mini-btn" data-open-showcase="${esc(group.id)}">Open Full Guide →</button>
      </div>
      <div class="ai-hover-tip-sub">${esc(group.summary)}</div>
      <div class="ai-hover-tip-grid">
        ${group.items.slice(0, 3).map((it) => `
          <div class="ai-hover-tip-card">
            ${it.hasVideo && it.videoUrl
              ? `<video src="${esc(it.videoUrl)}" muted loop autoplay playsinline></video>`
              : `<div class="ai-hover-tip-placeholder">${esc(it.value)}<span>Click "Open Full Guide" to render on Tranklena</span></div>`}
            <div class="ai-hover-tip-cap"><b>${esc(it.label)}</b><span>${esc(it.note)}</span></div>
          </div>`).join('')}
      </div>`;
    const r = anchorEl.getBoundingClientRect();
    tip.style.left = `${Math.max(12, Math.min(window.innerWidth - 470, r.left))}px`;
    tip.style.top = `${Math.max(12, Math.min(window.innerHeight - 250, r.bottom + 8))}px`;
    tip.hidden = false;
  }

  function ensureModal() {
    let modal = document.getElementById('quality-showcase-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'quality-showcase-modal';
    modal.className = 't2v-backdrop';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="t2v-dialog qs-dialog" role="dialog" aria-modal="true" aria-label="Model & Parameter Quality Showcase">
        <div class="t2v-head">
          <h2>📊 Model &amp; Settings Quality Showcase</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="muted" style="font-size:11px">Rendered on Tranklena RTX 3090 (\$0 cloud)</span>
            <button type="button" class="t2v-close" id="qs-close" title="Close">✕</button>
          </div>
        </div>
        <div class="qs-tabs" id="qs-tabs"></div>
        <div class="qs-summary" id="qs-summary"></div>
        <div class="qs-grid" id="qs-grid"></div>
        <div class="qs-status muted" id="qs-status"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', async (e) => {
      if (e.target === modal || e.target.closest('#qs-close')) {
        modal.querySelectorAll('video').forEach((v) => v.pause());
        modal.hidden = true;
        return;
      }
      const tab = e.target.closest('[data-qs-tab]');
      if (tab) {
        activeGroupId = tab.dataset.qsTab;
        renderModal();
        return;
      }
      const renderBtn = e.target.closest('[data-qs-render]');
      if (renderBtn && api.showcaseRender) {
        const itemId = renderBtn.dataset.qsRender;
        const status = document.getElementById('qs-status');
        renderBtn.disabled = true;
        renderBtn.textContent = '⏳ Rendering on Tranklena…';
        if (status) status.textContent = `Rendering benchmark "${itemId}" on Tranklena RTX 3090…`;
        const res = await api.showcaseRender({ itemId }).catch((err) => ({ ok: false, error: err.message }));
        if (res && res.ok) {
          cachedManifest = res.manifest || await ensureManifest(true);
          renderModal();
          if (status) status.textContent = `✅ Rendered "${itemId}" in ${res.renderSec || '?'}s and saved to assets/benchmarks/.`;
        } else {
          renderBtn.disabled = false;
          renderBtn.textContent = '▶ Render on Tranklena';
          if (status) status.textContent = `Benchmark render failed: ${(res && res.error) || 'Check Tranklena connection'}`;
        }
      }
    });
    return modal;
  }

  function renderModal() {
    const modal = ensureModal();
    if (!cachedManifest || !cachedManifest.groups) return;
    const tabsEl = modal.querySelector('#qs-tabs');
    const sumEl = modal.querySelector('#qs-summary');
    const gridEl = modal.querySelector('#qs-grid');
    const group = cachedManifest.groups.find((g) => g.id === activeGroupId) || cachedManifest.groups[0];
    activeGroupId = group.id;

    tabsEl.innerHTML = cachedManifest.groups.map((g) =>
      `<button type="button" class="pa-lib-cat ${g.id === activeGroupId ? 'on' : ''}" data-qs-tab="${esc(g.id)}">${esc(g.label)}</button>`
    ).join('');
    sumEl.innerHTML = `<strong>${esc(group.label)}:</strong> ${esc(group.summary)}`;
    gridEl.innerHTML = group.items.map((it) => `
      <div class="qs-card">
        <div class="qs-media">
          ${it.hasVideo && it.videoUrl
            ? `<video src="${esc(it.videoUrl)}" controls muted loop autoplay playsinline></video>`
            : `<div class="qs-empty"><span>${esc(it.resolution)}p · ${esc(it.fps)} fps · id ${esc(it.identityStrength)}</span><small>Not yet rendered locally</small></div>`}
        </div>
        <div class="qs-body">
          <div class="qs-title">${esc(it.label)}</div>
          <div class="qs-meta">${esc(it.resolution)}p · ${esc(it.fps)} fps · ${esc(it.steps)} steps · ID ${esc(it.identityStrength)} · Voice ${esc(it.voiceStrength)}${it.renderSec ? ` · ⏱ ${it.renderSec}s` : ''}</div>
          <div class="qs-note">${esc(it.note)}</div>
          <button type="button" class="ai-btn-purple qs-render-btn" data-qs-render="${esc(it.id)}">${it.hasVideo ? '↻ Re-render on Tranklena' : '▶ Render on Tranklena'}</button>
        </div>
      </div>`).join('');
  }

  async function openShowcase(groupId = 'resolution') {
    activeGroupId = groupId || 'resolution';
    const modal = ensureModal();
    await ensureManifest(true);
    renderModal();
    modal.hidden = false;
  }

  // Delegate hover on [data-param-hover] labels and clicks on [data-open-showcase]
  document.addEventListener('pointerenter', (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-param-hover]');
    if (el) showHoverTip(el.dataset.paramHover, el);
  }, true);
  document.addEventListener('pointerleave', (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-param-hover]');
    if (el) scheduleHideTip();
  }, true);
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-open-showcase]');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (hoverTip) hoverTip.hidden = true;
      openShowcase(btn.dataset.openShowcase || 'resolution');
    }
  });

  window.__zaudeOpenQualityShowcase = openShowcase;
})();
