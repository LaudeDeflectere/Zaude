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
