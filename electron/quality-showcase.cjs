// Model & Parameter Quality Showcase manifest manager and Tranklena benchmark runner.
const fs = require('node:fs');
const path = require('node:path');

const MASTER_BENCHMARK_PROMPT =
  'Wide establishing shot pulling smoothly into a medium close-up of <Subject 1> walking forward across a softly lit room, turning toward camera, speaking a calm line with natural expression and subtle jacket movement, crisp cinematic lighting.';

const SHOWCASE_GROUPS = [
  {
    id: 'resolution',
    label: 'Resolution',
    summary: 'Higher resolution sharpens faces, eyes, and textures at the cost of VRAM and render time. 480p is ideal for drafts; 640p–720p for final production.',
    items: [
      { id: 'res_360', label: '360p (Fast Sketch)', value: '360', resolution: '360', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Fastest layout & voice check (~2.5× faster than 640p).' },
      { id: 'res_480', label: '480p (Balanced Draft)', value: '480', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Great daily driver for blocking & multi-shot continuity.' },
      { id: 'res_640', label: '640p (Production)', value: '640', resolution: '640', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Sharp facial fidelity & clean lip-sync for final exports.' },
    ],
  },
  {
    id: 'fps',
    label: 'FPS',
    summary: 'Lower FPS generates dramatically fewer frames (6 fps = 4× faster than 24 fps) — great for animatics, stylized 2D motion, or fast voice-only passes.',
    items: [
      { id: 'fps_24', label: '24 fps (Cinema Smooth)', value: '24', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Standard cinematic motion and natural lip-sync.' },
      { id: 'fps_12', label: '12 fps (Anime / 2s)', value: '12', resolution: '480', fps: 12, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: '2× faster render; classic animated "on twos" cadence.' },
      { id: 'fps_6', label: '6 fps (Ultra-Fast / Audio)', value: '6', resolution: '480', fps: 6, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: '4× faster; ideal for storyboard previews or extracting RefMod voices.' },
    ],
  },
  {
    id: 'identity',
    label: 'Identity',
    summary: 'Controls how tightly RefMod locks face, hair, and clothing. Drop to 0.70 when changing outfits, hair, or battle damage via prompt.',
    items: [
      { id: 'id_07', label: 'Identity 0.7 (Flexible)', value: '0.7', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 0.7, voiceStrength: 1.0, note: 'Keeps face recognizable while allowing outfit/hair changes.' },
      { id: 'id_10', label: 'Identity 1.0 (Standard Lock)', value: '1.0', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Best all-around character consistency across shots.' },
      { id: 'id_13', label: 'Identity 1.3 (Strict Lock)', value: '1.3', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.3, voiceStrength: 1.0, note: 'Maximum likeness lock; resists wardrobe changes.' },
    ],
  },
  {
    id: 'voice',
    label: 'Voice',
    summary: 'Controls vocal timbre adherence for RefMods that include an audio track.',
    items: [
      { id: 'voice_05', label: 'Voice 0.5 (Natural Blend)', value: '0.5', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 0.5, note: 'Allows wider emotional pitch swings with lighter voice lock.' },
      { id: 'voice_10', label: 'Voice 1.0 (Exact Timbre)', value: '1.0', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Preserves exact character voice timbre across lines.' },
    ],
  },
  {
    id: 'models',
    label: 'Models',
    summary: 'Compare Zaude’s main video engines: Singularity v2 Ref2VA (character + voice), Singularity v2 FL2VA (first/last frame & T2V), Turbo (fast 4-step), and LTX-2 (local lightweight).',
    items: [
      { id: 'model_ref2va', label: 'Singularity v2 Ref2VA', value: 'ref2va', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Multi-character RefMod identity + synchronized voice generation.' },
      { id: 'model_fl2va', label: 'Singularity v2 FL2VA', value: 'fl2va', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Best for pure Text→Video and First/Last Frame interpolation.' },
      { id: 'model_turbo', label: 'Turbo / Lightning (4-Step)', value: 'turbo', resolution: '480', fps: 24, steps: 4, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Rapid 4-step iteration with SageAttention acceleration.' },
      { id: 'model_ltx', label: 'LTX-2 Local GGUF', value: 'ltx', resolution: '480', fps: 24, steps: 8, seconds: 4, identityStrength: 1.0, voiceStrength: 1.0, note: 'Runs locally on 8 GB GPUs (RTX 2070 Super) without Tranklena.' },
    ],
  },
  {
    id: 'loras',
    label: 'LoRAs',
    summary: 'LoRAs steer speed, lighting, or style without swapping the base model.',
    items: [
      { id: 'lora_none', label: 'No LoRA (Base)', value: 'none', resolution: '480', fps: 24, steps: 6, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Clean baseline output with zero style bias.' },
      { id: 'lora_lightning', label: 'Lightning / Fast-Step LoRA', value: 'lightning', resolution: '480', fps: 24, steps: 4, seconds: 5, identityStrength: 1.0, voiceStrength: 1.0, note: 'Sharp convergence in 4–6 steps for rapid turnaround.' },
    ],
  },
];

function benchmarksDir(appRoot) {
  return path.join(appRoot, 'assets', 'benchmarks');
}

function manifestPath(appRoot) {
  return path.join(benchmarksDir(appRoot), 'manifest.json');
}

function readSavedManifest(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(appRoot), 'utf8'));
  } catch {
    return { updatedAt: null, items: {} };
  }
}

function saveBenchmarkRecord(appRoot, itemId, record) {
  const dir = benchmarksDir(appRoot);
  fs.mkdirSync(dir, { recursive: true });
  const data = readSavedManifest(appRoot);
  data.updatedAt = new Date().toISOString();
  data.items = data.items || {};
  data.items[itemId] = { ...(data.items[itemId] || {}), ...record, updatedAt: data.updatedAt };
  fs.writeFileSync(manifestPath(appRoot), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function loadShowcaseManifest(appRoot, toMediaUrl = null) {
  const dir = benchmarksDir(appRoot);
  const saved = readSavedManifest(appRoot);
  const groups = SHOWCASE_GROUPS.map((g) => ({
    ...g,
    items: g.items.map((item) => {
      const rec = (saved.items && saved.items[item.id]) || {};
      const mp4Path = rec.file ? (path.isAbsolute(rec.file) ? rec.file : path.join(dir, rec.file)) : path.join(dir, `${item.id}.mp4`);
      const hasVideo = fs.existsSync(mp4Path);
      const videoUrl = hasVideo ? (toMediaUrl ? toMediaUrl(mp4Path) : `file://${mp4Path}`) : null;
      return {
        ...item,
        hasVideo,
        videoPath: hasVideo ? mp4Path : null,
        videoUrl,
        renderSec: rec.renderSec || null,
        refmod: rec.refmod || null,
      };
    }),
  }));
  return {
    ok: true,
    masterPrompt: MASTER_BENCHMARK_PROMPT,
    benchmarksDir: dir,
    updatedAt: saved.updatedAt || null,
    groups,
  };
}

function getHoverPreviewSpec(paramKey, manifest) {
  if (!manifest || !Array.isArray(manifest.groups)) return null;
  const key = String(paramKey || '').toLowerCase();
  const group = manifest.groups.find((g) => g.id === key);
  if (!group) return null;
  return {
    id: group.id,
    label: group.label,
    summary: group.summary,
    items: group.items,
  };
}

module.exports = {
  MASTER_BENCHMARK_PROMPT,
  SHOWCASE_GROUPS,
  benchmarksDir,
  loadShowcaseManifest,
  saveBenchmarkRecord,
  getHoverPreviewSpec,
};
