// Pre-process Video Motion & Character Analyzer + Motion Recast Request Builder for Zaude.
// Extracts keyframes + a 2x2 storyboard strip from a source video, runs a fast local VLM
// (Ollama vision model if installed, else connected AI CLI, else instant heuristic draft)
// to detect Character A / Character B and summarize the action & camera motion, and builds
// either a "General Motion" (RefMod recreation) or "Tight 1:1 Motion Transfer" (RV2V) job.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const aiChat = require('./ai-chat.cjs');

function probeDuration(filePath, ffprobe = 'ffprobe') {
  return new Promise((resolve) => {
    execFile(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(0);
      const d = Number(String(stdout || '').trim());
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    });
  });
}

function extractKeyframesStrip({ videoPath, start = 0, end = 0, outDir, ffmpeg = 'ffmpeg' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now().toString(36);
  const heroPath = path.join(outDir, `recast_hero_${stamp}.jpg`);
  const stripPath = path.join(outDir, `recast_strip_${stamp}.jpg`);
  const s = Math.max(0, Number(start) || 0);
  const e = Number(end) > s + 0.2 ? Number(end) : s + 4;
  const span = Math.max(0.5, e - s);
  const mid = s + span * 0.35;

  // Hero frame for clickable character pin canvas
  spawnSync(ffmpeg, [
    '-hide_banner', '-y', '-ss', mid.toFixed(3), '-i', videoPath,
    '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', heroPath,
  ], { windowsHide: true, timeout: 15000 });

  // 2x2 storyboard contact sheet across [start..end] for motion analysis
  const fpsVal = (4 / span).toFixed(4);
  spawnSync(ffmpeg, [
    '-hide_banner', '-y', '-ss', s.toFixed(3), '-t', span.toFixed(3), '-i', videoPath,
    '-vf', `fps=${fpsVal},scale=480:-2,tile=2x2`,
    '-frames:v', '1', '-q:v', '4', stripPath,
  ], { windowsHide: true, timeout: 20000 });

  return {
    ok: fs.existsSync(heroPath),
    heroPath: fs.existsSync(heroPath) ? heroPath : '',
    stripPath: fs.existsSync(stripPath) ? stripPath : (fs.existsSync(heroPath) ? heroPath : ''),
    span,
  };
}

function parseAnalysisJson(rawText) {
  const txt = String(rawText || '').trim();
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const chars = Array.isArray(obj.characters) ? obj.characters.slice(0, 4).map((c, idx) => ({
      id: String(c.id || String.fromCharCode(65 + idx)).toUpperCase(),
      label: String(c.label || `Character ${String.fromCharCode(65 + idx)}`).trim(),
      description: String(c.description || '').trim(),
      x: Math.max(0.08, Math.min(0.92, Number(c.x ?? (idx === 0 ? 0.34 : 0.66)))),
      y: Math.max(0.12, Math.min(0.88, Number(c.y ?? 0.45))),
    })) : [];
    return {
      characters: chars.length ? chars : [
        { id: 'A', label: 'Character A', description: 'Primary subject (screen-left)', x: 0.34, y: 0.45 },
        { id: 'B', label: 'Character B', description: 'Secondary subject (screen-right)', x: 0.66, y: 0.45 },
      ],
      motionSummary: String(obj.motionSummary || obj.motion_summary || '').trim(),
      cameraMotion: String(obj.cameraMotion || obj.camera_motion || '').trim(),
      originalBackground: String(obj.originalBackground || obj.background || '').trim(),
    };
  } catch {
    return null;
  }
}

async function tryOllamaVision(stripPath, prompt) {
  try {
    const tagsRes = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!tagsRes.ok) return null;
    const tags = await tagsRes.json();
    const models = (tags && Array.isArray(tags.models)) ? tags.models.map((m) => m.name) : [];
    const vlm = models.find((n) => /vl|llava|vision|moondream|minicpm|gemma3|pixtral|bakllava/i.test(n));
    if (!vlm) return null;
    const b64 = fs.readFileSync(stripPath).toString('base64');
    const genRes = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: vlm, prompt, images: [b64], stream: false }),
      signal: AbortSignal.timeout(35000),
    });
    if (!genRes.ok) return null;
    const data = await genRes.json();
    const parsed = parseAnalysisJson(data && data.response);
    return parsed ? { ...parsed, analyzer: `Ollama (${vlm})` } : null;
  } catch {
    return null;
  }
}

async function analyzeVideoMotion({ videoPath, start = 0, end = 0, outDir }) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, error: 'Source video file not found.' };
  }
  const totalDur = await probeDuration(videoPath);
  const s = Math.max(0, Number(start) || 0);
  const e = Number(end) > s + 0.2 ? Math.min(totalDur || end, Number(end)) : Math.min(totalDur || (s + 5), s + 5);
  const extracted = extractKeyframesStrip({ videoPath, start: s, end: e, outDir });
  if (!extracted.ok) {
    return { ok: false, error: 'Could not extract keyframes from the video via FFmpeg.' };
  }

  const visionPrompt = `Analyze this 2x2 chronological video storyboard strip. Return ONLY valid JSON (no markdown) with this exact schema:
{
  "characters": [
    {"id": "A", "label": "Character A", "description": "short visual description and screen side", "x": 0.35, "y": 0.45},
    {"id": "B", "label": "Character B", "description": "short visual description and screen side", "x": 0.68, "y": 0.45}
  ],
  "motionSummary": "2-3 concise sentences describing the physical choreography, movement, and interaction from frame 1 to frame 4 using Character A and Character B.",
  "cameraMotion": "short camera framing and movement description (e.g. handheld 35mm medium shot tracking right)",
  "originalBackground": "short description of the current setting"
}`;

  // 1. Try local Ollama Vision model (fast, $0, 100% local)
  let analysis = await tryOllamaVision(extracted.stripPath, visionPrompt);

  // 2. Fallback: instant editable draft with clickable Character A / B pins on the hero frame
  if (!analysis) {
    analysis = {
      characters: [
        { id: 'A', label: 'Character A', description: 'Click on the frame to position Character A', x: 0.35, y: 0.45 },
        { id: 'B', label: 'Character B', description: 'Click on the frame to position Character B', x: 0.68, y: 0.45 },
      ],
      motionSummary: 'Character A and Character B move dynamically through the scene following the general choreography and timing of the reference clip.',
      cameraMotion: 'Medium 35mm cinematic camera tracking the action smoothly.',
      originalBackground: 'Original scene environment',
      analyzer: 'Fast Local Draft (click frame to place pins · install an Ollama VLM like qwen2.5vl:3b for auto-description)',
    };
  }

  return {
    ok: true,
    heroPath: extracted.heroPath,
    stripPath: extracted.stripPath,
    start: s,
    end: e,
    duration: Math.max(1, Math.round(e - s)),
    ...analysis,
  };
}

// Builds a Zaude generation request from the user's Character A/B casting, motion summary, and new background.
function buildRecastRequest({
  videoPath = '',
  start = 0,
  end = 5,
  characters = [],
  motionSummary = '',
  cameraMotion = '',
  newBackground = '',
  backgroundImage = '',
  motionMode = 'loose', // 'loose' (RefMod general motion recreation) | 'tight' (RV2V direct motion transfer)
  resolution = 480,
  steps = 6,
  backend = 'remote',
} = {}) {
  const activeChars = (Array.isArray(characters) ? characters : [])
    .filter((c) => c && (c.refmod || c.refImage));

  const refmods = [];
  let rewrittenMotion = String(motionSummary || '').trim();
  const roleLines = [];

  activeChars.forEach((c) => {
    const idLetter = String(c.id || '').toUpperCase();
    const displayName = String(c.refmodName || c.label || `Character ${idLetter}`).trim();
    const outfit = String(c.outfit || '').trim();
    const strength = c.strength != null ? Number(c.strength) : (outfit ? 0.72 : 1.0);
    if (c.refmod) {
      const slotIdx = refmods.length + 1;
      refmods.push({
        file: c.refmod,
        name: displayName,
        identityStrength: Math.max(0.3, Math.min(1.0, strength)),
        voiceStrength: motionMode === 'loose' ? 1.0 : 0.0,
        outfit,
      });
      const token = `<Subject ${slotIdx}> (${displayName})`;
      if (idLetter) {
        rewrittenMotion = rewrittenMotion.replace(new RegExp(`\\bCharacter\\s+${idLetter}\\b`, 'gi'), token);
      }
      roleLines.push(`${token} plays the role of Character ${idLetter}${c.x != null ? (c.x < 0.5 ? ' (screen-left)' : ' (screen-right)') : ''}.`);
    }
  });

  const bgDesc = String(newBackground || '').trim();
  const camDesc = String(cameraMotion || '').trim();
  const seconds = Math.max(2, Math.min(15, Math.round((Number(end) || 5) - (Number(start) || 0)) || 5));

  if (motionMode === 'tight' && videoPath) {
    return {
      ok: true,
      backend,
      mode: 'auto',
      stylizeAction: bgDesc || backgroundImage ? 'both' : 'replace',
      video: videoPath,
      start: Number(start) || 0,
      end: Number(end) || 5,
      quality: String(resolution || 480),
      resolution: Number(resolution) || 480,
      preset: 'normal',
      steps: Number(steps) || 6,
      refmods,
      ref: activeChars.find((c) => !c.refmod && c.refImage)?.refImage || '',
      backgroundImage: String(backgroundImage || '').trim(),
      objectPrompt: [bgDesc ? `New environment/background: ${bgDesc}.` : '', rewrittenMotion].filter(Boolean).join(' '),
      backgroundMode: bgDesc || backgroundImage ? 'scene' : 'keep',
    };
  }

  // 'loose' (General Motion Recreation): uses RefMod mode so characters can inhabit a completely new
  // background and flexible choreography without fighting 1:1 source-video pixels!
  const promptParts = [];
  if (bgDesc) promptParts.push(`Setting & Background: ${bgDesc}.`);
  if (camDesc) promptParts.push(`Camera: ${camDesc}.`);
  if (roleLines.length) promptParts.push(roleLines.join(' '));
  if (rewrittenMotion) promptParts.push(`Action & Choreography: ${rewrittenMotion}`);

  return {
    ok: true,
    backend,
    mode: refmods.length ? 'refmod' : 'text-render',
    refmodMode: 'generate',
    prompt: promptParts.join('\n'),
    seconds,
    quality: String(resolution || 480),
    resolution: Number(resolution) || 480,
    fps: 24,
    steps: Number(steps) || 6,
    refmods,
    backgroundImage: String(backgroundImage || '').trim(),
  };
}

module.exports = {
  extractKeyframesStrip,
  parseAnalysisJson,
  analyzeVideoMotion,
  buildRecastRequest,
};
