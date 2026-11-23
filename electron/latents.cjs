// Friendly naming & per-clip sidecar discovery for Mannimmate H3 saved latents.
// Formats recognizable labels like "E+N · game night sofa controllers" from character initials
// and a short description of the scene prompt, persisted in <userData>/latent-names.json.
const fs = require('node:fs');
const path = require('node:path');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'of', 'to', 'and', 'with', 'from', 'for', 'into', 'by', 'is', 'are', 'as',
  'shot', 'wide', 'medium', 'close', 'closeup', 'scene', 'clip', 'video', 'frame', 'edit', 'keep', 'camera',
]);

function characterInitials(refmods = []) {
  const list = (refmods || []).filter((r) => r && (r.name || r.file));
  if (!list.length) return '';
  return list
    .map((r) => {
      const raw = String(r.name || r.file || '')
        .replace(/.*[\\/]/, '')
        .replace(/^(cb|changebang|salabin|mannimmate)[_\s-]+/i, '')
        .trim();
      const ch = raw.match(/[A-Za-z]/);
      return ch ? ch[0].toUpperCase() : '?';
    })
    .join('+');
}

function shortSceneDesc(prompt = '', maxWords = 5) {
  const clean = String(prompt || '')
    .replace(/subject_definitions:[\s\S]*?\n\n/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^A-Za-z0-9\s'-]/g, ' ')
    .trim();
  if (!clean) return '';
  const words = clean.split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  const picked = (words.length ? words : clean.split(/\s+/)).slice(0, maxWords);
  return picked.join(' ').slice(0, 42).trim();
}

function formatLatentLabel({ refmods = [], prompt = '', fallbackName = '' } = {}) {
  const init = characterInitials(refmods);
  const desc = shortSceneDesc(prompt);
  if (init && desc) return `${init} · ${desc}`;
  if (init) return `${init} · ${fallbackName || 'scene'}`;
  if (desc) return desc;
  return String(fallbackName || 'Saved latent').replace(/\.[^.]+$/, '');
}

function loadLatentNames(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveLatentName(storePath, latentFile, label) {
  if (!storePath || !latentFile || !label) return;
  const map = loadLatentNames(storePath);
  map[latentFile] = label;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(map, null, 2), 'utf8');
}

// Checks for a Mannimmate sidecar JSON next to a video clip (e.g. clip.json) to recover its saved latent.
function findClipLatent(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const parsed = path.parse(videoPath);
  const candidates = [path.join(parsed.dir, `${parsed.name}.json`)];
  for (const jsonPath of candidates) {
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const latent = data.latent || data.latent_file || null;
      if (latent) {
        const label = formatLatentLabel({
          refmods: Array.isArray(data.refmods) ? data.refmods : [],
          prompt: data.prompt || '',
          fallbackName: parsed.name,
        });
        return { latent, label };
      }
    } catch { /* ignore */ }
  }
  return null;
}

module.exports = { characterInitials, shortSceneDesc, formatLatentLabel, loadLatentNames, saveLatentName, findClipLatent };
