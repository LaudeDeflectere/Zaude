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

export const EXPORT_PRESETS = [
  { id: 'youtube', label: 'YouTube', aspect: '16:9', resTier: '1080', fps: 30, quality: 'high', format: 'MP4' },
  { id: 'youtube4k', label: 'YouTube 4K', aspect: '16:9', resTier: '2160', fps: 60, quality: 'high', format: 'MP4' },
  { id: 'tiktok', label: 'TikTok / Reels', aspect: '9:16', resTier: '1080', fps: 30, quality: 'high', format: 'MP4' },
  { id: 'square', label: 'Instagram 1:1', aspect: '1:1', resTier: '1080', fps: 30, quality: 'high', format: 'MP4' },
  { id: 'cinema', label: 'Cinema 24p', aspect: '16:9', resTier: '1080', fps: 24, quality: 'ultra', format: 'MOV' },
  { id: 'preview', label: 'Quick Preview', aspect: '16:9', resTier: '720', fps: 24, quality: 'draft', format: 'MP4' },
];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '21:9'];
export const RES_TIERS = [
  { id: '720', label: '720p (HD)' },
  { id: '1080', label: '1080p (Full HD)' },
  { id: '2160', label: '4K (Ultra HD)' },
];

// Computes exact even output pixel dimensions for any aspect ratio + resolution tier.
export function exportDimensions(aspect, resTier) {
  const shortSide = Number(resTier) || 1080;
  const parts = String(aspect || '16:9').split(':').map(Number);
  const aw = parts[0] > 0 ? parts[0] : 16;
  const ah = parts[1] > 0 ? parts[1] : 9;
  let w;
  let h;
  if (aw >= ah) {
    h = shortSide;
    w = Math.round((shortSide * aw) / ah);
  } else {
    w = shortSide;
    h = Math.round((shortSide * ah) / aw);
  }
  return { width: Math.round(w / 2) * 2, height: Math.round(h / 2) * 2 };
}

export function initialState() {
  return {
    clips: T.initialClips(),
    tracks: T.defaultTracks(),
    playhead: 12 + 8 / T.FPS,
    playing: false,
    selected: null,
    selectedIds: [],
    eyedropper: false,
    exportOpen: false,
    exportCfg: {
      preset: 'youtube',
      aspect: '16:9',
      resTier: '1080',
      fps: 30,
      quality: 'high',
      format: 'MP4',
      rangeMode: 'full',
      rangeStart: 0,
      rangeEnd: 10,
    },
    exportStatus: { busy: false, progress: 0, message: '', lastPath: null },
    page: 'cut',
    pps: 14,
    snap: true,
    beats: T.defaultBeats(),
    past: [],
    future: [],
    log: 'Ready. Import a folder or use a tool.',
    binIndex: 0,
    format: 'MP4',
    resolution: '1920 × 1080',
    media: [],             // files in the imported folder
    binSelected: null,     // path of the bin file selected
    projectFolder: null,
    zdFilePath: null,
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
    flushGesture();
    const s = get();
    store.set({
      clips,
      past: [...s.past, T.clone(s.clips)].slice(-50),
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
      past = [...s.past, T.clone(s.clips)].slice(-50);
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
      const ids = s.selectedIds && s.selectedIds.length > 1 ? s.selectedIds : [clip.id];
      next = ids.length > 1 ? T.moveClips(s.clips, ids, amount) : T.moveClip(s.clips, clip.id, amount);
      const after = T.findClip(next, clip.id);
      msg = ids.length > 1
        ? `Moved ${ids.length} clips (first at ${after.start.toFixed(2)} s)`
        : clip.name + " starts at " + after.start.toFixed(2) + " s";
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

  // ---------- history (up to 50 steps of undo & redo) ----------

  function flushGesture() {
    if (gesture) {
      clearTimeout(gesture.timer);
      gesture = null;
    }
  }

  function undo() {
    flushGesture();
    const s = get();
    if (!s.past.length) return log('Nothing to undo');
    const prev = s.past[s.past.length - 1];
    const nextPast = s.past.slice(0, -1);
    const nextFuture = [...s.future, T.clone(s.clips)].slice(-50);
    store.set({ clips: prev, past: nextPast, future: nextFuture, log: `Undid (${nextPast.length} undo · ${nextFuture.length} redo)` });
    scheduleSave();
  }

  function redo() {
    flushGesture();
    const s = get();
    if (!s.future.length) return log('Nothing to redo');
    const next = s.future[s.future.length - 1];
    const nextFuture = s.future.slice(0, -1);
    const nextPast = [...s.past, T.clone(s.clips)].slice(-50);
    store.set({ clips: next, future: nextFuture, past: nextPast, log: `Redid (${nextPast.length} undo · ${nextFuture.length} redo)` });
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

  function cancelGeneratingClips(clipList) {
    const api = window.zaudeAI;
    if (!api || !api.cancelTextToVideo) return 0;
    let cancelled = 0;
    for (const c of clipList) {
      if (c && c.generating && String(c.id).startsWith('gen-')) {
        api.cancelTextToVideo(String(c.id).slice(4)).catch(() => {});
        cancelled++;
      }
    }
    return cancelled;
  }

  function deleteSelected() {
    const s = get();
    const ids = (s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []))
      .filter((id) => T.findClip(s.clips, id));
    if (!ids.length) return needSelection();
    const removing = ids.map((id) => T.findClip(s.clips, id)).filter(Boolean);
    const cancelledCount = cancelGeneratingClips(removing);
    if (ids.length > 1) {
      const msg = cancelledCount
        ? `Deleted ${ids.length} clips (cancelled ${cancelledCount} generation${cancelledCount === 1 ? '' : 's'})`
        : `Deleted ${ids.length} clips`;
      commit(T.deleteClips(s.clips, ids), msg);
    } else {
      const sel = removing[0];
      const msg = cancelledCount
        ? `Cancelled generation & deleted ${sel.name}`
        : 'Deleted ' + sel.name;
      commit(T.deleteClip(s.clips, sel.id), msg);
    }
    store.set({ selected: null, selectedIds: [] });
  }

  function duplicate() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.duplicateClip(get().clips, sel.id), 'Duplicated ' + sel.name);
  }

  function ripple() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    const cancelled = cancelGeneratingClips([sel]);
    commit(T.rippleDelete(get().clips, sel.id), cancelled ? 'Cancelled generation & ripple deleted ' + sel.name : 'Ripple deleted ' + sel.name);
    store.set({ selected: null, selectedIds: [] });
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

  function setSpeed(targetSpeed, live = false) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    const next = T.setSpeed(get().clips, sel.id, targetSpeed);
    if (!next) return;
    const after = T.findClip(next, sel.id);
    const msg = `${sel.name} Time Warp ${after.speed.toFixed(2)}× (${after.dur.toFixed(2)}s)`;
    if (live) liveChange('speed:' + sel.id, next, msg);
    else commit(next, msg);
  }

  function matchAudioDuration() {
    const s = get();
    const selIds = s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []);
    const selClips = selIds.map((id) => T.findClip(s.clips, id)).filter(Boolean);
    const vClip = selClips.find((c) => c.kind === 'video') || (selectedClip() && selectedClip().kind === 'video' ? selectedClip() : null);
    const aClip = selClips.find((c) => c.kind === 'audio') || s.clips.find((c) => c.kind === 'audio');
    if (!vClip || !aClip) return log('Select a video clip and an audio clip to match duration.');
    const targetSpeed = Math.max(0.25, Math.min(4.0, T.sourceUsed(vClip) / Math.max(0.1, aClip.dur)));
    const next = T.setSpeed(s.clips, vClip.id, targetSpeed);
    if (next) {
      const after = T.findClip(next, vClip.id);
      commit(next, `⏱️ Time-warped "${vClip.name}" to ${after.speed.toFixed(2)}× (${after.dur.toFixed(2)}s) to match "${aClip.name}"`);
    }
  }

  function insertAudioClip({ path: filePath, url, name, dur }) {
    const s = get();
    const duration = Math.max(0.5, Number(dur) || 4);
    const startAt = Math.max(0, Number(s.playhead) || 0);
    const audioTracks = T.ensureTracksForClips(s.tracks, s.clips).filter((t) => t.kind === 'audio');
    let targetTrack = audioTracks[0] ? audioTracks[0].id : 'A1';
    for (const tr of audioTracks) {
      const conflict = s.clips.some((c) => c.track === tr.id && c.start < startAt + duration && T.clipEnd(c) > startAt);
      if (!conflict) { targetTrack = tr.id; break; }
    }
    const id = 'c' + Math.random().toString(36).slice(2, 9);
    const newClip = {
      id,
      kind: 'audio',
      track: targetTrack,
      name: name || (filePath ? filePath.split(/[\\/]/).pop() : 'voice.wav'),
      path: filePath,
      url: url || null,
      start: startAt,
      dur: duration,
      srcIn: 0,
      srcDur: duration,
      speed: 1,
      volume: 100,
      muted: false,
      hasAudio: true,
    };
    commit([...s.clips, newClip], `🎙️ Added "${newClip.name}" (${duration.toFixed(2)}s) to ${targetTrack}`);
    store.set({ selected: id, selectedIds: [id] });
    return newClip;
  }

  function replaceClipWithSynced({ clipId, path: filePath, url, dur }) {
    const s = get();
    const old = T.findClip(s.clips, clipId);
    if (!old) return;
    const nextDur = Number(dur) > 0 ? Number(dur) : old.dur;
    const next = s.clips.map((c) => (c.id === clipId ? {
      ...c,
      path: filePath,
      url: url || c.url,
      srcIn: 0,
      srcDur: nextDur,
      dur: nextDur,
      speed: 1,
      hasAudio: true,
      muted: false,
    } : c));
    commit(next, `🗣️ Replaced "${old.name}" with lip-synced clip (${nextDur.toFixed(2)}s)`);
  }

  function dissolve() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.toggleTransition(get().clips, sel.id), 'Cross dissolve toggled on ' + sel.name);
  }

  function setTransition(type, duration) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    const label = (T.TRANSITION_TYPES.find((x) => x.id === type) || { label: type }).label;
    commit(T.setTransition(get().clips, sel.id, type, duration), `${sel.name} transition: ${label}`);
  }

  function toggleMirror(axis) {
    const sel = selectedClip();
    if (!sel || sel.kind !== 'video') return needSelection('Select a video clip to mirror.');
    const key = axis === 'v' ? 'flipV' : 'flipH';
    const next = !sel[key];
    commit(T.setFlag(get().clips, sel.id, key, next), `${sel.name} ${axis === 'v' ? 'vertical' : 'horizontal'} mirror ${next ? 'on' : 'off'}`);
  }

  function resetTransform() {
    const sel = selectedClip();
    if (!sel || sel.kind !== 'video') return needSelection('Select a video clip to reset transform.');
    commit(T.resetTransform(get().clips, sel.id), `Reset transform on ${sel.name}`);
  }

  function transformClip(clipId, patch) {
    const s = get();
    const prev = T.findClip(s.clips, clipId);
    if (!prev || prev.kind !== 'video') return;
    let next = s.clips;
    let changed = false;
    for (const key of T.TRANSFORM_PROPS) {
      if (patch[key] === undefined) continue;
      const before = T.propValue(prev, key);
      const updated = T.setProp(next, clipId, key, patch[key]);
      const after = T.propValue(T.findClip(updated, clipId), key);
      if (after !== before) {
        next = updated;
        changed = true;
      }
    }
    if (!changed) return;
    const afterClip = T.findClip(next, clipId);
    const msg = `${afterClip.name} · Scale ${T.propValue(afterClip, 'scale')}% · Rot ${T.propValue(afterClip, 'rotation')}° · Pos ${T.propValue(afterClip, 'posX')}%, ${T.propValue(afterClip, 'posY')}%`;
    liveChange(`transform:${clipId}`, next, msg);
  }

  function toggleFill() {
    const sel = selectedClip();
    if (!sel || sel.kind !== 'video') return needSelection('Select a video clip to fill the frame.');
    const next = !sel.fill;
    commit(T.setFlag(get().clips, sel.id, 'fill', next), `${sel.name} ${next ? 'fills the frame' : 'fits inside the frame'}`);
  }

  function resetFilters() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.resetFilters(get().clips, sel.id), `Reset filters on ${sel.name}`);
  }

  function resetHsl() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.resetHsl(get().clips, sel.id), `Reset selective HSL on ${sel.name}`);
  }

  function addHslBand(hex) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.addHslBand(get().clips, sel.id, hex), `Added HSL color ${hex || ''}`.trim());
  }

  function removeHslBand(bandId) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    commit(T.removeHslBand(get().clips, sel.id, bandId), `Removed HSL color band`);
  }

  function selectHslBand(bandId) {
    const sel = selectedClip();
    if (!sel) return;
    store.set({ clips: T.setFlag(get().clips, sel.id, 'hslActiveBand', bandId) });
  }

  function setHslBandProp(clipId, bandId, key, value, live = true) {
    const s = get();
    const prevClip = T.findClip(s.clips, clipId);
    const next = T.updateHslBand(s.clips, clipId, bandId, { [key]: value });
    const nextClip = T.findClip(next, clipId);
    if (prevClip && nextClip && Array.isArray(prevClip.hslBands) && Array.isArray(nextClip.hslBands)) {
      const pb = prevClip.hslBands.find((b) => b.id === bandId);
      const nb = nextClip.hslBands.find((b) => b.id === bandId);
      if (pb && nb && pb[key] === nb[key]) return;
    }
    if (live) liveChange(`hsl:${clipId}:${bandId}:${key}`, next);
    else commit(next, `Updated HSL ${key}`);
  }

  function setHslTarget(hex, addNew = false) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    if (addNew) {
      commit(T.addHslBand(get().clips, sel.id, hex), `Added HSL color ${hex}`);
      return;
    }
    const activeId = sel.hslActiveBand || (sel.hslBands && sel.hslBands[0] && sel.hslBands[0].id) || 'hb0';
    commit(T.updateHslBand(get().clips, sel.id, activeId, { hex }), `${sel.name} HSL color set to ${hex}`);
  }

  function setEyedropper(mode) {
    const on = mode === true ? 'replace' : (mode || false);
    store.set({
      eyedropper: on,
      log: on
        ? (on === 'add' ? 'Click on the video to add a new HSL color (Esc to cancel)' : 'Click on the video to pick a color (Esc to cancel)')
        : get().log,
    });
  }

  function detach() {
    const sel = selectedClip();
    if (!sel) return needSelection();
    const r = T.detachAudio(get().clips, sel.id);
    if (r.error) return log(r.error);
    commit(r.clips, 'Detached the audio of ' + sel.name);
  }

  function setProp(clipId, prop, value) {
    const s = get();
    const prev = T.findClip(s.clips, clipId);
    if (!prev) return;
    const next = T.setProp(s.clips, clipId, prop, value);
    if (!next) return;
    const clip = T.findClip(next, clipId);
    if (T.propValue(prev, prop) === T.propValue(clip, prop)) return;
    liveChange(`${clipId}:${prop}`, next, `${clip.name} ${T.PROPS[prop].label.toLowerCase()} ${T.PROPS[prop].format(T.propValue(clip, prop))}`);
  }

  function bumpVolume(delta) {
    const sel = selectedClip();
    if (!sel) return needSelection();
    setProp(sel.id, 'volume', T.propValue(sel, 'volume') + delta);
  }

  // ---------- selection, playhead, view ----------

  function select(id) {
    store.set({
      selected: id,
      selectedIds: id ? [id] : [],
      log: id ? (T.findClip(get().clips, id)?.name || '') : get().log,
    });
  }

  function selectMany(ids, message) {
    const s = get();
    const valid = [...new Set(ids)].filter((id) => T.findClip(s.clips, id));
    store.set({
      selected: valid[0] || null,
      selectedIds: valid,
      log: message || (valid.length ? `Selected ${valid.length} clip${valid.length === 1 ? '' : 's'}` : s.log),
    });
  }

  function toggleSelect(id) {
    const s = get();
    const cur = s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    selectMany(next);
  }

  function seekTo(t) {
    engine.seekTo(t);
  }

  function stepBy(deltaSec) {
    engine.seekTo(get().playhead + deltaSec);
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

  function addTrack(kind) {
    const s = get();
    const next = T.addTrack(s.tracks, kind);
    const added = next.find((t) => !(s.tracks || []).some((old) => old.id === t.id));
    store.set({ tracks: next, log: `Added track ${added ? added.label : kind}` });
    scheduleSave();
  }

  function toggleSnap() {
    const snap = !get().snap;
    store.set({ snap, log: 'Magnetic snap ' + (snap ? 'on' : 'off') });
  }

  function snapTime(t, pps) {
    const s = get();
    const extra = T.allBeatSnapPoints(s.beats, T.projectEnd(s.clips));
    return T.snapTime(s.clips, Math.max(0, t), s.snap, SNAP_PX / pps, extra);
  }

  // ---------- beat detection, grid & editable markers ----------

  async function detectBeats(clipId) {
    const api = projectApi();
    if (!api || !api.detectBeats) return log('Beat detection needs the desktop app.');
    const s = get();
    const sel = clipId ? T.findClip(s.clips, clipId) : selectedClip();
    const target = (sel && sel.path && (sel.kind === 'audio' || sel.kind === 'video'))
      ? sel
      : (s.clips.find((c) => c.kind === 'audio' && c.path) || s.clips.find((c) => c.kind === 'video' && c.path));
    if (!target) return log('Add an audio or video clip first to detect beats.');

    log(`Detecting beats in ${target.name}…`);
    const beatsPerBar = (s.beats && s.beats.beatsPerBar) || 4;
    const res = await api.detectBeats(target.path, { beatsPerBar });
    if (!res || !res.ok) return log('Beat detection failed: ' + ((res && res.error) || 'unknown error'));

    const speed = target.speed || 1;
    const srcIn = Number(target.srcIn) || 0;
    const toTimeline = (srcT) => target.start + (srcT - srcIn) / speed;
    const clipEndT = T.clipEnd(target);
    const beatDur = 60 / (res.bpm * speed);

    let offset = toTimeline(res.offset);
    const barDur = beatDur * beatsPerBar;
    while (offset < target.start - 0.005) offset += barDur;
    while (offset - barDur >= 0) offset -= barDur;
    offset = Math.max(0, Math.round(offset * 1000) / 1000);

    const markers = (res.markers || [])
      .map((m) => ({ ...m, time: Math.round(toTimeline(m.time) * 1000) / 1000 }))
      .filter((m) => m.time >= target.start - 0.02 && m.time <= clipEndT + 0.02);

    const nextBeats = T.setBeatGrid(s.beats, {
      enabled: true,
      snap: true,
      bpm: Math.round(res.bpm * speed * 10) / 10,
      offset,
      beatsPerBar,
      sourceClipId: target.id,
      markers,
    });
    store.set({ beats: nextBeats, log: `Detected ${nextBeats.bpm} BPM (${markers.length} beat markers)` });
    scheduleSave();
    return nextBeats;
  }

  function setBeatGrid(patch) {
    const s = get();
    const next = T.setBeatGrid(s.beats, patch);
    store.set({ beats: next, log: `Beat grid: ${next.bpm} BPM · ${next.subdivisions}× sub` });
    scheduleSave();
  }

  function addBeatMarker(time, kind = 'custom', label = '') {
    const s = get();
    const t = typeof time === 'number' ? time : s.playhead;
    const next = T.addBeatMarker(s.beats, t, kind, label);
    store.set({ beats: next, log: `Added beat marker at ${T.timecode(t)}` });
    scheduleSave();
  }

  function moveBeatMarker(id, time, live = false) {
    const s = get();
    const next = T.moveBeatMarker(s.beats, id, time);
    store.set({ beats: next });
    if (!live) scheduleSave();
  }

  function removeBeatMarker(id) {
    const s = get();
    const next = T.removeBeatMarker(s.beats, id);
    store.set({ beats: next, log: 'Removed beat marker' });
    scheduleSave();
  }

  function clearBeats() {
    store.set({ beats: T.defaultBeats(), log: 'Cleared beat grid & markers' });
    scheduleSave();
  }

  // ---------- audio fades & volume keyframes ----------

  function setClipFade(id, edge, durSec, live = false) {
    const s = get();
    const next = T.setClipFade(s.clips, id, edge, durSec);
    if (live) {
      store.set({ clips: next });
    } else {
      const label = edge === 'in' ? 'Fade In' : 'Fade Out';
      commit(next, `${label} ${Math.max(0, Number(durSec) || 0).toFixed(2)}s`);
    }
  }

  function upsertVolumeKeyframe(id, localT, value) {
    const s = get();
    const clip = T.findClip(s.clips, id);
    if (!clip) return;
    const t = typeof localT === 'number' ? localT : Math.max(0, Math.min(clip.dur, s.playhead - clip.start));
    const v = typeof value === 'number' ? value : T.volumeAt(clip, clip.start + t);
    commit(T.upsertVolumeKeyframe(s.clips, id, t, v), `Volume keyframe ${Math.round(v * 100)}% at +${t.toFixed(2)}s`);
  }

  function removeVolumeKeyframe(id, kfId) {
    const s = get();
    commit(T.removeVolumeKeyframe(s.clips, id, kfId), 'Removed volume keyframe');
  }

  function clearVolumeKeyframes(id) {
    const s = get();
    commit(T.clearVolumeKeyframes(s.clips, id), 'Cleared volume keyframes');
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
    store.set({
      projectFolder: folder,
      projectName: (data && data.name) || folder.split(/[\\/]/).pop(),
      media: scan.media,
      clips: data && Array.isArray(data.clips) ? data.clips : get().clips,
      tracks: T.ensureTracksForClips(data && data.tracks ? data.tracks : T.defaultTracks(), data && Array.isArray(data.clips) ? data.clips : get().clips),
      beats: data && data.beats ? T.setBeatGrid(T.defaultBeats(), data.beats) : T.defaultBeats(),
      format: (data && data.format) || get().format,
      resolution: (data && data.resolution) || get().resolution,
      captions: (data && data.captions) || null,
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
      tracks: s.tracks,
      beats: s.beats,
    };
    if (s.captions) data.captions = s.captions; // subtitle file (.ass/.srt) in the project folder, burned in on export
    const res = await api.save(s.projectFolder, data);
    log(res.ok ? 'Project saved' : 'Could not save the project: ' + res.error);
    return res;
  }

  async function saveZd(saveAs = false) {
    const api = projectApi();
    if (!api || !api.saveZd) return log('Saving .zd projects needs the desktop app.');
    const s = get();
    log('Saving .zd project (bundling media)…');
    const res = await api.saveZd({
      filePath: saveAs ? null : s.zdFilePath,
      saveAs,
      name: s.projectName,
      format: s.format,
      resolution: s.resolution,
      clips: s.clips,
      tracks: s.tracks,
      beats: s.beats,
      media: s.media,
    });
    if (res.cancelled) return log('Save cancelled');
    if (!res.ok) return log('Could not save .zd: ' + res.error);
    const name = res.filePath.split(/[\\/]/).pop().replace(/\.zd$/i, '') || s.projectName;
    const mb = (res.totalBytes / (1024 * 1024)).toFixed(1);
    store.set({
      zdFilePath: res.filePath,
      projectName: name,
      log: `Saved ${name}.zd (${res.assetCount} media file${res.assetCount === 1 ? '' : 's'}, ${mb} MB)`,
    });
    return res;
  }

  async function openZd() {
    const api = projectApi();
    if (!api || !api.openZd) return log('Opening .zd projects needs the desktop app.');
    log('Opening .zd project…');
    const res = await api.openZd();
    if (res.cancelled) return log('Open cancelled');
    if (!res.ok) return log('Could not open .zd: ' + res.error);
    const p = res.project;
    store.set({
      zdFilePath: res.filePath,
      projectFolder: res.sessionDir,
      projectName: p.name,
      format: p.format || 'MP4',
      resolution: p.resolution || '1920 × 1080',
      clips: Array.isArray(p.clips) ? p.clips : [],
      tracks: T.ensureTracksForClips(p.tracks || T.defaultTracks(), Array.isArray(p.clips) ? p.clips : []),
      beats: p.beats ? T.setBeatGrid(T.defaultBeats(), p.beats) : T.defaultBeats(),
      media: Array.isArray(p.media) ? p.media : [],
      selected: null,
      selectedIds: [],
      binSelected: null,
      past: [],
      future: [],
      playhead: 0,
      playing: false,
      log: `Opened ${p.name}.zd (${res.assetCount} embedded media file${res.assetCount === 1 ? '' : 's'})`,
    });
    return res;
  }

  // ---------- AI: text to video placeholder on the timeline ----------

  function generationEvent(d) {
    // In-place multi-clip Upscale & Face-Fix updates an existing timeline clip without moving it
    if (d && d.replaceClipId) {
      const targetId = d.replaceClipId;
      const s = get();
      if (d.type === 'start' || d.type === 'progress' || d.type === 'preview' || d.type === 'queue') {
        store.set({
          clips: s.clips.map((c) => (c.id === targetId ? {
            ...c,
            upscaling: true,
            upscaleJobId: d.id || c.upscaleJobId,
            progress: typeof d.progress === 'number' ? d.progress : c.progress,
            queuePos: d.queuePos ?? c.queuePos,
          } : c)),
          log: d.label || s.log,
        });
      } else if (d.type === 'done' && d.path) {
        const upName = d.path.split(/[\\/]/).pop();
        store.set({
          clips: s.clips.map((c) => (c.id === targetId ? {
            ...c,
            path: d.path,
            url: d.url || c.url,
            name: c.name.includes('✨') ? c.name : `${c.name} ✨`,
            latent: d.latent || c.latent || undefined,
            latentLabel: d.latentLabel || c.latentLabel || undefined,
            upscaling: false,
            upscaleJobId: undefined,
            progress: undefined,
            queuePos: undefined,
          } : c)),
          log: `Upscaled clip → ${upName}`,
        });
        scheduleSave();
        if (engine && typeof engine.sync === 'function') engine.sync();
      } else if (d.type === 'error' || d.type === 'cancelled') {
        store.set({
          clips: s.clips.map((c) => (c.id === targetId ? {
            ...c,
            upscaling: false,
            upscaleJobId: undefined,
            progress: undefined,
            queuePos: undefined,
          } : c)),
          log: d.type === 'cancelled' ? 'Upscale cancelled' : `Upscale failed: ${d.message || 'unknown error'}`,
        });
      }
      return;
    }

    const id = 'gen-' + d.id;
    if (d.type === 'start') {
      const s = get();
      // Place queued generations at insertAt (e.g. FrameToFrame gap) or playhead side-by-side
      const existingGen = s.clips.filter((c) => c.generating && c.track === 'V1');
      let startAt = typeof d.insertAt === 'number' ? d.insertAt : s.playhead;
      for (const g of existingGen) {
        if (startAt >= g.start - 0.05 && startAt < T.clipEnd(g) + 0.05) {
          startAt = T.clipEnd(g);
        }
      }
      const props = {
        id,
        name: d.label ? `AI · ${d.label}` : 'Generating…',
        generating: true,
        progress: null,
        queuePos: d.queuePos || 1,
        etaSec: d.etaSec || null,
        step: 0,
        totalSteps: d.totalSteps || 6,
        previewUrl: d.previewUrl || null,
        srcDur: d.seconds,
        srcIn: 0,
        speed: 1,
        transition: 0,
        volume: 1,
        opacity: 1,
        muted: false,
        kind: 'video',
      };
      store.set({
        clips: T.placeRange(s.clips, 'V1', startAt, d.seconds, props),
        selected: id,
        log: `Queued #${props.queuePos}: generating ${d.seconds} s clip…`,
      });
    } else if (d.type === 'queue') {
      const s = get();
      store.set({
        clips: s.clips.map((c) => (c.id === id ? {
          ...c,
          queuePos: d.queuePos ?? c.queuePos,
          etaSec: d.etaSec ?? c.etaSec,
        } : c)),
      });
    } else if (d.type === 'preview') {
      const s = get();
      const bustUrl = d.previewUrl ? `${d.previewUrl}?v=${Date.now()}` : null;
      store.set({
        clips: s.clips.map((c) => (c.id === id ? {
          ...c,
          previewUrl: bustUrl || c.previewUrl,
          step: d.step ?? c.step,
          totalSteps: d.totalSteps ?? c.totalSteps,
          progress: typeof d.progress === 'number' ? d.progress : c.progress,
          etaSec: d.etaSec ?? c.etaSec,
        } : c)),
      });
    } else if (d.type === 'progress') {
      const s = get();
      store.set({
        clips: s.clips.map((c) => (c.id === id ? {
          ...c,
          progress: typeof d.progress === 'number' ? d.progress : c.progress,
          step: d.step ?? c.step,
          totalSteps: d.totalSteps ?? c.totalSteps,
          etaSec: d.etaSec ?? c.etaSec,
        } : c)),
        log: d.label || s.log,
      });
    } else if (d.type === 'done') {
      const s = get();
      if (d.dryRun || !d.path) {
        store.set({
          clips: T.deleteClip(s.clips, id),
          log: d.dryRun ? 'Dry run finished cleanly (no video generated).' : 'Generation finished.',
        });
        return;
      }
      const name = d.path.split(/[\\/]/).pop();
      store.set({
        clips: s.clips.map((c) => (c.id === id ? {
          ...c,
          name,
          path: d.path,
          latent: d.latent || c.latent || undefined,
          latentLabel: d.latentLabel || c.latentLabel || undefined,
          kind: 'video',
          hasAudio: true,
          generating: false,
          progress: undefined,
          queuePos: undefined,
          etaSec: undefined,
          step: undefined,
          totalSteps: undefined,
          previewUrl: undefined,
        } : c)),
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

  // ---------- export panel & render the timeline to MP4/MOV ----------
  function mediaEnd(clips) {
    const media = clips.filter((c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio'));
    if (!media.length) return T.projectEnd(clips);
    return Math.max(...media.map((c) => T.clipEnd(c)));
  }

  function openExport() {
    const s = get();
    const end = Number(mediaEnd(s.clips).toFixed(2));
    const cfg = { ...s.exportCfg };
    if (cfg.rangeEnd <= cfg.rangeStart || cfg.rangeEnd > end + 0.05) {
      cfg.rangeStart = 0;
      cfg.rangeEnd = Math.max(0.5, end);
    }
    store.set({ exportOpen: true, exportCfg: cfg });
  }

  function closeExport() {
    store.set({ exportOpen: false });
  }

  function toggleExport() {
    if (get().exportOpen) closeExport();
    else openExport();
  }

  function setExportCfg(patch) {
    const s = get();
    const next = { ...s.exportCfg, ...patch };
    if (patch.aspect || patch.resTier || patch.fps || patch.quality || patch.format) {
      if (!patch.preset) next.preset = 'custom';
    }
    store.set({ exportCfg: next });
  }

  function applyExportPreset(presetId) {
    const p = EXPORT_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setExportCfg({
      preset: p.id,
      aspect: p.aspect,
      resTier: p.resTier,
      fps: p.fps,
      quality: p.quality,
      format: p.format,
    });
  }

  let rendering = false;
  async function exportRender() {
    const api = window.zaudeRender;
    if (!api) return log('Rendering needs the desktop app.');
    if (rendering) return log('A render is already running.');
    const s = get();
    const cfg = s.exportCfg;
    const dims = exportDimensions(cfg.aspect, cfg.resTier);
    const useRange = cfg.rangeMode === 'custom';
    rendering = true;
    store.set({ exportStatus: { busy: true, progress: 0, message: 'Starting export…', lastPath: null }, log: 'Rendering…' });
    const off = api.onProgress((p) => {
      const pct = Math.round(p * 100);
      store.set({
        exportStatus: { busy: true, progress: p, message: `Exporting ${pct}%…`, lastPath: null },
        log: `Rendering ${pct}%`,
      });
    });
    try {
      const res = await api.start({
        clips: s.clips,
        resolution: `${dims.width} × ${dims.height}`,
        width: dims.width,
        height: dims.height,
        fps: cfg.fps,
        quality: cfg.quality,
        format: cfg.format,
        rangeStart: useRange ? Number(cfg.rangeStart) : null,
        rangeEnd: useRange ? Number(cfg.rangeEnd) : null,
        folder: s.projectFolder,
        name: s.projectName,
        captions: s.captions || null,
      });
      if (res.ok) {
        const encLabel = res.encoder === 'h264_nvenc' ? 'NVIDIA NVENC' : 'CPU';
        const msg = `Exported (${encLabel}): ${res.path.split(/[\\/]/).pop()}`;
        store.set({ exportStatus: { busy: false, progress: 1, message: msg, lastPath: res.path }, log: `Rendered ${res.path} (${encLabel})` });
      } else {
        store.set({ exportStatus: { busy: false, progress: 0, message: 'Export failed: ' + res.error, lastPath: null }, log: 'Render failed: ' + res.error });
      }
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


  function setClipRoomAcoustics(clipId, roomPreset, roomIntensity = null) {
    const s = get();
    const next = s.clips.map((c) => {
      if (c.id !== clipId) return c;
      return {
        ...c,
        roomPreset: roomPreset != null ? String(roomPreset) : (c.roomPreset || 'none'),
        roomIntensity: roomIntensity != null ? Math.max(0, Math.min(1, Number(roomIntensity))) : (c.roomIntensity != null ? c.roomIntensity : 1.0),
      };
    });
    commit(next, `Room acoustics → ${roomPreset || 'updated'}`);
  }

  function applyRoomAcousticsToAll(roomPreset, roomIntensity = 1.0) {
    const s = get();
    const next = s.clips.map((c) => (c.kind === 'video' || c.kind === 'audio'
      ? { ...c, roomPreset: String(roomPreset || 'none'), roomIntensity: Math.max(0, Math.min(1, Number(roomIntensity))) }
      : c));
    commit(next, `Applied room acoustics (${roomPreset}) to all clips`);
  }

  async function addRoomToneBed(presetId = 'dim-bar') {
    const audioApi = window.zaudeAudio;
    if (!audioApi || !audioApi.generateRoomToneBed) return log('Room-tone generator unavailable.');
    const s = get();
    const totalDur = s.clips.reduce((m, c) => Math.max(m, (c.start || 0) + (c.dur || 0)), 0) || 30;
    log(`Generating continuous ${presetId} room-tone bed (${totalDur.toFixed(1)}s)…`);
    const res = await audioApi.generateRoomToneBed({ presetId, durationSec: totalDur });
    if (!res || !res.ok) return log('Room-tone bed failed: ' + ((res && res.error) || 'unknown'));
    const bedClip = {
      id: `a2-bed-${Date.now().toString(36)}`,
      track: 'A2',
      name: res.name || `room_tone_${presetId}.ogg`,
      path: res.path,
      url: res.url,
      kind: 'audio',
      hasAudio: true,
      hasVideo: false,
      start: 0,
      dur: Number(res.duration) || totalDur,
      srcDur: Number(res.duration) || totalDur,
      srcIn: 0,
      speed: 1,
      volume: 1,
      muted: false,
    };
    const withoutOldBed = get().clips.filter((c) => !(c.track === 'A2' && String(c.id).startsWith('a2-bed-')));
    commit([...withoutOldBed, bedClip], `Added continuous ${res.label} room-tone bed on A2`);
  }

  return {
    undo, redo, split, trim, deleteSelected, duplicate, ripple, slip, speed, setSpeed, matchAudioDuration, insertAudioClip, replaceClipWithSynced, dissolve, setTransition, toggleMirror, resetTransform, transformClip, toggleFill, resetFilters, resetHsl, addHslBand, removeHslBand, selectHslBand, setHslBandProp, setHslTarget, setEyedropper, detach,
    setProp, bumpVolume, select, selectMany, toggleSelect, seekTo, stepBy, togglePlay, zoomIn, zoomOut, fit, setZoom, toggleSnap, snapTime, addTrack,
    detectBeats, setBeatGrid, addBeatMarker, moveBeatMarker, removeBeatMarker, clearBeats,
    setClipFade, upsertVolumeKeyframe, removeVolumeKeyframe, clearVolumeKeyframes,
    setClipRoomAcoustics, applyRoomAcousticsToAll, addRoomToneBed,
    setPage, importFolder, selectBin, addBinItem, saveProject, saveZd, openZd, scheduleSave, generationEvent, runTool, exportProject, exportRender,
    openExport, closeExport, toggleExport, setExportCfg, applyExportPreset,
    selectedClip, log, commitClips, gesture: trackpadGesture, liveClips,
  };
}
