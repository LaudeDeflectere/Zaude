import * as T from './timeline.js';

const PAGES = [
  { id: 'cut', label: 'Cut' }, { id: 'edit', label: 'Edit' }, { id: 'fusion', label: 'Fusion' },
  { id: 'color', label: 'Color' }, { id: 'audio', label: 'Audio' }, { id: 'deliver', label: 'Deliver' },
];
const TRACKS = [
  { id: 'V2', label: 'Video 2' }, { id: 'V1', label: 'Video 1' }, { id: 'A1', label: 'Audio 1' }, { id: 'A2', label: 'Audio 2' },
];
// `later: true` marks manual tools that are not built yet.
const TOOLS = {
  cut: [{ id: 'ripple', label: 'Ripple delete' }, { id: 'slip', label: 'Slip +1s' }, { id: 'speed', label: 'Speed change' }],
  edit: [{ id: 'insert', label: 'Insert' }, { id: 'overwrite', label: 'Overwrite' }, { id: 'dissolve', label: 'Cross dissolve' }],
  fusion: [{ id: 'text', label: 'Add text', later: true }, { id: 'mask', label: 'Mask', later: true }, { id: 'blur', label: 'Blur', later: true }],
  color: [{ id: 'lift', label: 'Lift', later: true }, { id: 'gain', label: 'Gain', later: true }, { id: 'curves', label: 'Curves', later: true }],
  audio: [{ id: 'volume', label: 'Volume', later: true }, { id: 'eq', label: 'EQ', later: true }, { id: 'normalize', label: 'Normalize loudness', later: true }],
  deliver: [{ id: 'format', label: 'Set format' }, { id: 'resolution', label: 'Set resolution' }, { id: 'export', label: 'Export project' }],
};
const SNAP_PX = 8;
const PPS_MIN = 1;      // whole project visible in a few minutes
const PPS_MAX = 4000;   // single frames are clearly visible
const GESTURE_IDLE_MS = 300;
const RULER_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

const state = {
  clips: T.initialClips(),
  playhead: 12 + 8 / T.FPS,
  selected: null,
  page: 'cut',
  pps: 14,           // pixels per second
  snap: true,
  playing: false,
  past: [],
  future: [],
  log: 'Ready. Pick a page or use a tool.',
  binIndex: 0,
  format: 'MP4',
  resolution: '1920 × 1080',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pad = (n) => String(n).padStart(2, '0');

// ---------- history and actions ----------

function pushHistory() {
  state.past.push(T.clone(state.clips));
  if (state.past.length > 200) state.past.shift();
  state.future = [];
}

function commit(clips, message) {
  pushHistory();
  state.clips = clips;
  if (message) state.log = message;
  render();
}

function selectedClip() {
  return state.selected ? T.findClip(state.clips, state.selected) : null;
}

function needSelection(message = 'Select a clip first.') {
  state.log = message;
  render();
  return null;
}

function setZoom(pps) {
  state.pps = Math.min(PPS_MAX, Math.max(PPS_MIN, pps));
}

function run(action) {
  const sel = selectedClip();
  switch (action) {
    case 'undo':
      if (!state.past.length) { state.log = 'Nothing to undo'; break; }
      state.future.push(T.clone(state.clips));
      state.clips = state.past.pop();
      state.log = 'Undid the last step';
      break;
    case 'redo':
      if (!state.future.length) { state.log = 'Nothing to redo'; break; }
      state.past.push(T.clone(state.clips));
      state.clips = state.future.pop();
      state.log = 'Redid the step';
      break;
    case 'play': return togglePlay();
    case 'split': {
      const next = T.splitAt(state.clips, state.playhead);
      if (next.length === state.clips.length) { state.log = 'Nothing under the playhead to split'; break; }
      return commit(next, 'Split at ' + T.timecode(state.playhead));
    }
    case 'trim': {
      if (!sel) return needSelection();
      const next = T.trimEnd(state.clips, sel.id, state.playhead);
      if (!next) return needSelection('Move the playhead inside the selected clip to trim it.');
      return commit(next, 'Trimmed the end of ' + sel.name);
    }
    case 'delete': {
      if (!sel) return needSelection();
      return commit(T.deleteClip(state.clips, sel.id), 'Deleted ' + sel.name);
    }
    case 'duplicate': {
      if (!sel) return needSelection();
      return commit(T.duplicateClip(state.clips, sel.id), 'Duplicated ' + sel.name);
    }
    case 'snap':
      state.snap = !state.snap;
      state.log = 'Magnetic snap ' + (state.snap ? 'on' : 'off');
      break;
    case 'zoomIn': setZoom(state.pps * 1.25); break;
    case 'zoomOut': setZoom(state.pps / 1.25); break;
    case 'fit': {
      const width = $('scroller').clientWidth || 800;
      setZoom(width / T.projectEnd(state.clips));
      state.log = 'Fit the whole timeline';
      break;
    }
    case 'ripple': {
      if (!sel) return needSelection();
      return commit(T.rippleDelete(state.clips, sel.id), 'Ripple deleted ' + sel.name);
    }
    case 'slip': {
      if (!sel) return needSelection();
      return commit(T.slipClip(state.clips, sel.id, 1), 'Slipped ' + sel.name + ' by 1 s');
    }
    case 'speed': {
      if (!sel) return needSelection();
      return commit(T.changeSpeed(state.clips, sel.id), sel.name + ' speed changed');
    }
    case 'dissolve': {
      if (!sel) return needSelection();
      return commit(T.toggleTransition(state.clips, sel.id), 'Cross dissolve toggled on ' + sel.name);
    }
    case 'insert':
    case 'overwrite': {
      const media = T.MEDIA[state.binIndex];
      state.binIndex = (state.binIndex + 1) % T.MEDIA.length;
      const track = sel ? sel.track : 'V1';
      const fn = action === 'insert' ? T.insertMedia : T.overwriteMedia;
      const verb = action === 'insert' ? 'Inserted' : 'Overwrote with';
      return commit(fn(state.clips, track, state.playhead, media), verb + ' ' + media.name + ' at ' + T.timecode(state.playhead));
    }
    case 'format':
      state.format = state.format === 'MP4' ? 'MOV' : 'MP4';
      state.log = 'Format set to ' + state.format;
      break;
    case 'resolution':
      state.resolution = state.resolution === '1920 × 1080' ? '3840 × 2160' : '1920 × 1080';
      state.log = 'Resolution set to ' + state.resolution;
      break;
    case 'export': return exportProject();
    default:
      if (action.startsWith('page:')) { state.page = action.slice(5); state.log = 'Opened the ' + state.page + ' page'; break; }
      return;
  }
  render();
}

function exportProject() {
  const data = { app: 'Zaude', version: 1, fps: T.FPS, format: state.format, resolution: state.resolution, clips: state.clips };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'zaude-project.json';
  a.click();
  URL.revokeObjectURL(url);
  state.log = 'Exported zaude-project.json (project file, not a rendered video)';
  render();
}

// ---------- trackpad gestures ----------
// Click a clip to select it. Then, with a modifier held, two-finger swipe left or right:
//   Ctrl  = change the clip's length (its end)
//   Shift = move the clip along its track
//   Alt   = slip the media under the clip
// Each gesture is one undo step. Sensitivity depends on the zoom (see secondsPerWheelUnit).

let gesture = null;
let gestureTimer = null;

function onWheel(e) {
  const mode = e.ctrlKey ? 'length' : e.shiftKey ? 'move' : e.altKey ? 'slip' : null;
  if (!mode) return; // plain scrolling pans the timeline
  e.preventDefault(); // stops Ctrl+wheel from zooming the whole page
  const dx = e.deltaX * (e.deltaMode === 1 ? 16 : 1);
  // Ignore vertical-dominant events, which is what a trackpad pinch sends with Ctrl held.
  if (Math.abs(dx) <= Math.abs(e.deltaY)) return;

  const clip = selectedClip();
  if (!clip) { state.log = 'Click a clip to select it first'; render(); return; }

  const visibleSpan = $('scroller').clientWidth / state.pps;
  const amount = dx * T.secondsPerWheelUnit(visibleSpan);

  if (!gesture || gesture.id !== clip.id || gesture.mode !== mode) {
    pushHistory();
    gesture = { id: clip.id, mode };
  }
  clearTimeout(gestureTimer);
  gestureTimer = setTimeout(() => { gesture = null; }, GESTURE_IDLE_MS);

  let next = null;
  let msg = '';
  if (mode === 'length') {
    next = T.adjustEnd(state.clips, clip.id, amount);
    const after = T.findClip(next || [], clip.id);
    msg = after ? `${clip.name} length ${after.dur.toFixed(2)} s` : '';
  } else if (mode === 'move') {
    next = T.moveClip(state.clips, clip.id, amount);
    const after = T.findClip(next || [], clip.id);
    msg = after ? `${clip.name} starts at ${after.start.toFixed(2)} s` : '';
  } else {
    next = T.slipClip(state.clips, clip.id, amount * clip.speed);
    const after = T.findClip(next || [], clip.id);
    msg = after ? `${clip.name} source in ${after.srcIn.toFixed(2)} s` : '';
  }
  if (!next) return;
  state.clips = next;
  state.log = msg;
  render();
}

// ---------- playback ----------

let lastTs = 0;
function togglePlay() {
  state.playing = !state.playing;
  if (state.playing) {
    lastTs = performance.now();
    requestAnimationFrame(tick);
  }
  render();
}

function tick(ts) {
  if (!state.playing) return;
  state.playhead += (ts - lastTs) / 1000;
  lastTs = ts;
  const end = T.projectEnd(state.clips);
  if (state.playhead >= end) { state.playhead = end; state.playing = false; render(); return; }
  updatePlayhead();
  syncVideo().catch(() => {});
  requestAnimationFrame(tick);
}

// ---------- rendering ----------

function renderTabs() {
  $('tabs').innerHTML = PAGES.map((p) =>
    `<button class="${p.id === state.page ? 'on' : ''}" aria-pressed="${p.id === state.page}" data-action="page:${p.id}">${p.label}</button>`).join('');
}

function renderTools() {
  const page = PAGES.find((p) => p.id === state.page);
  $('controls-label').textContent = page.label + ' controls';
  $('page-name').textContent = page.label;
  const tools = TOOLS[state.page] || [];
  const sel = selectedClip();
  const label = (t) => {
    if (t.id === 'format') return 'Format: ' + state.format;
    if (t.id === 'resolution') return 'Resolution: ' + state.resolution;
    return t.label;
  };
  $('tools').innerHTML = tools.map((t) =>
    `<button data-action="${t.later ? 'none' : t.id}" ${t.later ? 'disabled title="Coming in a later step"' : ''} aria-label="${esc(label(t))}">${esc(label(t))}</button>`).join('');
  $('selected-label').textContent = 'Selected clip: ' + (sel ? sel.name : 'none');
}

function tickLabel(s, step) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return step >= 1 ? `${pad(m)}:${pad(Math.floor(r))}` : `${pad(m)}:${r.toFixed(2).padStart(5, '0')}`;
}

function renderTimeline() {
  const end = T.projectEnd(state.clips);
  $('canvas').style.width = end * state.pps + 'px';

  // ruler: the smallest step that leaves at least 70 px between labels
  const step = RULER_STEPS.find((s) => s * state.pps >= 70) || RULER_STEPS[RULER_STEPS.length - 1];
  let ticks = '';
  for (let i = 0; i * step <= end + 1e-9; i++) {
    const s = i * step;
    ticks += `<span style="left:${s * state.pps}px">${tickLabel(s, step)}</span>`;
  }
  $('ruler').innerHTML = ticks;

  $('tracks').innerHTML = TRACKS.map((tr) => {
    const blocks = state.clips.filter((c) => c.track === tr.id).map((c) => {
      const kind = c.name.endsWith('.wav') ? 'audio' : c.name.startsWith('Title') ? 'title' : 'video';
      const speed = c.speed !== 1 ? ` ×${c.speed}` : '';
      const sel = c.id === state.selected ? ' sel' : '';
      const gen = c.generating ? ' gen' : '';
      const pct = Math.round((c.progress || 0) * 100);
      const fill = c.generating ? `<span class="gen-fill${c.progress == null ? ' pulse' : ''}" style="width:${pct}%"></span>` : '';
      return `<div class="blk ${kind}${sel}${gen}" role="button" tabindex="0" data-clip="${c.id}" aria-label="${esc(c.name)}" style="left:${c.start * state.pps}px;width:${Math.max(4, c.dur * state.pps)}px">${fill}${c.transition ? '<span class="tr" title="Cross dissolve"></span>' : ''}<span class="blk-label">${esc(c.name + speed)}</span></div>`;
    }).join('');
    return `<div class="trk" data-track="${tr.id}">${blocks}</div>`;
  }).join('');

  $('snap-btn').classList.toggle('on', state.snap);
  $('tl-info').textContent = `Zoom ${state.pps.toFixed(1)} px/s · Timeline ${T.timecode(end)}`;
  $('log').textContent = state.log;
  $('log').title = state.log;
  $('play-btn').textContent = state.playing ? '❚❚' : '▶';
  $('play-btn').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  updatePreview();
  updatePlayhead();
}

function updatePlayhead() {
  $('playhead').style.left = state.playhead * state.pps + 'px';
  $('timecode').textContent = T.timecode(state.playhead) + ' / ' + T.timecode(T.projectEnd(state.clips));
}

function updatePreview() {
  const c = T.clipAt(state.clips, state.playhead);
  $('preview-text').textContent = c ? `${c.name} · ${T.timecode(state.playhead)}` : 'No clip at playhead';
  syncVideo().catch(() => {});
}

// ---------- program monitor video ----------
// Plays the clip under the playhead when it has a file (generated clips). Other clips show the text preview.
const programVideo = $('program-video');
let videoClipId = null;
let videoLoadToken = 0;

function showPreviewText(on) {
  $('preview-text').hidden = on;
}

async function syncVideo() {
  // Titles and other overlays have no file, so the monitor shows the topmost clip that has one.
  const c = T.clipAt(state.clips.filter((x) => x.path), state.playhead);
  if (!c || !c.path || !window.zaudeAI) {
    programVideo.hidden = true;
    showPreviewText(false);
    if (!programVideo.paused) programVideo.pause();
    videoClipId = null;
    return;
  }
  if (videoClipId !== c.id) {
    videoClipId = c.id;
    const token = ++videoLoadToken;
    const res = await window.zaudeAI.mediaUrl(c.path);
    if (token !== videoLoadToken) return; // the playhead moved on while we waited
    if (!res.ok) {
      programVideo.hidden = true;
      showPreviewText(false);
      return;
    }
    programVideo.src = res.url;
  }
  programVideo.hidden = false;
  showPreviewText(true);
  const want = c.srcIn + (state.playhead - c.start) * c.speed;
  if (!state.playing || Math.abs(programVideo.currentTime - want) > 0.15) {
    try { programVideo.currentTime = Math.max(0, want); } catch { /* not loaded yet */ }
  }
  if (state.playing && programVideo.paused) programVideo.play().catch(() => {});
  if (!state.playing && !programVideo.paused) programVideo.pause();
}

function render() {
  renderTabs();
  renderTools();
  renderTimeline();
}

// ---------- pointer and keyboard ----------

function timeFromX(clientX) {
  const rect = $('canvas').getBoundingClientRect();
  const t = (clientX - rect.left) / state.pps;
  return T.snapTime(state.clips, Math.max(0, t), state.snap, SNAP_PX / state.pps);
}

let scrubbing = false;
function scrubTo(e) {
  state.playhead = timeFromX(e.clientX);
  updatePlayhead();
  updatePreview();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn && !btn.disabled) { run(btn.dataset.action); return; }
  const blk = e.target.closest('[data-clip]');
  if (blk) { state.selected = blk.dataset.clip; render(); }
});

$('scroller').addEventListener('wheel', onWheel, { passive: false });
$('ruler').addEventListener('pointerdown', (e) => { scrubbing = true; scrubTo(e); });
$('tracks').addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-clip]')) return;
  state.selected = null;
  scrubbing = true;
  scrubTo(e);
});
window.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
window.addEventListener('pointerup', () => {
  if (scrubbing) { scrubbing = false; render(); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.target.closest('#remote-dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); run(e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); run('redo'); }
  else if (mod) return;
  else if (e.key === ' ') { e.preventDefault(); run('play'); }
  else if (e.key === '=' || e.key === '+') run('zoomIn');
  else if (e.key === '-' || e.key === '_') run('zoomOut');
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selected) run('delete'); }
});

// ---------- text to video: a placeholder clip that fills as the render progresses ----------
window.addEventListener('zaude:t2v', (e) => onGenerationEvent(e.detail));

function onGenerationEvent(d) {
  const id = 'gen-' + d.id;
  if (d.type === 'start') {
    const props = { id, name: 'Generating…', generating: true, progress: null, srcDur: d.seconds, srcIn: 0, speed: 1, transition: 0 };
    state.clips = T.placeRange(state.clips, 'V1', state.playhead, d.seconds, props);
    state.selected = id;
    state.log = 'Generating a ' + d.seconds + ' s clip…';
  } else if (d.type === 'progress') {
    state.clips = state.clips.map((c) => (c.id === id ? { ...c, progress: typeof d.progress === 'number' ? d.progress : null } : c));
    if (d.label) state.log = d.label;
  } else if (d.type === 'done') {
    const name = d.path.split(/[\\/]/).pop();
    state.clips = state.clips.map((c) => (c.id === id ? { ...c, name, generating: false, progress: undefined, path: d.path } : c));
    state.log = 'Saved ' + name;
  } else if (d.type === 'error' || d.type === 'cancelled') {
    state.clips = T.deleteClip(state.clips, id);
    state.log = d.type === 'cancelled' ? 'Generation cancelled' : 'Generation failed: ' + (d.message || 'unknown error');
  }
  render();
}

render();
