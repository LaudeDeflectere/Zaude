// Reusable Talking-Head Lip-Sync runner for Tranklena ComfyUI (LatentSync / MuseTalk).
// Lets users generate ONE clean 5s talking/walking plate, loop or ping-pong it to match
// any new dialogue audio length, and diffusion-inpaint ONLY the mouth/jaw on Tranklena's RTX 3090
// (zero Modal credits) with optional Room Acoustics EQ/reverb matching.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const comfyLive = require('./comfy-live.cjs');
const roomAcoustics = require('./room-acoustics.cjs');

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

function detectLipSyncEngine(objectInfo = {}) {
  const keys = Object.keys(objectInfo || {});
  if (keys.includes('LatentSyncNode')) return { ok: true, engine: 'latentsync', nodeClass: 'LatentSyncNode' };
  const lsAlt = keys.find((k) => /^latentsync/i.test(k));
  if (lsAlt) return { ok: true, engine: 'latentsync', nodeClass: lsAlt };
  const mt = keys.find((k) => /musetalk/i.test(k));
  if (mt) return { ok: true, engine: 'musetalk', nodeClass: mt };
  return { ok: false, engine: null, nodeClass: null };
}

function computeLoopRepeats(videoDur, audioDur) {
  if (!videoDur || videoDur <= 0 || !audioDur || audioDur <= videoDur + 0.15) return 1;
  return Math.max(1, Math.ceil(audioDur / videoDur));
}

// Smoothly extends a short video plate to cover a longer dialogue audio track via ping-pong or straight loop.
function prepareLoopedPlate({ videoPath, targetDurationSec, loopMode = 'ping-pong', outPath, ffmpeg = 'ffmpeg' }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dur = Math.max(0.5, Number(targetDurationSec) || 5);
  let args;
  if (loopMode === 'ping-pong') {
    args = [
      '-hide_banner', '-y',
      '-i', videoPath,
      '-filter_complex',
      `[0:v]split[f][b];[b]reverse[r];[f][r]concat=n=2:v=1:a=0,loop=-1:size=32767:start=0,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v]`,
      '-map', '[v]',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      outPath,
    ];
  } else {
    args = [
      '-hide_banner', '-y',
      '-stream_loop', '-1',
      '-i', videoPath,
      '-t', dur.toFixed(3),
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      outPath,
    ];
  }
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true }, (err, _out, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || 'FFmpeg loop failed').slice(0, 300) });
      resolve({ ok: true, path: outPath });
    });
  });
}

function buildLatentSyncGraph({
  videoName,
  audioName,
  seed = 42,
  lipsExp = 1.5,
  inferenceSteps = 20,
  nodeClass = 'LatentSyncNode',
  fps = 24,
  filenamePrefix = 'zaude_lipsync',
}) {
  return {
    '1': {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: videoName,
        force_rate: fps,
        force_size: 'Disabled',
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    },
    '2': {
      class_type: 'LoadAudio',
      inputs: { audio: audioName },
    },
    '3': {
      class_type: nodeClass,
      inputs: {
        images: ['1', 0],
        audio: ['2', 0],
        seed: Number(seed) || 42,
        lips_expression: Number(lipsExp) || 1.5,
        inference_steps: Number(inferenceSteps) || 20,
      },
    },
    '4': {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['3', 0],
        audio: ['3', 1],
        frame_rate: fps,
        loop_count: 0,
        filename_prefix: filenamePrefix,
        format: 'video/h264-mp4',
        pix_fmt: 'yuv420p',
        crf: 18,
        save_metadata: true,
        pingpong: false,
        save_output: true,
      },
    },
  };
}

async function uploadToComfy(baseUrl, filePath, subfolder = '') {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  form.append('image', new Blob([bytes]), name);
  form.append('overwrite', 'true');
  if (subfolder) form.append('subfolder', subfolder);
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status}) for ${name}`);
  const data = await res.json();
  return data.name || name;
}

function runLipSyncJob({
  videoPath,
  audioPath,
  loopMode = 'ping-pong',
  roomPreset = 'none',
  roomIntensity = 1.0,
  outDir,
  previewDir,
  jobId = 'lipsync',
  baseUrl = comfyLive.comfyBaseUrl(),
  onEvent = () => {},
}) {
  let cancelled = false;
  let promptId = null;
  let watcher = null;
  const base = String(baseUrl || comfyLive.comfyBaseUrl()).replace(/\/+$/, '');

  const cancel = async () => {
    cancelled = true;
    if (watcher) { try { watcher.stop(); } catch { /* ignore */ } }
    if (promptId) await comfyLive.cancelComfyPrompt({ baseUrl: base, promptId }).catch(() => {});
  };

  const promise = (async () => {
    if (!videoPath || !fs.existsSync(videoPath)) return { ok: false, error: 'Source video clip not found.' };
    if (!audioPath || !fs.existsSync(audioPath)) return { ok: false, error: 'Target dialogue audio file not found.' };

    // 1. Check Tranklena ComfyUI for installed Lip-Sync node
    onEvent({ type: 'status', message: 'Checking Tranklena ComfyUI for LatentSync / MuseTalk…' });
    let info = {};
    try {
      const r = await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      info = await r.json();
    } catch (e) {
      return { ok: false, error: `Could not reach Tranklena ComfyUI (${base}): ${e.message}` };
    }
    const detected = detectLipSyncEngine(info);
    if (!detected.ok) {
      return {
        ok: false,
        needsInstall: true,
        error: 'LatentSync is not installed on Tranklena ComfyUI yet. Install ComfyUI-LatentSyncWrapper on Tranklena and restart ComfyUI.',
      };
    }

    // 2. Extend source plate if shorter than target dialogue audio
    fs.mkdirSync(outDir, { recursive: true });
    const [vDur, aDur] = await Promise.all([probeDuration(videoPath), probeDuration(audioPath)]);
    let uploadVideoPath = videoPath;
    if (aDur > 0 && vDur > 0 && aDur > vDur + 0.15 && loopMode !== 'trim') {
      onEvent({ type: 'status', message: `Extending ${vDur.toFixed(1)}s clip via ${loopMode} to match ${aDur.toFixed(1)}s dialogue…` });
      const loopedPath = path.join(outDir, `${jobId}_plate_${Date.now()}.mp4`);
      const prep = await prepareLoopedPlate({ videoPath, targetDurationSec: aDur + 0.1, loopMode, outPath: loopedPath });
      if (!prep.ok) return prep;
      uploadVideoPath = prep.path;
    }

    if (cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };

    // 3. Upload video & audio + submit LatentSync graph
    onEvent({ type: 'status', message: `Uploading plate & dialogue audio to Tranklena (${detected.engine})…` });
    const videoName = await uploadToComfy(base, uploadVideoPath);
    const audioName = await uploadToComfy(base, audioPath);
    const clientId = crypto.randomUUID();
    const graph = buildLatentSyncGraph({
      videoName,
      audioName,
      seed: Math.floor(Math.random() * 1000000),
      nodeClass: detected.nodeClass,
      filenamePrefix: `zaude_ls_${Date.now()}`,
    });

    const sub = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    if (!sub.ok) return { ok: false, error: `ComfyUI rejected Lip-Sync graph (${sub.status})` };
    const subData = await sub.json();
    promptId = subData.prompt_id;

    if (previewDir) {
      watcher = comfyLive.watchComfyJob({
        baseUrl: base,
        clientId,
        promptId,
        previewDir,
        jobId,
        onStep: (st) => onEvent({ type: 'progress', ...st }),
        onPreview: (p) => onEvent({ type: 'preview', ...p }),
      });
    }

    // 4. Poll history until complete
    let outFile = null;
    while (!cancelled) {
      await new Promise((r) => setTimeout(r, 1500));
      const hr = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
      if (!hr.ok) continue;
      const h = await hr.json();
      const entry = h && h[promptId];
      if (!entry) continue;
      if (entry.status && entry.status.status_str === 'error') {
        return { ok: false, error: 'Tranklena Lip-Sync job failed in ComfyUI.' };
      }
      const outs = entry.outputs || {};
      for (const nodeOut of Object.values(outs)) {
        const list = nodeOut.gifs || nodeOut.videos || [];
        if (list.length) { outFile = list[0]; break; }
      }
      if (outFile) break;
    }

    if (watcher) { try { watcher.stop(); } catch { /* ignore */ } }
    if (cancelled || !outFile) return { ok: false, cancelled: true, error: 'Cancelled' };

    // 5. Download synced MP4
    const dlUrl = `${base}/view?filename=${encodeURIComponent(outFile.filename)}&subfolder=${encodeURIComponent(outFile.subfolder || '')}&type=${encodeURIComponent(outFile.type || 'output')}`;
    const dlRes = await fetch(dlUrl);
    if (!dlRes.ok) return { ok: false, error: `Failed to download lip-sync output (${dlRes.status})` };
    const rawOut = path.join(outDir, `lipsync_${Date.now()}.mp4`);
    fs.writeFileSync(rawOut, Buffer.from(await dlRes.arrayBuffer()));

    // 6. Optional Room Acoustics matching on output audio
    const roomFx = roomAcoustics.buildRoomFilter(roomPreset, roomIntensity);
    let finalOut = rawOut;
    if (roomFx) {
      const matchedOut = rawOut.replace(/\.mp4$/, `_${roomPreset}.mp4`);
      await new Promise((resolve) => {
        execFile('ffmpeg', [
          '-hide_banner', '-y', '-i', rawOut,
          '-c:v', 'copy',
          '-af', roomFx,
          '-c:a', 'aac', '-b:a', '192k',
          matchedOut,
        ], { windowsHide: true }, (err) => {
          if (!err && fs.existsSync(matchedOut)) finalOut = matchedOut;
          resolve();
        });
      });
    }

    return { ok: true, output: finalOut, engine: detected.engine };
  })();

  return { promise, cancel };
}

module.exports = {
  detectLipSyncEngine,
  computeLoopRepeats,
  prepareLoopedPlate,
  buildLatentSyncGraph,
  runLipSyncJob,
};
