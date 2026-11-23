// Persistent storage for Zaude's Help & AI Tips page.
// Both the user and connected AIs (Antigravity, Claude, Codex, OpenCode via MCP or AI Chat)
// can add editing tips and workflow tricks here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STARTER_TIPS = [
  {
    id: 'tip-trackpad',
    title: 'Fast Laptop Trackpad Editing',
    category: 'Controls',
    author: 'Zaude',
    body: 'On the Timeline: hold Ctrl + horizontal two-finger swipe to fine-tune clip length, Shift + swipe to move, Alt + swipe to slip source. In the Viewer: Pinch to zoom (Shift + pinch for half-speed precision), Shift + two-finger swipe to pan.',
    createdAt: '2026-11-22T00:00:00.000Z',
  },
  {
    id: 'tip-autocad-select',
    title: 'AutoCAD Blue / Green Box Selection',
    category: 'Timeline',
    author: 'Zaude',
    body: 'Drag on empty timeline space from Left → Right (Blue box) to select only fully enclosed clips. Drag Right → Left (Green dashed box) to select any clip the box touches. Drag any selected clip to move the whole group rigidly.',
    createdAt: '2026-11-22T00:00:01.000Z',
  },
  {
    id: 'tip-hsl-dropper',
    title: 'Multi-Color Selective HSL Grading',
    category: 'Color',
    author: 'Zaude',
    body: 'Open Inspector → HSL to control up to 8 colors independently on your GPU. Click "+💧 New" to sample a color directly from the Viewer video frame and isolate its Hue, Saturation, Lightness, and Range.',
    createdAt: '2026-11-22T00:00:02.000Z',
  },
  {
    id: 'tip-mannimmate-sweetspot',
    title: 'Mannimmate AI Video Sweet Spot (640p · 6 Steps)',
    category: 'AI Video',
    author: 'Zaude',
    body: 'Use 640p with the 4-step Turbo LoRA at 6 steps (7 steps for RefMod continue) and 7–8s clips (~5.5–6.5 min/clip on RTX 3090). Always keep RefMod clothing negated when overriding outfits ("NOT in default outfit, instead wearing..."), repeat room/prop anchors verbatim, and lock TV/monitor screens brightly ON.',
    createdAt: '2026-11-23T00:00:00.000Z',
  },
  {
    id: 'tip-export-loudness',
    title: 'Production Export & Audio Mix Rules',
    category: 'Export',
    author: 'Zaude',
    body: 'Export at 30 fps, Ultra quality, 1920×1080 (16:9) or 1080×1920 (9:16) with Fill frame + Sharpen 38. Target -14.0 LUFS (TP -1.5). For story cuts: Version A (dialogue) uses V1 100% + Music 16%; Version B (narrated) uses V1 20% + VO 100% + Music 16%. Keep breathing zooms between 1.0× and 2.0× in 0.2× steps.',
    createdAt: '2026-11-23T00:00:01.000Z',
  },
];

function loadTips(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw.tips)) return raw.tips;
  } catch { /* first run or missing */ }
  return STARTER_TIPS.map((t) => ({ ...t }));
}

function saveTips(filePath, tips) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, tips }, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function addTip(filePath, input) {
  const title = String((input && input.title) || '').trim().slice(0, 120);
  const body = String((input && input.body) || '').trim().slice(0, 4000);
  if (!title || !body) return { ok: false, error: 'Both title and body are required for a tip.' };
  const category = String((input && input.category) || 'General').trim().slice(0, 40) || 'General';
  const author = String((input && input.author) || 'AI').trim().slice(0, 40) || 'AI';
  const tips = loadTips(filePath);
  const tip = {
    id: 'tip-' + crypto.randomUUID().slice(0, 8),
    title,
    category,
    author,
    body,
    createdAt: new Date().toISOString(),
  };
  tips.unshift(tip);
  saveTips(filePath, tips);
  return { ok: true, tip, tips };
}

function removeTip(filePath, id) {
  const tips = loadTips(filePath).filter((t) => t.id !== id);
  saveTips(filePath, tips);
  return { ok: true, tips };
}

module.exports = { STARTER_TIPS, loadTips, saveTips, addTip, removeTip };
