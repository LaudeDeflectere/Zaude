import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/timeline.js';
import { applyOps, mergeRanges, describeTimeline } from '../src/ops.js';

const media = [
  { name: 'talk.mp4', path: '/p/talk.mp4', kind: 'video', duration: 100, hasAudio: true },
  { name: 'work.mp4', path: '/p/work.mp4', kind: 'video', duration: 600, hasAudio: true },
  { name: 'music.wav', path: '/p/music.wav', kind: 'audio', duration: 200, hasAudio: true },
];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

test('setSpeed accepts any speed, changes the length, and moves later clips', () => {
  let r = T.appendSource([], 'V1', media[1], 0, 600);
  const first = r.id;
  r = T.appendSource(r.clips, 'V1', media[0], 0, 10);
  const next = T.setSpeed(r.clips, first, 20);
  near(T.findClip(next, first).dur, 30);
  near(T.findClip(next, r.id).start, 30);
  assert.equal(T.setSpeed(next, first, 1000).find((c) => c.id === first).speed, T.SPEED_MAX);
});

test('cutRange removes time on every track and closes the gap', () => {
  const clips = [
    { id: 'a', track: 'V1', start: 0, dur: 10, srcIn: 0, speed: 1 },
    { id: 'b', track: 'A2', start: 0, dur: 10, srcIn: 5, speed: 1 },
    { id: 'c', track: 'V1', start: 10, dur: 5, srcIn: 0, speed: 1 },
  ];
  const next = T.cutRange(clips, 4, 6);
  near(T.contentEnd(next), 13);
  const tail = next.find((c) => c.track === 'V1' && Math.abs(c.start - 4) < 1e-6);
  near(tail.srcIn, 6);
  near(next.find((c) => c.id === 'c').start, 8);
  near(T.contentEnd(T.cutRange(clips, 4, 6, ['A2'])), 15);
});

test('cutRanges takes ranges in original timeline time', () => {
  const clips = [{ id: 'a', track: 'V1', start: 0, dur: 20, srcIn: 0, speed: 1 }];
  const next = T.cutRanges(clips, [{ from: 2, to: 4 }, { from: 10, to: 15 }]).sort((x, y) => x.start - y.start);
  assert.deepEqual(next.map((c) => [c.start, c.dur, c.srcIn]), [[0, 2, 0], [2, 6, 4], [8, 5, 15]]);
});

test('sourceToTimeline maps source ranges through srcIn and speed', () => {
  const clips = [{ id: 'a', path: '/x', start: 10, dur: 5, srcIn: 20, speed: 2 }];
  assert.deepEqual(T.sourceToTimeline(clips, '/x', [{ from: 22, to: 26 }, { from: 0, to: 5 }]), [{ from: 11, to: 13 }]);
});

test('reserveIds keeps new ids clear of loaded ones', () => {
  T.reserveIds([{ id: 'c90000' }]);
  assert.equal(T.newId(), 'c90001');
});

test('applyOps builds an edit: clips in order, a time-lapse, a title and music', () => {
  const r = applyOps([], [
    { op: 'add', file: 'talk.mp4', in: 5, out: 15, as: 'intro' },
    { op: 'add', file: 'work', in: 0, out: 400, speed: 20, muted: true, as: 'lapse' },
    { op: 'add', file: 'talk.mp4', in: 50, out: 60, zoom: 1.2 },
    { op: 'title', text: 'Der Abfluss', over: 'lapse', dur: 3 },
    { op: 'add', file: 'music.wav', out: 40, volume: 0.2, track: 'A2', at: 0 },
  ], { media });
  assert.equal(r.ok, true, r.error);
  near(T.trackEnd(r.clips, 'V1'), 40);
  const lapse = T.findClip(r.clips, r.names.lapse);
  near(lapse.start, 10);
  near(lapse.dur, 20);
  assert.equal(lapse.muted, true);
  const title = r.clips.find((c) => c.kind === 'title');
  assert.equal(title.track, 'V2');
  near(title.start, 10);
  assert.equal(r.clips.find((c) => c.track === 'A2').volume, 0.2);
  assert.match(describeTimeline(r.clips), /5 clips, 0 min 40\.0 s/);
});

test('applyOps removeSilence cuts padded silences from talking clips only', () => {
  const r = applyOps([], [
    { op: 'add', file: 'talk.mp4', in: 0, out: 20 },
    { op: 'add', file: 'work.mp4', in: 0, out: 100, speed: 10, muted: true },
    { op: 'removeSilence', pad: 0.5 },
  ], { media, silences: { '/p/talk.mp4': [{ from: 4, to: 8 }, { from: 12, to: 12.5 }, { from: 90, to: 95 }], '/p/work.mp4': [{ from: 0, to: 100 }] } });
  assert.equal(r.ok, true, r.error);
  near(T.trackEnd(r.clips, 'V1'), 27); // 20 - 3 (4.5..7.5) + 10
  assert.equal(r.clips.filter((c) => c.name === 'work.mp4').length, 1);
});

test('applyOps reports the failing step and changes nothing', () => {
  const start = [{ id: 'c1', track: 'V1', start: 0, dur: 5, srcIn: 0, speed: 1, name: 'x' }];
  const r = applyOps(start, [{ op: 'split', at: 2 }, { op: 'add', file: 'missing.mp4' }], { media });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Step 2: .*missing\.mp4/);
  assert.equal(start.length, 1);
  assert.match(applyOps([], [{ op: 'removeSilence' }, { op: 'nope' }], { media }).error, /Unknown step "nope"/);
  assert.match(applyOps([], [{ op: 'add', file: 'talk.mp4' }, { op: 'removeSilence' }], { media }).error, /No silence analysis for: talk\.mp4/);
});

test('mergeRanges joins overlapping ranges', () => {
  assert.deepEqual(mergeRanges([{ from: 5, to: 7 }, { from: 0, to: 2 }, { from: 1, to: 3 }]), [{ from: 0, to: 3 }, { from: 5, to: 7 }]);
});
