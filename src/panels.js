// The content of each window type. Every panel builds its DOM once, updates from the store,
// and uses delegated listeners so it can be moved or rebuilt without losing state.
import * as T from './timeline.js';
import { previewRate } from './timeline.js';
import { TOOLS, PAGES } from './actions.js';
import { frameFor, ensureFrames, urlFor } from './thumbs.js';

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

// Each file is a small 16:9 tile with a still frame. Hovering plays the whole file sped up, so you can
// see what is in it. Double-click adds it to the timeline at the playhead; drag it onto a track to place it.
export function binPanel({ store, actions }) {
  const root = el(`<div class="panel bin">
    <div class="panel-bar">
      <button data-act="import">Import folder</button>
      <button data-act="save">Save project</button>
    </div>
    <div class="bin-folder muted"></div>
    <ul class="bin-list" role="listbox" aria-label="Bin"></ul>
    <div class="hint muted">Drag a file onto a track, or double-click it to add it at the playhead. Hover to preview.</div>
  </div>`);
  const list = root.querySelector('.bin-list');
  let lastKey = null;
  let hoverTile = null;
  let preview = null;

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'import') actions.importFolder();
      if (act.dataset.act === 'save') actions.saveProject();
      return;
    }
    const item = e.target.closest('[data-bin]');
    if (item) actions.selectBin(item.dataset.bin);
  });
  root.addEventListener('dblclick', (e) => {
    const item = e.target.closest('[data-bin]');
    if (item) actions.addBinItem(item.dataset.bin);
  });

  function stopPreview() {
    if (preview) {
      preview.pause();
      preview.removeAttribute('src');
      preview.remove();
      preview = null;
    }
    if (hoverTile) hoverTile.classList.remove('previewing');
    hoverTile = null;
  }

  async function startPreview(tile) {
    const path = tile.dataset.bin;
    const file = store.get().media.find((m) => m.path === path);
    if (!file || !file.hasVideo) return;
    hoverTile = tile;
    tile.classList.add('previewing');
    const url = await urlFor(path);
    // the pointer may have moved on while the URL was fetched
    if (!url || hoverTile !== tile) return;
    const v = document.createElement('video');
    v.className = 'bin-preview';
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => {
      v.playbackRate = previewRate(file.duration);
      v.play().catch(() => {});
    }, { once: true });
    v.src = url;
    tile.querySelector('.bin-thumb').appendChild(v);
    preview = v;
  }

  list.addEventListener('pointerover', (e) => {
    const tile = e.target.closest('.bin-tile');
    if (tile === hoverTile) return;
    stopPreview();
    if (tile) startPreview(tile);
  });
  list.addEventListener('pointerleave', stopPreview);

  function tileHtml(m) {
    const frame = frameFor(m.path);
    const thumb = m.hasVideo
      ? (frame ? `<img alt="" src="${frame}">` : '<span class="muted">▶</span>')
      : '<span class="muted">♪</span>';
    const dur = m.duration ? `<span class="bin-dur">${m.duration.toFixed(1)} s</span>` : '';
    const badges = [m.hasVideo ? 'video' : '', m.hasAudio ? 'audio' : ''].filter(Boolean).join(' · ');
    return `<li class="bin-tile" role="option" data-bin="${esc(m.path)}" title="${esc(m.name)}${badges ? ' · ' + badges : ''}">
      <div class="bin-thumb">${thumb}${dur}</div>
      <span class="bin-name">${esc(m.name)}</span>
    </li>`;
  }

  function update(s) {
    root.querySelector('.bin-folder').textContent = s.projectFolder
      ? `${s.projectName} · ${s.projectFolder}`
      : 'No folder open. Import a folder with your MP4s and audio.';
    if (!s.media.length) {
      stopPreview();
      list.innerHTML = '<li class="muted bin-empty">No files yet.</li>';
      lastKey = '';
      return;
    }
    // rebuild the tiles only when the files change, so a hover preview is not interrupted
    const key = s.media.map((m) => m.path).join('\n');
    if (key !== lastKey) {
      stopPreview();
      list.innerHTML = s.media.map(tileHtml).join('');
      lastKey = key;
      ensureFrames(s.media);
    }
    for (const t of list.querySelectorAll('.bin-tile')) {
      const on = t.dataset.bin === s.binSelected;
      t.classList.toggle('sel', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  // a frame finished in the background: put it into its tile
  const onThumb = (e) => {
    const tile = [...list.querySelectorAll('.bin-tile')].find((t) => t.dataset.bin === e.detail.path);
    const frame = frameFor(e.detail.path);
    if (!tile || !frame) return;
    const thumb = tile.querySelector('.bin-thumb');
    thumb.querySelector('span')?.remove();
    let img = thumb.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      thumb.prepend(img);
    }
    img.src = frame;
  };
  window.addEventListener('zaude:thumb', onThumb);

  return {
    el: root,
    update,
    destroy() {
      stopPreview();
      window.removeEventListener('zaude:thumb', onThumb);
    },
  };
}

// ---------- Viewer ----------

export function viewerPanel({ store, actions, engine }) {
  const root = el(`<div class="panel viewer">
    <div class="viewer-stage"><div class="viewer-text muted"></div></div>
    <div class="transport">
      <button data-act="play" aria-label="Play">▶</button>
      <span class="tc"></span>
      <span class="grow"></span>
      <span class="log" aria-live="polite"></span>
    </div>
    <div class="scrubbar" role="slider" aria-label="Scrub through the timeline" tabindex="0">
      <div class="scrub-fill"></div><div class="scrub-head"></div>
    </div>
  </div>`);
  const stage = root.querySelector('.viewer-stage');
  stage.prepend(engine.video);
  const bar = root.querySelector('.scrubbar');

  function seekFromX(clientX) {
    const r = bar.getBoundingClientRect();
    const end = T.projectEnd(store.get().clips);
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    actions.seekTo(f * end);
  }
  bar.addEventListener('pointerdown', (e) => {
    try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }
    seekFromX(e.clientX);
    const move = (ev) => seekFromX(ev.clientX);
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  root.querySelector('[data-act="play"]').addEventListener('click', () => actions.togglePlay());

  function timeText(s) {
    return T.timecode(s.playhead) + ' / ' + T.timecode(T.projectEnd(s.clips));
  }

  function updateTime(s) {
    root.querySelector('.tc').textContent = timeText(s);
    const end = T.projectEnd(s.clips);
    const f = end ? s.playhead / end : 0;
    root.querySelector('.scrub-fill').style.width = (f * 100) + '%';
    root.querySelector('.scrub-head').style.left = (f * 100) + '%';
  }

  function update(s) {
    const btn = root.querySelector('[data-act="play"]');
    btn.textContent = s.playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    const c = T.clipAt(s.clips, s.playhead);
    root.querySelector('.viewer-text').textContent = c && !c.path ? c.name : (c ? '' : 'No clip at playhead');
    root.querySelector('.log').textContent = s.log;
    root.querySelector('.log').title = s.log;
    updateTime(s);
  }

  return { el: root, update, updateTime };
}

// ---------- Timeline ----------

export function timelinePanel({ store, actions }) {
  const root = el(`<div class="panel timeline">
    <div class="tl-body">
      <div class="labels">${TRACKS.map((t) => `<div class="tlbl">${t.label}</div>`).join('')}</div>
      <div class="scroller">
        <div class="canvas">
          <div class="ruler" aria-label="Ruler. Click to move the playhead."></div>
          <div class="tracks"></div>
          <div class="playhead" aria-hidden="true"></div>
        </div>
      </div>
    </div>
    <div class="tl-bar">
      <button data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button data-act="split" title="Split at playhead">✂ Split</button>
      <button data-act="trim" title="Trim end to playhead">Trim</button>
      <button data-act="delete" title="Delete (Delete key)">Delete</button>
      <button data-act="duplicate" title="Duplicate">Duplicate</button>
      <button data-act="snap" class="snap-btn" title="Magnetic snap">Snap</button>
      <span class="sep"></span>
      <button data-act="zoomOut" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button data-act="zoomIn" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button data-act="fit" title="Fit the whole timeline">Fit</button>
      <div class="grow"></div>
      <span class="muted tl-info"></span>
    </div>
  </div>`);
  const scroller = root.querySelector('.scroller');
  const canvas = root.querySelector('.canvas');
  const ruler = root.querySelector('.ruler');
  const tracks = root.querySelector('.tracks');
  const playhead = root.querySelector('.playhead');

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'zoomIn') return actions.zoomIn();
      if (a === 'zoomOut') return actions.zoomOut();
      if (a === 'fit') return actions.fit(scroller.clientWidth);
      if (a === 'snap') return actions.toggleSnap();
      if (a === 'undo') return actions.undo();
      if (a === 'redo') return actions.redo();
      if (a === 'split') return actions.split();
      if (a === 'trim') return actions.trim();
      if (a === 'delete') return actions.deleteSelected();
      if (a === 'duplicate') return actions.duplicate();
      return;
    }
    const blk = e.target.closest('[data-clip]');
    if (blk) actions.select(blk.dataset.clip);
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
    if (!e.target.closest('.ruler') && e.target.closest('.blk')) return;
    e.preventDefault();
    scrubTo(e);
    const move = (ev) => scrubTo(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  ruler.addEventListener('pointerdown', startScrub);
  tracks.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-clip]')) actions.select(null);
    startScrub(e);
  });

  function update(s) {
    const end = T.projectEnd(s.clips);
    canvas.style.width = end * s.pps + 'px';

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
    ruler.innerHTML = ticks;

    tracks.innerHTML = TRACKS.map((tr) => {
      const blocks = s.clips.filter((c) => c.track === tr.id).map((c) => {
        const kind = c.generating ? 'gen' : (c.kind === 'audio' ? 'audio' : c.kind === 'video' ? 'video' : 'title');
        const sel = c.id === s.selected ? ' sel' : '';
        const speed = c.speed && c.speed !== 1 ? ` ×${c.speed}` : '';
        const vol = c.kind === 'audio' || c.kind === 'video' ? (c.muted ? ' · muted' : ` · ${Math.round(T.propValue(c, 'volume') * 100)}%`) : '';
        const pct = Math.round((c.progress || 0) * 100);
        const fill = c.generating ? `<span class="gen-fill${c.progress == null ? ' pulse' : ''}" style="width:${pct}%"></span>` : '';
        const dissolve = c.transition ? '<span class="tr" title="Cross dissolve"></span>' : '';
        return `<div class="blk ${kind}${sel}" role="button" tabindex="0" data-clip="${esc(c.id)}"
            aria-label="${esc(c.name)}" style="left:${c.start * s.pps}px;width:${Math.max(4, c.dur * s.pps)}px">
            ${fill}${dissolve}<span class="blk-label">${esc(c.name + speed + vol)}</span></div>`;
      }).join('');
      return `<div class="trk" data-track="${tr.id}">${blocks}</div>`;
    }).join('');

    root.querySelector('.snap-btn').classList.toggle('on', s.snap);
    root.querySelector('.tl-info').textContent = `Zoom ${s.pps.toFixed(1)} px/s · ${T.timecode(end)}`;
    updateTime(s);
  }

  function updateTime(s) {
    playhead.style.left = s.playhead * s.pps + 'px';
  }

  return { el: root, update, updateTime, scroller };
}

// ---------- Inspector ----------

export function inspectorPanel({ store, actions }) {
  const root = el(`<div class="panel inspector"></div>`);

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'detach') actions.detach();
    if (act.dataset.act === 'mute') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.commitClips(T.setFlag(s.clips, clip.id, 'muted', !clip.muted), (clip.muted ? 'Unmuted ' : 'Muted ') + clip.name);
    }
    if (act.dataset.act === 'delete') actions.deleteSelected();
  });

  function update(s) {
    const c = s.selected ? T.findClip(s.clips, s.selected) : null;
    if (!c) {
      root.innerHTML = '<p class="muted">Select a clip on the timeline to see its properties. Hold Ctrl and drag, or Ctrl and scroll, over a value to change it.</p>';
      return;
    }
    const isMedia = c.kind === 'video' || c.kind === 'audio';
    const scrubField = (prop) => `
      <div class="scrub-field" tabindex="0" role="slider" aria-label="${T.PROPS[prop].label}"
           data-scrub-clip="${esc(c.id)}" data-scrub-prop="${prop}"
           aria-valuemin="${T.PROPS[prop].min}" aria-valuemax="${T.PROPS[prop].max}" aria-valuenow="${T.propValue(c, prop)}">
        <span class="scrub-label">${T.PROPS[prop].label}</span>
        <span class="scrub-value">${T.PROPS[prop].format(T.propValue(c, prop))}</span>
        <span class="muted scrub-hint">Ctrl + drag or Ctrl + scroll</span>
      </div>`;
    root.innerHTML = `
      <div class="insp-title">${esc(c.name)}</div>
      <div class="muted">${esc(c.track)} · start ${c.start.toFixed(2)} s · length ${c.dur.toFixed(2)} s · speed ×${c.speed || 1}</div>
      ${isMedia ? scrubField('volume') : ''}
      ${c.kind === 'video' ? scrubField('opacity') : ''}
      ${isMedia ? `<div class="insp-row"><button data-act="mute">${c.muted ? 'Unmute' : 'Mute'}</button>
        ${c.kind === 'video' && c.hasAudio !== false && !c.muted ? '<button data-act="detach">Detach audio</button>' : ''}</div>` : ''}
      <div class="insp-row"><button data-act="delete">Delete clip</button></div>`;
  }

  return { el: root, update };
}

// ---------- Tools ----------

export function toolsPanel({ store, actions }) {
  const root = el(`<div class="panel tools">
    <div class="tabs" role="tablist"></div>
    <div class="tool-list"></div>
    <div class="hint muted">Manual editing works now. Purple AI buttons are disabled until AI features arrive.</div>
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
      `<button data-tool="${t.later ? '' : t.id}" ${t.later ? 'disabled title="Coming in a later step"' : ''}>${esc(label(t))}</button>`).join('')
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

export const PANEL_BUILDERS = {
  bin: binPanel,
  viewer: viewerPanel,
  timeline: timelinePanel,
  inspector: inspectorPanel,
  tools: toolsPanel,
  masking: () => placeholderPanel('Masking', 'Masking is not built yet. It will cut a subject out of a shot.'),
  remote: remotePanel,
};
