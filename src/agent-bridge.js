// Connects MCP / AI Chat tool calls directly to Zaude's live store and actions.
import * as T from './timeline.js';
import { getHslBands } from './color.js';

export function buildAgentStateSnapshot(store) {
  const s = store.get();
  return {
    projectName: s.projectName,
    projectFolder: s.projectFolder,
    zdFilePath: s.zdFilePath,
    playhead: Number(s.playhead.toFixed(3)),
    selected: s.selected,
    selectedIds: s.selectedIds || [],
    exportCfg: s.exportCfg,
    media: (s.media || []).map((m) => ({ name: m.name, path: m.path, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio })),
    clips: (s.clips || []).map((c) => ({
      id: c.id,
      track: c.track,
      name: c.name,
      kind: c.kind,
      start: Number(c.start.toFixed(3)),
      dur: Number(c.dur.toFixed(3)),
      srcIn: Number((c.srcIn || 0).toFixed(3)),
      speed: c.speed || 1,
      muted: Boolean(c.muted),
      volume: T.propValue(c, 'volume'),
      opacity: T.propValue(c, 'opacity'),
      blur: T.propValue(c, 'blur'),
      scale: T.propValue(c, 'scale'),
      rotation: T.propValue(c, 'rotation'),
      posX: T.propValue(c, 'posX'),
      posY: T.propValue(c, 'posY'),
      flipH: Boolean(c.flipH),
      flipV: Boolean(c.flipV),
      transitionType: c.transitionType || (c.transition > 0 ? 'dissolve' : 'none'),
      transition: c.transition || 0,
    })),
  };
}

function resolveClipId(store, clipId) {
  const s = store.get();
  if (clipId && T.findClip(s.clips, clipId)) return clipId;
  if (s.selected && T.findClip(s.clips, s.selected)) return s.selected;
  const atHead = T.clipAt(s.clips, s.playhead);
  return atHead ? atHead.id : null;
}

export async function executeAgentTool({ tool, args = {} }, { store, actions, workspace }) {
  const s = store.get();
  switch (tool) {
    case 'zaude_get_state':
      return { ok: true, state: buildAgentStateSnapshot(store) };

    case 'zaude_seek': {
      const t = Number(args.time);
      if (!Number.isFinite(t) || t < 0) return { ok: false, error: 'Invalid time.' };
      actions.seekTo(t);
      return { ok: true, summary: `Moved playhead to ${T.timecode(t)}` };
    }

    case 'zaude_select_clips': {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      actions.selectMany(ids);
      return { ok: true, summary: `Selected ${ids.length} clip(s)` };
    }

    case 'zaude_add_from_bin': {
      const q = String(args.nameOrPath || '').toLowerCase();
      const file = (s.media || []).find((m) => m.path.toLowerCase() === q || m.name.toLowerCase() === q || m.name.toLowerCase().includes(q));
      if (!file) return { ok: false, error: `No bin media matching "${args.nameOrPath}".` };
      if (typeof args.time === 'number' && Number.isFinite(args.time)) actions.seekTo(Math.max(0, args.time));
      actions.addBinItem(file.path);
      return { ok: true, summary: `Added ${file.name} to timeline` };
    }

    case 'zaude_split': {
      if (typeof args.time === 'number' && Number.isFinite(args.time)) actions.seekTo(Math.max(0, args.time));
      const before = store.get().clips.length;
      actions.split();
      const after = store.get().clips.length;
      if (after === before) return { ok: false, error: 'No clip straddles the playhead to split.' };
      return { ok: true, summary: `Split at ${T.timecode(store.get().playhead)}` };
    }

    case 'zaude_trim': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip found to trim.' };
      const clip = T.findClip(s.clips, id);
      let next = null;
      if (typeof args.duration === 'number' && Number.isFinite(args.duration)) {
        next = T.adjustEnd(s.clips, id, args.duration - clip.dur);
      } else if (typeof args.endTime === 'number' && Number.isFinite(args.endTime)) {
        next = T.trimEnd(s.clips, id, args.endTime);
      }
      if (!next) return { ok: false, error: 'Provide a valid duration or endTime inside the clip.' };
      actions.commitClips(next, `AI trimmed ${clip.name}`);
      return { ok: true, summary: `Trimmed ${clip.name}` };
    }

    case 'zaude_move_clip': {
      const ids = Array.isArray(args.clipIds) && args.clipIds.length
        ? args.clipIds
        : [resolveClipId(store, args.clipId)].filter(Boolean);
      if (!ids.length) return { ok: false, error: 'No clip found to move.' };
      let delta = Number(args.deltaSec);
      if (!Number.isFinite(delta) && typeof args.start === 'number' && ids.length === 1) {
        const c = T.findClip(s.clips, ids[0]);
        if (c) delta = args.start - c.start;
      }
      if (!Number.isFinite(delta)) return { ok: false, error: 'Provide deltaSec or start.' };
      const next = ids.length > 1 ? T.moveClips(s.clips, ids, delta) : T.moveClip(s.clips, ids[0], delta);
      if (!next) return { ok: false, error: 'Could not move clip(s).' };
      actions.commitClips(next, `AI moved ${ids.length} clip(s)`);
      return { ok: true, summary: `Moved ${ids.length} clip(s)` };
    }

    case 'zaude_delete_clips': {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id) => T.findClip(s.clips, id)) : [];
      if (!ids.length) return { ok: false, error: 'No matching clips to delete.' };
      if (args.ripple && ids.length === 1) {
        actions.select(ids[0]);
        actions.ripple();
        return { ok: true, summary: `Ripple deleted ${ids[0]}` };
      }
      actions.commitClips(T.deleteClips(s.clips, ids), `AI deleted ${ids.length} clip(s)`);
      actions.select(null);
      return { ok: true, summary: `Deleted ${ids.length} clip(s)` };
    }

    case 'zaude_set_filters': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip selected or under playhead.' };
      let next = s.clips;
      if (args.reset) next = T.resetFilters(next, id);
      const keys = [...T.FILTER_PROPS, 'blur', 'opacity', 'volume'];
      for (const k of keys) {
        if (typeof args[k] === 'number' && Number.isFinite(args[k])) {
          next = T.setProp(next, id, k, args[k]);
        }
      }
      if (typeof args.muted === 'boolean') next = T.setFlag(next, id, 'muted', args.muted);
      actions.select(id);
      actions.commitClips(next, `AI updated filters on ${T.findClip(next, id)?.name || id}`);
      return { ok: true, summary: `Updated filters on ${id}` };
    }

    case 'zaude_set_transform': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip selected or under playhead.' };
      let next = s.clips;
      if (args.reset) next = T.resetTransform(next, id);
      for (const k of T.TRANSFORM_PROPS) {
        if (typeof args[k] === 'number' && Number.isFinite(args[k])) {
          next = T.setProp(next, id, k, args[k]);
        }
      }
      if (typeof args.flipH === 'boolean') next = T.setFlag(next, id, 'flipH', args.flipH);
      if (typeof args.flipV === 'boolean') next = T.setFlag(next, id, 'flipV', args.flipV);
      if (typeof args.fill === 'boolean') next = T.setFlag(next, id, 'fill', args.fill);
      actions.select(id);
      actions.commitClips(next, `AI updated transform on ${T.findClip(next, id)?.name || id}`);
      return { ok: true, summary: `Updated transform on ${id}` };
    }

    case 'zaude_set_hsl': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip selected or under playhead.' };
      let next = s.clips;
      if (args.reset) {
        next = T.resetHsl(next, id);
      } else {
        if (args.addNew) next = T.addHslBand(next, id, args.hex || '#3b82f6');
        const c = T.findClip(next, id);
        const bands = getHslBands(c);
        const bandId = c.hslActiveBand || bands[0].id;
        next = T.updateHslBand(next, id, bandId, {
          ...(args.hex ? { hex: args.hex } : {}),
          ...(typeof args.hue === 'number' ? { hue: args.hue } : {}),
          ...(typeof args.sat === 'number' ? { sat: args.sat } : {}),
          ...(typeof args.light === 'number' ? { light: args.light } : {}),
          ...(typeof args.range === 'number' ? { range: args.range } : {}),
        });
      }
      actions.select(id);
      actions.commitClips(next, `AI updated selective HSL on ${T.findClip(next, id)?.name || id}`);
      return { ok: true, summary: `Updated selective HSL on ${id}` };
    }

    case 'zaude_set_transition': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip selected or under playhead.' };
      actions.select(id);
      actions.setTransition(args.type, args.duration);
      return { ok: true, summary: `Set transition ${args.type} on ${id}` };
    }

    case 'zaude_separate_audio': {
      const id = resolveClipId(store, args.clipId);
      if (!id) return { ok: false, error: 'No clip selected or under playhead.' };
      actions.select(id);
      actions.detach();
      return { ok: true, summary: `Separated audio on ${id}` };
    }

    case 'zaude_set_export': {
      if (args.preset) actions.applyExportPreset(args.preset);
      const patch = {};
      for (const k of ['aspect', 'resTier', 'fps', 'quality', 'format', 'rangeMode', 'rangeStart', 'rangeEnd']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (Object.keys(patch).length) actions.setExportCfg(patch);
      if (args.openPanel !== false) {
        if (workspace && workspace.ensurePanel) workspace.ensurePanel('inspector');
        actions.openExport();
      }
      if (args.startRender) actions.exportRender();
      return { ok: true, summary: 'Updated export settings' };
    }

    case 'zaude_add_tip': {
      if (!window.zaudeAgent || !window.zaudeAgent.addTip) {
        return { ok: false, error: 'Tips API unavailable.' };
      }
      const res = await window.zaudeAgent.addTip(args);
      return res.ok ? { ok: true, summary: `Added tip "${res.tip.title}"`, tip: res.tip } : res;
    }

    default:
      return { ok: false, error: `Unknown tool: ${tool}` };
  }
}

export function installAgentBridge(deps) {
  const api = window.zaudeAgent;
  if (!api) return () => {};
  const offState = api.onGetState(() => ({ ok: true, state: buildAgentStateSnapshot(deps.store) }));
  const offExec = api.onExecTool((payload) => executeAgentTool(payload, deps));
  return () => { offState(); offExec(); };
}
