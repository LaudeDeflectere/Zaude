// Live ComfyUI WebSocket preview streamer & remote job canceller.
// Connects to ComfyUI's /ws endpoint (respecting MANNIMMATE_HOST or laptop tunnel 127.0.0.1:8189)
// to receive per-step progress + binary denoised preview images (PREVIEW_IMAGE / PREVIEW_IMAGE_WITH_METADATA),
// and cancels running/queued prompts on ComfyUI when the user deletes a generating clip in Zaude.
const fs = require('node:fs');
const path = require('node:path');

function comfyBaseUrl() {
  const explicit = String(process.env.MANNIMMATE_HOST || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return 'http://127.0.0.1:8189';
}

function toWsUrl(baseUrl) {
  return String(baseUrl || comfyBaseUrl())
    .replace(/^https:/i, 'wss:')
    .replace(/^http:/i, 'ws:')
    .replace(/\/+$/, '') + '/ws';
}

// Pure parser for ComfyUI binary WebSocket preview frames.
// Event type 1 = PREVIEW_IMAGE: [uint32 type=1][uint32 format 1=JPEG|2=PNG][image bytes]
// Event type 4 = PREVIEW_IMAGE_WITH_METADATA: [uint32 type=4][uint32 metaLen][meta JSON][image bytes]
function parseComfyBinaryPreview(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < 12) return null;
  const eventType = buf.readUInt32BE(0);

  if (eventType === 1) {
    const fmt = buf.readUInt32BE(4);
    const data = buf.subarray(8);
    if (data.length < 8) return null;
    const ext = fmt === 2 || (data[0] === 0x89 && data[1] === 0x50) ? 'png' : 'jpg';
    return { ext, data };
  }

  if (eventType === 4) {
    const metaLen = buf.readUInt32BE(4);
    const imgStart = 8 + metaLen;
    if (imgStart >= buf.length - 8) return null;
    const data = buf.subarray(imgStart);
    const ext = (data[0] === 0x89 && data[1] === 0x50) ? 'png' : 'jpg';
    return { ext, data };
  }

  return null;
}

// Opens a WebSocket to ComfyUI and streams live step progress & denoised preview images to disk.
function watchComfyJob({ baseUrl = comfyBaseUrl(), promptId = null, previewDir, jobId = '', onStep = () => {}, onPreview = () => {} }) {
  if (typeof globalThis.WebSocket !== 'function') {
    return { setPromptId() {}, close() {} };
  }

  let activePromptId = promptId;
  let closed = false;
  let ws = null;
  let lastStep = 0;
  let lastTotal = 0;

  try {
    ws = new globalThis.WebSocket(toWsUrl(baseUrl));
    ws.binaryType = 'arraybuffer';
  } catch {
    return { setPromptId() {}, close() {} };
  }

  const matchesPrompt = (pid) => !activePromptId || !pid || pid === activePromptId;

  ws.addEventListener('message', (event) => {
    if (closed) return;
    const payload = event.data;

    if (typeof payload === 'string') {
      try {
        const msg = JSON.parse(payload);
        if (msg.type === 'progress' && msg.data && matchesPrompt(msg.data.prompt_id)) {
          const step = Number(msg.data.value) || 0;
          const totalSteps = Number(msg.data.max) || 0;
          if (totalSteps > 0) {
            lastStep = step;
            lastTotal = totalSteps;
            onStep({ step, totalSteps, progress: Math.max(0, Math.min(1, step / totalSteps)) });
          }
        } else if (msg.type === 'progress_state' && msg.data && matchesPrompt(msg.data.prompt_id) && msg.data.nodes) {
          const nodes = Object.values(msg.data.nodes);
          const running = nodes.find((n) => n && n.state === 'running' && Number(n.max) > 0);
          if (running) {
            lastStep = Number(running.value) || 0;
            lastTotal = Number(running.max) || 0;
            onStep({ step: lastStep, totalSteps: lastTotal, progress: Math.max(0, Math.min(1, lastStep / lastTotal)) });
          }
        }
      } catch { /* ignore malformed JSON */ }
      return;
    }

    // Binary preview frame from ComfyUI sampler
    try {
      const parsed = parseComfyBinaryPreview(payload);
      if (!parsed || !previewDir) return;
      fs.mkdirSync(previewDir, { recursive: true });
      const outPath = path.join(previewDir, `live-${jobId || 'job'}.${parsed.ext}`);
      const tmpPath = outPath + '.tmp';
      fs.writeFileSync(tmpPath, parsed.data);
      fs.renameSync(tmpPath, outPath);
      onPreview({ previewPath: outPath, step: Math.max(1, lastStep), totalSteps: lastTotal });
    } catch { /* ignore write errors */ }
  });

  ws.addEventListener('error', () => { /* ignore if tunnel unavailable */ });

  return {
    setPromptId(pid) {
      if (pid) activePromptId = pid;
    },
    close() {
      closed = true;
      try { if (ws && ws.readyState <= 1) ws.close(); } catch { /* ignore */ }
    },
  };
}

// Cancels a specific prompt on ComfyUI (and interrupts active execution) so GPU stops immediately.
async function cancelComfyPrompt({ baseUrl = comfyBaseUrl(), promptId = null } = {}) {
  const base = String(baseUrl || comfyBaseUrl()).replace(/\/+$/, '');
  const post = async (route, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      await fetch(`${base}${route}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch { /* ignore network errors */ } finally {
      clearTimeout(timer);
    }
  };

  if (promptId) {
    await post(`/api/jobs/${encodeURIComponent(promptId)}/cancel`);
    await post('/queue', { delete: [promptId] });
  }
  await post('/interrupt');
}

module.exports = { comfyBaseUrl, toWsUrl, parseComfyBinaryPreview, watchComfyJob, cancelComfyPrompt };
