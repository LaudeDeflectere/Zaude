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

  // Verify render.cjs injects roomPreset into the FFmpeg audio filter graph
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

  // Real FFmpeg Opus .ogg continuous room-tone bed generation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-roomtone-'));
  const outOgg = path.join(tmpDir, 'dim_bar_bed.ogg');
  const gen = await ra.generateRoomToneBed({ presetId: 'dim-bar', durationSec: 2.5, outPath: outOgg });
  assert.equal(gen.ok, true);
  assert.ok(fs.existsSync(outOgg));
  assert.ok(fs.statSync(outOgg).size > 1000);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
