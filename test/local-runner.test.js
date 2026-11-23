import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lr = require('../electron/local-runner.cjs');

test('localRunner detects installed GGUF models and builds LTX (T2V/FL2V) & Wan graphs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-local-'));
  fs.mkdirSync(path.join(tmp, 'models', 'unet'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'models', 'vae'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'models', 'clip'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'models', 'loras'), { recursive: true });

  fs.writeFileSync(path.join(tmp, 'models', 'unet', 'ltxv-2b-0.9.8-distilled-q4_k_m.gguf'), 'x');
  fs.writeFileSync(path.join(tmp, 'models', 'vae', 'ltxv_0.9.5_vae_fp16.safetensors'), 'x');
  fs.writeFileSync(path.join(tmp, 'models', 'clip', 't5-v1_1-xxl-encoder-Q4_K_M.gguf'), 'x');

  fs.writeFileSync(path.join(tmp, 'models', 'unet', 'wan2.1_t2v_1.3b-q8_0.gguf'), 'x');
  fs.writeFileSync(path.join(tmp, 'models', 'vae', 'wan_2.1_vae.safetensors'), 'x');
  fs.writeFileSync(path.join(tmp, 'models', 'clip', 'umt5-xxl-encoder-Q4_K_M.gguf'), 'x');
  fs.writeFileSync(path.join(tmp, 'models', 'loras', 'Wan21_CausVid_T2V_1_3B_lora_rank32.safetensors'), 'x');

  const models = lr.detectInstalledModels(tmp);
  assert.equal(models.length, 2);
  const ltx = models.find((m) => m.family === 'ltx');
  const wan = models.find((m) => m.family === 'wan');
  assert.equal(ltx.ready, true);
  assert.equal(ltx.distilled, true);
  assert.equal(ltx.defaultSteps, 8);
  assert.equal(wan.ready, true);
  assert.match(wan.lora, /CausVid/);

  // Frame & dimension snapping
  assert.equal((lr.snapLtxFrames(4, 24) - 1) % 8, 0);
  const d = lr.dimsForLocal(480, '16:9', 32);
  assert.equal(d.width % 32, 0);
  assert.equal(d.height % 32, 0);

  // LTX First/Last Frame graph wires LTXVAddGuide + LTXVCropGuides
  const ltxGraph = lr.buildLtxGraph({
    prompt: 'A tabby cat dancing',
    firstFrameName: 'first.png',
    lastFrameName: 'last.png',
    width: 768,
    height: 512,
    frames: 97,
    steps: 8,
  });
  assert.equal(ltxGraph['1'].class_type, 'UnetLoaderGGUF');
  assert.equal(ltxGraph['2'].class_type, 'CLIPLoaderGGUF');
  assert.equal(ltxGraph['21'].class_type, 'LTXVAddGuide');
  assert.equal(ltxGraph['21'].inputs.frame_idx, 0);
  assert.equal(ltxGraph['23'].class_type, 'LTXVAddGuide');
  assert.equal(ltxGraph['23'].inputs.frame_idx, -1);
  assert.equal(ltxGraph['24'].class_type, 'LTXVCropGuides');

  // Wan graph wires turbo LoRA when present
  const wanGraph = lr.buildWanGraph({
    prompt: 'Rainy street',
    lora: wan.lora,
  });
  assert.equal(wanGraph['20'].class_type, 'LoraLoaderModelOnly');
  assert.deepEqual(wanGraph['7'].inputs.model, ['20', 0]);

  fs.rmSync(tmp, { recursive: true, force: true });
});
