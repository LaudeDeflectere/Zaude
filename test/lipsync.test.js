import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ls = require('../electron/lipsync.cjs');

test('lipsync detects LatentSync/MuseTalk nodes, computes loop repeats, and builds ComfyUI graph', () => {
  assert.deepEqual(ls.detectLipSyncEngine({ LatentSyncNode: {} }), {
    ok: true,
    engine: 'latentsync',
    nodeClass: 'LatentSyncNode',
  });
  assert.deepEqual(ls.detectLipSyncEngine({ MuseTalkRun: {} }), {
    ok: true,
    engine: 'musetalk',
    nodeClass: 'MuseTalkRun',
  });
  assert.equal(ls.detectLipSyncEngine({ KSampler: {} }).ok, false);

  assert.equal(ls.computeLoopRepeats(5, 4), 1);
  assert.equal(ls.computeLoopRepeats(5, 12), 3);

  const g = ls.buildLatentSyncGraph({
    videoName: 'plate.mp4',
    audioName: 'line.wav',
    seed: 1234,
    lipsExp: 1.6,
    inferenceSteps: 20,
  });
  assert.equal(g['1'].class_type, 'VHS_LoadVideo');
  assert.equal(g['1'].inputs.video, 'plate.mp4');
  assert.equal(g['2'].class_type, 'LoadAudio');
  assert.equal(g['2'].inputs.audio, 'line.wav');
  assert.equal(g['3'].class_type, 'LatentSyncNode');
  assert.equal(g['3'].inputs.seed, 1234);
  assert.equal(g['4'].class_type, 'VHS_VideoCombine');
});
