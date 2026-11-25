import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ra = require('../electron/room-acoustics.cjs');
const render = require('../electron/render.cjs');

test('roomAcoustics builds FFmpeg filters, wires into render.cjs, and generates a real Opus .ogg bed', async () => {
  const presets = ra.listRoomPresets();
  assert.ok(presets.length >= 6);
  assert.equal(ra.buildRoomFilter('none', 1.0), '');

  const barFx = ra.buildRoomFilter('dim-bar', 0.8);
  assert.match(barFx, /highpass=f=85/);
  assert.match(barFx, /aecho=0\.85:0\.78:18\|37:/);

  const streetFx = ra.buildRoomFilter('outdoor-street', 1.0);
  assert.match(streetFx, /highpass=f=115/);
  assert.doesNotMatch(streetFx, /aecho/);

  // Verify render.cjs falls back to aecho when no IR .wav exists on disk
  const built = render.buildRenderArgs({
    clips: [{
      id: 'v1-001',
      track: 'V1',
      kind: 'video',
      path: '/tmp/clip.mp4',
      hasAudio: true,
      start: 0,
      dur: 5,
      srcDur: 5,
      srcIn: 0,
      volume: 1,
      roomPreset: 'dim-bar',
      roomIntensity: 0.9,
    }],
    output: '/tmp/out.mp4',
  });
  const fcIdx = built.args.indexOf('-filter_complex');
  assert.ok(fcIdx > 0);
  assert.match(built.args[fcIdx + 1], /aecho=0\.85:0\.78:18\|37:/);

  // Verify real afir convolution reverb graph + render.cjs IR wiring when IR .wav exists
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-roomtone-'));
  const fakeIr = path.join(tmpDir, 'dim-bar.wav');
  fs.writeFileSync(fakeIr, 'RIFF');
  assert.equal(ra.resolveIrPath('dim-bar', tmpDir), fakeIr);
  assert.equal(ra.resolveIrPath('hallway', tmpDir), null);

  const afirGraph = ra.buildRoomFilterComplex({
    presetId: 'dim-bar',
    intensity: 0.85,
    irPath: fakeIr,
    inputLabel: '[0:a]',
    irInputLabel: '[1:a]',
    outputLabel: '[aout]',
  });
  assert.match(afirGraph, /aresample=48000/);
  assert.match(afirGraph, /apad=pad_dur=2/);
  assert.match(afirGraph, /afir=dry=0:wet=1:irnorm=1:irgain=0\.8/);
  assert.doesNotMatch(afirGraph, /gtype=/);
  assert.match(afirGraph, /amix=inputs=2:duration=longest:normalize=0/);

  const builtIr = render.buildRenderArgs({
    clips: [{
      id: 'v1-001',
      track: 'V1',
      kind: 'video',
      path: '/tmp/clip.mp4',
      hasAudio: true,
      start: 0,
      dur: 5,
      srcDur: 5,
      srcIn: 0,
      volume: 1,
      roomPreset: 'dim-bar',
      roomIntensity: 0.9,
      roomIrPath: fakeIr,
    }],
    output: '/tmp/out.mp4',
  });
  assert.ok(builtIr.args.includes(fakeIr));
  const fcIrIdx = builtIr.args.indexOf('-filter_complex');
  assert.match(builtIr.args[fcIrIdx + 1], /afir=dry=0:wet=1:irnorm=1:irgain=0\.8/);
  assert.match(builtIr.args[fcIrIdx + 1], /normalize=0/);

  // Real FFmpeg Opus .ogg continuous room-tone bed generation
  const outOgg = path.join(tmpDir, 'dim_bar_bed.ogg');
  const gen = await ra.generateRoomToneBed({ presetId: 'dim-bar', durationSec: 2.5, outPath: outOgg });
  assert.equal(gen.ok, true);
  assert.ok(fs.existsSync(outOgg));
  assert.ok(fs.statSync(outOgg).size > 1000);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
