import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ls = require('../electron/lipsync.cjs');

test('lipsync detects LatentSync 1.6 / MuseTalk, defaults to 25 FPS, and wires selective crop-and-stitch', () => {
  // Prioritizes LatentSync 1.6 over generic LatentSyncNode & reports InpaintCropImproved availability
  assert.deepEqual(
    ls.detectLipSyncEngine({
      LatentSyncNode: {},
      LatentSync1_6Node: {},
      InpaintCropImproved: {},
      InpaintStitchImproved: {},
    }),
    {
      ok: true,
      engine: 'latentsync-1.6',
      nodeClass: 'LatentSync1_6Node',
      hasCropAndStitch: true,
    },
  );
  assert.deepEqual(ls.detectLipSyncEngine({ MuseTalkKJNode: {} }), {
    ok: true,
    engine: 'musetalk',
    nodeClass: 'MuseTalkKJNode',
    hasCropAndStitch: false,
  });
  assert.equal(ls.detectLipSyncEngine({ KSampler: {} }).ok, false);

  assert.equal(ls.computeLoopRepeats(5, 4), 1);
  assert.equal(ls.computeLoopRepeats(5, 12), 3);

  // Default graph uses 25 FPS (LatentSync 1.6 native rate)
  const g = ls.buildLatentSyncGraph({
    videoName: 'plate.mp4',
    audioName: 'line.wav',
    seed: 1234,
    lipsExp: 1.6,
    inferenceSteps: 20,
  });
  assert.equal(g['1'].class_type, 'VHS_LoadVideo');
  assert.equal(g['1'].inputs.force_rate, 25);
  assert.equal(g['4'].inputs.frame_rate, 25);
  assert.equal(g['3'].class_type, 'LatentSyncNode');
  assert.equal(g['13'], undefined);

  // Selective 2-person face crop-and-stitch wraps LatentSync with InpaintCropImproved (512x512) + InpaintStitchImproved
  const gCrop = ls.buildLatentSyncGraph({
    videoName: 'two_shot.mp4',
    audioName: 'elias_line.wav',
    nodeClass: 'LatentSync1_6Node',
    speakerBbox: { x: 0.1, y: 0.15, width: 0.3, height: 0.45 },
    useCropAndStitch: true,
    videoWidth: 1120,
    videoHeight: 640,
  });
  assert.equal(gCrop['13'].class_type, 'InpaintCropImproved');
  assert.equal(gCrop['13'].inputs.output_target_width, 512);
  assert.equal(gCrop['13'].inputs.output_target_height, 512);
  assert.deepEqual(gCrop['3'].inputs.images, ['13', 1]);
  assert.equal(gCrop['14'].class_type, 'InpaintStitchImproved');
  assert.deepEqual(gCrop['14'].inputs.stitcher, ['13', 0]);
  assert.deepEqual(gCrop['14'].inputs.inpainted_image, ['3', 0]);
  assert.deepEqual(gCrop['4'].inputs.images, ['14', 0]);
});
