import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as T from '../src/timeline.js';

const require = createRequire(import.meta.url);
const beatsDsp = require('../electron/beats.cjs');
const render = require('../electron/render.cjs');

// Synthesize a clean 120 BPM 4/4 drum pulse (strong kick on beat 1, lighter hits on beats 2-4)
function makeClickTrackPcm({ bpm = 120, durationSec = 12, sampleRate = 8000 } = {}) {
  const total = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(total * 2);
  const beatSamples = (60 / bpm) * sampleRate;
  for (let b = 0; b * beatSamples < total; b++) {
    const start = Math.round(b * beatSamples);
    const isDownbeat = b % 4 === 0;
    const amp = isDownbeat ? 0.95 : 0.55;
    const freq = isDownbeat ? 70 : 140;
    const len = Math.min(Math.round(sampleRate * 0.08), total - start);
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (sampleRate * 0.025));
      const s = Math.sin(2 * Math.PI * freq * (i / sampleRate)) * env * amp;
      const clamped = Math.max(-1, Math.min(1, s));
      buf.writeInt16LE(Math.round(clamped * 32767), (start + i) * 2);
    }
  }
  return buf;
}

test('analyzeBeatsFromPcm detects 120 BPM and downbeat markers from rhythmic PCM', () => {
  const pcm = makeClickTrackPcm({ bpm: 120, durationSec: 12 });
  const res = beatsDsp.analyzeBeatsFromPcm(pcm, { sampleRate: 8000, beatsPerBar: 4 });
  assert.ok(Math.abs(res.bpm - 120) <= 2.5, `expected ~120 BPM, got ${res.bpm}`);
  assert.ok(res.markers.length >= 20, `expected >= 20 beat markers, got ${res.markers.length}`);
  assert.ok(res.markers.some((m) => m.kind === 'downbeat'));
  assert.ok(res.markers.some((m) => m.kind === 'beat'));
});

test('beat grid generation, editable markers, and snap-to-beat work together', () => {
  let b = T.setBeatGrid(T.defaultBeats(), { enabled: true, snap: true, bpm: 120, offset: 0, beatsPerBar: 4, subdivisions: 2 });
  const grid = T.generateBeatGrid(b, 4);
  const downbeats = grid.filter((g) => g.kind === 'downbeat').map((g) => g.time);
  assert.deepEqual(downbeats, [0, 2, 4]);
  const subs = grid.filter((g) => g.kind === 'sub');
  assert.ok(subs.length >= 8);

  b = T.addBeatMarker(b, 1.37, 'custom', 'Hit');
  assert.equal(b.markers.length, 1);
  const mid = b.markers[0].id;
  b = T.moveBeatMarker(b, mid, 1.42);
  assert.equal(b.markers[0].time, 1.42);

  const snapPts = T.allBeatSnapPoints(b, 4);
  assert.equal(T.snapTime([], 1.44, true, 0.05, snapPts), 1.42);
  assert.equal(T.snapTime([], 2.02, true, 0.05, snapPts), 2);

  b = T.removeBeatMarker(b, mid);
  assert.equal(b.markers.length, 0);
});

test('audio fade handles and volume keyframes evaluate accurately with volumeAt', () => {
  let clips = [{ id: 'a1', kind: 'audio', track: 'A1', start: 10, dur: 10, volume: 1, muted: false }];
  clips = T.setClipFade(clips, 'a1', 'in', 2);
  clips = T.setClipFade(clips, 'a1', 'out', 2);
  assert.equal(clips[0].fadeIn, 2);
  assert.equal(clips[0].fadeOut, 2);

  // Mid fade-in (localT = 1s of 2s fade) -> 0.5
  assert.ok(Math.abs(T.volumeAt(clips[0], 11) - 0.5) < 1e-4);
  // Full body -> 1.0
  assert.ok(Math.abs(T.volumeAt(clips[0], 15) - 1.0) < 1e-4);
  // Mid fade-out (localT = 9s, 1s left of 2s fade) -> 0.5
  assert.ok(Math.abs(T.volumeAt(clips[0], 19) - 0.5) < 1e-4);

  // Volume keyframes: ramp from 0.5 at +2s to 1.5 at +6s
  clips = T.upsertVolumeKeyframe(clips, 'a1', 2, 0.5);
  clips = T.upsertVolumeKeyframe(clips, 'a1', 6, 1.5);
  assert.equal(clips[0].volumeKeyframes.length, 2);
  assert.ok(Math.abs(T.volumeAt(clips[0], 14) - 1.0) < 1e-4); // midpoint +4s -> 1.0

  // Fade-in multiplies keyframed base (at +1s, base=0.5, fade=0.5 -> 0.25)
  assert.ok(Math.abs(T.volumeAt(clips[0], 11) - 0.25) < 1e-4);

  const kfId = clips[0].volumeKeyframes[0].id;
  clips = T.removeVolumeKeyframe(clips, 'a1', kfId);
  assert.equal(clips[0].volumeKeyframes.length, 1);
  clips = T.clearVolumeKeyframes(clips, 'a1');
  assert.equal(clips[0].volumeKeyframes.length, 0);
});

test('buildRenderArgs exports audio fades and piecewise-linear volume keyframes', () => {
  const plan = render.buildRenderArgs({
    clips: [
      {
        id: 'a1', kind: 'audio', track: 'A1', path: '/tmp/music.mp3',
        start: 0, dur: 10, srcIn: 0, speed: 1, volume: 1, muted: false,
        fadeIn: 1.5, fadeOut: 2,
        volumeKeyframes: [
          { id: 'k1', t: 2, value: 0.4 },
          { id: 'k2', t: 6, value: 1.4 },
        ],
      },
    ],
    output: '/tmp/out.mp4',
  });
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /volume='if\(lt\(t,2\),0\.4,if\(lt\(t,6\),0\.4\+\(1\)\*\(t-2\)\/4,1\.4\)\)':eval=frame/);
  assert.match(graph, /afade=t=in:st=0:d=1\.5/);
  assert.match(graph, /afade=t=out:st=8:d=2/);
});
