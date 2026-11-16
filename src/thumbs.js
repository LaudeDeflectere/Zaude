// Still frames for the bin tiles. Each video gets one frame, taken a little way in, drawn to a small
// JPEG. Frames are made one at a time, so a big folder does not stall the editor. Results are kept
// in memory, and a "zaude:thumb" event tells the bin which tile to update.
import { reportTask, finishTask } from './tasks.js';

const WIDTH = 320;
const TIMEOUT_MS = 8000;
const frames = new Map(); // file path -> data URL
const failed = new Set();
const urls = new Map();   // file path -> playable URL
const queue = [];
const queued = new Set();
let running = false;
let batch = { total: 0, done: 0 };

export function frameFor(path) {
  return frames.get(path) || null;
}

// Playable URL for a file through the desktop app's media route. Null in the browser preview.
export async function urlFor(path) {
  if (urls.has(path)) return urls.get(path);
  const api = window.zaudeAI || null;
  if (!api || !api.mediaUrl) return null;
  const res = await api.mediaUrl(path);
  const url = res && res.ok ? res.url : null;
  if (url) urls.set(path, url);
  return url;
}

// Queues frames for every video file that does not have one yet.
export function ensureFrames(media) {
  let added = 0;
  for (const m of media) {
    if (!m.hasVideo || frames.has(m.path) || failed.has(m.path) || queued.has(m.path)) continue;
    queue.push(m);
    queued.add(m.path);
    added += 1;
  }
  if (!added) return;
  if (running) batch.total += added;
  else run(added);
}

async function run(added) {
  running = true;
  batch = { total: added, done: 0 };
  while (queue.length) {
    const m = queue.shift();
    queued.delete(m.path);
    batch.done += 1;
    reportTask('thumbs', { label: `Making previews ${batch.done} of ${batch.total}: ${m.name}`, progress: batch.done / batch.total });
    const url = await urlFor(m.path);
    const data = url ? await grabFrame(url, m.duration) : null;
    if (data) {
      frames.set(m.path, data);
      window.dispatchEvent(new CustomEvent('zaude:thumb', { detail: { path: m.path } }));
    } else {
      failed.add(m.path);
    }
  }
  running = false;
  batch = { total: 0, done: 0 };
  finishTask('thumbs');
}

// Draws one frame from the video at url. Resolves to a JPEG data URL, or null if it cannot be read.
function grabFrame(url, duration) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => {
      const d = Number(duration) || v.duration || 0;
      // a frame about a tenth of the way in, never past the first few seconds
      v.currentTime = Math.min(2, Math.max(0, d * 0.1));
    };
    v.onseeked = () => {
      try {
        const vw = v.videoWidth || 16;
        const vh = v.videoHeight || 9;
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = Math.max(1, Math.round(WIDTH * vh / vw));
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.75));
      } catch {
        finish(null);
      }
    };
    v.src = url;
  });
}
