import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mr = require('../electron/modal-runner.cjs');

test('modalRunner picks optimal Modal GPU and final-pass settings per shot complexity', () => {
  assert.ok(fs.existsSync(mr.DEFAULT_MODAL_SCRIPT));

  // Fast RealESRGAN upscale -> L40S
  const upPlan = mr.recommendModalPlan({ mode: 'upscale-esrgan', resolution: 720, seconds: 5 });
  assert.equal(upPlan.ok, true);
  assert.equal(upPlan.gpu, 'L40S');
  assert.ok(upPlan.estCostUsd > 0 && upPlan.estCostUsd < 0.05);

  // Heavy 720p 7s multi-RefMod hero shot -> H100
  const heroPlan = mr.recommendModalPlan({
    mode: 'refmod',
    resolution: 720,
    seconds: 7,
    refmods: [{ file: 'a' }, { file: 'b' }, { file: 'c' }],
  });
  assert.equal(heroPlan.gpu, 'H100');
  assert.equal(heroPlan.resolution, 720);

  // Standard 4s 480p shot -> L40S
  const stdPlan = mr.recommendModalPlan({ mode: 'text-render', resolution: 480, seconds: 4 });
  assert.equal(stdPlan.gpu, 'L40S');
  assert.equal(stdPlan.resolution, 640);

  // 7s 640p FL2V bridge -> A100-80GB
  const fl2vPlan = mr.recommendModalPlan({
    mode: 'refmod',
    resolution: 640,
    seconds: 7,
    firstFrame: 'a.png',
    lastFrame: 'b.png',
  });
  assert.equal(fl2vPlan.gpu, 'A100-80GB');
  assert.equal(fl2vPlan.resolution, 720);
});
