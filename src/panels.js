// The content of each window type. Every panel builds its DOM once, updates from the store,
// and uses delegated listeners so it can be moved or rebuilt without losing state.
import * as T from './timeline.js';
import { TOOLS, PAGES, EXPORT_PRESETS, ASPECT_RATIOS, RES_TIERS, exportDimensions } from './actions.js';
import { timelineThumbStages } from './thumbs.js';
import { drawWaveform } from './waveform.js';
import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex, normalizeHex, getHslBands, isBandActive, MAX_HSL_BANDS } from './color.js';
import { buildAgentStateSnapshot, executeAgentTool } from './agent-bridge.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TRACKS = [
  { id: 'V2', label: 'Video 2' }, { id: 'V1', label: 'Video 1' }, { id: 'A1', label: 'Audio 1' }, { id: 'A2', label: 'Audio 2' },
];
const RULER_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function el(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

// ---------- Bin ----------

export function binPanel({ store, actions, engine, thumbs }) {
  const root = el(`<div class="panel bin">
    <div class="panel-bar">
      <button data-act="import">Import folder</button>
      <button data-act="save">Save project</button>
    </div>
    <div class="bin-folder muted"></div>
    <div class="bin-grid" role="listbox" aria-label="Bin"></div>
    <div class="hint muted">Hover any video to scrub preview. Double-click or click + to add at playhead.</div>
  </div>`);
  const grid = root.querySelector('.bin-grid');

  // Single reusable hover-scrub <video> so even 100+ videos stay fast and light on RAM.
  const hoverVideo = document.createElement('video');
  hoverVideo.className = 'bin-hover-video';
  hoverVideo.muted = true;
  hoverVideo.playsInline = true;
  hoverVideo.preload = 'auto';
  const hoverBar = document.createElement('span');
  hoverBar.className = 'bin-scrub-bar';
  const hoverHead = document.createElement('span');
  hoverHead.className = 'bin-scrub-head';
  hoverBar.appendChild(hoverHead);

  let activeCard = null;
  let activePath = null;
  let hoverToken = 0;
  let pendingFrac = null;
  let lastMediaRef = null;
  let lastSelected = null;

  function applyHoverSeek(f) {
    hoverHead.style.left = (f * 100) + '%';
    if (Number.isFinite(hoverVideo.duration) && hoverVideo.duration > 0) {
      pendingFrac = null;
      try { hoverVideo.currentTime = f * hoverVideo.duration; } catch { /* ignore */ }
    } else {
      pendingFrac = f;
    }
  }

  hoverVideo.addEventListener('loadedmetadata', () => {
    if (pendingFrac !== null) applyHoverSeek(pendingFrac);
  });

  let hoverReleaseTimer = null;
  function stopHover() {
    hoverToken += 1;
    activeCard = null;
    activePath = null;
    pendingFrac = null;
    hoverVideo.pause();
    hoverVideo.remove();
    hoverBar.remove();
    clearTimeout(hoverReleaseTimer);
    hoverReleaseTimer = setTimeout(() => {
      if (activeCard) return;
      hoverVideo.removeAttribute('src');
      try { hoverVideo.load(); } catch { /* ignore */ }
    }, 2000);
  }

  function startHover(card, clientX) {
    const filePath = card.dataset.bin;
    const kind = card.dataset.kind;
    if (kind !== 'video' || !engine || !engine.getMediaUrl) return;
    const stage = card.querySelector('.bin-thumb');
    if (!stage) return;

    const r = stage.getBoundingClientRect();
    const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;

    if (activeCard !== card) {
      activeCard = card;
      activePath = filePath;
      stage.append(hoverVideo, hoverBar);
      const token = ++hoverToken;
      engine.getMediaUrl(filePath).then((url) => {
        if (token !== hoverToken || activePath !== filePath || !url) return;
        if (hoverVideo.src !== url) hoverVideo.src = url;
        applyHoverSeek(f);
      });
    }
    applyHoverSeek(f);
  }

  grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.bin-card[data-bin]');
    if (!card || card.dataset.kind !== 'video') {
      if (activeCard) stopHover();
      return;
    }
    startHover(card, e.clientX);
  });
  grid.addEventListener('pointerleave', stopHover);

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'import') actions.importFolder();
      if (act.dataset.act === 'save') actions.saveProject();
      if (act.dataset.act === 'add') {
        e.stopPropagation();
        actions.addBinItem(act.dataset.path);
      }
      return;
    }
    const item = e.target.closest('[data-bin]');
    if (item) actions.selectBin(item.dataset.bin);
  });
  root.addEventListener('dblclick', (e) => {
    const item = e.target.closest('[data-bin]');
    if (item) actions.addBinItem(item.dataset.bin);
  });

  function formatDur(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function update(s) {
    const folderEl = root.querySelector('.bin-folder');
    folderEl.textContent = s.zdFilePath
      ? `${s.projectName}.zd · ${s.zdFilePath}`
      : s.projectFolder
        ? `${s.projectName} · ${s.projectFolder}`
        : 'No folder or .zd open. Import a folder or click Open .zd.';
    folderEl.title = s.zdFilePath || s.projectFolder || '';

    // Avoid rebuilding the grid if media list hasn't changed; just toggle selection class.
    if (lastMediaRef === s.media) {
      if (lastSelected !== s.binSelected) {
        lastSelected = s.binSelected;
        grid.querySelectorAll('.bin-card').forEach((c) => {
          const isSel = c.dataset.bin === s.binSelected;
          c.classList.toggle('sel', isSel);
          c.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });
      }
      return;
    }

    lastMediaRef = s.media;
    lastSelected = s.binSelected;
    stopHover();

    if (!s.media.length) {
      grid.innerHTML = '<div class="bin-empty muted">No files yet.</div>';
      return;
    }

    grid.innerHTML = s.media.map((m) => {
      const sel = s.binSelected === m.path ? ' sel' : '';
      const dur = formatDur(m.duration);
      const posterTime = m.duration ? Math.min(0.5, m.duration * 0.1) : 0;
      const cached = m.kind === 'video' && thumbs ? thumbs.getCached(m.path, posterTime) : null;
      const bgStyle = cached ? ` style="background-image:url('${cached}')"` : '';
      const audioBadge = m.kind === 'audio' ? '<span class="bin-audio-icon" aria-hidden="true">♪</span>' : '';
      return `<div class="bin-card${sel}" role="option" aria-selected="${sel ? 'true' : 'false'}" data-bin="${esc(m.path)}" data-kind="${esc(m.kind)}" title="${esc(m.name)}">
        <div class="bin-thumb${m.kind === 'audio' ? ' is-audio' : ''}"${bgStyle}>
          ${audioBadge}
          ${dur ? `<span class="bin-dur">${dur}</span>` : ''}
          <button type="button" class="bin-quick-add" data-act="add" data-path="${esc(m.path)}" title="Add to timeline at playhead">+</button>
        </div>
        <div class="bin-card-name">${esc(m.name)}</div>
      </div>`;
    }).join('');

    // Request poster frames asynchronously for any uncached videos.
    if (thumbs) {
      for (const m of s.media) {
        if (m.kind !== 'video') continue;
        const posterTime = m.duration ? Math.min(0.5, m.duration * 0.1) : 0;
        if (thumbs.getCached(m.path, posterTime)) continue;
        thumbs.request(m.path, posterTime).then((url) => {
          if (!url || lastMediaRef !== s.media) return;
          const card = Array.from(grid.querySelectorAll('.bin-card')).find((el_) => el_.dataset.bin === m.path);
          const thumb = card && card.querySelector('.bin-thumb');
          if (thumb) thumb.style.backgroundImage = `url('${url}')`;
        });
      }
    }
  }

  return { el: root, update, destroy: stopHover };
}

// ---------- Viewer ----------

export function viewerPanel({ store, actions, engine }) {
  const root = el(`<div class="panel viewer">
    <div class="viewer-stage">
      <div class="viewer-frame">
        <div class="viewer-export-matte" aria-hidden="true">
          <span class="viewer-aspect-tag"></span>
        </div>
      </div>
      <div class="viewer-text muted"></div>
      <div class="viewer-transform-hud" hidden></div>
      <div class="dropper-loupe" hidden><span class="dropper-swatch"></span><span class="dropper-hex">#000000</span></div>
    </div>
    <div class="transport">
      <button data-act="play" aria-label="Play" title="Play / Pause (Space)">▶</button>
      <span class="tc"></span>
      <span class="gpu-pill muted" hidden></span>
      <span class="grow"></span>
      <span class="log" aria-live="polite"></span>
    </div>
    <div class="scrubbar" role="slider" aria-label="Scrub through the timeline" tabindex="0">
      <div class="scrub-fill"></div><div class="scrub-head"></div>
      <div class="scrub-tip" hidden></div>
    </div>
  </div>`);
  const stage = root.querySelector('.viewer-stage');
  const frame = root.querySelector('.viewer-frame');
  const aspectTag = root.querySelector('.viewer-aspect-tag');
  const bar = root.querySelector('.scrubbar');
  const tip = root.querySelector('.scrub-tip');
  const loupe = root.querySelector('.dropper-loupe');
  const loupeSwatch = root.querySelector('.dropper-swatch');
  const loupeHex = root.querySelector('.dropper-hex');
  const transformHud = root.querySelector('.viewer-transform-hud');
  let hudTimer = null;
  const gpuPill = root.querySelector('.gpu-pill');
  if (engine.getGpuInfo) {
    const raw = engine.getGpuInfo();
    if (raw) {
      const short = /NVIDIA|RTX|GTX/i.test(raw)
        ? (raw.match(/(?:RTX|GTX)\s+[0-9A-Za-z ]+/)?.[0]?.trim() || 'NVIDIA GPU')
        : /Intel/i.test(raw) ? 'Intel GPU'
        : /SwiftShader|llvmpipe|Software/i.test(raw) ? 'CPU Software WebGL'
        : raw.slice(0, 24);
      gpuPill.textContent = 'GPU: ' + short;
      gpuPill.title = raw;
      gpuPill.hidden = false;
      gpuPill.classList.toggle('is-sw', /SwiftShader|llvmpipe|Software/i.test(raw));
    }
  }

  function ensureVideoAttached() {
    if (!engine.video.isConnected || engine.video.parentElement !== frame) frame.prepend(engine.video);
    if (engine.glCanvas && (!engine.glCanvas.isConnected || engine.glCanvas.parentElement !== frame)) engine.video.after(engine.glCanvas);
    if (engine.fxOverlay && (!engine.fxOverlay.isConnected || engine.fxOverlay.parentElement !== frame)) (engine.glCanvas || engine.video).after(engine.fxOverlay);
  }
  ensureVideoAttached();

  // Size the white inner export frame to match exportCfg.aspect with darkened pasteboard space around it.
  function layoutExportFrame(s) {
    const cfg = (s || store.get()).exportCfg || { aspect: '16:9', resTier: '1080' };
    const parts = String(cfg.aspect || '16:9').split(':').map(Number);
    const aw = parts[0] > 0 ? parts[0] : 16;
    const ah = parts[1] > 0 ? parts[1] : 9;
    const pad = 0.84; // 16% outer pasteboard margin so clips outside the export box remain visible
    const sw = Math.max(40, stage.clientWidth * pad);
    const sh = Math.max(40, stage.clientHeight * pad);
    let fw = sw;
    let fh = (sw * ah) / aw;
    if (fh > sh) {
      fh = sh;
      fw = (sh * aw) / ah;
    }
    frame.style.width = Math.max(24, Math.round(fw)) + 'px';
    frame.style.height = Math.max(24, Math.round(fh)) + 'px';
    const dims = exportDimensions(cfg.aspect, cfg.resTier);
    aspectTag.textContent = `${cfg.aspect} · ${dims.width}×${dims.height}`;
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layoutExportFrame()).observe(stage);
  }

  function showTransformHud(clip) {
    if (!clip) return;
    const sc = T.propValue(clip, 'scale');
    const rot = T.propValue(clip, 'rotation');
    const px = T.propValue(clip, 'posX');
    const py = T.propValue(clip, 'posY');
    transformHud.textContent = `Scale ${sc}% · Rot ${rot > 0 ? '+' : ''}${rot}° · Pos ${px > 0 ? '+' : ''}${px}%, ${py > 0 ? '+' : ''}${py}%`;
    transformHud.hidden = false;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { transformHud.hidden = true; }, 1300);
  }

  function targetVideoClip() {
    const s = store.get();
    const atHead = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), s.playhead);
    if (atHead) {
      if (s.selected !== atHead.id) actions.select(atHead.id);
      return atHead;
    }
    const sel = s.selected ? T.findClip(s.clips, s.selected) : null;
    return sel && sel.kind === 'video' ? sel : null;
  }

  // Apple Maps-style trackpad & touch gestures over the Viewer:
  // - Pinch (ctrlKey wheel, with or without Shift) -> Zoom / Scale
  // - Shift + Two-finger swipe (L/R/U/D) -> Pan Position X / Y
  // - Two-finger twist (native gesturechange / 2-pointer touch) OR Shift+Alt / R + scroll -> Rotate
  let scaleAccum = 100;
  let rotAccum = 0;
  let panXAccum = 0;
  let panYAccum = 0;
  let accumClipId = null;
  let accumTimer = null;
  let rKeyDown = false;
  let shiftKeyDown = false;
  let stageHovered = false;
  let lastScrewRotateAt = 0;

  const onKeyDownMod = (e) => {
    if (e.key === 'r' || e.key === 'R') rKeyDown = true;
    if (e.key === 'Shift') shiftKeyDown = true;
  };
  const onKeyUpMod = (e) => {
    if (e.key === 'r' || e.key === 'R') rKeyDown = false;
    if (e.key === 'Shift') shiftKeyDown = false;
  };
  window.addEventListener('keydown', onKeyDownMod);
  window.addEventListener('keyup', onKeyUpMod);

  stage.addEventListener('pointerenter', () => { stageHovered = true; });
  stage.addEventListener('pointerleave', () => { stageHovered = false; });

  // Native Linux evdev 1-finger-anchored screw rotation (one finger stays still, second orbits)
  const offTouchpadRotate = (window.zaudeTouchpad && window.zaudeTouchpad.onRotate)
    ? window.zaudeTouchpad.onRotate(({ deltaAngle }) => {
        if (!stageHovered || !Number.isFinite(deltaAngle)) return;
        const clip = targetVideoClip();
        if (!clip) return;
        lastScrewRotateAt = performance.now();
        syncAccum(clip);
        const speedMul = shiftKeyDown ? 0.5 : 1;
        rotAccum = Math.min(180, Math.max(-180, rotAccum + deltaAngle * speedMul));
        actions.transformClip(clip.id, { rotation: Math.round(rotAccum) });
        showTransformHud(T.findClip(store.get().clips, clip.id));
      })
    : null;

  function syncAccum(clip) {
    if (accumClipId !== clip.id) {
      accumClipId = clip.id;
      scaleAccum = T.propValue(clip, 'scale');
      rotAccum = T.propValue(clip, 'rotation');
      panXAccum = T.propValue(clip, 'posX');
      panYAccum = T.propValue(clip, 'posY');
    }
    clearTimeout(accumTimer);
    accumTimer = setTimeout(() => { accumClipId = null; }, 350);
  }

  stage.addEventListener('wheel', (e) => {
    // Allow pinch-to-zoom directly (e.ctrlKey) OR any Shift+trackpad gesture
    if (!e.shiftKey && !e.ctrlKey && !rKeyDown) return;
    const clip = targetVideoClip();
    if (!clip) return;
    e.preventDefault();
    const mul = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * mul;
    const dy = e.deltaY * mul;
    syncAccum(clip);

    if (e.ctrlKey) {
      // Suppress accidental pinch-zoom jitter while a hardware screw-rotation is actively turning
      if (performance.now() - lastScrewRotateAt < 180) return;
      // Pinch-to-zoom: +50% faster by default (0.975), half speed when holding Shift (0.4875)
      const pinchGain = e.shiftKey ? 0.4875 : 0.975;
      scaleAccum = Math.min(400, Math.max(10, scaleAccum - dy * pinchGain));
      actions.transformClip(clip.id, { scale: Math.round(scaleAccum) });
    } else if (rKeyDown || e.altKey) {
      // Screw-rotate fallback on Linux Wayland when /dev/input isn't readable
      const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      const rotGain = e.shiftKey ? 0.125 : 0.25;
      rotAccum = Math.min(180, Math.max(-180, rotAccum + d * rotGain));
      actions.transformClip(clip.id, { rotation: Math.round(rotAccum) });
    } else if (e.shiftKey) {
      // Apple Maps pan: two-finger left/right/up/down moves clip position X/Y
      panXAccum = Math.min(100, Math.max(-100, panXAccum - dx * 0.14));
      panYAccum = Math.min(100, Math.max(-100, panYAccum - dy * 0.14));
      actions.transformClip(clip.id, { posX: Math.round(panXAccum), posY: Math.round(panYAccum) });
    }
    showTransformHud(T.findClip(store.get().clips, clip.id));
  }, { passive: false });

  // Native macOS/WebKit/Wayland gesture events (two-finger pinch + twist rotation like Apple Maps)
  let gestBaseScale = 100;
  let gestBaseRot = 0;
  stage.addEventListener('gesturestart', (e) => {
    const clip = targetVideoClip();
    if (!clip) return;
    e.preventDefault();
    gestBaseScale = T.propValue(clip, 'scale');
    gestBaseRot = T.propValue(clip, 'rotation');
  }, { passive: false });
  stage.addEventListener('gesturechange', (e) => {
    const clip = targetVideoClip();
    if (!clip) return;
    e.preventDefault();
    const nextScale = Math.round(Math.min(400, Math.max(10, gestBaseScale * (e.scale || 1))));
    const nextRot = Math.round(Math.min(180, Math.max(-180, gestBaseRot + (e.rotation || 0))));
    actions.transformClip(clip.id, { scale: nextScale, rotation: nextRot });
    showTransformHud(T.findClip(store.get().clips, clip.id));
  }, { passive: false });

  // Multi-touch 2-finger pinch + twist ("hold like a screw and turn") for touchscreens / raw touchpads
  const activeTouches = new Map();
  let touchStartDist = 0;
  let touchStartAngle = 0;
  let touchBaseScale = 100;
  let touchBaseRot = 0;

  stage.addEventListener('pointermove', (e) => {
    if (activeTouches.has(e.pointerId)) {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size === 2) {
        const [p1, p2] = Array.from(activeTouches.values());
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
        const clip = targetVideoClip();
        if (clip && touchStartDist > 5) {
          let dAngle = angle - touchStartAngle;
          if (dAngle > 180) dAngle -= 360;
          if (dAngle < -180) dAngle += 360;
          actions.transformClip(clip.id, {
            scale: Math.round(Math.min(400, Math.max(10, touchBaseScale * (dist / touchStartDist)))),
            rotation: Math.round(Math.min(180, Math.max(-180, touchBaseRot + dAngle))),
          });
          showTransformHud(T.findClip(store.get().clips, clip.id));
        }
        return;
      }
    }
    if (!store.get().eyedropper) { loupe.hidden = true; return; }
    const picked = engine.samplePixel ? engine.samplePixel(e.clientX, e.clientY, frame) : null;
    if (!picked) { loupe.hidden = true; return; }
    const r = stage.getBoundingClientRect();
    loupe.hidden = false;
    loupe.style.left = Math.min(r.width - 92, Math.max(8, e.clientX - r.left + 14)) + 'px';
    loupe.style.top = Math.max(8, e.clientY - r.top - 34) + 'px';
    loupeSwatch.style.background = picked.hex;
    loupeHex.textContent = picked.hex.toUpperCase();
  });
  stage.addEventListener('pointerup', (e) => activeTouches.delete(e.pointerId));
  stage.addEventListener('pointercancel', (e) => activeTouches.delete(e.pointerId));
  stage.addEventListener('pointerleave', () => { loupe.hidden = true; });
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size === 2) {
        const [p1, p2] = Array.from(activeTouches.values());
        touchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        touchStartAngle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
        const clip = targetVideoClip();
        if (clip) {
          touchBaseScale = T.propValue(clip, 'scale');
          touchBaseRot = T.propValue(clip, 'rotation');
        }
        return;
      }
    }
    const mode = store.get().eyedropper;
    if (mode && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      const picked = engine.samplePixel ? engine.samplePixel(e.clientX, e.clientY, frame) : null;
      loupe.hidden = true;
      actions.setEyedropper(false);
      if (picked) actions.setHslTarget(picked.hex, mode === 'add');
      return;
    }
    // Shift + drag on Viewer -> pan video X/Y directly (or Shift+Alt+drag to rotate around center)
    if (e.shiftKey && e.button === 0) {
      const clip = targetVideoClip();
      if (!clip) return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const baseX = T.propValue(clip, 'posX');
      const baseY = T.propValue(clip, 'posY');
      const baseRot = T.propValue(clip, 'rotation');
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const startAngle = (Math.atan2(startY - cy, startX - cx) * 180) / Math.PI;
      const rotateMode = e.altKey || rKeyDown;
      stage.classList.add('transform-drag');
      const move = (ev) => {
        if (rotateMode) {
          const curAngle = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
          let d = curAngle - startAngle;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          actions.transformClip(clip.id, { rotation: Math.round(Math.min(180, Math.max(-180, baseRot + d))) });
        } else {
          const dxPct = r.width > 0 ? ((ev.clientX - startX) / r.width) * 100 : 0;
          const dyPct = r.height > 0 ? ((ev.clientY - startY) / r.height) * 100 : 0;
          actions.transformClip(clip.id, {
            posX: Math.round(Math.min(100, Math.max(-100, baseX + dxPct))),
            posY: Math.round(Math.min(100, Math.max(-100, baseY + dyPct))),
          });
        }
        showTransformHud(T.findClip(store.get().clips, clip.id));
      };
      const up = () => {
        stage.classList.remove('transform-drag');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
  });

  function timeFromX(clientX) {
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const end = T.projectEnd(store.get().clips);
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { t: f * end, f };
  }

  bar.addEventListener('pointermove', (e) => {
    const { t, f } = timeFromX(e.clientX);
    tip.hidden = false;
    tip.textContent = T.timecode(t);
    tip.style.left = (f * 100) + '%';
  });
  bar.addEventListener('pointerleave', () => { tip.hidden = true; });
  bar.addEventListener('pointerdown', (e) => {
    try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }
    actions.seekTo(timeFromX(e.clientX).t);
    const move = (ev) => actions.seekTo(timeFromX(ev.clientX).t);
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); actions.stepBy(e.shiftKey ? -1 : -1 / T.FPS); }
    if (e.key === 'ArrowRight') { e.preventDefault(); actions.stepBy(e.shiftKey ? 1 : 1 / T.FPS); }
  });
  root.querySelector('[data-act="play"]').addEventListener('click', () => actions.togglePlay());

  function timeText(s) {
    return T.timecode(s.playhead) + ' / ' + T.timecode(T.projectEnd(s.clips));
  }

  function updateTime(s) {
    root.querySelector('.tc').textContent = timeText(s);
    const end = T.projectEnd(s.clips);
    const f = end ? Math.min(1, Math.max(0, s.playhead / end)) : 0;
    root.querySelector('.scrub-fill').style.width = (f * 100) + '%';
    root.querySelector('.scrub-head').style.left = (f * 100) + '%';
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(Math.round(end * 100) / 100));
    bar.setAttribute('aria-valuenow', String(Math.round(s.playhead * 100) / 100));
  }

  function update(s) {
    ensureVideoAttached();
    layoutExportFrame(s);
    stage.classList.toggle('eyedropper-on', Boolean(s.eyedropper));
    if (!s.eyedropper) loupe.hidden = true;
    const btn = root.querySelector('[data-act="play"]');
    btn.textContent = s.playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    const c = T.clipAt(s.clips, s.playhead);
    const labelEl = root.querySelector('.viewer-text');
    if (c && c.generating) {
      const stepInfo = c.step >= 1 && c.totalSteps ? `Step ${c.step}/${c.totalSteps}` : (c.progress != null ? `${Math.round(c.progress * 100)}%` : 'Starting…');
      const etaInfo = c.etaSec > 0 ? ` · ~${Math.max(1, Math.round(c.etaSec))}s left` : '';
      const pct = c.progress != null ? Math.max(4, Math.min(100, Math.round(c.progress * 100))) : 12;
      if (c.previewUrl) {
        labelEl.innerHTML = `<img class="viewer-gen-preview" src="${esc(c.previewUrl)}" alt="Live generation preview"><span class="viewer-gen-tag">#${c.queuePos || 1} · ${esc(stepInfo)}${esc(etaInfo)}</span>`;
        labelEl.className = 'viewer-text viewer-gen-wrap';
      } else {
        labelEl.innerHTML = `<div class="viewer-gen-hud"><div class="viewer-gen-hud-title">✨ ${esc(c.name)}</div><div class="viewer-gen-hud-sub">#${c.queuePos || 1} · ${esc(stepInfo)}${esc(etaInfo)}</div><div class="viewer-gen-hud-bar"><span style="width:${pct}%"></span></div></div>`;
        labelEl.className = 'viewer-text viewer-gen-wrap';
      }
    } else if (c && !c.path) {
      labelEl.textContent = c.name;
      labelEl.className = 'viewer-text viewer-badge';
    } else if (!c) {
      labelEl.textContent = 'No clip at playhead';
      labelEl.className = 'viewer-text muted';
    } else {
      labelEl.textContent = '';
      labelEl.className = 'viewer-text';
    }
    const logEl = root.querySelector('.log');
    logEl.textContent = s.log;
    logEl.title = s.log;
    updateTime(s);
  }

  return {
    el: root,
    update,
    updateTime,
    destroy() {
      window.removeEventListener('keydown', onKeyDownMod);
      window.removeEventListener('keyup', onKeyUpMod);
      if (offTouchpadRotate) offTouchpadRotate();
    },
  };
}

// ---------- Timeline ----------

export function timelinePanel({ store, actions, thumbs, waveforms }) {
  const root = el(`<div class="panel timeline">
    <div class="tl-body">
      <div class="scroller">
        <div class="tl-grid">
          <div class="tl-corner"></div>
          <div class="ruler" aria-label="Ruler. Click to move the playhead."></div>
          <div class="labels"></div>
          <div class="canvas">
            <div class="beat-grid" aria-hidden="true"></div>
            <div class="tracks"></div>
            <div class="playhead" aria-hidden="true"></div>
            <div class="marquee" hidden aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="tl-bar">
      <button data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button data-act="split" title="Split at playhead (S)">✂ Split</button>
      <button data-act="trim" title="Trim end to playhead">Trim</button>
      <button data-act="delete" title="Delete (Delete key)">Delete</button>
      <button data-act="duplicate" title="Duplicate">Duplicate</button>
      <button data-act="snap" class="snap-btn" title="Magnetic snap (clips & beats)">Snap</button>
      <button data-act="add-video-track" title="Add a new Video track row">+V</button>
      <button data-act="add-audio-track" title="Add a new Audio track row">+A</button>
      <span class="sep"></span>
      <button data-act="detect-beats" class="beats-btn" title="Detect tempo, downbeats & beat markers from audio">♫ Beats</button>
      <span class="beat-ctl" hidden>
        <input type="number" class="beat-bpm" min="30" max="300" step="0.5" title="BPM" aria-label="BPM">
        <button data-act="beat-nudge-l" title="Nudge beat grid −10 ms">−10ms</button>
        <button data-act="beat-nudge-r" title="Nudge beat grid +10 ms">+10ms</button>
        <button data-act="beat-sub" class="beat-sub-btn" title="Cycle beat subdivisions (1×, 2×, 4×)">2×</button>
        <button data-act="beat-add-marker" title="Add beat marker at playhead (M)">+M</button>
        <button data-act="beat-clear" title="Clear beat grid & markers">×</button>
      </span>
      <span class="sep"></span>
      <button data-act="zoomOut" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button data-act="zoomIn" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button data-act="fit" title="Fit the whole timeline">Fit</button>
      <div class="grow"></div>
      <span class="muted tl-info"></span>
    </div>
  </div>`);
  const scroller = root.querySelector('.scroller');
  const labelsEl = root.querySelector('.labels');
  const canvas = root.querySelector('.canvas');
  const beatGridEl = root.querySelector('.beat-grid');
  const ruler = root.querySelector('.ruler');
  const tracks = root.querySelector('.tracks');
  const playhead = root.querySelector('.playhead');
  const marquee = root.querySelector('.marquee');
  const beatCtl = root.querySelector('.beat-ctl');
  const beatBpmInput = root.querySelector('.beat-bpm');
  const beatSubBtn = root.querySelector('.beat-sub-btn');
  let lastTimelineKey = '';

  beatBpmInput.addEventListener('change', () => {
    const val = Number(beatBpmInput.value);
    if (Number.isFinite(val) && val >= 30 && val <= 300) {
      actions.setBeatGrid({ bpm: val, enabled: true });
    }
  });

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'zoomIn') return actions.zoomIn();
      if (a === 'zoomOut') return actions.zoomOut();
      if (a === 'fit') return actions.fit(Math.max(200, scroller.clientWidth - 86));
      if (a === 'snap') return actions.toggleSnap();
      if (a === 'undo') return actions.undo();
      if (a === 'redo') return actions.redo();
      if (a === 'split') return actions.split();
      if (a === 'trim') return actions.trim();
      if (a === 'delete') return actions.deleteSelected();
      if (a === 'duplicate') return actions.duplicate();
      if (a === 'add-video-track') return actions.addTrack('video');
      if (a === 'add-audio-track') return actions.addTrack('audio');
      if (a === 'detect-beats') return actions.detectBeats();
      if (a === 'beat-nudge-l') {
        const b = store.get().beats || T.defaultBeats();
        return actions.setBeatGrid({ offset: Math.max(0, (b.offset || 0) - 0.01) });
      }
      if (a === 'beat-nudge-r') {
        const b = store.get().beats || T.defaultBeats();
        return actions.setBeatGrid({ offset: (b.offset || 0) + 0.01 });
      }
      if (a === 'beat-sub') {
        const b = store.get().beats || T.defaultBeats();
        const order = [1, 2, 4];
        const nextSub = order[(order.indexOf(b.subdivisions || 2) + 1) % order.length];
        return actions.setBeatGrid({ subdivisions: nextSub });
      }
      if (a === 'beat-add-marker') return actions.addBeatMarker();
      if (a === 'beat-clear') return actions.clearBeats();
      return;
    }
  });

  // scrubbing on the ruler and empty track space
  function scrubTo(e) {
    const s = store.get();
    const rect = canvas.getBoundingClientRect();
    const t = (e.clientX - rect.left) / s.pps;
    actions.seekTo(actions.snapTime(t, s.pps));
  }
  function startScrub(e) {
    if (e.button !== 0) return;
    if (e.target.closest('[data-clip]')) return;
    e.preventDefault();
    scrubTo(e);
    const move = (ev) => scrubTo(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  ruler.addEventListener('pointerdown', (e) => {
    const markerEl = e.target.closest('[data-beat-marker]');
    if (markerEl && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      const markerId = markerEl.dataset.beatMarker;
      const move = (ev) => {
        const s = store.get();
        const rect = canvas.getBoundingClientRect();
        const t = Math.max(0, (ev.clientX - rect.left) / s.pps);
        actions.moveBeatMarker(markerId, t, true);
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const s = store.get();
        const rect = canvas.getBoundingClientRect();
        const t = Math.max(0, (ev.clientX - rect.left) / s.pps);
        actions.moveBeatMarker(markerId, t, false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return;
    }
    startScrub(e);
  });
  ruler.addEventListener('dblclick', (e) => {
    const markerEl = e.target.closest('[data-beat-marker]');
    if (markerEl) {
      e.preventDefault();
      actions.removeBeatMarker(markerEl.dataset.beatMarker);
    }
  });
  ruler.addEventListener('contextmenu', (e) => {
    const markerEl = e.target.closest('[data-beat-marker]');
    if (markerEl) {
      e.preventDefault();
      actions.removeBeatMarker(markerEl.dataset.beatMarker);
    }
  });

  // right-click context menu on clips (Separate Audio Track, Mute, Split, Duplicate, Delete)
  let ctxMenu = null;
  function closeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    document.removeEventListener('pointerdown', outsideCtxClose, true);
    document.removeEventListener('keydown', escCtxClose);
  }
  function outsideCtxClose(e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
  }
  function escCtxClose(e) {
    if (e.key === 'Escape') closeCtxMenu();
  }

  tracks.addEventListener('contextmenu', (e) => {
    const blk = e.target.closest('.blk[data-clip]');
    if (!blk) return;
    e.preventDefault();
    closeCtxMenu();
    const clipId = blk.dataset.clip;
    const preSel = store.get().selectedIds || [];
    if (!preSel.includes(clipId)) actions.select(clipId);
    const sNow = store.get();
    const clip = T.findClip(sNow.clips, clipId);
    if (!clip) return;

    const selIds = sNow.selectedIds && sNow.selectedIds.length ? sNow.selectedIds : (sNow.selected ? [sNow.selected] : []);
    const selVideoClips = selIds
      .map((id) => T.findClip(sNow.clips, id))
      .filter((c) => c && c.kind === 'video' && c.path)
      .sort((a, b) => a.start - b.start);
    const canFrameToFrame = selVideoClips.length === 2 && Boolean(window.zaudeAI && window.zaudeAI.extractFrame);

    const isVideo = clip.kind === 'video';
    const canFrameContinue = isVideo && Boolean(clip.path) && Boolean(window.__zaudeOpenFrameContinue);
    const upscaleTargets = selVideoClips.length ? selVideoClips : (isVideo && clip.path ? [clip] : []);
    const canUpscale = upscaleTargets.length > 0 && Boolean(window.zaudeAI && window.zaudeAI.upscaleClips);
    const upSuffix = upscaleTargets.length > 1 ? ` (${upscaleTargets.length} clips)` : '';
    const isMedia = isVideo || clip.kind === 'audio';
    const canSeparate = isVideo && clip.hasAudio !== false && !clip.muted;
    const sepReason = !isVideo ? '' : clip.hasAudio === false ? ' (no audio)' : clip.muted ? ' (already separated / muted)' : '';

    ctxMenu = document.createElement('div');
    ctxMenu.className = 'menu clip-ctx-menu';
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.innerHTML = `
      <div class="menu-title">${esc(selVideoClips.length >= 2 ? `${selVideoClips.length} video clips selected` : clip.name)}</div>
      ${canFrameToFrame ? '<button role="menuitem" data-ctx="frame-to-frame" class="menu-ai">✨ FrameToFrame</button>' : ''}
      ${canFrameContinue ? `<button role="menuitem" data-ctx="frame-continue" class="menu-ai">✨ FrameContinue${clip.latent ? ' (latent)' : ''}</button>` : ''}
      ${canUpscale ? `<button role="menuitem" data-ctx="upscale-refmod" class="menu-ai">✨ Upscale &amp; Fix Faces · 640p${upSuffix}</button>` : ''}
      ${canUpscale ? `<button role="menuitem" data-ctx="upscale-esrgan" class="menu-ai">⚡ Fast 2× Upscale · RealESRGAN${upSuffix}</button>` : ''}
      ${(canFrameToFrame || canFrameContinue || canUpscale) ? '<div class="menu-sep"></div>' : ''}
      ${isVideo ? `<button role="menuitem" data-ctx="separate" ${canSeparate ? '' : 'disabled'}>Separate Audio Track${sepReason}</button>` : ''}
      ${isMedia ? `<button role="menuitem" data-ctx="mute">${clip.muted ? 'Unmute audio' : 'Mute audio'}</button>` : ''}
      <button role="menuitem" data-ctx="split">Split at playhead</button>
      <button role="menuitem" data-ctx="duplicate">Duplicate</button>
      <div class="menu-sep"></div>
      <button role="menuitem" data-ctx="ripple">Ripple delete</button>
      <button role="menuitem" data-ctx="delete" class="danger">Delete clip</button>
    `;
    document.body.appendChild(ctxMenu);
    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8)) + 'px';
    ctxMenu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)) + 'px';

    ctxMenu.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-ctx]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.ctx;
      closeCtxMenu();
      if ((act === 'upscale-refmod' || act === 'upscale-esrgan') && upscaleTargets.length) {
        const method = act === 'upscale-esrgan' ? 'esrgan-2x' : 'refmod-refine';
        const payloadClips = upscaleTargets.map((c) => ({
          clipId: c.id,
          path: c.path,
          start: Number(c.srcIn) || 0,
          end: (Number(c.srcIn) || 0) + (Number(c.dur) || 5) * (c.speed || 1),
        }));
        actions.log(`Queueing ${payloadClips.length} clip(s) for ${method === 'esrgan-2x' ? 'Fast 2× Upscale' : 'RefMod Face-Fix & Upscale (640p)'}…`);
        const res = await window.zaudeAI.upscaleClips({ clips: payloadClips, method, quality: '640' });
        if (res && res.ok && Array.isArray(res.jobs)) {
          for (const j of res.jobs) {
            actions.generationEvent({
              type: 'start',
              id: j.id,
              replaceClipId: j.clipId,
              queuePos: j.queuePos,
              progress: 0.05,
              label: `Queued #${j.queuePos}: ${method === 'esrgan-2x' ? 'Fast 2× Upscale' : 'RefMod Face-Fix 640p'}…`,
            });
          }
        } else {
          actions.log(`Upscale failed: ${(res && res.error) || 'unknown error'}`);
        }
      } else if (act === 'frame-continue' && clip.path) {
        actions.log(`Preparing FrameContinue from ${clip.name}…`);
        const tEnd = Math.max(0, (Number(clip.srcIn) || 0) + (Number(clip.dur) || 1) * (clip.speed || 1) - 0.05);
        const [lastFrameRes, latentRes] = await Promise.all([
          window.zaudeAI && window.zaudeAI.extractFrame
            ? window.zaudeAI.extractFrame({ filePath: clip.path, timeSec: tEnd, tag: 'continue_first' })
            : Promise.resolve({ ok: false }),
          !clip.latent && window.zaudeAI && window.zaudeAI.clipLatent
            ? window.zaudeAI.clipLatent(clip.path)
            : Promise.resolve({ ok: true, latent: clip.latent || '', label: clip.latentLabel || '' }),
        ]);
        if (window.__zaudeOpenFrameContinue) {
          window.__zaudeOpenFrameContinue({
            seedVideo: clip.path,
            latent: (latentRes && latentRes.latent) || clip.latent || '',
            latentLabel: (latentRes && latentRes.label) || clip.latentLabel || '',
            quality: (latentRes && latentRes.quality) || '',
            clipName: clip.name,
            firstFrame: lastFrameRes && lastFrameRes.ok ? lastFrameRes : null,
            insertAt: T.clipEnd(clip),
          });
        }
      } else if (act === 'frame-to-frame' && selVideoClips.length === 2) {
        const [c1, c2] = selVideoClips;
        actions.log('Extracting First & Last frames for FrameToFrame…');
        const t1 = Math.max(0, (Number(c1.srcIn) || 0) + (Number(c1.dur) || 1) * (c1.speed || 1) - 0.05);
        const t2 = Math.max(0, Number(c2.srcIn) || 0);
        const [f1, f2] = await Promise.all([
          window.zaudeAI.extractFrame({ filePath: c1.path, timeSec: t1, tag: 'fl2v_first' }),
          window.zaudeAI.extractFrame({ filePath: c2.path, timeSec: t2, tag: 'fl2v_last' }),
        ]);
        if (!f1.ok || !f2.ok) {
          actions.log('Could not extract frames: ' + (f1.error || f2.error || 'unknown error'));
          return;
        }
        const gap = c2.start - T.clipEnd(c1);
        const seconds = gap >= 1 ? Math.min(15, Math.round(gap)) : 4;
        const insertAt = gap >= 0.5 ? T.clipEnd(c1) : T.clipEnd(c1);
        if (window.__zaudeOpenFrameToFrame) {
          window.__zaudeOpenFrameToFrame({ firstFrame: f1, lastFrame: f2, seconds, insertAt });
        }
      } else if (act === 'separate') actions.detach();
      else if (act === 'mute') {
        const s = store.get();
        const cur = T.findClip(s.clips, clipId);
        if (cur) actions.commitClips(T.setFlag(s.clips, cur.id, 'muted', !cur.muted), (cur.muted ? 'Unmuted ' : 'Muted ') + cur.name);
      } else if (act === 'split') actions.split();
      else if (act === 'duplicate') actions.duplicate();
      else if (act === 'ripple') actions.ripple();
      else if (act === 'delete') actions.deleteSelected();
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideCtxClose, true);
      document.addEventListener('keydown', escCtxClose);
    }, 0);
  });

  // AutoCAD-style marquee box select on empty track space (L->R blue = window, R->L green = crossing)
  // and direct drag to move a single clip or all selected clips, or drag right edge to trim.
  tracks.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const blk = e.target.closest('[data-clip]');

    if (!blk) {
      e.preventDefault();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const additive = e.shiftKey;
      const baseIds = additive ? [...(store.get().selectedIds || [])] : [];
      let draggingBox = false;
      let matchedIds = [];
      let mode = 'window';

      const updateBox = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!draggingBox && Math.hypot(dx, dy) < 4) return;
        draggingBox = true;
        mode = ev.clientX >= x0 ? 'window' : 'crossing';

        const cRect = canvas.getBoundingClientRect();
        const leftPx = Math.min(x0, ev.clientX) - cRect.left;
        const topPx = Math.min(y0, ev.clientY) - cRect.top;
        const widthPx = Math.abs(ev.clientX - x0);
        const heightPx = Math.abs(ev.clientY - y0);

        marquee.hidden = false;
        marquee.className = 'marquee ' + (mode === 'window' ? 'marquee-window' : 'marquee-crossing');
        marquee.style.left = leftPx + 'px';
        marquee.style.top = topPx + 'px';
        marquee.style.width = widthPx + 'px';
        marquee.style.height = heightPx + 'px';

        const blkEls = Array.from(tracks.querySelectorAll('.blk[data-clip]'));
        const rects = blkEls.map((el_) => {
          const r = el_.getBoundingClientRect();
          return { id: el_.dataset.clip, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const box = { left: x0, right: ev.clientX, top: y0, bottom: ev.clientY };
        const hits = T.selectByBox(rects, box, mode);
        matchedIds = additive ? [...new Set([...baseIds, ...hits])] : hits;
        const hitSet = new Set(matchedIds);
        blkEls.forEach((el_) => el_.classList.toggle('sel', hitSet.has(el_.dataset.clip)));
      };

      const finishBox = () => {
        window.removeEventListener('pointermove', updateBox);
        window.removeEventListener('pointerup', finishBox);
        window.removeEventListener('pointercancel', finishBox);
        marquee.hidden = true;
        if (draggingBox) {
          const label = mode === 'window' ? 'Window' : 'Crossing';
          const msg = matchedIds.length
            ? `Selected ${matchedIds.length} clip${matchedIds.length === 1 ? '' : 's'} (${label})`
            : 'Selection cleared';
          actions.selectMany(matchedIds, msg);
        } else {
          actions.select(null);
          scrubTo(e);
        }
      };

      window.addEventListener('pointermove', updateBox);
      window.addEventListener('pointerup', finishBox);
      window.addEventListener('pointercancel', finishBox);
      return;
    }

    const clipId = blk.dataset.clip;
    const fadeHandle = e.target.closest('.blk-fade');
    if (fadeHandle) {
      e.preventDefault();
      e.stopPropagation();
      const edge = fadeHandle.dataset.fade;
      const rect = blk.getBoundingClientRect();
      const applyFade = (ev, live) => {
        const s = store.get();
        const clip = T.findClip(s.clips, clipId);
        if (!clip) return;
        const px = edge === 'in' ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
        const durSec = Math.max(0, Math.min(clip.dur, px / s.pps));
        actions.setClipFade(clipId, edge, durSec, live);
      };
      applyFade(e, true);
      const move = (ev) => applyFade(ev, true);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        applyFade(ev, false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return;
    }

    // Alt + Click on a media clip drops a volume keyframe at that exact time and vertical height.
    if (e.altKey) {
      const s = store.get();
      const clip = T.findClip(s.clips, clipId);
      if (clip && (clip.kind === 'audio' || clip.kind === 'video')) {
        e.preventDefault();
        e.stopPropagation();
        const rect = blk.getBoundingClientRect();
        const fracX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const fracY = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / Math.max(1, rect.height)));
        actions.select(clipId);
        actions.upsertVolumeKeyframe(clipId, fracX * clip.dur, fracY * 2);
        return;
      }
    }

    const isTrim = Boolean(e.target.closest('.blk-handle'));
    const curSel = store.get().selectedIds || [];

    if ((e.shiftKey || e.ctrlKey || e.metaKey) && !isTrim) {
      actions.toggleSelect(clipId);
      return;
    }

    const alreadyInGroup = curSel.length > 1 && curSel.includes(clipId);
    if (!alreadyInGroup) actions.select(clipId);

    const x0 = e.clientX;
    const y0 = e.clientY;
    const initClip = T.findClip(store.get().clips, clipId);
    const start0 = initClip ? initClip.start : 0;
    let lastX = x0;
    let moved = false;

    const findTrackUnderY = (clientY) => {
      for (const row of tracks.querySelectorAll('.trk[data-track]')) {
        const r = row.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) return row.dataset.track;
      }
      return null;
    };

    const move = (ev) => {
      const dx = ev.clientX - lastX;
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 6) return;
      moved = true;
      lastX = ev.clientX;
      const s = store.get();
      const clip = T.findClip(s.clips, clipId);
      if (!clip) return;
      const dt = dx / s.pps;
      if (isTrim) {
        const next = T.adjustEnd(s.clips, clipId, dt);
        if (next) {
          const after = T.findClip(next, clipId);
          actions.liveClips('drag-trim:' + clipId, next, `${clip.name} length ${after.dur.toFixed(2)} s`);
        }
      } else {
        const ids = s.selectedIds && s.selectedIds.length > 1 && s.selectedIds.includes(clipId)
          ? s.selectedIds
          : [clipId];
        let next = null;
        if (ids.length === 1) {
          const rawStart = Math.max(0, start0 + (ev.clientX - x0) / s.pps);
          const targetStart = s.snap ? actions.snapTime(rawStart, s.pps) : rawStart;
          const hoverTrack = findTrackUnderY(ev.clientY);
          if (hoverTrack && hoverTrack !== clip.track && T.isTrackCompatible(clip, hoverTrack)) {
            next = T.moveClipToTrack(s.clips, clipId, hoverTrack, targetStart);
          }
          if (!next) {
            next = T.moveClip(s.clips, clipId, targetStart - clip.start);
          }
        } else {
          next = T.moveClips(s.clips, ids, dt);
        }
        if (next) {
          const after = T.findClip(next, clipId);
          const msg = ids.length > 1
            ? `Moved ${ids.length} clips (first at ${after.start.toFixed(2)} s)`
            : `${clip.name} on ${after.track} at ${after.start.toFixed(2)} s`;
          actions.liveClips('drag-move:' + ids.join(','), next, msg);
        }
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // If user clicked a clip in a multi-selection without dragging, narrow selection to just that clip.
      if (!moved && alreadyInGroup) actions.select(clipId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  function update(s) {
    const selKey = (s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : [])).join(',');
    const trackList = T.ensureTracksForClips(s.tracks, s.clips);
    const tracksKey = trackList.map((t) => t.id).join(',');
    const b = s.beats || T.defaultBeats();
    const beatsKey = `${b.enabled}:${b.snap}:${b.bpm}:${b.offset}:${b.beatsPerBar}:${b.subdivisions}:` +
      (Array.isArray(b.markers) ? b.markers.map((m) => `${m.id}@${m.time}`).join(',') : '');
    const timelineKey = `${s.pps}|${s.snap}|${selKey}|${tracksKey}|${beatsKey}|` + s.clips.map((c) =>
      `${c.id}:${c.track}:${c.start}:${c.dur}:${c.srcIn}:${c.speed}:${c.volume}:${c.muted}:${c.fadeIn || 0}:${c.fadeOut || 0}:${(c.volumeKeyframes || []).map((k) => `${k.t}=${k.value}`).join(',')}:${c.transition}:${c.generating}:${c.upscaling ? 1 : 0}:${c.progress}:${c.queuePos || 0}:${c.etaSec || 0}:${c.step || 0}:${c.previewUrl || ''}:${c.name}:${c.path}`
    ).join(';');
    if (timelineKey === lastTimelineKey) {
      updateTime(s);
      return;
    }
    lastTimelineKey = timelineKey;

    labelsEl.style.setProperty('--track-count', String(trackList.length));
    tracks.style.setProperty('--track-count', String(trackList.length));
    labelsEl.innerHTML = trackList.map((t) => `<div class="tlbl">${esc(t.label)}</div>`).join('');

    const end = T.projectEnd(s.clips);
    const pxWidth = Math.max(scroller.clientWidth - 86, end * s.pps);
    canvas.style.width = pxWidth + 'px';
    ruler.style.width = pxWidth + 'px';

    // Beat controls in bottom timeline bar
    root.querySelector('.beats-btn').classList.toggle('on', Boolean(b.enabled));
    beatCtl.hidden = !b.enabled;
    if (b.enabled) {
      if (document.activeElement !== beatBpmInput) beatBpmInput.value = String(b.bpm || 120);
      beatSubBtn.textContent = `${b.subdivisions || 2}×`;
    }

    const step = RULER_STEPS.find((x) => x * s.pps >= 70) || RULER_STEPS[RULER_STEPS.length - 1];
    let ticks = '';
    for (let i = 0; i * step <= end + 1e-9; i++) {
      const t = i * step;
      const m = Math.floor(t / 60);
      const r = t - m * 60;
      const label = step >= 1 ? `${String(m).padStart(2, '0')}:${String(Math.floor(r)).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
      ticks += `<span style="left:${t * s.pps}px">${label}</span>`;
    }

    // Beat grid lines across tracks + bar labels & editable markers on the ruler
    let gridHtml = '';
    if (b.enabled) {
      const grid = T.generateBeatGrid(b, end);
      const showSubs = s.pps >= 35;
      for (const g of grid) {
        if (g.kind === 'sub' && !showSubs) continue;
        const left = (g.time * s.pps).toFixed(1);
        gridHtml += `<span class="beat-line ${g.kind}" style="left:${left}px"></span>`;
        if (g.kind === 'downbeat' && g.bar) {
          ticks += `<span class="ruler-bar" style="left:${left}px">B${g.bar}</span>`;
        }
      }
      for (const mk of (b.markers || [])) {
        if (mk.time > end + 0.5) continue;
        const left = (mk.time * s.pps).toFixed(1);
        const cls = mk.kind === 'downbeat' ? 'downbeat' : mk.kind === 'custom' ? 'custom' : 'beat';
        ticks += `<span class="beat-marker ${cls}" data-beat-marker="${esc(mk.id)}" style="left:${left}px" title="Beat marker at ${mk.time.toFixed(2)}s (drag to move · double-click to delete)"></span>`;
      }
    }
    beatGridEl.innerHTML = gridHtml;
    ruler.innerHTML = ticks;

    const pendingThumbs = [];
    const waveClips = [];
    const selSet = new Set(s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []));
    tracks.innerHTML = trackList.map((tr) => {
      const blocks = s.clips.filter((c) => c.track === tr.id).map((c) => {
        const kind = c.generating ? 'gen' : (c.kind === 'audio' ? 'audio' : c.kind === 'video' ? 'video' : 'title');
        const sel = selSet.has(c.id) ? ' sel' : '';
        const speed = c.speed && c.speed !== 1 ? ` ×${c.speed}` : '';
        const vol = c.kind === 'audio' || c.kind === 'video' ? (c.muted ? ' · muted' : ` · ${Math.round(T.propValue(c, 'volume') * 100)}%`) : '';
        const pct = Math.round((c.progress || 0) * 100);
        const clipPx = Math.max(8, c.dur * s.pps);
        const fmtEta = (sec) => {
          if (!Number.isFinite(sec) || sec <= 0) return '';
          if (sec < 60) return `~${Math.round(sec)}s`;
          const m = Math.floor(sec / 60);
          const rem = Math.round(sec % 60);
          return rem ? `~${m}m ${rem}s` : `~${m}m`;
        };
        const genPreview = c.generating && c.previewUrl
          ? `<span class="blk-gen-preview" style="background-image:url('${esc(c.previewUrl)}')" aria-hidden="true"></span>`
          : '';
        let genMeta = '';
        if (c.generating) {
          const qBadge = c.queuePos ? `#${c.queuePos}` : '#1';
          const stepTxt = c.step >= 1 && c.totalSteps ? ` · ${c.step}/${c.totalSteps}` : '';
          const etaTxt = c.etaSec ? ` · ${fmtEta(c.etaSec)}` : '';
          const metaText = clipPx >= 95 ? `${qBadge}${stepTxt}${etaTxt}` : (clipPx >= 46 ? qBadge : '');
          if (metaText) genMeta = `<span class="blk-gen-meta">${esc(metaText)}</span>`;
        } else if (c.upscaling) {
          const metaText = clipPx >= 75 ? `✨ Upscaling ${pct}%` : '✨';
          genMeta = `<span class="blk-gen-meta">${esc(metaText)}</span>`;
        }
        const fill = (c.generating || c.upscaling) ? `<span class="gen-fill${c.progress == null ? ' pulse' : ''}" style="width:${pct}%"></span>` : '';
        const dissolve = c.transition ? '<span class="tr" title="Cross dissolve"></span>' : '';

        let strip = '';
        if (c.kind === 'video' && c.path && !c.generating && thumbs) {
          const stages = timelineThumbStages(c);
          const tiles = stages.map((st, idx) => {
            const leftPct = (st.offset / c.dur) * 100;
            const widthPct = (st.span / c.dur) * 100;
            const cached = thumbs.getCached(c.path, st.srcTime);
            const bg = cached ? `background-image:url('${cached}');` : '';
            if (!cached) pendingThumbs.push({ clipId: c.id, idx, path: c.path, srcTime: st.srcTime });
            return `<span class="blk-frame" data-frame="${idx}" style="left:${leftPct}%;width:${widthPct}%;${bg}"></span>`;
          }).join('');
          strip = `<span class="blk-strip" aria-hidden="true">${tiles}</span>`;
        }

        const hasInternalAudio = c.kind === 'video' && c.path && !c.generating && c.hasAudio !== false && !c.muted;
        const isAudioMedia = c.kind === 'audio' && c.path && !c.generating;
        let waveHtml = '';
        if ((hasInternalAudio || isAudioMedia) && waveforms) {
          waveHtml = `<canvas class="blk-wave ${isAudioMedia ? 'blk-wave-audio' : 'blk-wave-internal'}" aria-hidden="true"></canvas>`;
          waveClips.push(c);
        }

        const fadeHandles = (hasInternalAudio || isAudioMedia)
          ? `<span class="blk-fade blk-fade-in" data-fade="in" title="Drag to adjust Audio Fade In${c.fadeIn ? ` (${c.fadeIn.toFixed(2)}s)` : ''}" style="left:${Math.min(Math.max(0, (c.fadeIn || 0) * s.pps), Math.max(8, c.dur * s.pps) - 10)}px"></span>` +
            `<span class="blk-fade blk-fade-out" data-fade="out" title="Drag to adjust Audio Fade Out${c.fadeOut ? ` (${c.fadeOut.toFixed(2)}s)` : ''}" style="right:${Math.min(Math.max(0, (c.fadeOut || 0) * s.pps), Math.max(8, c.dur * s.pps) - 10)}px"></span>`
          : '';

        return `<div class="blk ${kind}${sel}${strip ? ' has-strip' : ''}${hasInternalAudio ? ' has-wave' : ''}" role="button" tabindex="0" data-clip="${esc(c.id)}"
            aria-label="${esc(c.name)}" style="left:${c.start * s.pps}px;width:${Math.max(8, c.dur * s.pps)}px">
            ${strip}${genPreview}${waveHtml}${fill}${dissolve}${fadeHandles}${genMeta}<span class="blk-label">${esc(c.name + speed + vol)}</span><span class="blk-handle" title="Drag edge to trim length"></span></div>`;
      }).join('');
      return `<div class="trk" data-track="${tr.id}">${blocks}</div>`;
    }).join('');

    for (const item of pendingThumbs) {
      thumbs.request(item.path, item.srcTime).then((url) => {
        if (!url) return;
        const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === item.clipId);
        const tile = blk && blk.querySelector(`.blk-frame[data-frame="${item.idx}"]`);
        if (tile) tile.style.backgroundImage = `url('${url}')`;
      });
    }

    for (const c of waveClips) {
      const cached = waveforms.getCached(c.path);
      if (cached) {
        const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === c.id);
        const canvasEl = blk && blk.querySelector('.blk-wave');
        if (canvasEl && cached.peaks.length) drawWaveform(canvasEl, cached, c, b);
      } else {
        waveforms.request(c.path).then((data) => {
          if (!data || !data.peaks.length) return;
          const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === c.id);
          const canvasEl = blk && blk.querySelector('.blk-wave');
          const liveState = store.get();
          const liveClip = T.findClip(liveState.clips, c.id);
          if (canvasEl && liveClip) drawWaveform(canvasEl, data, liveClip, liveState.beats);
        });
      }
    }

    root.querySelector('.snap-btn').classList.toggle('on', s.snap);
    const selInfo = selSet.size > 1 ? ` · ${selSet.size} selected` : '';
    root.querySelector('.tl-info').textContent = `Zoom ${s.pps.toFixed(1)} px/s · ${T.timecode(end)}${selInfo}`;
    updateTime(s);
  }

  function updateTime(s) {
    playhead.style.left = s.playhead * s.pps + 'px';
  }

  return { el: root, update, updateTime, scroller, destroy: closeCtxMenu };
}

// ---------- Inspector ----------

const HSL_SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
const HSL_BAND_FIELDS = [
  { key: 'hue', prop: 'hslHue' },
  { key: 'sat', prop: 'hslSat' },
  { key: 'light', prop: 'hslLight' },
  { key: 'range', prop: 'hslRange' },
];

// Pre-render the color wheel disc ONCE into a cached offscreen canvas so redraws take < 0.05ms.
let wheelCache = null;
function getWheelBitmap(w, h) {
  if (wheelCache && wheelCache.width === w && wheelCache.height === h) return wheelCache;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 4;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const sat = Math.min(1, dist / radius);
      const { r, g, b } = hslToRgb(hue, sat, 0.5);
      const idx = (y * w + x) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  wheelCache = off;
  return off;
}

function drawColorWheel(canvas, hex, allBands = []) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 4;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(getWheelBitmap(w, h), 0, 0);

  // Small dots for other color bands so you can see all targeted colors on the wheel at once
  for (const b of allBands) {
    const rgb = hexToRgb(b.hex);
    if (!rgb) continue;
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const rad = (hsl.h * Math.PI) / 180;
    const rPos = Math.max(0.15, hsl.s) * (radius - 2);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(rad) * rPos, cy + Math.sin(rad) * rPos, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = b.hex;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
  }

  // Active target reticle
  const rgb = hexToRgb(hex) || { r: 239, g: 68, b: 68 };
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const rad = (hsl.h * Math.PI) / 180;
  const rPos = Math.max(0.15, hsl.s) * (radius - 2);
  const mx = cx + Math.cos(rad) * rPos;
  const my = cy + Math.sin(rad) * rPos;

  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, 7.5, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.stroke();
}

export function inspectorPanel({ store, actions }) {
  const root = el(`<div class="panel inspector"></div>`);
  let tab = 'clip'; // 'clip' | 'filters' | 'hsl' | 'transitions'
  let lastStructKey = '';

  function activeBandOf(clip) {
    const bands = getHslBands(clip);
    const active = bands.find((b) => b.id === clip.hslActiveBand) || bands[0];
    return { bands, active };
  }

  function pickWheelColor(canvas, clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = Math.min(r.width, r.height) / 2 - 4;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const sat = Math.min(1, Math.max(0.15, Math.hypot(dx, dy) / Math.max(1, radius)));
    const rgb = hslToRgb(hue, sat, 0.5);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  root.addEventListener('pointerdown', (e) => {
    const wheel = e.target.closest('.hsl-wheel');
    if (!wheel || e.button !== 0) return;
    e.preventDefault();
    const apply = (ev) => {
      const hex = pickWheelColor(wheel, ev.clientX, ev.clientY);
      const s = store.get();
      const clip = s.selected ? T.findClip(s.clips, s.selected) : null;
      if (!clip) return;
      const { active } = activeBandOf(clip);
      actions.setHslBandProp(clip.id, active.id, 'hex', hex, true);
    };
    apply(e);
    const move = (ev) => apply(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  root.addEventListener('change', (e) => {
    const hexInput = e.target.closest('[data-hsl-hex]');
    if (hexInput) {
      const norm = normalizeHex(hexInput.value, null);
      if (norm) actions.setHslTarget(norm, false);
      else { lastStructKey = ''; update(store.get()); }
      return;
    }
    const expField = e.target.closest('[data-exp-field]');
    if (expField) {
      const key = expField.dataset.expField;
      const val = expField.type === 'number' ? Number(expField.value) : expField.value;
      if (key === 'fps') actions.setExportCfg({ fps: Number(val) });
      else if (key === 'rangeStart') actions.setExportCfg({ rangeStart: Math.max(0, Number(val) || 0) });
      else if (key === 'rangeEnd') actions.setExportCfg({ rangeEnd: Math.max(0.1, Number(val) || 0.1) });
      else actions.setExportCfg({ [key]: val });
    }
  });

  root.addEventListener('click', (e) => {
    const expPreset = e.target.closest('[data-exp-preset]');
    if (expPreset) return actions.applyExportPreset(expPreset.dataset.expPreset);
    const expAspect = e.target.closest('[data-exp-aspect]');
    if (expAspect) return actions.setExportCfg({ aspect: expAspect.dataset.expAspect });
    const expFps = e.target.closest('[data-exp-fps]');
    if (expFps) return actions.setExportCfg({ fps: Number(expFps.dataset.expFps) });
    const expRange = e.target.closest('[data-exp-range]');
    if (expRange) return actions.setExportCfg({ rangeMode: expRange.dataset.expRange });
    const expAct = e.target.closest('[data-exp-act]');
    if (expAct) {
      const a = expAct.dataset.expAct;
      if (a === 'close') return actions.closeExport();
      if (a === 'start') return actions.exportRender();
      if (a === 'set-in') {
        const s = store.get();
        const t = Number(s.playhead.toFixed(2));
        actions.setExportCfg({ rangeMode: 'custom', rangeStart: t, rangeEnd: Math.max(t + 0.5, s.exportCfg.rangeEnd) });
        return;
      }
      if (a === 'set-out') {
        const s = store.get();
        const t = Number(s.playhead.toFixed(2));
        actions.setExportCfg({ rangeMode: 'custom', rangeStart: Math.min(s.exportCfg.rangeStart, Math.max(0, t - 0.5)), rangeEnd: Math.max(0.5, t) });
        return;
      }
      if (a === 'reveal') {
        const p = store.get().exportStatus.lastPath;
        if (p && window.zaudeAI && window.zaudeAI.reveal) window.zaudeAI.reveal(p);
        return;
      }
    }
    const tabBtn = e.target.closest('[data-insp-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.inspTab;
      lastStructKey = '';
      update(store.get());
      return;
    }
    const rmBand = e.target.closest('[data-hsl-remove]');
    if (rmBand) {
      e.stopPropagation();
      actions.removeHslBand(rmBand.dataset.hslRemove);
      return;
    }
    const selBand = e.target.closest('[data-hsl-band]');
    if (selBand) {
      actions.selectHslBand(selBand.dataset.hslBand);
      return;
    }
    const swatch = e.target.closest('[data-hsl-swatch]');
    if (swatch) {
      actions.setHslTarget(swatch.dataset.hslSwatch, false);
      return;
    }
    const trBtn = e.target.closest('[data-tr-type]');
    if (trBtn) {
      actions.setTransition(trBtn.dataset.trType);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'detach') actions.detach();
    if (act.dataset.act === 'mirror-h') actions.toggleMirror('h');
    if (act.dataset.act === 'fill') actions.toggleFill();
    if (act.dataset.act === 'mirror-v') actions.toggleMirror('v');
    if (act.dataset.act === 'reset-transform') actions.resetTransform();
    if (act.dataset.act === 'reset-filters') actions.resetFilters();
    if (act.dataset.act === 'reset-hsl') actions.resetHsl();
    if (act.dataset.act === 'add-hsl-band') {
      const s = store.get();
      const clip = s.selected ? T.findClip(s.clips, s.selected) : null;
      const used = clip ? getHslBands(clip).map((b) => b.hex.toLowerCase()) : [];
      const nextHex = HSL_SWATCHES.find((sw) => !used.includes(sw)) || '#3b82f6';
      actions.addHslBand(nextHex);
    }
    if (act.dataset.act === 'eyedropper') {
      actions.setEyedropper(store.get().eyedropper === 'replace' ? false : 'replace');
    }
    if (act.dataset.act === 'eyedropper-add') {
      actions.setEyedropper(store.get().eyedropper === 'add' ? false : 'add');
    }
    if (act.dataset.act === 'mute') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.commitClips(T.setFlag(s.clips, clip.id, 'muted', !clip.muted), (clip.muted ? 'Unmuted ' : 'Muted ') + clip.name);
    }
    if (act.dataset.act === 'vol-kf-add') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.upsertVolumeKeyframe(clip.id);
    }
    if (act.dataset.act === 'vol-kf-clear') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.clearVolumeKeyframes(clip.id);
    }
    if (act.dataset.act === 'vol-kf-del') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.removeVolumeKeyframe(clip.id, act.dataset.kfId);
    }
    if (act.dataset.act === 'vol-kf-jump') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      const t = Number(act.dataset.kfTime);
      if (clip && Number.isFinite(t)) actions.seekTo(clip.start + t);
    }
    if (act.dataset.act === 'delete') actions.deleteSelected();
  });

  root.addEventListener('change', (e) => {
    const fadeInput = e.target.closest('[data-fade-input]');
    if (fadeInput) {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.setClipFade(clip.id, fadeInput.dataset.fadeInput, Number(fadeInput.value) || 0, false);
      return;
    }
    const kfVal = e.target.closest('[data-kf-val]');
    if (kfVal) {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      const t = Number(kfVal.dataset.kfTime);
      const pct = Number(kfVal.value);
      if (clip && Number.isFinite(t) && Number.isFinite(pct)) {
        actions.upsertVolumeKeyframe(clip.id, t, pct / 100);
      }
    }
  });

  // Double-click any scrub slider to reset it to its default value.
  root.addEventListener('dblclick', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field) return;
    const prop = field.dataset.scrubProp;
    const def = T.PROPS[prop];
    if (!def) return;
    if (field.dataset.scrubBand) {
      actions.setHslBandProp(field.dataset.scrubClip, field.dataset.scrubBand, field.dataset.scrubBandKey, def.default, false);
    } else {
      actions.setProp(field.dataset.scrubClip, prop, def.default);
    }
  });

  root.addEventListener('keydown', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const s = store.get();
    const clip = T.findClip(s.clips, field.dataset.scrubClip);
    if (!clip) return;
    const prop = field.dataset.scrubProp;
    const def = T.PROPS[prop];
    if (!def) return;
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1 : -1;
    const step = (e.shiftKey ? def.step * 5 : def.step) * dir;
    if (field.dataset.scrubBand) {
      const band = getHslBands(clip).find((b) => b.id === field.dataset.scrubBand);
      if (!band) return;
      const key = field.dataset.scrubBandKey;
      const cur = typeof band[key] === 'number' ? band[key] : def.default;
      actions.setHslBandProp(clip.id, band.id, key, cur + step, true);
    } else {
      actions.setProp(clip.id, prop, T.propValue(clip, prop) + step);
    }
  });

  // Fast in-place update while dragging sliders/wheel so the DOM isn't rebuilt 60 times/sec.
  function patchInPlace(c) {
    root.querySelectorAll('.scrub-field[data-scrub-prop]').forEach((field) => {
      const prop = field.dataset.scrubProp;
      const def = T.PROPS[prop];
      if (!def) return;
      let val;
      if (field.dataset.scrubBand) {
        const band = getHslBands(c).find((b) => b.id === field.dataset.scrubBand);
        if (!band) return;
        const key = field.dataset.scrubBandKey;
        val = typeof band[key] === 'number' ? band[key] : def.default;
      } else {
        val = T.propValue(c, prop);
      }
      const pct = Math.min(100, Math.max(0, ((val - def.min) / (def.max - def.min)) * 100));
      field.classList.toggle('changed', Math.abs(val - def.default) > 1e-4);
      field.setAttribute('aria-valuenow', String(val));
      const bar = field.querySelector('.scrub-bar');
      const valEl = field.querySelector('.scrub-value');
      if (bar) bar.style.width = pct + '%';
      if (valEl) valEl.textContent = def.format(val);
    });
    if (tab === 'hsl') {
      const { bands, active } = activeBandOf(c);
      const chip = root.querySelector('.hsl-chip');
      const hexInput = root.querySelector('[data-hsl-hex]');
      if (chip) chip.style.background = active.hex;
      if (hexInput && document.activeElement !== hexInput) hexInput.value = active.hex.toUpperCase();
      root.querySelectorAll('.hsl-band-pill').forEach((pill) => {
        const b = bands.find((x) => x.id === pill.dataset.hslBand);
        if (!b) return;
        const dot = pill.querySelector('.hsl-band-dot');
        if (dot) dot.style.background = b.hex;
        pill.classList.toggle('modified', isBandActive(b));
      });
      drawColorWheel(root.querySelector('.hsl-wheel'), active.hex, bands);
    }
  }

  function renderExportPanel(s) {
    const cfg = s.exportCfg;
    const st = s.exportStatus;
    const dims = exportDimensions(cfg.aspect, cfg.resTier);
    const media = s.clips.filter((c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio'));
    const fullEnd = media.length ? Math.max(...media.map((c) => T.clipEnd(c))) : T.projectEnd(s.clips);
    const dur = cfg.rangeMode === 'custom'
      ? Math.max(0, Number(cfg.rangeEnd) - Number(cfg.rangeStart))
      : fullEnd;

    const expKey = JSON.stringify([cfg, st.busy, Math.round((st.progress || 0) * 100), st.message, st.lastPath, fullEnd.toFixed(2)]);
    if (lastStructKey === 'export|' + expKey) return;
    lastStructKey = 'export|' + expKey;

    root.innerHTML = `
      <div class="exp-head">
        <span class="insp-title">Export Video</span>
        <button class="area-btn" data-exp-act="close" title="Back to Clip &amp; Effects">×</button>
      </div>
      <div class="insp-body exp-body">
        <div class="lbl">Platform presets</div>
        <div class="exp-preset-grid">
          ${EXPORT_PRESETS.map((p) => `<button class="${cfg.preset === p.id ? 'on' : ''}" data-exp-preset="${p.id}">${esc(p.label)}</button>`).join('')}
        </div>

        <div class="lbl">Aspect ratio <span class="muted">(${dims.width} × ${dims.height})</span></div>
        <div class="exp-pill-row">
          ${ASPECT_RATIOS.map((ar) => `<button class="${cfg.aspect === ar ? 'on' : ''}" data-exp-aspect="${ar}">${ar}</button>`).join('')}
        </div>

        <div class="exp-two-col">
          <label class="exp-lbl">Resolution
            <select data-exp-field="resTier">
              ${RES_TIERS.map((r) => `<option value="${r.id}" ${cfg.resTier === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </label>
          <label class="exp-lbl">Format
            <select data-exp-field="format">
              <option value="MP4" ${cfg.format === 'MP4' ? 'selected' : ''}>MP4 (H.264)</option>
              <option value="MOV" ${cfg.format === 'MOV' ? 'selected' : ''}>MOV (QuickTime)</option>
            </select>
          </label>
        </div>

        <div class="exp-two-col">
          <div class="exp-lbl">Framerate
            <div class="exp-pill-row">
              ${[24, 30, 60].map((f) => `<button class="${Number(cfg.fps) === f ? 'on' : ''}" data-exp-fps="${f}">${f} fps</button>`).join('')}
            </div>
          </div>
          <label class="exp-lbl">Quality
            <select data-exp-field="quality">
              <option value="draft" ${cfg.quality === 'draft' ? 'selected' : ''}>Draft (fastest)</option>
              <option value="standard" ${cfg.quality === 'standard' ? 'selected' : ''}>Standard</option>
              <option value="high" ${cfg.quality === 'high' ? 'selected' : ''}>High</option>
              <option value="ultra" ${cfg.quality === 'ultra' ? 'selected' : ''}>Ultra</option>
            </select>
          </label>
        </div>

        <div class="lbl">Export range <span class="muted">(${dur.toFixed(1)} s)</span></div>
        <div class="exp-pill-row">
          <button class="${cfg.rangeMode === 'full' ? 'on' : ''}" data-exp-range="full">Full (${fullEnd.toFixed(1)} s)</button>
          <button class="${cfg.rangeMode === 'custom' ? 'on' : ''}" data-exp-range="custom">Custom part</button>
        </div>
        ${cfg.rangeMode === 'custom' ? `
          <div class="exp-two-col">
            <label class="exp-lbl">Start (sec)
              <input type="number" step="0.1" min="0" max="${fullEnd.toFixed(2)}" value="${Number(cfg.rangeStart).toFixed(2)}" data-exp-field="rangeStart">
            </label>
            <label class="exp-lbl">End (sec)
              <input type="number" step="0.1" min="0.1" max="${fullEnd.toFixed(2)}" value="${Number(cfg.rangeEnd).toFixed(2)}" data-exp-field="rangeEnd">
            </label>
          </div>
          <div class="exp-pill-row">
            <button data-exp-act="set-in" title="Set export start to current playhead">In = Playhead</button>
            <button data-exp-act="set-out" title="Set export end to current playhead">Out = Playhead</button>
          </div>` : ''}

        ${st.busy ? `<div class="exp-progress"><div style="width:${Math.round((st.progress || 0) * 100)}%"></div></div>` : ''}
        ${st.message ? `<div class="exp-status muted">${esc(st.message)}</div>` : ''}
        <div class="exp-actions">
          <button class="primary exp-go" data-exp-act="start" ${st.busy ? 'disabled' : ''}>${st.busy ? `Exporting ${Math.round((st.progress || 0) * 100)}%…` : `Export ${cfg.format}`}</button>
          ${st.lastPath ? '<button data-exp-act="reveal">Show in folder</button>' : ''}
        </div>
      </div>`;
  }

  function update(s) {
    if (s.exportOpen) {
      renderExportPanel(s);
      return;
    }
    const c = s.selected ? T.findClip(s.clips, s.selected) : null;
    if (!c) {
      if (lastStructKey !== 'none') {
        lastStructKey = 'none';
        root.innerHTML = '<p class="muted">Select a clip on the timeline to edit its properties, filters, HSL, or transitions. Drag or Ctrl+scroll over any slider (double-click to reset).</p>';
      }
      return;
    }
    const isVideo = c.kind === 'video';
    const isMedia = isVideo || c.kind === 'audio';
    if (!isVideo && tab !== 'clip') tab = 'clip';

    const { bands, active } = isVideo ? activeBandOf(c) : { bands: [], active: null };
    const multiCount = s.selectedIds && s.selectedIds.length > 1 ? s.selectedIds.length : 1;
    const activeTr = c.transition > 0 ? (c.transitionType || 'dissolve') : 'none';
    const kfKey = (c.volumeKeyframes || []).map((k) => `${k.id}:${k.t}:${k.value}`).join(',');
    const structKey = [
      c.id, c.name, c.track, c.start.toFixed(2), c.dur.toFixed(2), c.speed,
      c.muted, c.flipH, c.flipV, c.fill, activeTr, tab, s.eyedropper, multiCount,
      c.fadeIn || 0, c.fadeOut || 0, kfKey,
      bands.map((b) => b.id).join(','), active ? active.id : '',
    ].join('|');

    if (structKey === lastStructKey) {
      patchInPlace(c);
      return;
    }
    lastStructKey = structKey;

    const scrubField = (prop, band = null, bandKey = null) => {
      const def = T.PROPS[prop];
      const val = band ? (typeof band[bandKey] === 'number' ? band[bandKey] : def.default) : T.propValue(c, prop);
      const pct = Math.min(100, Math.max(0, ((val - def.min) / (def.max - def.min)) * 100));
      const changed = Math.abs(val - def.default) > 1e-4 ? ' changed' : '';
      const bandAttrs = band ? ` data-scrub-band="${esc(band.id)}" data-scrub-band-key="${esc(bandKey)}"` : '';
      return `
      <div class="scrub-field${changed}" tabindex="0" role="slider" aria-label="${def.label}" title="Drag or Ctrl+scroll to adjust · Double-click to reset"
           data-scrub-clip="${esc(c.id)}" data-scrub-prop="${prop}"${bandAttrs}
           aria-valuemin="${def.min}" aria-valuemax="${def.max}" aria-valuenow="${val}">
        <span class="scrub-bar" style="width:${pct}%"></span>
        <span class="scrub-label">${def.label}</span>
        <span class="scrub-value">${def.format(val)}</span>
      </div>`;
    };

    const tabsHtml = isVideo ? `
      <div class="insp-tabs" role="tablist">
        <button class="${tab === 'clip' ? 'on' : ''}" data-insp-tab="clip">Clip</button>
        <button class="${tab === 'filters' ? 'on' : ''}" data-insp-tab="filters">Filters</button>
        <button class="${tab === 'hsl' ? 'on' : ''}" data-insp-tab="hsl">HSL${bands.filter(isBandActive).length ? ` (${bands.filter(isBandActive).length})` : ''}</button>
        <button class="${tab === 'transitions' ? 'on' : ''}" data-insp-tab="transitions">Transitions</button>
      </div>` : '';

    let bodyHtml = '';
    if (tab === 'filters' && isVideo) {
      bodyHtml = `
        <div class="insp-filter-list">
          ${T.FILTER_PROPS.map((p) => scrubField(p)).join('')}
        </div>
        <div class="insp-row">
          <button data-act="reset-filters">Reset all filters</button>
        </div>`;
    } else if (tab === 'hsl' && isVideo && active) {
      const targetHex = normalizeHex(active.hex, '#ef4444');
      const bandPills = bands.map((b, i) => `
        <div class="hsl-band-pill${b.id === active.id ? ' on' : ''}${isBandActive(b) ? ' modified' : ''}" data-hsl-band="${esc(b.id)}" role="button" tabindex="0" title="Edit color #${i + 1} (${esc(b.hex)})">
          <span class="hsl-band-dot" style="background:${esc(b.hex)}"></span>
          <span class="hsl-band-idx">#${i + 1}</span>
          ${bands.length > 1 ? `<button type="button" class="hsl-band-rm" data-hsl-remove="${esc(b.id)}" title="Remove color">×</button>` : ''}
        </div>`).join('');
      const canAdd = bands.length < MAX_HSL_BANDS;

      bodyHtml = `
        <div class="hsl-bands-bar">
          ${bandPills}
          ${canAdd ? '<button type="button" class="hsl-add-band" data-act="add-hsl-band" title="Add another color to control simultaneously">+ Color</button>' : ''}
        </div>
        <div class="hsl-wheel-row">
          <canvas class="hsl-wheel" width="136" height="136" title="Click or drag to pick a target color"></canvas>
          <div class="hsl-controls">
            <div class="lbl">Target color</div>
            <div class="hsl-hex-row">
              <span class="hsl-chip" style="background:${esc(targetHex)}"></span>
              <input class="hsl-hex-input" data-hsl-hex="1" value="${esc(targetHex.toUpperCase())}" maxlength="7" spellcheck="false" aria-label="Hex color code">
            </div>
            <div class="hsl-dropper-row">
              <button class="hsl-dropper-btn${s.eyedropper === 'replace' ? ' on' : ''}" data-act="eyedropper" title="Pick a color from the video for this slot">💧 ${s.eyedropper === 'replace' ? 'Click video…' : 'Pick color'}</button>
              ${canAdd ? `<button class="hsl-dropper-btn${s.eyedropper === 'add' ? ' on' : ''}" data-act="eyedropper-add" title="Pick a new color from the video and add it as a new slot">+💧 New</button>` : ''}
            </div>
            <div class="hsl-swatches">
              ${HSL_SWATCHES.map((sw) => `<button type="button" class="hsl-swatch${targetHex.toLowerCase() === sw ? ' on' : ''}" data-hsl-swatch="${sw}" style="background:${sw}" title="${sw}"></button>`).join('')}
            </div>
          </div>
        </div>
        <div class="insp-filter-list">
          ${HSL_BAND_FIELDS.map((f) => scrubField(f.prop, active, f.key)).join('')}
        </div>
        <div class="insp-row">
          <button data-act="reset-hsl">Reset all HSL</button>
        </div>`;
    } else if (tab === 'transitions' && isVideo) {
      bodyHtml = `
        <div class="lbl">Transition preset</div>
        <div class="insp-tr-grid">
          ${T.TRANSITION_TYPES.map((t) => `<button class="${activeTr === t.id ? 'on' : ''}" data-tr-type="${t.id}">${esc(t.label)}</button>`).join('')}
        </div>
        ${activeTr !== 'none' ? scrubField('transition') : '<p class="muted hint">Pick a transition above to apply it to this clip.</p>'}`;
    } else {
      const kfs = Array.isArray(c.volumeKeyframes) ? c.volumeKeyframes : [];
      const audioEnvHtml = isMedia ? `
        <div class="lbl">Audio Fades &amp; Volume Keyframes <span class="muted">(Alt+Click clip)</span></div>
        <div class="exp-two-col">
          <label class="exp-lbl">Fade In (s)
            <input type="number" min="0" max="${c.dur.toFixed(2)}" step="0.05" value="${(c.fadeIn || 0).toFixed(2)}" data-fade-input="in">
          </label>
          <label class="exp-lbl">Fade Out (s)
            <input type="number" min="0" max="${c.dur.toFixed(2)}" step="0.05" value="${(c.fadeOut || 0).toFixed(2)}" data-fade-input="out">
          </label>
        </div>
        <div class="insp-row">
          <button data-act="vol-kf-add" title="Add or update a volume keyframe at the playhead">+ Keyframe at playhead</button>
          ${kfs.length ? '<button data-act="vol-kf-clear">Clear</button>' : ''}
        </div>
        ${kfs.length ? `<div class="kf-list">${kfs.map((k) => `
          <div class="kf-row">
            <button class="kf-jump" data-act="vol-kf-jump" data-kf-time="${k.t}" title="Jump playhead to +${k.t.toFixed(2)}s">+${k.t.toFixed(2)}s</button>
            <input type="number" class="kf-val" min="0" max="400" step="5" value="${Math.round(k.value * 100)}" data-kf-val="1" data-kf-time="${k.t}" aria-label="Volume percent">
            <span class="muted">%</span>
            <button class="kf-del" data-act="vol-kf-del" data-kf-id="${esc(k.id)}" title="Delete keyframe">×</button>
          </div>`).join('')}</div>` : ''}` : '';

      bodyHtml = `
        ${isMedia ? scrubField('volume') : ''}
        ${audioEnvHtml}
        ${isVideo ? scrubField('opacity') : ''}
        ${isVideo ? scrubField('blur') : ''}
        ${isVideo ? `<div class="lbl">Transform <span class="muted">(Shift + trackpad in Viewer)</span></div>
        ${T.TRANSFORM_PROPS.map((p) => scrubField(p)).join('')}
        <div class="insp-row">
          <button class="${c.flipH ? 'on' : ''}" data-act="mirror-h" title="Mirror horizontally">⇄ Mirror H</button>
          <button class="${c.flipV ? 'on' : ''}" data-act="mirror-v" title="Mirror vertically">⇅ Mirror V</button>
          <button data-act="reset-transform" title="Reset scale, rotation, position, and mirror">Reset</button>
        </div>` : ''}
        ${isVideo ? `<div class="lbl">Framing</div>
        <div class="insp-row">
          <button class="${c.fill ? 'on' : ''}" data-act="fill" title="Fill the export frame, cropping the edges (for vertical Shorts from wide clips)">▣ Fill frame</button>
        </div>
        ${scrubField('zoom')}
        ${scrubField('panX')}
        ${scrubField('panY')}` : ''}
        ${isMedia ? `<div class="insp-row"><button data-act="mute">${c.muted ? 'Unmute' : 'Mute'}</button>
          ${isVideo && c.hasAudio !== false && !c.muted ? '<button data-act="detach">Separate Audio Track</button>' : ''}</div>` : ''}
        <div class="insp-row"><button data-act="delete">Delete clip</button></div>`;
    }

    const multiNote = multiCount > 1 ? ` · +${multiCount - 1} more selected` : '';
    root.innerHTML = `
      <div class="insp-title" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="muted insp-meta">${esc(c.track)} · start ${c.start.toFixed(2)} s · length ${c.dur.toFixed(2)} s · speed ×${c.speed || 1}${multiNote}</div>
      ${tabsHtml}
      <div class="insp-body">${bodyHtml}</div>`;

    if (tab === 'hsl' && isVideo && active) {
      drawColorWheel(root.querySelector('.hsl-wheel'), normalizeHex(active.hex, '#ef4444'), bands);
    }
  }

  return { el: root, update };
}

// ---------- Tools ----------

export function toolsPanel({ store, actions }) {
  const root = el(`<div class="panel tools">
    <div class="tabs" role="tablist"></div>
    <div class="tool-list"></div>
    <div class="hint muted">Manual editing works now. Upcoming AI &amp; finishing tools are marked as coming soon.</div>
  </div>`);

  root.addEventListener('click', (e) => {
    const page = e.target.closest('[data-page]');
    if (page) return actions.setPage(page.dataset.page);
    const tool = e.target.closest('[data-tool]');
    if (tool && !tool.disabled) actions.runTool(tool.dataset.tool);
  });

  function update(s) {
    root.querySelector('.tabs').innerHTML = PAGES.map((p) =>
      `<button class="${p.id === s.page ? 'on' : ''}" data-page="${p.id}" aria-pressed="${p.id === s.page}">${p.label}</button>`).join('');
    const sel = s.selected ? T.findClip(s.clips, s.selected) : null;
    const label = (t) => {
      if (t.id === 'format') return 'Format: ' + s.format;
      if (t.id === 'resolution') return 'Resolution: ' + s.resolution;
      return t.label;
    };
    root.querySelector('.tool-list').innerHTML = (TOOLS[s.page] || []).map((t) =>
      `<button class="${t.later ? 'tool-soon' : ''}" data-tool="${t.later ? '' : t.id}" ${t.later ? 'disabled title="Coming in a later step"' : ''}>${esc(label(t))}</button>`).join('')
      + `<div class="muted tool-sel">Selected clip: ${esc(sel ? sel.name : 'none')}</div>`;
  }

  return { el: root, update };
}

// ---------- Placeholder windows ----------

export function placeholderPanel(title, text) {
  const root = el(`<div class="panel placeholder"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p></div>`);
  return { el: root, update() {} };
}

// ---------- Remote machines ----------

export function remotePanel({ openRemote }) {
  const root = el(`<div class="panel remote"><h3>Remote machines</h3>
    <p class="muted">Add a machine over ssh to check its GPU, RAM, and ComfyUI models.</p>
    <button data-act="open" class="ai">Open Remote machines</button></div>`);
  root.addEventListener('click', (e) => { if (e.target.closest('[data-act="open"]')) openRemote(); });
  return { el: root, update() {} };
}

// ---------- AI Chat (Claude Code, Codex, OpenCode, Antigravity MCP) ----------

const CHAT_STARTERS = [
  'Give the selected clip a warm cinematic grade (+15 temp, 58 contrast, 20 vignette)',
  'Split at the playhead and add a 1s fade to black on the clip',
  'Set up a 9:16 TikTok 1080p 30fps export',
  'Write a useful color grading tip to the Help & Tips page',
];

export function aiChatPanel({ store, actions, workspace }) {
  const api = window.zaudeAgent || null;
  const root = el(`<div class="panel aichat">
    <div class="aichat-head">
      <div class="aichat-providers" role="radiogroup" aria-label="AI Provider"></div>
      <span class="mcp-badge muted" title="External MCP clients (Antigravity, Claude, Codex, OpenCode) can connect directly to Zaude">MCP</span>
    </div>
    <div class="aichat-log" aria-live="polite"></div>
    <div class="aichat-starters">
      ${CHAT_STARTERS.map((q) => `<button type="button" class="aichat-chip" data-starter="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <form class="aichat-form">
      <textarea class="aichat-input" rows="2" placeholder="Ask Claude, Codex, or OpenCode to edit your video or save a tip… (Enter to send)"></textarea>
      <div class="aichat-actions">
        <button type="submit" class="ai aichat-send">Send</button>
        <button type="button" class="aichat-cancel" hidden>Cancel</button>
        <button type="button" class="aichat-clear">Clear</button>
        <span class="grow"></span>
        <button type="button" class="aichat-help-link" data-open-help="1">MCP Setup &amp; Tips</button>
      </div>
    </form>
  </div>`);

  const provBar = root.querySelector('.aichat-providers');
  const mcpBadge = root.querySelector('.mcp-badge');
  const logEl = root.querySelector('.aichat-log');
  const startersEl = root.querySelector('.aichat-starters');
  const form = root.querySelector('.aichat-form');
  const inputEl = root.querySelector('.aichat-input');
  const sendBtn = root.querySelector('.aichat-send');
  const cancelBtn = root.querySelector('.aichat-cancel');

  let providers = [
    { id: 'claude', label: 'Claude', available: false },
    { id: 'codex', label: 'Codex', available: false },
    { id: 'opencode', label: 'OpenCode', available: false },
  ];
  let selectedProvider = 'claude';
  let busy = false;
  const messages = []; // { role: 'user'|'assistant'|'error', provider?, text, actions?: [{tool, ok, summary}] }

  function renderProviders() {
    provBar.innerHTML = providers.map((p) => `
      <button type="button" class="prov-pill${p.id === selectedProvider ? ' on' : ''}${p.available ? ' ready' : ''}" data-prov="${p.id}" title="${p.available ? `${p.label} detected at ${p.path}` : `${p.label} CLI not found in PATH`}">
        <span class="prov-dot"></span>${esc(p.label)}
      </button>`).join('');
  }

  function renderMessages() {
    startersEl.hidden = messages.length > 0;
    if (!messages.length) {
      logEl.innerHTML = `<div class="aichat-empty muted">
        <p><b>AI Video Assistant</b></p>
        <p>Tell <b>Claude Code</b>, <b>Codex</b>, or <b>OpenCode</b> what edit you want — they read your live timeline and apply filters, HSL, transforms, splits, transitions, exports, or save tips directly to the Help page.</p>
        <p><b>Antigravity</b> and external MCP clients can also connect live via Zaude's MCP server (see <b>MCP Setup &amp; Tips</b>).</p>
      </div>`;
      return;
    }
    logEl.innerHTML = messages.map((m) => {
      const actHtml = m.actions && m.actions.length
        ? `<div class="aichat-tools">${m.actions.map((a) => `<span class="tool-tag ${a.ok ? 'ok' : 'err'}" title="${esc(a.summary || a.error || '')}">${a.ok ? '✓' : '✗'} ${esc(a.tool)}${a.summary ? ': ' + esc(a.summary) : ''}</span>`).join('')}</div>`
        : '';
      const who = m.role === 'user' ? 'You' : m.role === 'error' ? 'Error' : (m.providerLabel || 'AI');
      return `<div class="aichat-msg ${m.role}">
        <div class="aichat-who">${esc(who)}</div>
        <div class="aichat-text">${esc(m.text)}</div>
        ${actHtml}
      </div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    sendBtn.textContent = on ? 'Thinking…' : 'Send';
    cancelBtn.hidden = !on;
    inputEl.disabled = on;
  }

  async function sendMessage(text) {
    const clean = String(text || '').trim();
    if (!clean || busy) return;
    if (!api) {
      messages.push({ role: 'error', text: 'AI Chat requires the Zaude desktop app.' });
      renderMessages();
      return;
    }
    const prov = providers.find((p) => p.id === selectedProvider) || providers[0];
    messages.push({ role: 'user', text: clean });
    inputEl.value = '';
    renderMessages();
    setBusy(true);

    try {
      const s = store.get();
      const res = await api.chat({
        provider: selectedProvider,
        message: clean,
        state: buildAgentStateSnapshot(store),
        history: messages.slice(0, -1).map((m) => ({ role: m.role, text: m.text })),
        projectFolder: s.projectFolder,
      });
      if (!res.ok) {
        messages.push({ role: 'error', text: res.error || 'AI request failed.' });
      } else {
        const executed = [];
        for (const call of Array.isArray(res.calls) ? res.calls : []) {
          const out = await executeAgentTool(call, { store, actions, workspace });
          executed.push({ tool: call.tool, ok: Boolean(out && out.ok), summary: (out && (out.summary || out.error)) || '' });
        }
        messages.push({
          role: 'assistant',
          providerLabel: prov ? prov.label : selectedProvider,
          text: res.text || 'Done.',
          actions: executed,
        });
      }
    } catch (err) {
      messages.push({ role: 'error', text: err.message || String(err) });
    } finally {
      setBusy(false);
      renderMessages();
      inputEl.focus();
    }
  }

  root.addEventListener('click', (e) => {
    const provBtn = e.target.closest('[data-prov]');
    if (provBtn) {
      selectedProvider = provBtn.dataset.prov;
      renderProviders();
      return;
    }
    const starter = e.target.closest('[data-starter]');
    if (starter) {
      sendMessage(starter.dataset.starter);
      return;
    }
    if (e.target.closest('.aichat-cancel') && api) {
      api.cancel();
      return;
    }
    if (e.target.closest('.aichat-clear')) {
      messages.length = 0;
      renderMessages();
      return;
    }
    if (e.target.closest('[data-open-help]') && workspace && workspace.ensurePanel) {
      workspace.ensurePanel('help');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  renderProviders();
  renderMessages();

  if (api && api.info) {
    api.info().then((info) => {
      if (info && Array.isArray(info.providers)) {
        providers = info.providers;
        const firstAvail = providers.find((p) => p.available);
        if (firstAvail && !providers.find((p) => p.id === selectedProvider && p.available)) {
          selectedProvider = firstAvail.id;
        }
        renderProviders();
      }
      if (info && info.bridgePort) {
        mcpBadge.textContent = info.antigravity && info.antigravity.available ? 'MCP · Antigravity Ready' : 'MCP Live';
        mcpBadge.classList.add('live');
        mcpBadge.title = `Zaude MCP bridge listening on 127.0.0.1:${info.bridgePort}`;
      }
    }).catch(() => {});
  }

  return { el: root, update() {} };
}

// ---------- Help, Manual & AI Tips Page ----------

export function helpPanel() {
  const api = window.zaudeAgent || null;
  const aiApi = window.zaudeAI || null;
  const root = el(`<div class="panel help-panel">
    <div class="tabs help-tabs" role="tablist">
      <button class="on" data-help-tab="guide">📖 Guide</button>
      <button data-help-tab="ai">🤖 AI &amp; Prompts</button>
      <button data-help-tab="perf">⚡ Performance</button>
      <button data-help-tab="folders">📂 Folders</button>
      <button data-help-tab="controls">⌨️ Controls</button>
      <button data-help-tab="tips">💡 Tips</button>
      <button data-help-tab="mcp">🔌 MCP</button>
    </div>
    <div class="help-body"></div>
  </div>`);

  const body = root.querySelector('.help-body');
  let tab = 'guide';
  let tips = [];
  let search = '';
  let agentInfo = null;

  function copyText(text, btn) {
    navigator.clipboard?.writeText(text).then(() => {
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }).catch(() => {});
  }

  function render() {
    root.querySelectorAll('[data-help-tab]').forEach((b) => b.classList.toggle('on', b.dataset.helpTab === tab));

    if (tab === 'guide') {
      body.innerHTML = `<div class="help-section help-manual">
        <div class="help-hero">
          <h3>🎬 Welcome to Zaude — Complete Editor &amp; AI Studio Guide</h3>
          <p class="muted">Zaude is a fast, GPU-accelerated desktop video editor built for trackpad editing, beat-synced cutting, multi-color selective HSL grading, and 1-click AI video generation (remote RTX 3090 MiniMax-H3 + local laptop LTX-Video 2B / Wan 2.1).</p>
        </div>

        <h4>1. Workspace &amp; Panels</h4>
        <ul class="help-list">
          <li><b>Media Bin</b>: Open any project folder, preview clips, and drag or insert video/audio onto the timeline.</li>
          <li><b>Viewer</b>: Hardware-accelerated WebGL preview with Apple Maps-style pinch zoom, Shift+swipe pan, 1-finger screw rotate, live white export-frame overlay, and AI live-render HUD.</li>
          <li><b>Timeline</b>: Multi-track <code>+V</code> / <code>+A</code> dynamic tracks, AutoCAD Blue (enclosed) &amp; Green (crossing) box selection, editable beat markers with Snap-to-Beat, audio waveforms, fade handles, and piecewise-linear volume keyframes.</li>
          <li><b>Inspector</b>: Transform (scale/rotation/pan/mirror), Filters, <b>GPU Multi-Color Selective HSL</b> (up to 8 color bands + live video eyedropper), Transitions, and Export Panel.</li>
          <li><b>Portable <code>.zd</code> Projects</b>: <code>Ctrl+S</code> / <code>Ctrl+O</code> packs your entire timeline + all video &amp; audio bytes into a single self-contained <code>.zd</code> archive you can move anywhere.</li>
        </ul>

        <h4>2. Right-Click AI Superpowers on Timeline Clips</h4>
        <ul class="help-list">
          <li><b>✨ FrameToFrame</b> (select <b>2 clips</b> → right-click): Extracts clip 1's last frame and clip 2's first frame, pre-fills the gap duration, and generates a seamless AI bridge between them.</li>
          <li><b>✨ FrameContinue</b> (right-click <b>1 clip</b>): Automatically loads that clip's saved <code>.h3latent.safetensors</code> (locking the exact matching resolution so it never mismatches!), previews its ending frame, and continues the action with your new prompt. For external videos without a latent, automatically uses a 2s tail and trims off the prepended source clip.</li>
          <li><b>✨ Upscale &amp; Fix Faces · 640p</b> (select <b>1 or N clips</b> → right-click): Recovers each clip's RefMods + prompt from its sidecar JSON and runs a MiniMax-H3 2nd-pass refine at 640p, replacing clips in-place.</li>
          <li><b>⚡ Fast 2× Upscale · RealESRGAN</b> (select <b>1 or N clips</b> → right-click): Runs <code>RealESRGAN_x2plus.pth</code> on Tranklena in seconds per clip while preserving exact original audio.</li>
        </ul>

        <h4>3. Top Bar Tools</h4>
        <ul class="help-list">
          <li><b>✨ AI Studio</b>: Switch in 1 click between <b>🌐 Tranklena · MiniMax-H3</b> (RTX 3090 24 GB) and <b>💻 Rizzar · Local</b> (LTX-Video 2B Distilled / Wan 2.1). Includes Text→Video, RefMod→Video, Stylize &amp; Objects, Coverage, and the <b>✨ Advance Prompt</b> AI + <b>📚 Prompt Database</b>.</li>
          <li><b>🖥️ Local GPU</b>: Analyzes your laptop's GPU, RAM, and disk, lets an AI agent search the web for the newest local models, and 1-click installs ComfyUI + GGUF models + Turbo LoRAs + GPU optimizations.</li>
          <li><b>AI Chat</b>: Talk directly to Claude Code, Codex, or OpenCode with live MCP tools that can inspect and edit your timeline.</li>
        </ul>
      </div>`;
      return;
    }

    if (tab === 'ai') {
      const sampleRefmod = `Medium two-shot in a warm dimly lit study with wooden bookshelves and a glowing green desk lamp. Subject 1 (Elias, NOT in his default coat, instead wearing a rumpled dark olive crewneck sweater) leans forward over an oak desk. Subject 2 (Daniel, NOT in his default jacket, instead wearing a heather grey hoodie) grips a ceramic mug. The desktop monitor stays brightly ON showing a blue spreadsheet. Slow 50mm push-in, shallow depth of field. Dialogue (0.8s–4.8s): Subject 1 whispers, "If we move tonight, nobody catches us."`;
      const sampleFight = `One continuous dark fantasy action shot on a 35mm lens. Open behind the blonde woman in the dim stone corridor. She lunges forward from screen-left and lands two quick blows; the monster barely flinches and swats her aside into the left wall. As it rears back, Subject 1 (Tony) rushes in from screen-right, steps between them, and lands one decisive strike. Camera jolts once on impact then steadies as the creature collapses onto the stone floor. overall_soundscape: Echoing footsteps, muted impact thuds, deep creature growl, sharp crack on Tony's strike, heavy floor thump. non_diegetic_music: Low tense drone builds then cuts out on impact.`;
      const sampleLtx = `Smooth cinematic 35mm dolly-in through a rain-slicked Tokyo alleyway at midnight. Cyan and magenta neon signs shimmer in deep asphalt puddles as light rain falls through mist. A lone silhouette under a clear vinyl umbrella walks steadily down the narrow lane while steam rises from a ramen vent. Consistent moody lighting, natural 24fps motion blur, single continuous shot.`;

      body.innerHTML = `<div class="help-section help-manual">
        <h4>✨ Prompt Advancer, Master Prompts &amp; Learning DB</h4>
        <ul class="help-list">
          <li>Click the purple <b>✨ Advance Prompt</b> button above any prompt box to have your connected AI (Claude / Codex / OpenCode) upgrade your draft and ask clickable clarifying questions when details are ambiguous.</li>
          <li><b>Directing Master Prompts</b> (saved in <code>prompts/master-prompts.json</code> so everyone with Zaude shares them): toggle pills like <b>🎥 Cinema Camera Rules</b>, <b>🥊 Better Fights &amp; Action</b>, <b>🎭 Dialogue &amp; Acting</b>, <b>🧬 Strict RefMod Lock</b>, <b>🔊 Rich Sound &amp; Foley</b>, or <b>💻 Local LTX 2B Tuned</b> before running!</li>
          <li><b>📚 Prompt Database</b>: Click <b>⭐ Apply &amp; Save to DB</b> on prompts that rendered well. Zaude ranks your highest-rated working examples and feeds them back into future Prompt Advancer runs so the AI learns your style over time.</li>
        </ul>

        <h4>Golden Rules for MiniMax-H3 (Tranklena)</h4>
        <ul class="help-list">
          <li><b>RefMod Outfit Override</b>: Always negate default clothes first — <code>NOT in default outfit, instead wearing...</code></li>
          <li><b>Screen Lock</b>: Explicitly state <code>The television/monitor screen stays brightly lit and ON the entire time</code> so screens don't flicker black.</li>
          <li><b>Verbatim Room Anchors</b>: Repeat exact lighting, wall color, and key props across shots for continuity.</li>
          <li><b>Draft → Touchup Workflow</b>: Draft fast at <code>480p</code> (or <code>320p</code> for blocking), then right-click your best takes → <b>✨ Upscale &amp; Fix Faces · 640p</b>!</li>
        </ul>

        <h4>Working Prompt Templates (Click to Copy)</h4>
        <div class="help-prompt-card">
          <div class="help-prompt-head"><b>🧬 RefMod Multi-Char Dialogue + Outfit Override</b><button type="button" data-copy="${esc(sampleRefmod)}">Copy</button></div>
          <pre class="help-code">${esc(sampleRefmod)}</pre>
        </div>
        <div class="help-prompt-card">
          <div class="help-prompt-head"><b>🥊 Action / Fight Choreography + Soundscape</b><button type="button" data-copy="${esc(sampleFight)}">Copy</button></div>
          <pre class="help-code">${esc(sampleFight)}</pre>
        </div>
        <div class="help-prompt-card">
          <div class="help-prompt-head"><b>💻 Local LTX-Video 2B (8-Step Distilled · 8 GB Laptop)</b><button type="button" data-copy="${esc(sampleLtx)}">Copy</button></div>
          <pre class="help-code">${esc(sampleLtx)}</pre>
        </div>
      </div>`;
      return;
    }

    if (tab === 'perf') {
      body.innerHTML = `<div class="help-section help-manual">
        <h4>⚡ Expected Performance: Tranklena vs. Rizzar</h4>
        <table class="help-table">
          <thead>
            <tr><th>Engine / Machine</th><th>Model</th><th>Resolution</th><th>Sweet-Spot Length</th><th>Expected Time</th><th>Best Used For</th></tr>
          </thead>
          <tbody>
            <tr><td><b>🌐 Tranklena</b><br><span class="muted">RTX 3090 · 24 GB</span></td><td>MiniMax-H3 (4-step Turbo)</td><td><b>640p</b> (1120×640)</td><td>7s (6 steps, 24fps)</td><td><b>~5–6.5 min</b></td><td>Production shots, RefMod dialogue, synced audio, FrameContinue</td></tr>
            <tr><td><b>🌐 Tranklena</b><br><span class="muted">RTX 3090 · 24 GB</span></td><td>MiniMax-H3</td><td><b>480p</b> (864×480)</td><td>5–7s (6 steps)</td><td><b>~2.5–3.5 min</b></td><td>Fast story blocking &amp; drafts (then right-click Upscale to 640p)</td></tr>
            <tr><td><b>🌐 Tranklena</b><br><span class="muted">RTX 3090 · 24 GB</span></td><td>MiniMax-H3 FL2VA</td><td><b>480p–640p</b></td><td>3–5s (8 steps)</td><td><b>~2–4 min</b></td><td>Right-click FrameToFrame bridges between 2 clips</td></tr>
            <tr><td><b>🌐 Tranklena</b><br><span class="muted">RTX 3090 · 24 GB</span></td><td>RealESRGAN 2×</td><td>2× source</td><td>Any clip</td><td><b>~15–35 sec</b></td><td>Fast crisp multi-clip upscale preserving original audio</td></tr>
            <tr><td><b>💻 Rizzar (Local)</b><br><span class="muted">RTX 2070S Max-Q · 8 GB</span></td><td>LTX-Video 2B 0.9.8 GGUF</td><td><b>320p–480p</b></td><td>2–4s (8 steps, 24fps)</td><td><b>~35–85 sec</b></td><td>Offline B-roll, quick shot tests, local First/Last Frame (uses ~5 GB VRAM)</td></tr>
            <tr><td><b>💻 Rizzar (Local)</b><br><span class="muted">RTX 2070S Max-Q · 8 GB</span></td><td>Wan 2.1 1.3B GGUF</td><td><b>480p</b> (832×480)</td><td>3–4s (8 steps, CausVid)</td><td><b>~50–110 sec</b></td><td>Sharp local T2V without needing Tranklena online</td></tr>
          </tbody>
        </table>

        <h4>Recommended Production &amp; Export Settings</h4>
        <ul class="help-list">
          <li><b>Tranklena Production Sweet Spot</b>: <code>640p</code> · <code>6 steps</code> (<code>7 steps</code> for FrameContinue) · <code>7s</code> · <code>24 fps</code> · 4-step Turbo LoRA.</li>
          <li><b>Local Rizzar Sweet Spot</b>: <code>480p</code> (768×512) · <code>8 steps</code> · <code>4s</code> · ComfyUI flags <code>--use-pytorch-cross-attention --force-fp16 --lowvram --preview-method auto</code>.</li>
          <li><b>Final Export</b>: <code>30 fps</code> · <b>Ultra</b> quality · <code>1920×1080</code> (16:9) or <code>1080×1920</code> (9:16) · Fill frame + Sharpen <code>38</code> · NVENC GPU encode.</li>
          <li><b>Audio Mix Targets</b>: <code>-14.0 LUFS</code> (TP <code>-1.5 dB</code>). Dialogue cut: V1 <code>100%</code> + Music <code>16%</code>. Narrated cut: V1 <code>20%</code> + VO <code>100%</code> + Music <code>16%</code>.</li>
        </ul>
      </div>`;
      return;
    }

    if (tab === 'folders') {
      const folders = [
        { name: 'Master Prompts (Shared in App)', path: '/home/laude/Projects/Zaude/prompts/master-prompts.json', desc: 'Directing directives (Cinema Camera, Better Fights, RefMod Lock, etc.) used by ✨ Advance Prompt.' },
        { name: 'Visual RefMods Library', path: '/home/laude/Projects/Zaude/refmods', desc: 'Character folders containing headshot.png and walk.mp4 hover previews for the RefMod grid.' },
        { name: 'Rendered AI Clips & Sidecars', path: '/home/laude/Videos/Zaude', desc: 'All generated MP4 clips plus their .json sidecars (storing saved_latent, RefMods, prompt, resolution).' },
        { name: 'Local ComfyUI & Models (Rizzar)', path: '/home/laude/ComfyUI', desc: 'Local ComfyUI install: models/unet/ (LTX 0.9.8 GGUF), models/vae/, models/clip/ (T5-XXL GGUF), custom_nodes/.' },
        { name: 'Zaude User Data & Prompt DB', path: '/home/laude/.config/Zaude', desc: 'Persistent prompt-db.json (learning prompt database), ai-tips.json, latent-names.json, zaude-settings.json, and ai-previews/.' },
        { name: 'Mannimmate Backend CLI', path: '/home/laude/Documents/MeineProgramme/mannimmate', desc: 'mannimmate_cli.py and refmod_graph.py driving Tranklena MiniMax-H3 workflows.' },
      ];
      body.innerHTML = `<div class="help-section help-manual">
        <h4>📂 Important Folders &amp; Configuration Files</h4>
        <p class="muted">Everything Zaude reads or writes lives in these predictable folders. Click <b>Open</b> to reveal in your file manager or <b>Copy</b> to copy the exact path.</p>
        <div class="help-folder-list">
          ${folders.map((f) => `
            <div class="help-folder-card">
              <div class="help-folder-head">
                <b>${esc(f.name)}</b>
                <div class="help-folder-btns">
                  <button type="button" data-copy="${esc(f.path)}">Copy</button>
                  ${aiApi && aiApi.reveal ? `<button type="button" data-reveal-path="${esc(f.path)}">Open</button>` : ''}
                </div>
              </div>
              <code class="help-path">${esc(f.path)}</code>
              <div class="muted">${esc(f.desc)}</div>
            </div>
          `).join('')}
        </div>
      </div>`;
      return;
    }

    if (tab === 'controls') {
      body.innerHTML = `<div class="help-section">
        <h4>Laptop Trackpad — Viewer</h4>
        <ul class="help-list">
          <li><b>Pinch</b>: Zoom / Scale video (<b>Shift + Pinch</b> = half-speed precision)</li>
          <li><b>Shift + Two-finger swipe</b> (L/R/U/D): Pan video Position X / Y (Apple Maps style)</li>
          <li><b>1-finger anchored screw turn</b> (or <b>R + scroll</b> / <b>Shift + Alt + drag</b>): Rotate video</li>
          <li><b>White inner frame</b>: Exact exported region (adapts to Export aspect ratio); darker outside shows off-frame clip area</li>
        </ul>
        <h4>Laptop Trackpad — Timeline</h4>
        <ul class="help-list">
          <li><b>Ctrl + horizontal swipe</b>: Fine-tune selected clip length</li>
          <li><b>Shift + horizontal swipe</b>: Move selected clip(s)</li>
          <li><b>Alt + horizontal swipe</b>: Slip source window</li>
          <li><b>Ctrl + vertical swipe</b> over a clip: Adjust clip volume</li>
          <li><b>Drag empty space Left → Right (Blue)</b>: Select fully enclosed clips (AutoCAD Window)</li>
          <li><b>Drag empty space Right → Left (Green)</b>: Select any touched clips (AutoCAD Crossing)</li>
          <li><b>Right-click 1 or more video clips</b>: ✨ FrameToFrame, ✨ FrameContinue, ✨ Upscale &amp; Fix Faces, ⚡ Fast 2× Upscale, Separate Audio, Mute, Split, Duplicate, Delete</li>
        </ul>
        <h4>Keyboard &amp; Projects</h4>
        <ul class="help-list">
          <li><b>Space</b>: Play / Pause · <b>S</b>: Split at playhead · <b>← / →</b>: Step 1 frame (<b>Shift</b> = 1s)</li>
          <li><b>Ctrl+Z / Ctrl+Y</b>: Undo / Redo · <b>+ / −</b>: Zoom timeline</li>
          <li><b>Ctrl+S / Ctrl+O</b>: Save / Open self-contained <code>.zd</code> project archive (bundles all video &amp; audio)</li>
          <li><b>Double-click any Inspector slider</b>: Reset to default</li>
        </ul>
      </div>`;
      return;
    }

    if (tab === 'mcp') {
      const srvPath = (agentInfo && agentInfo.mcpServerPath) || '/home/laude/Projects/Zaude/electron/mcp-server.cjs';
      const port = agentInfo && agentInfo.bridgePort;
      const mcpJson = JSON.stringify({
        mcpServers: {
          zaude: {
            command: 'node',
            args: [srvPath],
          },
        },
      }, null, 2);
      const claudeCmd = `claude mcp add zaude -- node "${srvPath}"`;
      const codexCmd = `codex mcp add zaude -- node "${srvPath}"`;
      const opencodeJson = JSON.stringify({
        mcp: {
          zaude: {
            type: 'local',
            command: ['node', srvPath],
            enabled: true,
          },
        },
      }, null, 2);

      body.innerHTML = `<div class="help-section">
        <div class="mcp-status-card">
          <span class="prov-dot ${port ? 'on' : ''}"></span>
          <div>
            <b>Zaude MCP Server</b>
            <div class="muted">${port ? `Live bridge active on 127.0.0.1:${port}` : 'Desktop bridge active when running Zaude desktop app'}</div>
          </div>
        </div>
        <p class="muted">Connect <b>Antigravity</b>, <b>Claude Code</b>, <b>Codex</b>, or <b>OpenCode</b> to Zaude's MCP server so any AI can inspect your timeline, perform edits, and write tips to the Help page.</p>

        <h4>Antigravity / Standard MCP JSON</h4>
        <pre class="help-code">${esc(mcpJson)}</pre>
        <button type="button" data-copy="${esc(mcpJson)}">Copy Antigravity / MCP JSON</button>

        <h4>Claude Code CLI</h4>
        <pre class="help-code">${esc(claudeCmd)}</pre>
        <button type="button" data-copy="${esc(claudeCmd)}">Copy Claude command</button>

        <h4>Codex CLI</h4>
        <pre class="help-code">${esc(codexCmd)}</pre>
        <button type="button" data-copy="${esc(codexCmd)}">Copy Codex command</button>

        <h4>OpenCode MCP Config</h4>
        <pre class="help-code">${esc(opencodeJson)}</pre>
        <button type="button" data-copy="${esc(opencodeJson)}">Copy OpenCode JSON</button>
      </div>`;
      return;
    }

    // AI Tips & Tricks tab
    const q = search.trim().toLowerCase();
    const shown = q
      ? tips.filter((t) => `${t.title} ${t.category} ${t.author} ${t.body}`.toLowerCase().includes(q))
      : tips;

    const cards = shown.length
      ? shown.map((t) => `
          <article class="tip-card">
            <div class="tip-head">
              <b>${esc(t.title)}</b>
              <span class="tip-badge">${esc(t.category || 'General')}</span>
              <span class="tip-author muted">by ${esc(t.author || 'AI')}</span>
              <span class="grow"></span>
              <button type="button" class="area-btn" data-tip-rm="${esc(t.id)}" title="Delete tip">×</button>
            </div>
            <div class="tip-body">${esc(t.body)}</div>
          </article>`).join('')
      : '<p class="muted">No matching tips yet. Ask an AI in AI Chat (or via MCP) to add tips here, or write one below!</p>';

    body.innerHTML = `<div class="help-section">
      <div class="tips-toolbar">
        <input class="tips-search" type="search" placeholder="Search tips…" value="${esc(search)}">
        <span class="muted">${shown.length} tip${shown.length === 1 ? '' : 's'}</span>
      </div>
      <div class="tips-list">${cards}</div>
      <form class="tip-form">
        <div class="lbl">Add a tip or trick</div>
        <div class="tip-form-row">
          <input name="title" placeholder="Tip title" required maxlength="120">
          <input name="category" placeholder="Category (e.g. Color)" maxlength="40" value="Workflow">
        </div>
        <textarea name="body" rows="2" placeholder="Write a tip or trick…" required maxlength="4000"></textarea>
        <button type="submit" class="primary">Save Tip</button>
      </form>
    </div>`;
  }

  root.addEventListener('click', (e) => {
    const tBtn = e.target.closest('[data-help-tab]');
    if (tBtn) { tab = tBtn.dataset.helpTab; render(); return; }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) { copyText(copyBtn.dataset.copy, copyBtn); return; }
    const revBtn = e.target.closest('[data-reveal-path]');
    if (revBtn && aiApi && aiApi.reveal) { aiApi.reveal(revBtn.dataset.revealPath); return; }
    const rmBtn = e.target.closest('[data-tip-rm]');
    if (rmBtn && api && api.removeTip) {
      api.removeTip(rmBtn.dataset.tipRm).then((res) => {
        if (res && Array.isArray(res.tips)) { tips = res.tips; render(); }
      });
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target.matches('.tips-search')) {
      search = e.target.value;
      render();
      const inp = root.querySelector('.tips-search');
      if (inp) { inp.focus(); inp.setSelectionRange(search.length, search.length); }
    }
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('.tip-form');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    if (api && api.addTip) {
      const res = await api.addTip({
        title: fd.get('title'),
        category: fd.get('category'),
        author: 'You',
        body: fd.get('body'),
      });
      if (res && res.ok && Array.isArray(res.tips)) {
        tips = res.tips;
        render();
      }
    }
  });

  const offTips = api && api.onTipsUpdated
    ? api.onTipsUpdated((nextTips) => { tips = Array.isArray(nextTips) ? nextTips : tips; if (tab === 'tips') render(); })
    : null;

  if (api && api.listTips) {
    api.listTips().then((list) => { tips = Array.isArray(list) ? list : []; render(); }).catch(() => render());
  } else {
    render();
  }
  if (api && api.info) {
    api.info().then((info) => { agentInfo = info; if (tab === 'mcp') render(); }).catch(() => {});
  }

  return {
    el: root,
    update() {},
    destroy() { if (offTips) offTips(); },
  };
}

export const PANEL_BUILDERS = {
  bin: binPanel,
  viewer: viewerPanel,
  timeline: timelinePanel,
  inspector: inspectorPanel,
  tools: toolsPanel,
  aichat: aiChatPanel,
  help: helpPanel,
  masking: () => placeholderPanel('Masking', 'Masking is not built yet. It will cut a subject out of a shot.'),
  remote: remotePanel,
};
