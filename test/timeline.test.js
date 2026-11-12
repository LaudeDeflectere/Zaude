import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/timeline.js';

const clip = (over) => ({ id: 'x' + Math.random(), track: 'V1', name: 'a', start: 0, dur: 10, srcDur: 30, srcIn: 0, speed: 1, transition: 0, ...over });

test('splitAt splits straddling clips and keeps source offsets', () => {
  const out = T.splitAt([clip({ id: 'a', start: 0, dur: 10 })], 4);
  assert.equal(out.length, 2);
  assert.equal(out[0].dur, 4);
  assert.equal(out[1].start, 4);
  assert.equal(out[1].dur, 6);
  assert.equal(out[1].srcIn, 4);
});

test('splitAt at a clip edge does nothing', () => {
  assert.equal(T.splitAt([clip({ start: 0, dur: 10 })], 10).length, 1);
});

test('rippleDelete removes the clip and closes the gap', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  const out = T.rippleDelete(clips, 'a');
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
});

test('deleteClip leaves a gap', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  assert.equal(T.deleteClip(clips, 'a')[0].start, 5);
});

test('duplicateClip places a copy after the original and pushes later clips', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  const out = T.duplicateClip(clips, 'a');
  assert.equal(out.length, 3);
  const copy = out.find((c) => c.id !== 'a' && c.id !== 'b');
  assert.equal(copy.start, 5);
  assert.equal(out.find((c) => c.id === 'b').start, 10);
});

test('trimEnd shortens the clip to the playhead', () => {
  const out = T.trimEnd([clip({ id: 'a', start: 2, dur: 10 })], 'a', 6);
  assert.equal(out[0].dur, 4);
});

test('slipClip moves the source window and stays in range', () => {
  const clips = [clip({ id: 'a', dur: 10, srcDur: 30, srcIn: 0 })];
  assert.equal(T.slipClip(clips, 'a', 5)[0].srcIn, 5);
  assert.equal(T.slipClip(clips, 'a', -5)[0].srcIn, 0);
  assert.equal(T.slipClip(clips, 'a', 100)[0].srcIn, 20);
});

test('changeSpeed cycles speed and resizes the clip and shifts later clips', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 8 }), clip({ id: 'b', start: 8, dur: 2 })];
  const out = T.changeSpeed(clips, 'a'); // 1x -> 2x
  assert.equal(out.find((c) => c.id === 'a').speed, 2);
  assert.equal(out.find((c) => c.id === 'a').dur, 4);
  assert.equal(out.find((c) => c.id === 'b').start, 4);
});

test('insertMedia pushes later clips on that track right', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 10 })];
  const media = { name: 'm.mp4', srcDur: 30 };
  const out = T.insertMedia(clips, 'V1', 4, media);
  const inserted = out.find((c) => c.name === 'm.mp4');
  assert.equal(inserted.start, 4);
  assert.equal(inserted.dur, T.INSERT_LENGTH);
  const right = out.find((c) => c.id !== inserted.id && c.start > 4);
  assert.equal(right.start, 4 + T.INSERT_LENGTH);
});

test('overwriteMedia replaces the range on its track', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 10 })];
  const out = T.overwriteMedia(clips, 'V1', 2, { name: 'm.mp4', srcDur: 30 });
  const v1 = out.filter((c) => c.track === 'V1').sort((p, q) => p.start - q.start);
  assert.deepEqual(v1.map((c) => [c.start, c.dur]), [[0, 2], [2, T.INSERT_LENGTH], [2 + T.INSERT_LENGTH, 10 - 2 - T.INSERT_LENGTH]]);
});

test('toggleTransition turns a cross dissolve on and off', () => {
  const clips = [clip({ id: 'a', dur: 10 })];
  const on = T.toggleTransition(clips, 'a');
  assert.equal(on[0].transition, 1);
  assert.equal(T.toggleTransition(on, 'a')[0].transition, 0);
});

test('snapTime snaps to nearby edges only when enabled', () => {
  const clips = [clip({ start: 5, dur: 5 })];
  assert.equal(T.snapTime(clips, 5.1, true, 0.25), 5);
  assert.equal(T.snapTime(clips, 5.1, false, 0.25), 5.1);
  assert.equal(T.snapTime(clips, 7, true, 0.25), 7);
});

test('timecode formats at 24 fps', () => {
  assert.equal(T.timecode(0), '00:00:00:00');
  assert.equal(T.timecode(12 + 8 / 24), '00:00:12:08');
});

test('initial project has the expected clips', () => {
  assert.equal(T.initialClips().length, 6);
});

test('one full sweep at a 60 s view changes a clip by the calibrated amount', () => {
  assert.ok(Math.abs(1000 * T.secondsPerWheelUnit(60) - T.SWEEP_SECONDS_AT_60S) < 1e-9);
});

test('sensitivity scales with the visible span', () => {
  assert.ok(Math.abs(T.secondsPerWheelUnit(6) - T.secondsPerWheelUnit(60) / 10) < 1e-12);
});

test('adjustEnd lengthens and shortens a clip', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', 2)[0].dur, 7);
  assert.equal(T.adjustEnd(clips, 'a', -2)[0].dur, 3);
});

test('adjustEnd keeps at least the minimum length', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 0.05, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', -10)[0].dur, T.MIN_CLIP_DUR);
});

test('adjustEnd cannot run past the source media', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 8, srcIn: 0, speed: 1 })];
  assert.equal(T.adjustEnd(clips, 'a', 100)[0].dur, 8);
});

test('adjustEnd stops at the next clip on the same track', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 30 }), clip({ id: 'b', start: 6, dur: 2, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', 100)[0].dur, 6);
});

test('moveClip shifts a clip and stops at neighbours and zero', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 2 }), clip({ id: 'b', start: 4, dur: 2 })];
  assert.equal(T.moveClip(clips, 'b', -1)[1].start, 3);
  assert.equal(T.moveClip(clips, 'b', -10)[1].start, 2);
  assert.equal(T.moveClip(clips, 'b', 100)[1].start, 104);
  assert.equal(T.moveClip(clips, 'a', -5)[0].start, 0);
});

test('placeRange puts a clip in a free range and replaces what it covers', () => {
  const clips = [clip({ id: 'a', track: 'V1', start: 0, dur: 10 })];
  const out = T.placeRange(clips, 'V1', 4, 2, { id: 'gen', name: 'Generating…' });
  const gen = out.find((c) => c.id === 'gen');
  assert.equal(gen.start, 4);
  assert.equal(gen.dur, 2);
  const v1 = out.filter((c) => c.track === 'V1').sort((p, q) => p.start - q.start);
  assert.deepEqual(v1.map((c) => [c.start, c.dur]), [[0, 4], [4, 2], [6, 4]]);
});
