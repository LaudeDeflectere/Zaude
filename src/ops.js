// Edit commands: a list of steps, each one a timeline tool with its settings. The same tools the
// editor's buttons use, so an edit can be written down, repeated, and run without the window.
// Pure: no files are read here. The caller supplies the media list and any saved silence analysis.
import * as T from './timeline.js';

const num = (v, name, op) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${op}" needs a number for "${name}".`);
  return n;
};

// What each command does and which settings it takes. Shown by `zaude help ops`.
export const OPS = {
  clear: 'Remove every clip. {op}',
  add: 'Place part of a file. {op, file, in?, out?, track?, at?, speed?, zoom?, volume?, opacity?, muted?, as?}. Goes after the last clip on the track unless "at" is given. "as" names the clip for later steps.',
  title: 'Draw text over the picture. {op, text, dur, at? | over?, track?, position? (top|center|bottom), size?, color?, as?}. "over" is a clip name or id: the title starts where that clip starts.',
  split: 'Split clips at a time. {op, at, track?}',
  delete: 'Remove a clip and leave the gap. {op, clip}',
  ripple: 'Remove a clip and close the gap. {op, clip}',
  cut: 'Remove a time range and close the gap. {op, from, to, tracks?}',
  speed: 'Set a clip\'s speed, 0.1 to 100. {op, clip, speed}',
  set: 'Set volume, opacity or zoom. {op, clip, prop, value}',
  mute: 'Mute or unmute a clip. {op, clip, value?}',
  move: 'Move a clip along its track. {op, clip, by}',
  length: 'Lengthen or shorten a clip\'s end. {op, clip, by}',
  slip: 'Shift which part of the source a clip shows. {op, clip, by}',
  detach: 'Put a video clip\'s audio on its own track. {op, clip}',
  removeSilence: 'Cut the silent parts out of normal-speed clips with sound. {op, file?, pad?, minCut?, tracks?}. Cuts every track unless "tracks" is given, so add music afterwards. Needs the silence analysis of each file.',
};

function findFile(media, name) {
  const wanted = String(name || '');
  const lower = wanted.toLowerCase();
  return media.find((m) => m.path === wanted)
    || media.find((m) => m.name === wanted)
    || media.find((m) => m.name.toLowerCase() === lower)
    || media.find((m) => m.name.toLowerCase().replace(/\.[^.]+$/, '') === lower)
    || null;
}

// Runs the steps in order. context: { media: [{ name, path, kind, duration, hasAudio }], silences: { [path]: [{ from, to }] } }.
// Returns { ok, clips, log, names } or { ok: false, error, step }. Nothing is changed when a step fails.
export function applyOps(startClips, ops, context = {}) {
  const media = context.media || [];
  const silences = context.silences || {};
  const names = { ...(context.names || {}) };
  const log = [];
  let clips = T.clone(startClips);
  T.reserveIds(clips);

  const resolve = (ref, op) => {
    const id = names[ref] || ref;
    const c = T.findClip(clips, id);
    if (!c) throw new Error(`"${op}" could not find the clip "${ref}".`);
    return c;
  };
  const must = (next, what) => {
    if (!next) throw new Error(what);
    return next;
  };

  if (!Array.isArray(ops)) return { ok: false, error: 'The edit must be a list of steps.', step: null };

  for (let k = 0; k < ops.length; k++) {
    const o = ops[k] || {};
    try {
      switch (o.op) {
        case 'clear':
          clips = [];
          log.push('Cleared the timeline');
          break;
        case 'add': {
          const file = findFile(media, o.file);
          if (!file) throw new Error(`"add" could not find the file "${o.file}" in the project folder.`);
          const track = o.track || (file.kind === 'audio' ? 'A1' : 'V1');
          if (!T.TRACK_IDS.includes(track)) throw new Error(`"add" does not know the track "${track}".`);
          const props = {};
          for (const key of ['speed', 'zoom', 'volume', 'opacity']) if (o[key] != null) props[key] = num(o[key], key, 'add');
          if (o.muted != null) props.muted = Boolean(o.muted);
          const at = o.at == null ? null : num(o.at, 'at', 'add');
          const r = T.appendSource(clips, track, file, o.in == null ? 0 : num(o.in, 'in', 'add'), o.out == null ? null : num(o.out, 'out', 'add'), props, at);
          if (r.error) throw new Error(r.error);
          clips = r.clips;
          if (o.as) names[o.as] = r.id;
          const c = T.findClip(clips, r.id);
          log.push(`Added ${file.name} ${c.srcIn.toFixed(2)}–${(c.srcIn + T.sourceUsed(c)).toFixed(2)} s on ${track} at ${c.start.toFixed(2)} s` + (c.speed !== 1 ? ` ×${c.speed}` : ''));
          break;
        }
        case 'title': {
          const at = o.over != null ? resolve(o.over, 'title').start + (o.offset ? num(o.offset, 'offset', 'title') : 0) : num(o.at, 'at', 'title');
          const r = T.addTitle(clips, o.track || 'V2', at, num(o.dur, 'dur', 'title'), o.text, o);
          if (r.error) throw new Error(r.error);
          clips = r.clips;
          if (o.as) names[o.as] = r.id;
          log.push(`Title "${String(o.text).trim()}" at ${at.toFixed(2)} s`);
          break;
        }
        case 'split':
          clips = T.splitAt(clips, num(o.at, 'at', 'split'), o.track || null);
          log.push(`Split at ${Number(o.at).toFixed(2)} s`);
          break;
        case 'delete': {
          const c = resolve(o.clip, 'delete');
          clips = T.deleteClip(clips, c.id);
          log.push('Deleted ' + c.name);
          break;
        }
        case 'ripple': {
          const c = resolve(o.clip, 'ripple');
          clips = must(T.rippleDelete(clips, c.id), 'Ripple delete failed.');
          log.push('Ripple deleted ' + c.name);
          break;
        }
        case 'cut': {
          const from = num(o.from, 'from', 'cut');
          const to = num(o.to, 'to', 'cut');
          if (!(to > from)) throw new Error('"cut" needs "to" after "from".');
          clips = T.cutRange(clips, from, to, Array.isArray(o.tracks) ? o.tracks : null);
          log.push(`Cut ${from.toFixed(2)}–${to.toFixed(2)} s`);
          break;
        }
        case 'speed': {
          const c = resolve(o.clip, 'speed');
          clips = must(T.setSpeed(clips, c.id, num(o.speed, 'speed', 'speed')), 'Speed change failed.');
          log.push(`${c.name} speed ×${T.findClip(clips, c.id).speed}`);
          break;
        }
        case 'set': {
          const c = resolve(o.clip, 'set');
          if (!T.PROPS[o.prop]) throw new Error(`"set" does not know the property "${o.prop}". Use volume, opacity or zoom.`);
          clips = T.setProp(clips, c.id, o.prop, num(o.value, 'value', 'set'));
          log.push(`${c.name} ${o.prop} ${T.PROPS[o.prop].format(T.propValue(T.findClip(clips, c.id), o.prop))}`);
          break;
        }
        case 'mute': {
          const c = resolve(o.clip, 'mute');
          clips = T.setFlag(clips, c.id, 'muted', o.value == null ? true : Boolean(o.value));
          log.push((o.value === false ? 'Unmuted ' : 'Muted ') + c.name);
          break;
        }
        case 'move': {
          const c = resolve(o.clip, 'move');
          clips = T.moveClip(clips, c.id, num(o.by, 'by', 'move'));
          log.push(`${c.name} starts at ${T.findClip(clips, c.id).start.toFixed(2)} s`);
          break;
        }
        case 'length': {
          const c = resolve(o.clip, 'length');
          clips = T.adjustEnd(clips, c.id, num(o.by, 'by', 'length'));
          log.push(`${c.name} length ${T.findClip(clips, c.id).dur.toFixed(2)} s`);
          break;
        }
        case 'slip': {
          const c = resolve(o.clip, 'slip');
          clips = T.slipClip(clips, c.id, num(o.by, 'by', 'slip'));
          log.push(`${c.name} source in ${T.findClip(clips, c.id).srcIn.toFixed(2)} s`);
          break;
        }
        case 'detach': {
          const c = resolve(o.clip, 'detach');
          const r = T.detachAudio(clips, c.id);
          if (r.error) throw new Error(r.error);
          clips = r.clips;
          log.push('Detached the audio of ' + c.name);
          break;
        }
        case 'removeSilence': {
          const only = o.file ? findFile(media, o.file) : null;
          if (o.file && !only) throw new Error(`"removeSilence" could not find the file "${o.file}".`);
          const pad = o.pad == null ? 0.15 : num(o.pad, 'pad', 'removeSilence');
          const minCut = o.minCut == null ? 0.3 : num(o.minCut, 'minCut', 'removeSilence');
          // only clips that are heard at normal speed: a time-lapse or a muted shot keeps its length
          const talking = clips.filter((c) => c.path && (c.speed || 1) === 1 && !c.muted && c.hasAudio !== false && (!only || c.path === only.path));
          const paths = [...new Set(talking.map((c) => c.path))];
          const missing = paths.filter((p) => !silences[p]);
          if (missing.length) throw new Error('No silence analysis for: ' + missing.map((p) => p.split(/[\\/]/).pop()).join(', ') + '. Run "zaude silence" on the folder first.');
          const ranges = [];
          for (const p of paths) {
            const padded = silences[p]
              .map((s) => ({ from: s.from + pad, to: s.to - pad }))
              .filter((s) => s.to - s.from >= minCut);
            ranges.push(...T.sourceToTimeline(talking, p, padded));
          }
          const before = T.contentEnd(clips);
          clips = T.cutRanges(clips, mergeRanges(ranges), Array.isArray(o.tracks) ? o.tracks : null);
          log.push(`Removed ${ranges.length} silent parts, ${(before - T.contentEnd(clips)).toFixed(1)} s in total`);
          break;
        }
        default:
          throw new Error(`Unknown step "${o.op}". Known steps: ${Object.keys(OPS).join(', ')}.`);
      }
    } catch (e) {
      return { ok: false, error: `Step ${k + 1}: ${e.message}`, step: k };
    }
  }
  return { ok: true, clips, log, names };
}

// Joins ranges that touch or overlap, so each stretch of time is cut once.
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1e-6) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

// The timeline as text, one line per clip, in playing order.
export function describeTimeline(clips) {
  const order = (c) => T.TRACK_IDS.indexOf(c.track);
  const rows = [...clips].sort((a, b) => a.start - b.start || order(a) - order(b));
  const lines = rows.map((c) => {
    const src = c.kind === 'title' ? `"${c.text || c.name}"` : `${c.name} ${Number(c.srcIn || 0).toFixed(2)}–${(Number(c.srcIn || 0) + T.sourceUsed(c)).toFixed(2)}`;
    const extra = [
      c.speed && c.speed !== 1 ? `×${c.speed}` : '',
      c.muted ? 'muted' : '',
      typeof c.volume === 'number' && c.volume !== 1 && c.kind !== 'title' ? `vol ${Math.round(c.volume * 100)}%` : '',
      typeof c.zoom === 'number' && c.zoom > 1 ? `zoom ${Math.round(c.zoom * 100)}%` : '',
    ].filter(Boolean).join(' ');
    return `${String(c.id).padEnd(6)} ${c.track}  ${c.start.toFixed(2).padStart(9)} → ${T.clipEnd(c).toFixed(2).padStart(9)}  ${src}${extra ? '  ' + extra : ''}`;
  });
  const end = T.contentEnd(clips);
  lines.push(`${clips.length} clips, ${Math.floor(end / 60)} min ${(end % 60).toFixed(1)} s`);
  return lines.join('\n');
}
