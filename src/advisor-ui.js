// Interactive Local GPU Hardware Analyzer, Live AI Web Research, and 1-Click Model + LoRA Installer.
const api = window.zaudeAdvisor || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let lastReport = null;
let installing = false;
let researching = false;
const installLines = [];

function renderReport(r) {
  lastReport = r;
  if ($('adv-comfy-dir') && !$('adv-comfy-dir').value && r.tools && r.tools.comfyDir) {
    $('adv-comfy-dir').value = r.tools.comfyDir;
  }

  $('adv-hw-grid').innerHTML = `
    <div class="adv-hw-card">
      <div class="adv-hw-k">GPU &amp; VRAM</div>
      <div class="adv-hw-v">${esc(r.gpu.name)}</div>
      <div class="muted">${r.gpu.vramTotalGb} GB VRAM (${r.gpu.vramFreeGb} GB free) · ${esc(r.gpu.archNote)}</div>
    </div>
    <div class="adv-hw-card">
      <div class="adv-hw-k">RAM &amp; CPU</div>
      <div class="adv-hw-v">${r.ram.totalGb} GB RAM (${r.ram.freeGb} GB free)</div>
      <div class="muted">${esc(r.cpu.model)} · ${r.cpu.cores} threads</div>
    </div>
    <div class="adv-hw-card">
      <div class="adv-hw-k">Storage &amp; Runtime</div>
      <div class="adv-hw-v">${r.disk.freeGb} GB free / ${r.disk.totalGb} GB</div>
      <div class="muted">ComfyUI: ${r.tools.comfyInstalled ? 'Installed' : 'Will auto-install'} · Optimizations: ${esc((r.optimizations.pipPackages || []).join(', ') || 'SDPA')}, ${esc((r.optimizations.comfyFlags || []).join(' '))}</div>
    </div>
  `;

  $('adv-model-list').innerHTML = (r.recommendations || []).map((m) => {
    const cls = m.fits ? 'fits' : 'heavy';
    const loraNames = (m.loras || []).map((l) => l.name).join(', ') || 'Standard / Remote';
    const nodeNames = (m.customNodes || []).map((n) => n.name).join(', ') || '—';
    const canInstall = m.fits && ((m.downloads && m.downloads.length) || (m.loras && m.loras.length));
    const blockerHtml = m.blockers && m.blockers.length
      ? `<div class="adv-blockers">${esc(m.blockers.join(' · '))}</div>`
      : '';
    return `<div class="adv-model-card ${cls}">
      <div class="adv-model-head">
        <div>
          <b>${esc(m.name)}</b>
          <span class="adv-badge ${cls}">${esc(m.badge)}</span>
          ${m.supportsFl2v ? '<span class="adv-tag">First+Last Frame</span>' : ''}
          ${m.supportsRefmod ? '<span class="adv-tag">RefMods</span>' : ''}
        </div>
        <button type="button" class="${canInstall ? 'ai' : ''}" data-adv-install="${esc(m.id)}" ${canInstall && !installing ? '' : 'disabled'}>
          ${canInstall ? '⬇ 1-Click Install' : (m.fits ? 'Remote Only' : 'Exceeds Hardware')}
        </button>
      </div>
      <div class="muted adv-model-desc">${esc(m.summary)}</div>
      <div class="adv-model-specs">
        <span>VRAM: ≥${m.minVramGb} GB</span>
        <span>RAM: ≥${m.minRamGb} GB</span>
        <span>Disk: ~${m.diskGb} GB</span>
        <span>Max: ${esc(m.maxRes)}</span>
        <span>Speed: ${esc(m.estSpeed8gb)}</span>
      </div>
      <div class="muted adv-model-extras">
        <b>LoRAs:</b> ${esc(loraNames)} · <b>Nodes &amp; Optimizations:</b> ${esc(nodeNames)}
      </div>
      ${blockerHtml}
    </div>`;
  }).join('');
}

async function analyze() {
  if (!api) return;
  const comfyDir = ($('adv-comfy-dir') && $('adv-comfy-dir').value.trim()) || undefined;
  const res = await api.analyze({ comfyDir });
  if (res && res.ok) renderReport(res);
}

async function open() {
  $('advisor-dialog').hidden = false;
  await analyze();
}

function close() {
  $('advisor-dialog').hidden = true;
}

async function startWebResearch() {
  if (!api || researching) return;
  researching = true;
  $('adv-web-search').disabled = true;
  $('adv-cancel-web').hidden = false;
  const box = $('adv-web-result');
  box.hidden = false;
  box.textContent = 'Searching the web via AI agent for the newest local video models, LoRAs & optimizations…\n';
  await api.research({
    provider: $('adv-provider').value,
    comfyDir: $('adv-comfy-dir').value.trim() || undefined,
  });
}

async function startInstall(modelId) {
  if (!api || installing) return;
  installing = true;
  installLines.length = 0;
  $('adv-install-box').hidden = false;
  $('adv-install-status').textContent = `Installing ${modelId} (ComfyUI + LoRAs + GPU optimizations)…`;
  $('adv-install-log').textContent = '';
  if (lastReport) renderReport(lastReport);
  const res = await api.install({
    modelId,
    comfyDir: $('adv-comfy-dir').value.trim() || undefined,
  });
  if (!res || !res.ok) {
    installing = false;
    $('adv-install-status').textContent = (res && res.error) || 'Could not start install.';
    if (lastReport) renderReport(lastReport);
  }
}

function init() {
  const btn = $('advisor-open');
  if (!btn) return;
  if (!api) {
    btn.disabled = true;
    btn.title = 'Local GPU Analyzer requires the desktop app';
    return;
  }
  btn.addEventListener('click', open);
  $('adv-close').addEventListener('click', close);
  $('adv-analyze').addEventListener('click', analyze);
  $('adv-web-search').addEventListener('click', startWebResearch);
  $('adv-cancel-web').addEventListener('click', () => api.cancelResearch());
  $('adv-cancel-install').addEventListener('click', () => api.cancelInstall());

  $('advisor-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'advisor-dialog') return close();
    const inst = e.target.closest('[data-adv-install]');
    if (inst && !inst.disabled) startInstall(inst.dataset.advInstall);
  });

  api.onEvent((ev) => {
    if (ev.scope === 'research') {
      const box = $('adv-web-result');
      if (ev.type === 'chunk') {
        if (box.textContent.startsWith('Searching the web')) box.textContent = '';
        box.textContent += ev.text;
        box.scrollTop = box.scrollHeight;
      } else if (ev.type === 'done') {
        researching = false;
        $('adv-web-search').disabled = false;
        $('adv-cancel-web').hidden = true;
        if (ev.ok && ev.text) {
          box.textContent = `[AI Web Research via ${ev.provider}]\n\n${ev.text}`;
        } else if (!ev.ok) {
          box.textContent = `Web research stopped: ${ev.error || 'unknown error'}`;
        }
      }
      return;
    }

    if (ev.scope === 'install') {
      if (ev.text) {
        installLines.push(ev.text);
        if (installLines.length > 300) installLines.splice(0, installLines.length - 300);
        const logEl = $('adv-install-log');
        logEl.textContent = installLines.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (ev.type === 'finished') {
        installing = false;
        $('adv-install-status').textContent = ev.ok
          ? `✅ Installed! Launch: ${ev.launchCmd}`
          : `❌ ${ev.error || 'Install failed'}`;
        analyze();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('advisor-dialog').hidden) close();
  });
}

init();
