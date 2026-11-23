import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as T from '../src/timeline.js';

const require = createRequire(import.meta.url);
const mannimmate = require('../electron/mannimmate.cjs');

test('mannimmate.buildCommand routes text-render, refmod, auto, and coverage with dry-run', () => {
  const t2v = mannimmate.buildCommand({
    mode: 'text-render',
    prompt: 'A neon dancer in rain',
    seconds: 5,
    quality: '480',
    preset: 'draft',
    aspect: '9:16',
    model: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    steps: 4,
    dryRun: true,
  }, { promptFile: '/tmp/p.txt', outDir: '/tmp/out' });
  assert.equal(t2v.ok, true);
  assert.equal(t2v.args[0], 'text-render');
  assert.ok(t2v.args.includes('--aspect') && t2v.args.includes('9:16'));
  assert.ok(t2v.args.includes('--dry-run'));
  assert.ok(t2v.promptContent.includes('A neon dancer in rain'));

  const rm = mannimmate.buildCommand({
    mode: 'refmod',
    refmod: 'elias_varga',
    refmodName: 'Elias Varga',
    identityStrength: 0.9,
    voiceStrength: 0.8,
    refmod2: 'nadia_krasavica',
    refmod2Name: 'Nadia Krasavica',
    prompt: 'Elias walks into the studio',
    seconds: 7,
    quality: '640',
    fps: 24,
    steps: 6,
    model: 'H3\\Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors',
    dryRun: true,
  }, { outDir: '/tmp/out' });
  assert.equal(rm.ok, true);
  assert.equal(rm.args[0], 'refmod');
  assert.ok(rm.args.includes('elias_varga|Elias Varga|0.9|0.8'));
  assert.ok(rm.args.includes('nadia_krasavica|Nadia Krasavica|1|1'));
  assert.ok(rm.args.includes('--save-latent'));

  const auto = mannimmate.buildCommand({
    mode: 'auto',
    video: '/tmp/src.mp4',
    ref: '/tmp/ref.png',
    start: 1,
    end: 6,
    backgroundMode: 'sheet',
  });
  assert.equal(auto.ok, true);
  assert.equal(auto.args[0], 'auto');
  assert.ok(auto.args.includes('--background-mode') && auto.args.includes('sheet'));

  const cov = mannimmate.buildCommand({
    mode: 'coverage',
    image: '/tmp/scene.png',
    coverageTarget: 'Keep lighting',
  });
  assert.equal(cov.ok, true);
  assert.equal(cov.args[0], 'coverage');
  assert.ok(cov.args.includes('--coverage-target'));

  assert.equal(mannimmate.buildCommand({ mode: 'refmod', prompt: 'hi' }).ok, false);
});

test('dynamic tracks add V3/A3 and moveClipToTrack moves videos across rows cleanly', () => {
  let tracks = T.defaultTracks();
  tracks = T.addTrack(tracks, 'video');
  tracks = T.addTrack(tracks, 'audio');
  assert.deepEqual(tracks.map((t) => t.id), ['V3', 'V2', 'V1', 'A1', 'A2', 'A3']);

  const clips = [
    { id: 'v1', track: 'V1', kind: 'video', start: 0, dur: 5 },
    { id: 'v2', track: 'V2', kind: 'video', start: 10, dur: 5 },
    { id: 'a1', track: 'A1', kind: 'audio', start: 0, dur: 5 },
  ];

  // Move video clip v1 from V1 to V2 at t=2 (free space)
  const moved = T.moveClipToTrack(clips, 'v1', 'V2', 2);
  assert.ok(moved);
  assert.equal(T.findClip(moved, 'v1').track, 'V2');
  assert.equal(T.findClip(moved, 'v1').start, 2);

  // Blocked by v2 at t=11
  assert.equal(T.moveClipToTrack(clips, 'v1', 'V2', 11), null);

  // Incompatible track (video -> A1, audio -> V2)
  assert.equal(T.moveClipToTrack(clips, 'v1', 'A1', 0), null);
  assert.equal(T.moveClipToTrack(clips, 'a1', 'V2', 0), null);

  // Higher video track V3 wins clipAt priority over V2 and V1
  const stacked = [
    { id: 'a', track: 'V1', kind: 'video', start: 0, dur: 5 },
    { id: 'b', track: 'V3', kind: 'video', start: 0, dur: 5 },
    { id: 'c', track: 'V2', kind: 'video', start: 0, dur: 5 },
  ];
  assert.equal(T.clipAt(stacked, 2).id, 'b');
});
