// Everything the editor can do: editing, playback, the bin, the project file, and the AI events.
// Panels and keyboard shortcuts call these; they change the store and nothing else.
import * as T from './timeline.js';

const SNAP_PX = 8;
export const PPS_MIN = 1;     // whole project visible in a few minutes
export const PPS_MAX = 4000;  // single frames are visible
const SAVE_DELAY_MS = 800;
const GESTURE_IDLE_MS = 300;

export const PAGES = [
  { id: 'cut', label: 'Cut' }, { id: 'edit', label: 'Edit' }, { id: 'fusion', label: 'Fusion' },
  { id: 'color', label: 'Color' }, { id: 'audio', label: 'Audio' }, { id: 'deliver', label: 'Deliver' },
];

// Tools per page. `later: true` marks tools that are not built yet.
export const TOOLS = {
  cut: [{ id: 'ripple', label: 'Ripple delete' }, { id: 'slip', label: 'Slip +1s' }, { id: 'speed', label: 'Speed change' }],
  edit: [{ id: 'insert', label: 'Insert' }, { id: 'overwrite', label: 'Overwrite' }, { id: 'dissolve', label: 'Cross dissolve' }],
  fusion: [{ id: 'text', label: 'Add text', later: true }, { id: 'mask', label: 'Mask', later: true }, { id: 'blur', label: 'Blur', later: true }],
  color: [{ id: 'lift', label: 'Lift', later: true }, { id: 'gain', label: 'Gain', later: true }, { id: 'curves', label: 'Curves', later: true }],
  audio: [
    { id: 'detach', label: 'Detach audio' },
    { id: 'volumeUp', label: 'Volume +10%' }, { id: 'volumeDown', label: 'Volume −10%' },
    { id: 'eq', label: 'EQ', later: true }, { id: 'normalize', label: 'Normalize loudness', later: true },
  ],
  deliver: [{ id: 'format', label: 'Set format' }, { id: 'resolution', label: 'Set resolution' }, { id: 'export', label: 'Export project' }],
};

export function initialState() {
  return {
    clips: T.initialClips(),
    playhead: 12 + 8 / T.FPS,
    playing: false,
    selected: null,
    page: 'cut',
    pps: 14,
    snap: true,
    past: [],
    future: [],
    log: 'Ready. Import a folder or use a tool.',
    binIndex: 0,
    format: 'MP4',
    resolution: '1920 × 1080',
    media: [],             // files in the imported folder
    binSelected: null,     // path of the bin file selected
    projectFolder: null,
    projectName: 'Untitled',
  };
}

export function createActions(store, engine) {
  const get = () => store.get();
  const projectApi = () => window.zaudeProject || null;
  let saveTimer = null;
  let gesture = null; // { key, timer }

  function log(message) {
    store.set({ log: message });
  }

  function commit(clips, message) {
    const s = get();
    store.set({
      clips,
      past: [...s.past, T.clone(s.clips)].slice(-200),
      future: [],
      log: message || s.log,
    });
    scheduleSave();
  }

  // Live changes (dragging a value) become one undo step: the first change in a gesture records the snapshot.
  function liveChange(key, clips, message) {
    const s = get();
    let past = s.past;
    if (!gesture || gesture.key !== key) {
      past = [...s.past, T.clone(s.clips)].slice(-200);
      gesture = { key, timer: null };
    }
    clearTimeout(gesture.timer);
    gesture.timer = setTimeout(() => { gesture = null; scheduleSave(); }, GESTURE_IDLE_MS);
    store.set({ clips, past, future: [], log: message || s.log });
  }

  function commitClips(clips, message) {
    commit(clips, message);
  }

  // Trackpad gestures on the selected clip: length (Ctrl), move (Shift), slip (Alt).
  function trackpadGesture(mode, dxPx) {
    const s = get();
    const clip = s.selected ? T.findClip(s.clips, s.selected) : null;
    if (!clip) return log("Click a clip to select it first");
    const visibleSpan = (document.querySelector(".timeline .scroller")?.clientWidth || 800) / s.pps;
    const amount = dxPx * T.secondsPerWheelUnit(visibleSpan);
    let next = null;
    let msg = "";
    if (mode === "length") {
      next = T.adjustEnd(s.clips, clip.id, amount);
      const after = T.findClip(next, clip.id);
      msg = clip.name + " length " + after.dur.toFixed(2) + " s";
    } else if (mode === "move") {
      next = T.moveClip(s.clips, clip.id, amount);
      const after = T.findClip(next, clip.id);
      msg = clip.name + " starts at " + after.start.toFixed(2) + " s";
    } else {
      next = T.slipClip(s.clips, clip.id, amount * clip.speed);
      const after = T.findClip(next, clip.id);
      msg = clip.name + " source in " + after.srcIn.toFixed(2) + " s";
    }
    if (next) liveChange("gesture:" + mode + ":" + clip.id, next, msg);
  }

  function liveClips(key, clips, message) {
    liveChange(key, clips, message);
  }

  function selectedClip() {
    const s = get();
    return s.selected ? T.findClip(s.clips, s.selected) : null;
  }

  function needSelection(message = 'Select a clip first.') {
    log(message);
  }

  // ---------- history ----------

  function undo() {
    const s = get();
    if (!s.past.length) return log('Nothing to undo');
    const prev = s.past[s.past.length - 1];
    store.set({ clips: prev, past: s.past.slice(0, -1), future: [...s.future, T.clone(s.clips)], log: 'Undid the last step' });
    scheduleSave();
  }

  function redo() {
    const s = get();
    if (!s.future.length) return log('Nothing to redo');
    const next = s.future[s.future.length - 1];
    store.set({ clips: next, future: s.future.slice(0, -1), past: [...s.past, T.clone(s.clips)], log: 'Redid the step' });
    scheduleSave();
  }

  // ---------- timeline edits ----------

  function split() {
    const s = get();
    const next = T.splitAt(s.clips, s.playhead);
    if (next.length === s.clips.length) return log('Nothing under the playhead to split');
    commit(next, 'Split at ' + T.timecode(s.playhead));
  }

  function trim() {
    const s = get();
    const sel = selectedClip();
    if (!sel) return needSelection();
    const next = T.trimEnd(s.clips, sel.id, s.playhead);
    if (!next) return needSelection('Move the playhead inside the selected clip to trim it.');
    commit(next, 'Trimmed the end of ' + sel.name);
  }

  function deleteSelected() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.deleteClip(get().clips, sel.id), 'Deleted ' + sel.name);
    store.set({ selected: null });
  }

  function duplicate() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.duplicateClip(get().clips, sel.id), 'Duplicated ' + sel.name);
  }

  function ripple() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.rippleDelete(get().clips, sel.id), 'Ripple deleted ' + sel.name);
  }

  function slip() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.slipClip(get().clips, sel.id, 1), 'Slipped ' + sel.name + ' by 1 s');
  }

  function speed() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.changeSpeed(get().clips, sel.id), sel.name + ' speed changed');
  }

  function dissolve() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.toggleTransition(get().clips, sel.id), 'Cross dissolve toggled on ' + sel.name);
  }

  function detach() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    const r = T.detachAudio(get().clips, sel.id);
    if (r.error) return log(r.error);
    commit(r.clips, 'Detached the audio of ' + sel.name);
  }

  function setProp(clipId, prop, value) {
    const next = T.setProp(get().clips, clipId, prop, value);
    if (!next) return;
    const clip = T.findClip(next, clipId);
    liveChange(`${clipId}:${prop}`, next, `${clip.name} ${T.PROPS[prop].label.toLowerCase()} ${T.PROPS[prop].format(T.propValue(clip, prop))}`);
  }

  function bumpVolume(delta) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    setProp(sel.id, 'volume', T.propValue(sel, 'volume') + delta);
  }

  // ---------- selection, playhead, view ----------

  function select(id) {
    store.set({ selected: id, log: id ? (T.findClip(get().clips, id)?.name || '') : get().log });
  }

  function seekTo(t) {
    engine.seekTo(t);
  }

  function togglePlay() {
    engine.toggle();
  }

  function setZoom(pps) {
    store.set({ pps: Math.min(PPS_MAX, Math.max(PPS_MIN, pps)) });
  }

  function zoomIn() { setZoom(get().pps * 1.25); }
  function zoomOut() { setZoom(get().pps / 1.25); }

  function fit(width) {
    const s = get();
    setZoom((width || 800) / T.projectEnd(s.clips));
    log('Fit the whole timeline');
  }

  function toggleSnap() {
    const snap = !get().snap;
    store.set({ snap, log: 'Magnetic snap ' + (snap ? 'on' : 'off') });
  }

  function snapTime(t, pps) {
    const s = get();
    return T.snapTime(s.clips, Math.max(0, t), s.snap, SNAP_PX / pps);
  }

  function setPage(id) {
    store.set({ page: id, log: 'Opened the ' + (PAGES.find((p) => p.id === id)?.label || id) + ' page' });
  }

  // ---------- the bin and project ----------

  async function importFolder() {
    const api = projectApi();
    if (!api) return log('Importing folders needs the desktop app.');
    const folder = await api.pickFolder();
    if (!folder) return;
    const scan = await api.scan(folder);
    if (!scan.ok) return log('Could not read that folder: ' + scan.error);
    const loaded = await api.load(folder);
    const data = loaded && loaded.ok ? loaded.data : null;
    if (data && Array.isArray(data.clips)) T.reserveIds(data.clips);
    store.set({
      projectFolder: folder,
      projectName: (data && data.name) || folder.split(/[\\/]/).pop(),
      media: scan.media,
      clips: data && Array.isArray(data.clips) ? data.clips : get().clips,
      format: (data && data.format) || get().format,
      resolution: (data && data.resolution) || get().resolution,
      past: [],
      future: [],
      log: `Opened ${scan.media.length} files from ${folder}`,
    });
    scheduleSave();
  }

  function selectBin(path) {
    store.set({ binSelected: path });
  }

  function addBinItem(path) {
    const s = get();
    const file = s.media.find((m) => m.path === path);
    if (!file) return log('Select a file in the bin first.');
    const track = file.kind === 'audio' ? 'A1' : 'V1';
    commit(T.insertFile(s.clips, track, s.playhead, file), 'Added ' + file.name + ' at ' + T.timecode(s.playhead));
  }

  function scheduleSave() {
    const s = get();
    if (!s.projectFolder || !projectApi()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProject(), SAVE_DELAY_MS);
  }

  async function saveProject() {
    const s = get();
    const api = projectApi();
    if (!s.projectFolder || !api) return { ok: false, error: 'No project folder is open.' };
    const data = {
      version: 1,
      name: s.projectName,
      format: s.format,
      resolution: s.resolution,
      clips: s.clips,
    };
    const res = await api.save(s.projectFolder, data);
    log(res.ok ? 'Project saved' : 'Could not save the project: ' + res.error);
    return res;
  }

  // ---------- AI: text to video placeholder on the timeline ----------

  function generationEvent(d) {
    const id = 'gen-' + d.id;
    if (d.type === 'start') {
      const s = get();
      const props = { id, name: 'Generating…', generating: true, progress: null, srcDur: d.seconds, srcIn: 0, speed: 1, transition: 0, volume: 1, opacity: 1, muted: false, kind: 'video' };
      store.set({ clips: T.placeRange(s.clips, 'V1', s.playhead, d.seconds, props), selected: id, log: 'Generating a ' + d.seconds + ' s clip…' });
    } else if (d.type === 'progress') {
      const s = get();
      store.set({
        clips: s.clips.map((c) => (c.id === id ? { ...c, progress: typeof d.progress === 'number' ? d.progress : null } : c)),
        log: d.label || s.log,
      });
    } else if (d.type === 'done') {
      const s = get();
      const name = d.path.split(/[\\/]/).pop();
      store.set({
        clips: s.clips.map((c) => (c.id === id ? { ...c, name, path: d.path, kind: 'video', hasAudio: false, generating: false, progress: undefined } : c)),
        log: 'Saved ' + name,
      });
      scheduleSave();
    } else if (d.type === 'error' || d.type === 'cancelled') {
      const s = get();
      store.set({
        clips: T.deleteClip(s.clips, id),
        log: d.type === 'cancelled' ? 'Generation cancelled' : 'Generation failed: ' + (d.message || 'unknown error'),
      });
    }
  }

  // ---------- render the timeline to an MP4 ----------
  let rendering = false;
  async function exportRender() {
    const api = window.zaudeRender;
    if (!api) return log('Rendering needs the desktop app.');
    if (rendering) return log('A render is already running.');
    const s = get();
    rendering = true;
    const off = api.onProgress((p) => log(`Rendering ${Math.round(p * 100)}%`));
    log('Rendering…');
    try {
      const res = await api.start({ clips: s.clips, resolution: s.resolution, folder: s.projectFolder, name: s.projectName });
      log(res.ok ? `Rendered ${res.path} (${res.encoder === 'h264_nvenc' ? 'NVIDIA NVENC' : 'CPU'})` : 'Render failed: ' + res.error);
    } finally {
      off();
      rendering = false;
    }
  }

  // ---------- tools ----------

  function runTool(action) {
    const s = get();
    switch (action) {
      case 'ripple': return ripple();
      case 'slip': return slip();
      case 'speed': return speed();
      case 'dissolve': return dissolve();
      case 'detach': return detach();
      case 'volumeUp': return bumpVolume(0.1);
      case 'volumeDown': return bumpVolume(-0.1);
      case 'insert':
      case 'overwrite': {
        const media = T.MEDIA[s.binIndex];
        const track = selectedClip() ? selectedClip().track : 'V1';
        const fn = action === 'insert' ? T.insertMedia : T.overwriteMedia;
        const verb = action === 'insert' ? 'Inserted' : 'Overwrote with';
        store.set({ binIndex: (s.binIndex + 1) % T.MEDIA.length });
        return commit(fn(get().clips, track, s.playhead, media), verb + ' ' + media.name + ' at ' + T.timecode(s.playhead));
      }
      case 'format':
        store.set({ format: s.format === 'MP4' ? 'MOV' : 'MP4', log: 'Format set to ' + (s.format === 'MP4' ? 'MOV' : 'MP4') });
        return;
      case 'resolution': {
        const next = s.resolution === '1920 × 1080' ? '3840 × 2160' : '1920 × 1080';
        return store.set({ resolution: next, log: 'Resolution set to ' + next });
      }
      case 'export': return exportProject();
      default:
        return;
    }
  }

  function exportProject() {
    const s = get();
    const data = { app: 'Zaude', version: 1, fps: T.FPS, format: s.format, resolution: s.resolution, clips: s.clips };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zaude-project.json';
    a.click();
    URL.revokeObjectURL(url);
    log('Exported zaude-project.json (project file, not a rendered video)');
  }


  return {
    undo, redo, split, trim, deleteSelected, duplicate, ripple, slip, speed, dissolve, detach,
    setProp, bumpVolume, select, seekTo, togglePlay, zoomIn, zoomOut, fit, setZoom, toggleSnap, snapTime,
    setPage, importFolder, selectBin, addBinItem, saveProject, scheduleSave, generationEvent, runTool, exportProject, exportRender,
    selectedClip, log, commitClips, gesture: trackpadGesture, liveClips,
  };
}
