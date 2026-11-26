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

  // 3-tier per-generation cost estimation scales fast < balanced < ultra
  const cFast = mr.estimateModalCost({ tier: 'fast' });
  const cBal = mr.estimateModalCost({ tier: 'balanced' });
  const cUltra = mr.estimateModalCost({ tier: 'ultra' });
  assert.equal(cFast.gpu, 'L40S');
  assert.equal(cBal.gpu, 'H100');
  assert.equal(cUltra.gpu, 'H200');
  assert.ok(cFast.estCostUsd < cBal.estCostUsd);
  assert.ok(cBal.estCostUsd < cUltra.estCostUsd);

  // Tier endpoint derivation maps cleanly between fast / balanced / ultra / web
  assert.equal(
    mr.deriveTierEndpoint('https://trankilena--zaude-comfy-comfy-web.us-east.modal.run', 'ultra'),
    'https://trankilena--zaude-comfy-comfy-ultra.us-east.modal.run',
  );
  assert.equal(
    mr.deriveTierEndpoint('https://trankilena--zaude-comfy-comfy-ultra.us-east.modal.run', 'fast'),
    'https://trankilena--zaude-comfy-comfy-fast.us-east.modal.run',
  );
  assert.equal(
    mr.deriveTierEndpoint('https://trankilena--zaude-comfy-comfy-fast.us-east.modal.run', 'balanced'),
    'https://trankilena--zaude-comfy-comfy-balanced.us-east.modal.run',
  );

  // Verify Modal server config enables SageAttention, GPU Memory Snapshots, and single-thread Inductor
  const pySrc = fs.readFileSync(mr.DEFAULT_MODAL_SCRIPT, 'utf8');
  assert.match(pySrc, /--use-sage-attention/);
  assert.match(pySrc, /enable_memory_snapshot=True/);
  assert.match(pySrc, /enable_gpu_snapshot/);
  assert.match(pySrc, /TORCHINDUCTOR_COMPILE_THREADS/);
  assert.match(pySrc, /@app\.cls\(/);
  assert.match(pySrc, /@modal\.enter\(snap=True\)/);
  assert.match(pySrc, /comfy-fast/);
  assert.match(pySrc, /comfy-balanced/);
  assert.match(pySrc, /comfy-ultra/);
  assert.match(pySrc, /comfy-web/);

  // Singularity RefMod graph wires SatoDive EasyContextSegments + RefModContinuumBridge
  const sg = mr.buildSingularityGraph({
    prompt: 'Elias walks into the living room',
    model: 'Minimax-h3_Singularity_ref2va_v2_bf16.safetensors',
    clip: 'qwen3vl_32b_minimax_h3_bf16.safetensors',
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    refmods: [{ file: 'mannimmate_2d_v1/elias_varga_2d_v2', name: 'Elias' }],
  });
  assert.equal(sg['10'].class_type, 'MiniMaxH3RefModsLoader');
  assert.equal(sg['11'].class_type, 'MiniMaxH3RefModContinuumBridge');
  assert.equal(sg['13'].class_type, 'MiniMaxH3EasyContextSegments_SatoDive');
});
