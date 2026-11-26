import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const audioTts = require('../electron/audio-tts.cjs');
const refmods = require('../electron/refmods.cjs');

test('audioTts auto-estimates cadence duration from text + tags and builds timed cadence prompt', () => {
  const shortFast = audioTts.estimateSpeechDuration('[fast] Run right now!');
  const longEmotional = audioTts.estimateSpeechDuration(
    '[fast] Wait, do not open that door! [pause 0.5s] [slow, emotional] I told you what is waiting behind it in the dark.'
  );
  assert.ok(shortFast.seconds >= 2 && shortFast.seconds <= 4);
  assert.ok(longEmotional.seconds > shortFast.seconds);
  assert.equal(longEmotional.pauseSec, 0.5);
  assert.match(longEmotional.cadenceSummary, /fast/);
  assert.match(longEmotional.cadenceSummary, /slow|emotional/);

  const built = audioTts.buildCadenceVoicePrompt({
    text: '[fast] Hey! [pause 0.4s] [slow, emotional] Stay right here.',
    refmodName: 'Karlsten',
  });
  assert.ok(built.seconds >= 3);
  assert.match(built.prompt, /fast brisk delivery/);
  assert.match(built.prompt, /slow deliberate delivery|emotional/);
  assert.match(audioTts.TTS_CADENCE_AGENT_PROMPT, /\[fast\]/);
  assert.match(audioTts.TTS_CADENCE_AGENT_PROMPT, /\[pause 0\.4s\]/);
});

test('refmods library exposes hasVoice=true when voice.wav exists and hasVoice=false for visual-only RefMods', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-voice-rm-'));
  const voicedDir = path.join(tmp, 'tony_sheen');
  const visualDir = path.join(tmp, 'elias_visual');
  fs.mkdirSync(voicedDir, { recursive: true });
  fs.mkdirSync(visualDir, { recursive: true });
  fs.writeFileSync(path.join(voicedDir, 'voice.wav'), 'RIFF');
  fs.writeFileSync(path.join(visualDir, 'voice.wav'), 'RIFF'); // _visual suffix still marks visual-only

  const list = refmods.syncRefMods(tmp, [
    { file: 'tony_sheen', name: 'Tony Sheen' },
    { file: 'elias_visual', name: 'Elias' },
  ]);
  const tony = list.find((m) => m.slug === 'tony_sheen');
  const elias = list.find((m) => m.slug === 'elias_visual');
  assert.equal(tony.hasVoice, true);
  assert.ok(tony.voicePath.endsWith('voice.wav'));
  assert.equal(elias.hasVoice, false);
  assert.equal(elias.voicePath, null);

  fs.rmSync(tmp, { recursive: true, force: true });
});
