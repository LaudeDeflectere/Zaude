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
  assert.equal(graph['6'].inputs.codec, 'h264');

  // SPAN preferred over RealESRGAN when available, with automatic fallback when missing
  assert.equal(
    up.pickFastUpscaleModel(['RealESRGAN_x2plus.pth', '2x-NomosUni_span_multijpg.pth']),
    '2x-NomosUni_span_multijpg.pth',
  );
  assert.equal(
    up.pickFastUpscaleModel(['RealESRGAN_x2plus.pth']),
    'RealESRGAN_x2plus.pth',
  );

  // SeedVR2 4n+1 (>= 5) batch size enforcement
  assert.equal(up.normalizeSeedVR2BatchSize(1), 5);
  assert.equal(up.normalizeSeedVR2BatchSize(5), 5);
  assert.equal(up.normalizeSeedVR2BatchSize(8), 9);
  assert.equal(up.normalizeSeedVR2BatchSize(9), 9);
  assert.equal(up.normalizeSeedVR2BatchSize(12), 13);

  // Capability detection handles both missing and present SeedVR2 nodes
  const capsMissing = up.detectUpscaleCapabilities({
    UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { options: ['RealESRGAN_x2plus.pth'] }] } } },
  });
  assert.equal(capsMissing.hasSeedVR2, false);
  assert.equal(capsMissing.fastModel, 'RealESRGAN_x2plus.pth');

  const capsReady = up.detectUpscaleCapabilities({
    UpscaleModelLoader: { input: { required: { model_name: [['2x-NomosUni_span_multijpg.pth', 'RealESRGAN_x2plus.pth']] } } },
    SeedVR2LoadDiTModel: {},
    SeedVR2LoadVAEModel: {},
    SeedVR2VideoUpscaler: {},
  });
  assert.equal(capsReady.hasSpan, true);
  assert.equal(capsReady.hasSeedVR2, true);

  // SeedVR2 graph structure & audio preservation
  const svr = up.buildSeedVR2Graph({ videoName: 'clip.mp4', batchSize: 10, temporalOverlap: 2, resolution: 1080 });
  assert.equal(svr['3'].class_type, 'SeedVR2LoadDiTModel');
  assert.equal(svr['3'].inputs.attention_mode, 'sageattn_2');
  assert.equal(svr['4'].class_type, 'SeedVR2LoadVAEModel');
  assert.equal(svr['4'].inputs.encode_tiled, true);
  assert.equal(svr['5'].class_type, 'SeedVR2VideoUpscaler');
  assert.equal(svr['5'].inputs.batch_size, 9);
  assert.equal(svr['5'].inputs.temporal_overlap, 2);
  assert.deepEqual(svr['6'].inputs.audio, ['2', 1]);
  assert.equal(svr['7'].class_type, 'SaveVideo');

  fs.rmSync(tmp, { recursive: true, force: true });
});
