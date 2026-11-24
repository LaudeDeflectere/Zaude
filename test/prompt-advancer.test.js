import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pa = require('../electron/prompt-advancer.cjs');

test('promptAdvancer stores, ranks, rates, and injects working examples into AI prompts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-promptdb-'));
  const dbPath = path.join(tmpDir, 'prompt-db.json');

  // 1. Starter examples load cleanly on first run
  const initial = pa.loadPromptDb(dbPath);
  assert.ok(initial.length >= 4);

  // 2. Saving a new working prompt persists and ranks high for matching queries
  const saved = pa.saveExample(dbPath, {
    title: 'Dancing Tabby Cat Neon Loft',
    mode: 'stylize',
    originalDraft: 'add neon cat dancing',
    enhancedPrompt: 'Preserve the original dancer and add a fluffy orange tabby cat dancing with neon contact shadows.',
    notes: 'Neon contact shadows locked the cat to the floor.',
    tags: ['stylize', 'cat', 'neon', 'dance'],
    rating: 5,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.example.rating, 5);

  const relevant = pa.findRelevantExamples(saved.examples, {
    draft: 'make an orange cat dance in neon light',
    mode: 'stylize',
    limit: 2,
  });
  assert.equal(relevant[0].title, 'Dancing Tabby Cat Neon Loft');

  // 3. Rating and updating notes persists cleanly
  const rated = pa.rateExample(dbPath, { id: saved.example.id, rating: 4, notes: 'Works best at 640p 6 steps.' });
  assert.equal(rated.ok, true);
  assert.equal(rated.example.rating, 4);
  assert.match(rated.example.notes, /640p/);

  // 4. Prompt builder includes shot context, DB examples, master directives, and clarifying answers
  const masters = pa.loadMasterPrompts();
  assert.ok(masters.length >= 6);
  const pickedMasters = masters.filter((m) => m.id === 'camera-cinematic' || m.id === 'fight-choreography');
  assert.equal(pickedMasters.length, 2);

  const fullPrompt = pa.buildAdvancerPrompt({
    draft: 'Elias walks into the kitchen',
    mode: 'refmod',
    context: { seconds: 7, resolution: 640, refmods: ['Elias', 'Daniel'], hasFirstFrame: true },
    answers: [{ question: 'What mood?', answer: 'Tense night lighting' }],
    relevantExamples: relevant,
    selectedMasters: pickedMasters,
  });
  assert.match(fullPrompt, /Subject 1 \(Elias\)/);
  assert.match(fullPrompt, /Dancing Tabby Cat Neon Loft/);
  assert.match(fullPrompt, /Tense night lighting/);
  assert.match(fullPrompt, /Cinema Camera Rules/);
  assert.match(fullPrompt, /Better Fights & Action/);

  // 5. Response parser extracts clarifying questions + enhancedPrompt from fenced JSON
  const parsed = pa.parseAdvancerResponse([
    'Here is the structured output:',
    '```json',
    JSON.stringify({
      status: 'clarify',
      questions: [{ id: 'q1', question: 'What lighting?', options: ['Warm sunset', 'Moody neon'] }],
      enhancedPrompt: 'Medium shot of Subject 1 (Elias) entering a dim kitchen.',
      improvements: ['Added camera framing', 'Anchored RefMod Subject 1'],
      matchedExamples: ['RefMod Multi-Character Dialogue + Outfit Override'],
      suggestedTitle: 'Elias Dim Kitchen Entrance',
      suggestedTags: ['refmod', 'kitchen'],
    }),
    '```',
  ].join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, 'clarify');
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].options.length, 2);
  assert.match(parsed.enhancedPrompt, /Subject 1 \(Elias\)/);

  // 6. Plain-text fallback still succeeds cleanly
  const fallback = pa.parseAdvancerResponse('Wide cinematic shot of a rain-soaked street.', 'rain street');
  assert.equal(fallback.ok, true);
  assert.equal(fallback.status, 'ready');
  assert.match(fallback.enhancedPrompt, /rain-soaked/);

  // 7. Removing an example works
  const removed = pa.removeExample(dbPath, saved.example.id);
  assert.equal(removed.ok, true);
  assert.ok(!removed.examples.some((e) => e.id === saved.example.id));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shot library ships 20 character-swappable shots, Stylize before/afters, and existing preview squares', () => {
  const lib = pa.loadShotLibrary();
  assert.equal(lib.ok, true);
  assert.equal(lib.shots.length, 20);
  assert.equal(lib.stylizePresets.length, 4);
  assert.ok(lib.backgroundRecipes.length >= 5);
  assert.ok(lib.playbook.length >= 5);

  const rootDir = path.resolve(path.dirname(pa.DEFAULT_SHOT_LIBRARY_PATH), '..');
  for (const s of lib.shots) {
    assert.ok(s.preview, `Missing preview path on ${s.id}`);
    assert.ok(fs.existsSync(path.join(rootDir, s.preview)), `Preview image missing on disk: ${s.preview}`);
  }
  for (const p of lib.stylizePresets) {
    assert.ok(fs.existsSync(path.join(rootDir, p.beforePreview)), `Missing before preview: ${p.beforePreview}`);
    assert.ok(fs.existsSync(path.join(rootDir, p.afterPreview)), `Missing after preview: ${p.afterPreview}`);
  }

  // Character template substitution works for 1-char and 2-char shots
  const hero = lib.shots.find((s) => s.id === 'shot-01-hero-walk');
  const filledElias = pa.renderShotTemplate(hero.template, ['Elias Varga']);
  const filledNadia = pa.renderShotTemplate(hero.template, ['Nadia Krasavica']);
  assert.match(filledElias, /Subject 1 \(Elias Varga\)/);
  assert.match(filledNadia, /Subject 1 \(Nadia Krasavica\)/);
  assert.equal(filledElias.replace(/Elias Varga/g, 'X'), filledNadia.replace(/Nadia Krasavica/g, 'X'));

  const ots = lib.shots.find((s) => s.id === 'shot-05-ots-confrontation');
  const filledTwo = pa.renderShotTemplate(ots.template, ['Elias', 'Nadia']);
  assert.match(filledTwo, /Subject 1 \(Elias\)/);
  assert.match(filledTwo, /Subject 2 \(Nadia\)/);

  // Stylize Change Background builds valid RV2V command without requiring a RefMod
  const mannimmate = require('../electron/mannimmate.cjs');
  const bgCmd = mannimmate.buildCommand({
    mode: 'auto',
    stylizeAction: 'background',
    video: '/tmp/clip.mp4',
    start: 0,
    end: 5,
    objectPrompt: 'A rain-drenched cyberpunk Tokyo alleyway at midnight with neon rim light',
  });
  assert.equal(bgCmd.ok, true);
  assert.match(bgCmd.promptContent, /Replace ONLY the background/);
  assert.match(bgCmd.promptContent, /cyberpunk Tokyo/);
});
