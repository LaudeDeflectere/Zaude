import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const va = require('../electron/video-analyzer.cjs');

test('videoAnalyzer parses VLM JSON and builds Loose (General Motion) & Tight (RV2V) Character A/B recast requests', () => {
  const parsed = va.parseAnalysisJson(`\`\`\`json
  {
    "characters": [
      {"id": "A", "label": "Fighter Left", "description": "man in dark coat", "x": 0.3, "y": 0.5},
      {"id": "B", "label": "Fighter Right", "description": "woman in jacket", "x": 0.72, "y": 0.48}
    ],
    "motionSummary": "Character A lunges forward and swings while Character B ducks and counters.",
    "cameraMotion": "handheld 35mm medium shot",
    "originalBackground": "alleyway"
  }
  \`\`\``);
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.characters[0].id, 'A');
  assert.equal(parsed.characters[1].id, 'B');
  assert.match(parsed.motionSummary, /Character A lunges/);

  // 1. Loose (General Motion) mode recreates action in a brand new background using RefMod mode
  const looseReq = va.buildRecastRequest({
    videoPath: '/tmp/fight.mp4',
    start: 0,
    end: 5,
    characters: [
      { id: 'A', x: 0.3, refmod: 'karlsten_malco', refmodName: 'Karlsten', outfit: 'no coat, torn shirt, hair zapped spiky', strength: 0.68 },
      { id: 'B', x: 0.72, refmod: 'elias_varga', refmodName: 'Elias', outfit: '', strength: 1.0 },
    ],
    motionSummary: parsed.motionSummary,
    cameraMotion: parsed.cameraMotion,
    newBackground: 'rain-slicked neon rooftop overlooking a cyberpunk skyline',
    motionMode: 'loose',
    resolution: 480,
    steps: 6,
  });
  assert.equal(looseReq.ok, true);
  assert.equal(looseReq.mode, 'refmod');
  assert.equal(looseReq.refmods.length, 2);
  assert.equal(looseReq.refmods[0].identityStrength, 0.68);
  assert.equal(looseReq.refmods[0].outfit, 'no coat, torn shirt, hair zapped spiky');
  assert.match(looseReq.prompt, /<Subject 1> \(Karlsten\) lunges forward/);
  assert.match(looseReq.prompt, /<Subject 2> \(Elias\) ducks/);
  assert.match(looseReq.prompt, /rain-slicked neon rooftop/);

  // 2. Tight (1:1 Motion Transfer) mode routes through auto (RV2V) with RefMods + new background
  const tightReq = va.buildRecastRequest({
    videoPath: '/tmp/fight.mp4',
    start: 1,
    end: 5,
    characters: [
      { id: 'A', x: 0.3, refmod: 'karlsten_malco', refmodName: 'Karlsten', outfit: 'no jacket', strength: 0.7 },
    ],
    motionSummary: parsed.motionSummary,
    newBackground: 'ancient stone temple courtyard',
    motionMode: 'tight',
    resolution: 480,
    steps: 6,
  });
  assert.equal(tightReq.ok, true);
  assert.equal(tightReq.mode, 'auto');
  assert.equal(tightReq.stylizeAction, 'both');
  assert.equal(tightReq.refmods[0].identityStrength, 0.7);
  assert.match(tightReq.objectPrompt, /ancient stone temple courtyard/);
});
