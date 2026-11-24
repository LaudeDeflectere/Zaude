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
