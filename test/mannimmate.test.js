import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as T from '../src/timeline.js';

const require = createRequire(import.meta.url);
const mannimmate = require('../electron/mannimmate.cjs');
const refmods = require('../electron/refmods.cjs');

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
    refmods: [
      { file: 'elias_varga', name: 'Elias Varga', identityStrength: 0.9, voiceStrength: 0.8 },
      { file: 'nadia_krasavica', name: 'Nadia Krasavica', identityStrength: 1, voiceStrength: 1 },
      { file: 'tony_sheen', name: 'Tony Sheen', identityStrength: 0.95, voiceStrength: 0.9 },
    ],
    prompt: 'Elias, Nadia, and Tony walk into the studio',
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
  assert.ok(rm.args.includes('tony_sheen|Tony Sheen|0.95|0.9'));
  assert.ok(rm.args.includes('--save-latent'));

  const auto = mannimmate.buildCommand({
    mode: 'auto',
    video: '/tmp/src.mp4',
    refmods: [{ file: 'elias_cbphoto_v1_visual', name: 'Elias' }],
    stylizeAction: 'both',
    objectPrompt: 'A fluffy orange tabby cat walking across the floor',
    start: 2,
    end: 7,
  }, { promptFile: '/tmp/stylize.txt' });
  assert.equal(auto.ok, true);
  assert.equal(auto.args[0], 'render');
  assert.ok(auto.args.includes('--refmod') && auto.args.includes('elias_cbphoto_v1_visual|Elias|1.0|0.0'));
  assert.ok(auto.args.includes('--prompt-file') && auto.args.includes('/tmp/stylize.txt'));
  assert.ok(auto.promptContent.includes('Replace the original performer completely'));
  assert.ok(auto.promptContent.includes('fluffy orange tabby cat'));

  const objOnly = mannimmate.buildCommand({
    mode: 'auto',
    video: '/tmp/src.mp4',
    stylizeAction: 'object',
    objectPrompt: 'A glowing neon hoverboard floating in the background',
    start: 1,
    end: 5,
  }, { promptFile: '/tmp/obj.txt' });
  assert.equal(objOnly.ok, true);
  assert.equal(objOnly.args[0], 'render');
  assert.ok(!objOnly.args.includes('--refmod'));
  assert.ok(objOnly.promptContent.includes('neon hoverboard'));

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

test('refmods library extracts first name only, falls back to Subject N, and creates per-refmod folders', () => {
  assert.equal(refmods.displayFirstName('Elias Varga', 1), 'Elias');
  assert.equal(refmods.displayFirstName('nadia_krasavica', 2), 'Nadia');
  assert.equal(refmods.displayFirstName('', 3), 'Subject 3');
  assert.equal(refmods.displayFirstName('   ', 4), 'Subject 4');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-refmods-'));
  try {
    const synced = refmods.syncRefMods(tmp, [
      { file: 'elias_varga', name: 'Elias Varga' },
      { file: 'unnamed_02', name: '' },
    ]);
    assert.equal(synced.length, 2);
    assert.equal(synced[0].firstName, 'Elias');
    assert.equal(synced[1].firstName, 'Subject 2');
    assert.ok(fs.existsSync(path.join(tmp, 'elias_varga', 'meta.json')));

    const created = refmods.createRefModFolder(tmp, { name: '', file: '' });
    assert.equal(created.firstName, 'Subject 3');
    assert.ok(fs.existsSync(path.join(created.dir, 'meta.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('estimateJobSeconds scales with quality, steps, length, and dryRun', () => {
  assert.equal(mannimmate.estimateJobSeconds({ dryRun: true }), 5);
  const prod = mannimmate.estimateJobSeconds({ quality: '640', steps: 6, seconds: 7 });
  const draft = mannimmate.estimateJobSeconds({ quality: '480', steps: 4, seconds: 4 });
  assert.ok(prod > draft && prod >= 300);
});

test('parseComfyBinaryPreview decodes ComfyUI JPEG (type 1) and metadata PNG (type 4) preview frames', () => {
  const comfyLive = require('../electron/comfy-live.cjs');

  // Event type 1 = PREVIEW_IMAGE, format 1 = JPEG
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const frame1 = Buffer.alloc(8 + jpgBytes.length);
  frame1.writeUInt32BE(1, 0);
  frame1.writeUInt32BE(1, 4);
  jpgBytes.copy(frame1, 8);
  const p1 = comfyLive.parseComfyBinaryPreview(frame1);
  assert.ok(p1);
  assert.equal(p1.ext, 'jpg');
  assert.deepEqual(p1.data, jpgBytes);

  // Event type 4 = PREVIEW_IMAGE_WITH_METADATA + PNG magic bytes
  const meta = Buffer.from(JSON.stringify({ node: '14' }));
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const frame4 = Buffer.alloc(8 + meta.length + pngBytes.length);
  frame4.writeUInt32BE(4, 0);
  frame4.writeUInt32BE(meta.length, 4);
  meta.copy(frame4, 8);
  pngBytes.copy(frame4, 8 + meta.length);
  const p4 = comfyLive.parseComfyBinaryPreview(frame4);
  assert.ok(p4);
  assert.equal(p4.ext, 'png');
  assert.deepEqual(p4.data, pngBytes);
});

test('frameToFrame.buildFl2vGraph wires first_frame, last_frame, 17k+5 frames, and optional RefMods', () => {
  const fl2v = require('../electron/frame-to-frame.cjs');
  assert.equal(fl2v.snapH3Frames(4, 24), 90);
  assert.equal(fl2v.snapH3Frames(5, 24), 124);

  const g = fl2v.buildFl2vGraph({
    prompt: 'Smooth transition between shot A and shot B',
    firstFrameName: 'first.png',
    lastFrameName: 'last.png',
    width: 864,
    height: 480,
    frames: 90,
    steps: 8,
    refmods: [{ file: 'elias_varga', name: 'Elias' }],
  });
  assert.equal(g['5'].class_type, 'MiniMaxH3ImageToVideo');
  assert.deepEqual(g['5'].inputs.first_frame, ['21', 0]);
  assert.deepEqual(g['5'].inputs.last_frame, ['23', 0]);
  assert.equal(g['20'].inputs.image, 'first.png');
  assert.equal(g['22'].inputs.image, 'last.png');
  assert.equal(g['30'].class_type, 'MiniMaxH3RefModsLoader');
  assert.deepEqual(g['8'].inputs.conditioning, ['31', 0]);
});

test('mannimmate.buildCommand supports FrameContinue with saved latent or seedVideo', () => {
  const withLatent = mannimmate.buildCommand({
    mode: 'refmod',
    refmodMode: 'continue',
    latent: 'Mannimmaterefmod_abc123.h3latent.safetensors',
    prompt: 'The camera pulls back as everyone cheers',
    seconds: 5,
    steps: 7,
  });
  assert.equal(withLatent.ok, true);
  assert.ok(withLatent.args.includes('--mode') && withLatent.args.includes('continue'));
  assert.ok(withLatent.args.includes('--latent') && withLatent.args.includes('Mannimmaterefmod_abc123.h3latent.safetensors'));

  const withSeed = mannimmate.buildCommand({
    mode: 'refmod',
    refmodMode: 'continue',
    seedVideo: '/tmp/clip1.mp4',
    prompt: 'Continue the dance smoothly',
    seconds: 5,
    steps: 7,
  });
  assert.equal(withSeed.ok, true);
  assert.ok(withSeed.args.includes('--seed-video') && withSeed.args.includes('/tmp/clip1.mp4'));
});

test('latents.formatLatentLabel builds character initials + short scene summary and refmods skips pack prefixes', () => {
  const latents = require('../electron/latents.cjs');
  const label = latents.formatLatentLabel({
    refmods: [{ name: 'Elias Varga' }, { name: 'Nadia Krasavica' }],
    prompt: 'Medium shot of Elias and Nadia laughing around the game night sofa with pizza',
  });
  assert.equal(label, 'E+N · Elias Nadia laughing around game');
  assert.equal(refmods.displayFirstName('Cb Alexander Visual', 1), 'Alexander');
  assert.equal(refmods.displayFirstName('Changebang Michael 2d V1 Visual', 2), 'Michael');
});
