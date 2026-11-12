// Pure timeline model for Zaude. No DOM, so it can be tested with `node --test`.

export const FPS = 24;
export const SPEEDS = [0.5, 1, 2, 4];
export const TRACK_IDS = ['V2', 'V1', 'A1', 'A2'];
const EPS = 1e-6;

let seq = 0;
export function newId() {
  seq += 1;
  return 'c' + seq;
}

export const MEDIA = [
  { name: 'forest_pan.mov', kind: 'video', srcDur: 20 },
  { name: 'beach_drone.mp4', kind: 'video', srcDur: 30 },
  { name: 'market_walk.mp4', kind: 'video', srcDur: 40 },
  { name: 'interview_a.mp4', kind: 'video', srcDur: 30 },
  { name: 'voiceover_01.wav', kind: 'audio', srcDur: 60 },
];
export const INSERT_LENGTH = 6; // seconds placed on the timeline by Insert / Overwrite

export function initialClips() {
  const c = (track, name, start, dur, srcDur, extra = {}) => ({
    id: newId(), track, name, start, dur, srcDur, srcIn: 0, speed: 1, transition: 0, ...extra,
  });
  return [
    c('V2', 'Title · Natural Moment', 2.5, 14, 14),
    c('V1', 'forest_pan.mov', 0, 9, 20),
    c('A1', 'beach_drone.mp4', 0, 13, 30),
    c('A1', 'market_walk.mp4', 15, 14, 40, { srcIn: 4 }),
    c('A1', 'interview_a.mp4', 40, 17, 30),
    c('A2', 'voiceover_01.wav', 0, 38, 60),
  ];
}

export const clipEnd = (c) => c.start + c.dur;
export const sourceUsed = (c) => c.dur * c.speed;
export const findClip = (clips, id) => clips.find((c) => c.id === id) || null;
export const clone = (clips) => clips.map((c) => ({ ...c }));

export function projectEnd(clips) {
  const latest = clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return Math.max(60, latest + 4);
}

export function timecode(sec) {
  const frames = Math.max(0, Math.round(sec * FPS));
  const pad = (n) => String(n).padStart(2, '0');
  const ff = frames % FPS;
  const s = Math.floor(frames / FPS) % 60;
  const m = Math.floor(frames / (FPS * 60)) % 60;
  const h = Math.floor(frames / (FPS * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

// Clip under the playhead on the topmost track that has one.
export function clipAt(clips, t) {
  const hits = clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
  if (!hits.length) return null;
  return hits.sort((a, b) => TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track))[0];
}

// Split every clip that straddles t (optionally only on one track).
export function splitAt(clips, t, track = null) {
  const out = [];
  for (const c of clips) {
    const eligible = track === null || c.track === track;
    if (eligible && t > c.start + EPS && t < clipEnd(c) - EPS) {
      const leftDur = t - c.start;
      out.push({ ...c, dur: leftDur });
      out.push({ ...c, id: newId(), start: t, dur: c.dur - leftDur, srcIn: c.srcIn + leftDur * c.speed, transition: 0 });
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// Move every clip on `track` that starts at or after t by delta seconds.
export function shiftFrom(clips, track, t, delta) {
  return clips.map((c) => (c.track === track && c.start >= t - EPS ? { ...c, start: c.start + delta } : c));
}

export function trimEnd(clips, id, t) {
  const c = findClip(clips, id);
  if (!c || !(t > c.start + EPS && t < clipEnd(c) - EPS)) return null;
  return clips.map((x) => (x.id === id ? { ...x, dur: t - c.start } : { ...x }));
}

export function deleteClip(clips, id) {
  return clips.filter((c) => c.id !== id).map((c) => ({ ...c }));
}

export function rippleDelete(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const end = clipEnd(c);
  return clips
    .filter((x) => x.id !== id)
    .map((x) => (x.track === c.track && x.start >= end - EPS ? { ...x, start: x.start - c.dur } : { ...x }));
}

export function duplicateClip(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const at = clipEnd(c);
  const base = splitAt(clips, at, c.track);
  const shifted = shiftFrom(base, c.track, at, c.dur);
  return [...shifted, { ...c, id: newId(), start: at, transition: 0 }];
}

export function slipClip(clips, id, deltaSource) {
  const c = findClip(clips, id);
  if (!c) return null;
  const max = Math.max(0, c.srcDur - sourceUsed(c));
  const srcIn = Math.min(max, Math.max(0, c.srcIn + deltaSource));
  return clips.map((x) => (x.id === id ? { ...x, srcIn } : { ...x }));
}

// Cycle the clip's speed. The clip gets longer or shorter on the timeline and later clips on its track move.
export function changeSpeed(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const idx = SPEEDS.indexOf(c.speed);
  const speed = SPEEDS[(idx + 1) % SPEEDS.length];
  const newDur = sourceUsed(c) / speed;
  const delta = newDur - c.dur;
  const end = clipEnd(c);
  return clips.map((x) => {
    if (x.id === id) return { ...x, speed, dur: newDur };
    if (x.track === c.track && x.start >= end - EPS) return { ...x, start: x.start + delta };
    return { ...x };
  });
}

export function toggleTransition(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const transition = c.transition ? 0 : Math.min(1, c.dur / 2);
  return clips.map((x) => (x.id === id ? { ...x, transition } : { ...x }));
}

function makeClip(track, media, start, dur) {
  return { id: newId(), track, name: media.name, start, dur, srcDur: media.srcDur, srcIn: 0, speed: 1, transition: 0 };
}

export function insertMedia(clips, track, t, media) {
  const dur = Math.min(media.srcDur, INSERT_LENGTH);
  const split = splitAt(clips, t, track);
  const shifted = shiftFrom(split, track, t, dur);
  return [...shifted, makeClip(track, media, t, dur)];
}

export function overwriteMedia(clips, track, t, media) {
  const dur = Math.min(media.srcDur, INSERT_LENGTH);
  const end = t + dur;
  let next = splitAt(clips, t, track);
  next = splitAt(next, end, track);
  next = next.filter((c) => !(c.track === track && c.start >= t - EPS && clipEnd(c) <= end + EPS));
  return [...next, makeClip(track, media, t, dur)];
}

// Snap t to the nearest clip edge within `threshold` seconds. Returns t unchanged when snapping is off.
export function snapTime(clips, t, enabled, threshold) {
  if (!enabled) return t;
  let best = t;
  let bestDist = threshold;
  for (const c of clips) {
    for (const edge of [c.start, clipEnd(c)]) {
      const d = Math.abs(edge - t);
      if (d <= bestDist) { best = edge; bestDist = d; }
    }
  }
  return best;
}

// ---------- trackpad gestures ----------

// Calibration: one full two-finger sweep across the trackpad is WHEEL_UNITS_PER_SWEEP scroll units.
// At a 60 s visible window, one sweep changes a clip by SWEEP_SECONDS_AT_60S. The rate scales with the
// visible span, so zooming in gives finer control. Adjust these two numbers to tune the feel.
export const WHEEL_UNITS_PER_SWEEP = 1000;
export const SWEEP_SECONDS_AT_60S = 0.80;
export const MIN_CLIP_DUR = 0.01;

export function secondsPerWheelUnit(visibleSpan) {
  return (SWEEP_SECONDS_AT_60S / WHEEL_UNITS_PER_SWEEP) * (visibleSpan / 60);
}

// Change the clip's end (its length). Clamped to the source media, to the next clip on the track, and to a minimum length.
export function adjustEnd(clips, id, deltaSec) {
  const c = findClip(clips, id);
  if (!c) return null;
  const nextStart = clips
    .filter((x) => x.track === c.track && x.id !== id && x.start > c.start + EPS)
    .reduce((m, x) => Math.min(m, x.start), Infinity);
  const maxBySource = (c.srcDur - c.srcIn) / c.speed;
  const maxByNeighbour = nextStart - c.start;
  const dur = Math.max(MIN_CLIP_DUR, Math.min(c.dur + deltaSec, maxBySource, maxByNeighbour));
  return clips.map((x) => (x.id === id ? { ...x, dur } : { ...x }));
}

// Move the clip's start along its track without overlapping its neighbours or going before 0.
export function moveClip(clips, id, deltaSec) {
  const c = findClip(clips, id);
  if (!c) return null;
  const others = clips.filter((x) => x.track === c.track && x.id !== id);
  const prevEnd = others.filter((x) => x.start <= c.start + EPS).reduce((m, x) => Math.max(m, clipEnd(x)), 0);
  const nextStart = others.filter((x) => x.start > c.start + EPS).reduce((m, x) => Math.min(m, x.start), Infinity);
  const start = Math.min(Math.max(c.start + deltaSec, prevEnd, 0), nextStart - c.dur);
  return clips.map((x) => (x.id === id ? { ...x, start } : { ...x }));
}
