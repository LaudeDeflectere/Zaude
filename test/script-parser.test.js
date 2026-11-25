import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sp = require('../electron/script-parser.cjs');

test('parseMultiShotScript parses upgraded Zaude multi-shot .md scripts and omits absent characters per shot', () => {
  const md = `
zaude_cast:
- <Subject 1>: refmod=elias_varga | name=Elias Varga | identity=1.0 | voice=1.0
- <Subject 2>: refmod=nadia_krasavica | name=Nadia Krasavica | identity=1.0 | voice=1.0
- background_lock: refmod=mannimmate_shared_2d_style_v1|Background Set|1.0|0.0

subject_definitions:
<Subject 1> is Elias Varga from RefMod (elias_varga): dark jacket, calm gaze.
<Subject 2> is Nadia Krasavica from RefMod (nadia_krasavica): glasses, crimson top.

---

zaude_shot_config:
shot: 1
engine: tranklena
mode: refmod
cast_in_shot: <Subject 1>
speaking: <Subject 1>
settings: 640p | 24fps | 5s | 6 steps | 16:9 | seed=42101

style_definitions:
keep same style, moody tungsten noir.

[Shot 1] 50mm medium shot lasting 00:00.000–00:05.000.
summary: Elias checks the hallway alone.
00:00.000–00:02.500:
<Subject 1> (S1) leans out and whispers, <d>[English] Coast is clear.</d>

overall_soundscape:
Quiet hallway tone.

---

zaude_shot_config:
shot: 2
engine: modal:balanced
mode: continue
cast_in_shot: <Subject 1>, <Subject 2>
settings: 640p | 24fps | 7s | 6 steps | 16:9

[Shot 2] 50mm OTS two-shot lasting 00:00.000–00:07.000.
summary: Nadia joins Elias at the door.
00:00.000–00:03.500:
<Subject 2> (S2) steps beside <Subject 1> (S1) and nods.
`;

  const res = sp.parseMultiShotScript(md);
  assert.equal(res.ok, true);
  assert.equal(res.shots.length, 2);
  assert.equal(res.cast.length, 2);
  assert.equal(res.backgroundLock.type, 'refmod');
  assert.equal(res.backgroundLock.value, 'mannimmate_shared_2d_style_v1');

  // Shot 1: ONLY Elias appears; Nadia must be omitted from refmods and subject_definitions!
  const s1 = res.shots[0];
  assert.equal(s1.shotNumber, 1);
  assert.equal(s1.engine, 'tranklena');
  assert.equal(s1.mode, 'refmod');
  assert.equal(s1.refmodMode, 'generate');
  assert.equal(s1.seconds, 5);
  assert.equal(s1.seed, 42101);
  assert.equal(s1.refmods.length, 1);
  assert.equal(s1.refmods[0].file, 'elias_varga');
  assert.match(s1.prompt, /Elias Varga/);
  assert.doesNotMatch(s1.prompt, /Nadia Krasavica/);

  // Shot 2: FrameContinue with both Elias and Nadia
  const s2 = res.shots[1];
  assert.equal(s2.shotNumber, 2);
  assert.equal(s2.engine, 'modal:balanced');
  assert.equal(s2.mode, 'refmod');
  assert.equal(s2.refmodMode, 'continue');
  assert.equal(s2.seconds, 7);
  assert.equal(s2.refmods.length, 2);
  assert.match(s2.prompt, /Elias Varga/);
  assert.match(s2.prompt, /Nadia Krasavica/);
});

test('parseMultiShotScript also parses classic Mannimmate syntax without zaude_cast', () => {
  const classic = `
subject_definitions:
<Subject 1> is Alice from <Picture 1>: red coat.
<Subject 2> is Bob from <Picture 2>: blue hoodie.

---

[Shot 1] Wide 35mm establishing shot lasting 00:00.000–00:06.000.
summary: Alice enters the lobby.
00:00.000–00:06.000:
<Subject 1> (S1) walks across the lobby.
`;
  const res = sp.parseMultiShotScript(classic);
  assert.equal(res.ok, true);
  assert.equal(res.shots.length, 1);
  assert.equal(res.shots[0].seconds, 6);
  assert.deepEqual(res.shots[0].castSlots, [1]);
  assert.match(res.shots[0].prompt, /Alice/);
  assert.doesNotMatch(res.shots[0].prompt, /Bob/);
});

test('locationRefMod assigns to next free mod_K slot without colliding with characters and builds StepCurve graph', () => {
  const refmodsLib = require('../electron/refmods.cjs');
  const modalRunner = require('../electron/modal-runner.cjs');

  // 1. Non-colliding slot assignment for 2 characters + 1 location RefMod -> mod_3
  const assigned = sp.assignLocationRefModSlot(
    [
      { file: 'elias_cbphoto_v1_visual', name: 'Elias', identityStrength: 1.0, voiceStrength: 1.0 },
      { file: 'nadia_cbphoto_v1_visual', name: 'Nadia', identityStrength: 1.0, voiceStrength: 1.0 },
    ],
    'locations/billiard_bar_location',
  );
  assert.equal(assigned.locationSlotIndex, 3);
  assert.equal(assigned.modKey, 'mod_3');
  assert.equal(assigned.slots.length, 3);
  assert.equal(assigned.slots[2].file, 'locations/billiard_bar_location');
  assert.equal(assigned.slots[2].voiceStrength, 0.0);

  // 2. Zero-training Location RefMod extraction graph wires 8 views -> MiniMaxH3RefModMasterExtract (concept_type=background)
  const builtLoc = refmodsLib.buildLocationRefModGraph({
    name: 'Billiard Bar',
    imageNames: ['v1.png', 'v2.png', 'v3.png', 'v4.png', 'v5.png', 'v6.png', 'v7.png', 'v8.png'],
  });
  assert.equal(builtLoc.modName, 'billiard_bar_location');
  assert.equal(builtLoc.graph['50'].class_type, 'MiniMaxH3RefModMasterExtract');
  assert.equal(builtLoc.graph['50'].inputs.concept_type, 'background');
  assert.equal(builtLoc.graph['50'].inputs.merge, true);
  assert.equal(builtLoc.graph['50'].inputs.save, true);
  assert.deepEqual(builtLoc.graph['50'].inputs['refs_image.ref_image_7'], ['17', 0]);

  // 3. Singularity graph attaches locationRefMod to mod_3 (voice=0) and wires MiniMaxH3RefModStepCurve (concept_at_start)
  const sg = modalRunner.buildSingularityGraph({
    prompt: 'Elias and Nadia talk at the bar.',
    model: 'Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors',
    clip: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
    videoVae: 'minimax_h3_video_vae_int8_convrot.safetensors',
    refmods: [
      { file: 'elias_cbphoto_v1_visual', name: 'Elias' },
      { file: 'nadia_cbphoto_v1_visual', name: 'Nadia' },
    ],
    locationRefMod: 'locations/billiard_bar_location',
    useStepCurve: true,
  });
  assert.equal(sg['10'].inputs.mod_1, 'elias_cbphoto_v1_visual');
  assert.equal(sg['10'].inputs.mod_2, 'nadia_cbphoto_v1_visual');
  assert.equal(sg['10'].inputs.mod_3, 'locations/billiard_bar_location');
  assert.equal(sg['10'].inputs.audio_strength_3, 0.0);
  assert.equal(sg['11b'].class_type, 'MiniMaxH3RefModStepCurve');
  assert.equal(sg['11b'].inputs.curve_direction, 'concept_at_start');
  assert.deepEqual(sg['12'].inputs.ref2va_model, ['11b', 0]);
});
