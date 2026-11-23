// AI Prompt Advancer & Self-Improving Prompt Database.
// Uses a connected AI CLI agent (Codex, Claude, OpenCode) to upgrade rough video prompts into
// production-grade prompts, ask targeted clarifying questions when details are ambiguous, and
// compare against a persistent database of proven working examples that grows and improves over time.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const aiChat = require('./ai-chat.cjs');

// Curated starter database of proven, real-world working video prompts across Zaude modes.
const STARTER_EXAMPLES = [
  {
    id: 'ex-refmod-dialogue',
    title: 'RefMod Multi-Character Dialogue + Outfit Override',
    mode: 'refmod',
    originalDraft: 'Elias and Daniel talking at a desk about a secret plan',
    enhancedPrompt: 'Medium two-shot in a warm dimly lit study with wooden bookshelves and a glowing green desk lamp. Subject 1 (Elias, NOT in his default coat, instead wearing a rumpled dark olive crewneck sweater) leans forward over a cluttered oak desk, eyes narrowed and urgent. Subject 2 (Daniel, NOT in his default jacket, instead wearing a heather grey hoodie) sits across from him, gripping a ceramic mug. A desktop monitor on the corner of the desk stays brightly ON showing a blue spreadsheet. Camera performs a slow, steady push-in on a 50mm lens with shallow depth of field. Natural film grain, subtle tungsten rim light. Dialogue (0.8s–4.8s): Subject 1 whispers intensely, "If we move tonight, nobody catches us." Subject 2 exhales and replies quietly, "Then we only get one shot."',
    notes: 'Negating default RefMod clothing prevents outfit bleed; locking the monitor screen ON prevents flickering black screens; explicit dialogue timestamps improve lip-sync.',
    tags: ['refmod', 'dialogue', 'outfit-override', 'screen-lock', 'two-shot'],
    rating: 5,
    usedCount: 3,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  },
  {
    id: 'ex-fl2v-transition',
    title: 'First-to-Last Frame Smooth Camera & Pose Bridge',
    mode: 'fl2v',
    originalDraft: 'person turns around from window to smile at camera',
    enhancedPrompt: 'Seamless continuous shot bridging the exact opening frame to the exact ending frame in the same sunlit apartment living room with sheer white curtains and warm oak floors. Starting from the subject gazing thoughtfully out the window in profile, they slowly pivot their shoulders and head clockwise toward the camera, hair catching the golden afternoon backlight, expression softening from contemplative into a warm, genuine smile as they settle cleanly into the final framing. Smooth handheld micro-motion, consistent exposure and color temperature throughout, no abrupt cuts or morphing.',
    notes: 'Explicitly describing the physical motion path from opening pose to ending pose prevents morphing artifacts in First-to-Last Frame (FL2V) generation.',
    tags: ['fl2v', 'frametoframe', 'transition', 'natural-light'],
    rating: 5,
    usedCount: 2,
    createdAt: '2026-11-23T00:01:00.000Z',
    updatedAt: '2026-11-23T00:01:00.000Z',
  },
  {
    id: 'ex-framecontinue-action',
    title: 'FrameContinue Seamless Action Extension',
    mode: 'continue',
    originalDraft: 'continue the scene as she picks up the keys and walks out',
    enhancedPrompt: 'Direct seamless continuation from the exact last frame, preserving identical lighting, wardrobe, camera height, and room layout. Without any jump or reset, the subject reaches down with her right hand to scoop the brass key ring off the wooden counter, shifts her weight forward, and walks briskly toward the sunlit hallway door while glancing back over her shoulder. Camera tracks smoothly backward at eye level, maintaining crisp focus on her face and natural cloth physics.',
    notes: 'Stating "Direct seamless continuation from the exact last frame" and anchoring lighting/wardrobe keeps FrameContinue latent transitions invisible.',
    tags: ['continue', 'framecontinue', 'tracking', 'continuity'],
    rating: 5,
    usedCount: 2,
    createdAt: '2026-11-23T00:02:00.000Z',
    updatedAt: '2026-11-23T00:02:00.000Z',
  },
  {
    id: 'ex-stylize-object',
    title: 'Stylize & Add Moving Object (Preserve Original Subject)',
    mode: 'stylize',
    originalDraft: 'add an orange cat walking around and dancing',
    enhancedPrompt: 'Preserve the original dancer, outfit, choreography, studio background, and crisp natural lighting exactly as filmed. Add a fluffy orange and white tabby cat on the hardwood floor beside the dancer: the cat trots playfully across the lower frame with its tail raised and swishing, pauses to look up curiously at the dancer, then rises onto its hind legs and waves its front paws in playful rhythm with the beat. Ground the cat with soft contact shadows matching the room light.',
    notes: 'Explicitly anchoring contact shadows and telling the model to preserve the original subject keeps RV2V object additions grounded and stable.',
    tags: ['stylize', 'object', 'cat', 'rv2v', 'shadows'],
    rating: 5,
    usedCount: 2,
    createdAt: '2026-11-23T00:03:00.000Z',
    updatedAt: '2026-11-23T00:03:00.000Z',
  },
  {
    id: 'ex-t2v-cinematic',
    title: 'Cinematic Text-to-Video Establishing Shot',
    mode: 'text-render',
    originalDraft: 'rainy cyber street at night with neon reflections',
    enhancedPrompt: 'Wide cinematic establishing shot of a rain-slicked Tokyo alleyway at midnight. Cyan and magenta neon signs shimmer in deep asphalt puddles as light rain falls diagonally through volumetric mist. A lone silhouette under a clear vinyl umbrella walks away from camera down the narrow lane while steam rises from a street-side ramen vent. Slow, fluid dolly-in on a 35mm anamorphic lens, subtle horizontal lens flares, rich shadows, 24fps filmic motion blur.',
    notes: 'Specifying lens focal length, camera move, foreground/midground/background motion, and lighting texture produces far stronger single-shot T2V results.',
    tags: ['text-render', 'cinematic', 'night', 'neon', 'establishing'],
    rating: 4,
    usedCount: 1,
    createdAt: '2026-11-23T00:04:00.000Z',
    updatedAt: '2026-11-23T00:04:00.000Z',
  },
];

const PROMPT_ADVANCER_SYSTEM_PROMPT = `You are Zaude's Expert AI Video Prompt Engineer & Creative Director.
Your job is to transform a user's rough video prompt into a crisp, vivid, production-ready AI video prompt AND ask concise clarifying questions whenever important creative details are missing or ambiguous.

You are also given relevant PROVEN WORKING EXAMPLES from the user's Prompt Database (which includes notes on why they worked). Study those examples and apply their winning patterns, structure, and guardrails!

Mode-Specific Best Practices:
- refmod: Reference subjects as "Subject 1 (<Name>)", "Subject 2 (<Name>)". If overriding default clothing, explicitly negate the default ("NOT in default outfit, instead wearing..."). Keep room/prop anchors concrete, lock TV/monitor screens brightly ON if present, and include timestamped Dialogue windows if characters speak.
- fl2v (First-to-Last Frame): Describe the exact continuous physical motion arc connecting the opening frame to the closing frame, locking consistent lighting, camera, and environment so the model bridges smoothly without morphing.
- continue (FrameContinue): Emphasize direct seamless continuation from the exact ending frame with matching wardrobe, lighting, and camera momentum.
- stylize (Stylize & Objects): Clearly state what to preserve from the source clip vs. what object/effect/style to add, including grounded contact shadows and matching lighting.
- text-render: Specify shot size/lens, concrete subject & wardrobe, specific physical motion beat-by-beat, environment anchors, lighting/mood, and camera movement.

Output Format:
Return ONLY a valid JSON object (wrapped in \`\`\`json ... \`\`\`) with this exact schema:
{
  "status": "clarify" | "ready",
  "questions": [
    {
      "id": "q1",
      "question": "Short, specific question about an unclear detail?",
      "options": ["Quick option 1", "Quick option 2", "Quick option 3"]
    }
  ],
  "enhancedPrompt": "The complete, robust, ready-to-render prompt (ALWAYS provide your best upgraded version even when status is 'clarify')",
  "improvements": ["Short bullet of what you upgraded #1", "Short bullet #2"],
  "matchedExamples": ["Title of DB example(s) you drew patterns from"],
  "suggestedTitle": "Short 3–6 word title for saving to Prompt DB",
  "suggestedTags": ["tag1", "tag2", "tag3"]
}

Rules:
1. If the user's draft is short, vague, or missing key choices (like camera angle, mood/lighting, clothing, pacing, or ending beat) AND they haven't already answered clarifying questions, set "status": "clarify" and ask 2–3 sharp, high-leverage questions with 3–4 clickable options each.
2. If the user already answered your clarifying questions OR the draft is already detailed and unambiguous, set "status": "ready" and "questions": [].
3. ALWAYS provide a strong, ready-to-use "enhancedPrompt" (under 1400 chars, vivid concrete visual language, no fluff or meta-commentary).`;

function loadPromptDb(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw.examples)) return raw.examples;
  } catch { /* first run or missing */ }
  return STARTER_EXAMPLES.map((e) => ({ ...e }));
}

function savePromptDb(filePath, examples) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, examples }, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function findRelevantExamples(examples, { draft = '', mode = '', limit = 4 } = {}) {
  const list = Array.isArray(examples) ? examples : [];
  const tokens = new Set(tokenize(draft));
  const normMode = String(mode || '').toLowerCase();

  const scored = list.map((ex) => {
    let score = 0;
    if (normMode && String(ex.mode || '').toLowerCase() === normMode) score += 6;
    const exTokens = new Set([
      ...tokenize(ex.title),
      ...tokenize(ex.originalDraft),
      ...tokenize(ex.enhancedPrompt),
      ...((ex.tags || []).map((t) => String(t).toLowerCase())),
    ]);
    for (const t of tokens) {
      if (exTokens.has(t)) score += 2;
    }
    const rating = Math.max(1, Math.min(5, Number(ex.rating) || 3));
    score += rating * 0.9;
    score += Math.min(3, (Number(ex.usedCount) || 0) * 0.3);
    return { ex, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.ex);
}

function saveExample(filePath, input) {
  const enhancedPrompt = String((input && input.enhancedPrompt) || '').trim().slice(0, 4000);
  if (!enhancedPrompt) return { ok: false, error: 'Prompt text is required.' };
  const examples = loadPromptDb(filePath);
  const now = new Date().toISOString();
  const title = String((input && input.title) || '').trim().slice(0, 100) || enhancedPrompt.slice(0, 56) + '…';
  const mode = String((input && input.mode) || 'text-render').trim().slice(0, 32);
  const originalDraft = String((input && input.originalDraft) || '').trim().slice(0, 1000);
  const notes = String((input && input.notes) || '').trim().slice(0, 1000);
  const tags = Array.isArray(input && input.tags)
    ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10)
    : [];
  const rating = Math.max(1, Math.min(5, Math.round(Number(input && input.rating) || 4)));

  // Update existing entry if matching ID or identical enhancedPrompt
  const existingIdx = examples.findIndex((e) => (input.id && e.id === input.id) || e.enhancedPrompt === enhancedPrompt);
  let saved;
  if (existingIdx >= 0) {
    saved = {
      ...examples[existingIdx],
      title,
      mode,
      originalDraft: originalDraft || examples[existingIdx].originalDraft,
      notes: notes || examples[existingIdx].notes,
      tags: tags.length ? tags : examples[existingIdx].tags,
      rating,
      usedCount: (Number(examples[existingIdx].usedCount) || 0) + 1,
      updatedAt: now,
    };
    examples.splice(existingIdx, 1);
    examples.unshift(saved);
  } else {
    saved = {
      id: 'ex-' + crypto.randomUUID().slice(0, 8),
      title,
      mode,
      originalDraft,
      enhancedPrompt,
      notes,
      tags,
      rating,
      usedCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    examples.unshift(saved);
  }
  savePromptDb(filePath, examples);
  return { ok: true, example: saved, examples };
}

function rateExample(filePath, { id, rating, notes }) {
  const examples = loadPromptDb(filePath);
  const idx = examples.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: 'Example not found.' };
  if (rating != null) examples[idx].rating = Math.max(1, Math.min(5, Math.round(Number(rating) || 4)));
  if (typeof notes === 'string') examples[idx].notes = notes.trim().slice(0, 1000);
  examples[idx].updatedAt = new Date().toISOString();
  savePromptDb(filePath, examples);
  return { ok: true, example: examples[idx], examples };
}

function removeExample(filePath, id) {
  const examples = loadPromptDb(filePath).filter((e) => e.id !== id);
  savePromptDb(filePath, examples);
  return { ok: true, examples };
}

const DEFAULT_MASTER_PROMPTS_PATH = path.join(__dirname, '..', 'prompts', 'master-prompts.json');

function loadMasterPrompts(filePath = DEFAULT_MASTER_PROMPTS_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw.masters)) return raw.masters;
  } catch { /* missing or invalid */ }
  return [];
}

function pickAvailableProvider(requested = 'auto') {
  const det = aiChat.detectProviders();
  const list = Array.isArray(det && det.providers) ? det.providers : [];
  if (requested && requested !== 'auto') {
    const found = list.find((p) => p.id === requested && p.available);
    if (found) return found.id;
  }
  const order = ['claude', 'codex', 'opencode'];
  for (const id of order) {
    if (list.some((p) => p.id === id && p.available)) return id;
  }
  return requested && requested !== 'auto' ? requested : 'claude';
}

function buildAdvancerPrompt({ draft, mode, context = {}, answers = [], relevantExamples = [], selectedMasters = [] }) {
  const lines = [PROMPT_ADVANCER_SYSTEM_PROMPT, ''];

  if (Array.isArray(selectedMasters) && selectedMasters.length) {
    lines.push('### Selected Master Directing Directives (FOLLOW THESE STRICTLY!)');
    selectedMasters.forEach((m, i) => {
      lines.push(`${i + 1}. ${m.icon || ''} ${m.name} [${m.category || 'Directive'}]: ${m.instructions}`);
    });
    lines.push('');
  }

  lines.push('### Current Shot Context');
  lines.push(`- Mode: ${mode || 'text-render'}`);
  if (context.seconds) lines.push(`- Duration: ${context.seconds}s`);
  if (context.resolution) lines.push(`- Resolution: ${context.resolution}p`);
  if (context.aspect) lines.push(`- Aspect: ${context.aspect}`);
  if (Array.isArray(context.refmods) && context.refmods.length) {
    lines.push(`- Selected RefMods: ${context.refmods.map((r, i) => `Subject ${i + 1} (${r})`).join(', ')}`);
  }
  if (context.hasFirstFrame) lines.push('- First Frame: Locked from timeline/image');
  if (context.hasLastFrame) lines.push('- Last Frame: Locked from timeline/image (FL2V bridge)');
  if (context.isContinue) lines.push('- FrameContinue: Continuing from previous clip saved latent');
  if (context.stylizeAction) lines.push(`- Stylize Action: ${context.stylizeAction}`);
  lines.push('');

  if (relevantExamples.length) {
    lines.push('### Proven Working Examples from User Prompt Database (learn from these!)');
    relevantExamples.forEach((ex, i) => {
      lines.push(`${i + 1}. [${ex.title}] (mode=${ex.mode}, rating=${ex.rating}/5)`);
      if (ex.originalDraft) lines.push(`   Draft: ${ex.originalDraft}`);
      lines.push(`   Working Prompt: ${ex.enhancedPrompt}`);
      if (ex.notes) lines.push(`   Why it worked: ${ex.notes}`);
    });
    lines.push('');
  }

  lines.push('### User Draft Prompt');
  lines.push(draft || '(empty — help the user brainstorm a concrete video shot)');
  lines.push('');

  if (Array.isArray(answers) && answers.length) {
    lines.push('### User Clarifying Answers (incorporate ALL of these and return status="ready")');
    answers.forEach((a) => {
      lines.push(`- Q: ${a.question}`);
      lines.push(`  A: ${a.answer}`);
    });
    lines.push('');
  }

  lines.push('Respond ONLY with the JSON object in a ```json fenced block.');
  return lines.join('\n');
}

function parseAdvancerResponse(rawText, fallbackDraft = '') {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj === 'object' && typeof obj.enhancedPrompt === 'string') {
        const questions = Array.isArray(obj.questions)
          ? obj.questions
            .filter((q) => q && q.question)
            .slice(0, 4)
            .map((q, i) => ({
              id: String(q.id || `q${i + 1}`),
              question: String(q.question).trim(),
              options: Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 5) : [],
            }))
          : [];
        return {
          ok: true,
          status: obj.status === 'clarify' && questions.length ? 'clarify' : 'ready',
          questions,
          enhancedPrompt: obj.enhancedPrompt.trim(),
          improvements: Array.isArray(obj.improvements) ? obj.improvements.map(String).slice(0, 6) : [],
          matchedExamples: Array.isArray(obj.matchedExamples) ? obj.matchedExamples.map(String).slice(0, 4) : [],
          suggestedTitle: String(obj.suggestedTitle || '').trim().slice(0, 90),
          suggestedTags: Array.isArray(obj.suggestedTags) ? obj.suggestedTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8) : [],
        };
      }
    } catch { /* try next candidate */ }
  }

  // Graceful fallback if the AI replied in plain text instead of JSON
  return {
    ok: true,
    status: 'ready',
    questions: [],
    enhancedPrompt: text || fallbackDraft,
    improvements: ['Upgraded prompt using connected AI agent'],
    matchedExamples: [],
    suggestedTitle: '',
    suggestedTags: [],
  };
}

function advancePrompt({
  draft = '',
  mode = 'text-render',
  context = {},
  answers = [],
  masterIds = [],
  provider = 'auto',
  dbFilePath,
  mastersFilePath = DEFAULT_MASTER_PROMPTS_PATH,
  onChunk = () => {},
}) {
  const chosen = pickAvailableProvider(provider);
  const examples = dbFilePath ? loadPromptDb(dbFilePath) : STARTER_EXAMPLES;
  const relevantExamples = findRelevantExamples(examples, { draft, mode, limit: 4 });
  const allMasters = loadMasterPrompts(mastersFilePath);
  const idSet = new Set(Array.isArray(masterIds) ? masterIds : []);
  const selectedMasters = allMasters.filter((m) => idSet.has(m.id));
  const prompt = buildAdvancerPrompt({ draft, mode, context, answers, relevantExamples, selectedMasters });

  const built = aiChat.buildCliCommand({ provider: chosen, prompt, mcpConfigPath: null });
  if (!built || !built.bin) {
    return { promise: Promise.resolve({ ok: false, error: `No connected AI CLI available for "${chosen}". Install claude, codex, or opencode.` }), cancel: () => {} };
  }

  let child;
  try {
    child = spawn(built.bin, built.args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    return { promise: Promise.resolve({ ok: false, error: e.message }), cancel: () => {} };
  }

  let fullOut = '';
  let errOut = '';
  let cancelled = false;
  onChunk({
    type: 'start',
    provider: chosen,
    referencedCount: relevantExamples.length,
    referencedTitles: relevantExamples.map((e) => e.title),
    appliedMasters: selectedMasters.map((m) => `${m.icon || ''} ${m.name}`.trim()),
  });

  child.stdout.on('data', (c) => {
    const t = String(c);
    fullOut += t;
    onChunk({ type: 'chunk', text: t, provider: chosen });
  });
  child.stderr.on('data', (c) => { errOut += String(c); });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (cancelled) return resolve({ ok: false, cancelled: true, error: 'Cancelled' });
      if (code === 0 && fullOut.trim()) {
        const parsed = parseAdvancerResponse(fullOut, draft);
        return resolve({
          ...parsed,
          provider: chosen,
          referencedExamples: relevantExamples.map((e) => ({ id: e.id, title: e.title, rating: e.rating })),
        });
      }
      resolve({ ok: false, provider: chosen, error: errOut.trim() || fullOut.trim() || `${chosen} exited with code ${code}` });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  STARTER_EXAMPLES,
  DEFAULT_MASTER_PROMPTS_PATH,
  PROMPT_ADVANCER_SYSTEM_PROMPT,
  loadMasterPrompts,
  pickAvailableProvider,
  loadPromptDb,
  savePromptDb,
  findRelevantExamples,
  saveExample,
  rateExample,
  removeExample,
  buildAdvancerPrompt,
  parseAdvancerResponse,
  advancePrompt,
};
