import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as T from '../src/timeline.js';

const require = createRequire(import.meta.url);
const mannimmate = require('../electron/mannimmate.cjs');

test('adjustStart restores trimmed leading seconds back to srcIn=0 and clamps to prev clip', () => {
  const clips = [
    { id: 'c1', kind: 'video', track: 'V1', start: 0, dur: 2, srcIn: 0, srcDur: 5, speed: 1, name: 'A' },
    // c2 had its first 3s removed (srcIn=3), starts at t=6, dur=5 (srcDur=10)
    { id: 'c2', kind: 'video', track: 'V1', start: 6, dur: 5, srcIn: 3, srcDur: 10, speed: 1, name: 'B' },
  ];

  // Drag left edge left by 3 seconds -> restores all 3 trimmed seconds!
  const restored = T.adjustStart(clips, 'c2', -3);
  const c2 = T.findClip(restored, 'c2');
  assert.equal(c2.start, 3);
  assert.equal(c2.srcIn, 0);
  assert.equal(c2.dur, 8);

  // Dragging even further left clamps at srcIn=0 (doesn't go negative)
  const clamped = T.adjustStart(restored, 'c2', -2);
  assert.equal(T.findClip(clamped, 'c2').srcIn, 0);
  assert.equal(T.findClip(clamped, 'c2').start, 3);

  // Dragging right trims inward and increases srcIn
  const trimmed = T.adjustStart(restored, 'c2', 1.5);
  assert.equal(T.findClip(trimmed, 'c2').start, 4.5);
  assert.equal(T.findClip(trimmed, 'c2').srcIn, 1.5);
  assert.equal(T.findClip(trimmed, 'c2').dur, 6.5);
});

test('floating clip drag (canPlaceClip / placeClips) flies over blocking clips and rejects occupied drops', () => {
  const clips = [
    { id: 'c1', kind: 'video', track: 'V1', start: 0, dur: 3, srcIn: 0, srcDur: 3, speed: 1, name: 'A' },
    { id: 'c2', kind: 'video', track: 'V1', start: 3, dur: 4, srcIn: 0, srcDur: 4, speed: 1, name: 'B' },
    { id: 'c3', kind: 'video', track: 'V1', start: 7, dur: 3, srcIn: 0, srcDur: 3, speed: 1, name: 'C' },
  ];

  // Flying c1 over c2 & c3 to drop at t=10 succeeds!
  assert.equal(T.canPlaceClip(clips, 'c1', 'V1', 10), true);
  const moved = T.moveClipToTrack(clips, 'c1', 'V1', 10);
  assert.equal(T.findClip(moved, 'c1').start, 10);

  // Hovering c1 on top of c2 (t=4) is blocked
  assert.equal(T.canPlaceClip(clips, 'c1', 'V1', 4), false);

  // Multi-clip floating placeClips: flying [c1] over c2/c3 to t=10 works, dropping on c2 returns null
  assert.equal(T.placeClips(clips, ['c1'], 4), null);
  const placed = T.placeClips(clips, ['c1'], 10);
  assert.equal(T.findClip(placed, 'c1').start, 10);
});

test('Stylize (auto) supports RefMod + Background Change + per-RefMod clothes override', () => {
  // 1. Background Change with RefMod + clothes override + text background
  const bgCmd = mannimmate.buildCommand({
    mode: 'auto',
    stylizeAction: 'background',
    video: '/tmp/clip.mp4',
    start: 0,
    end: 4,
    objectPrompt: 'rainy neon cyberpunk alley at midnight',
    refmods: [{ file: 'karlsten_malco', name: 'Karlsten', outfit: 'dark tailored navy suit and white shirt' }],
  });
  assert.equal(bgCmd.ok, true);
  assert.ok(bgCmd.args.includes('--refmod'));
  assert.ok(bgCmd.args.includes('--background-text'));
  assert.match(bgCmd.promptContent, /NOT in default outfit, instead wearing: dark tailored navy suit and white shirt/);

  // 2. RefMod generation with per-RefMod clothes override injects wardrobe negation
  const rmCmd = mannimmate.buildCommand({
    mode: 'refmod',
    prompt: 'Karlsten walks into the cafe and orders espresso.',
    seconds: 5,
    refmods: [{ file: 'karlsten_malco', name: 'Karlsten', outfit: 'red flannel shirt and denim jacket' }],
  });
  assert.equal(rmCmd.ok, true);
  const promptIdx = rmCmd.args.indexOf('--prompt');
  assert.ok(promptIdx >= 0);
  assert.match(rmCmd.args[promptIdx + 1], /NOT in default outfit, instead wearing: red flannel shirt and denim jacket/);
});
