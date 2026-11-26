import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qs = require('../electron/quality-showcase.cjs');

test('quality showcase manifest loads all parameter groups, tracks rendered videos, and looks up hover previews', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-qs-'));
  const m1 = qs.loadShowcaseManifest(tmp, (p) => `media://${path.basename(p)}`);
  assert.equal(m1.ok, true);
  assert.ok(m1.groups.length >= 6);
  const fpsGroup = qs.getHoverPreviewSpec('fps', m1);
  assert.equal(fpsGroup.label, 'FPS');
  assert.equal(fpsGroup.items.length, 3);
  assert.equal(fpsGroup.items[0].hasVideo, false);

  // Simulate saving a rendered benchmark mp4
  const bDir = qs.benchmarksDir(tmp);
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'fps_24.mp4'), Buffer.from('fake-mp4'));
  qs.saveBenchmarkRecord(tmp, 'fps_24', { file: 'fps_24.mp4', renderSec: 18.4, refmod: 'karlsten_malco' });

  const m2 = qs.loadShowcaseManifest(tmp, (p) => `media://${path.basename(p)}`);
  const fps24 = m2.groups.find((g) => g.id === 'fps').items.find((i) => i.id === 'fps_24');
  assert.equal(fps24.hasVideo, true);
  assert.equal(fps24.videoUrl, 'media://fps_24.mp4');
  assert.equal(fps24.renderSec, 18.4);

  fs.rmSync(tmp, { recursive: true, force: true });
});
