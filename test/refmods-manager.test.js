import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rm = require('../electron/refmods.cjs');

test('refmods manager supports auto-categorization, recategorize, delete tombstones, and full image+audio RefMod extraction graph', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-refmods-mgr-'));

  // 1. Auto-categorization across Photoreal, 2D / Anime, Locations, Voices
  const synced = rm.syncRefMods(tmp, [
    { file: 'elias_cbphoto_v1_visual', name: 'Elias' },
    { file: 'mannimmate_2d_v1\\tony_sheen_2d_v2', name: 'Tony Sheen' },
    { file: 'locations/billiard_bar_location', name: 'Billiard Bar' },
    { file: 'natalia_face_audio', name: 'Natalia Audio' },
  ]);
  assert.equal(synced.find((m) => /elias/.test(m.slug)).category, 'Photoreal');
  assert.equal(synced.find((m) => /tony_sheen/.test(m.slug)).category, '2D / Anime');
  assert.equal(synced.find((m) => /billiard/.test(m.slug)).category, 'Locations');
  assert.equal(synced.find((m) => /audio/.test(m.slug)).category, 'Voices');

  // 2. Recategorizing persists in meta.json
  const tonySlug = synced.find((m) => /tony_sheen/.test(m.slug)).slug;
  const recat = rm.setRefModCategory(tmp, { slug: tonySlug, category: 'Characters' });
  assert.equal(recat.ok, true);
  assert.equal(recat.entry.category, 'Characters');

  // 3. Deleting removes folder and prevents re-sync resurrection via tombstone
  const del = rm.deleteRefMod(tmp, { slug: tonySlug });
  assert.equal(del.ok, true);
  const resynced = rm.syncRefMods(tmp, [
    { file: 'elias_cbphoto_v1_visual', name: 'Elias' },
    { file: 'mannimmate_2d_v1\\tony_sheen_2d_v2', name: 'Tony Sheen' },
  ]);
  assert.equal(resynced.some((m) => m.slug === tonySlug), false);

  // 4. Full RefMod extraction graph wires images + audio + video + bundle save layout
  const built = rm.buildRefModExtractGraph({
    name: 'tony_sheen_custom',
    conceptType: 'identity',
    mode: 'Full Reference',
    imageNames: ['front.png', 'three_quarter.png', 'profile.png'],
    audioName: 'tony_voice.wav',
    videoNames: ['tony_walk.mp4'],
    refResolution: 1024,
    saveLayout: 'bundle',
    subfolder: 'mannimmate_2d_v1',
  });
  assert.equal(built.modName, 'tony_sheen_custom');
  assert.equal(built.refmodFile, 'mannimmate_2d_v1/tony_sheen_custom');
  assert.equal(built.graph['50'].class_type, 'MiniMaxH3RefModMasterExtract');
  assert.equal(built.graph['50'].inputs.concept_type, 'identity');
  assert.equal(built.graph['50'].inputs.mode, 'Full Reference');
  assert.equal(built.graph['50'].inputs.save_layout, 'bundle');
  assert.deepEqual(built.graph['50'].inputs.ref_image_3, ['12', 0]);
  assert.deepEqual(built.graph['50'].inputs.ref_video_1, ['30', 0]);
  assert.deepEqual(built.graph['50'].inputs.audio, ['3', 0]);
  assert.deepEqual(built.graph['50'].inputs.audio_vae, ['2', 0]);

  fs.rmSync(tmp, { recursive: true, force: true });
});
