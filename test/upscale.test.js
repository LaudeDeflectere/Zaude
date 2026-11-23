import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const up = require('../electron/upscale.cjs');

test('upscale module recovers RefMods + prompt from clip sidecar and builds RealESRGAN 2x graph', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-upscale-'));
  const vid = path.join(tmp, 'shot_generate.mp4');
  const sidecar = path.join(tmp, 'shot_generate.json');
  fs.writeFileSync(vid, 'fake');
  fs.writeFileSync(sidecar, JSON.stringify({
    seconds: 5,
    characters: [{ mod: 'mannimmate_2d_v1\\tony_sheen_2d_v1', name: 'Tony' }],
    prompt: 'subject_definitions:\n<Subject 1> is Tony.\n\nTony runs down a stone alley at dusk.',
  }));

  const meta = up.readClipMeta(vid);
  assert.equal(meta.refmods.length, 1);
  assert.equal(meta.refmods[0].file, 'mannimmate_2d_v1\\tony_sheen_2d_v1');
  assert.equal(meta.duration, 5);
  assert.match(meta.prompt, /stone alley/);

  const refPrompt = up.buildRefinePrompt(meta);
  assert.match(refPrompt, /facial details/i);
  assert.match(refPrompt, /stone alley/);

  const graph = up.buildEsrganGraph({ videoName: 'clip.mp4' });
  assert.equal(graph['1'].class_type, 'LoadVideo');
  assert.equal(graph['3'].class_type, 'UpscaleModelLoader');
  assert.equal(graph['4'].class_type, 'ImageUpscaleWithModel');
  assert.deepEqual(graph['5'].inputs.audio, ['2', 1]);
  assert.equal(graph['6'].class_type, 'SaveVideo');

  fs.rmSync(tmp, { recursive: true, force: true });
});
