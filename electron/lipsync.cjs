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
  const info = objectInfo || {};
  const keys = Object.keys(info);
  const hasCropAndStitch = Boolean(info.InpaintCropImproved && info.InpaintStitchImproved);

  // Prioritize LatentSync 1.6, then generic LatentSyncNode, then MuseTalk (including ComfyUI-MuseTalk-KJ)
  const ls16 = keys.find((k) => /latentsync.*1[._]?6/i.test(k));
  if (ls16) return { ok: true, engine: 'latentsync-1.6', nodeClass: ls16, hasCropAndStitch };
  if (keys.includes('LatentSyncNode')) return { ok: true, engine: 'latentsync', nodeClass: 'LatentSyncNode', hasCropAndStitch };
  const lsAlt = keys.find((k) => /^latentsync/i.test(k));
  if (lsAlt) return { ok: true, engine: 'latentsync', nodeClass: lsAlt, hasCropAndStitch };
  const mtKj = keys.find((k) => /musetalk.*kj|kj.*musetalk/i.test(k));
  if (mtKj) return { ok: true, engine: 'musetalk', nodeClass: mtKj, hasCropAndStitch };
  const mt = keys.find((k) => /musetalk/i.test(k));
  if (mt) return { ok: true, engine: 'musetalk', nodeClass: mt, hasCropAndStitch };
  return { ok: false, engine: null, nodeClass: null, hasCropAndStitch };
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

function normalizeSpeakerBbox(bbox, videoWidth = 1120, videoHeight = 640) {
  if (!bbox || typeof bbox !== 'object') return null;
  const rawX = Number(bbox.x);
  const rawY = Number(bbox.y);
  const rawW = Number(bbox.width);
  const rawH = Number(bbox.height);
  if (![rawX, rawY, rawW, rawH].every(Number.isFinite) || rawW <= 0 || rawH <= 0) return null;
  const isNorm = rawW <= 1.0 && rawH <= 1.0 && rawX <= 1.0 && rawY <= 1.0;
  const x = Math.max(0, Math.round(isNorm ? rawX * videoWidth : rawX));
  const y = Math.max(0, Math.round(isNorm ? rawY * videoHeight : rawY));
  const width = Math.max(32, Math.min(videoWidth - x, Math.round(isNorm ? rawW * videoWidth : rawW)));
  const height = Math.max(32, Math.min(videoHeight - y, Math.round(isNorm ? rawH * videoHeight : rawH)));
  return { x, y, width, height, videoWidth, videoHeight };
}

function buildLatentSyncGraph({
  videoName,
  audioName,
  seed = 42,
  lipsExp = 1.5,
  inferenceSteps = 20,
  nodeClass = 'LatentSyncNode',
  // LatentSync 1.6 is trained at 25 FPS; 24 FPS causes gradual A/V drift.
  fps = 25,
  filenamePrefix = 'zaude_lipsync',
  speakerBbox = null,
  useCropAndStitch = false,
  videoWidth = 1120,
  videoHeight = 640,
}) {
  const box = useCropAndStitch ? normalizeSpeakerBbox(speakerBbox, videoWidth, videoHeight) : null;
  const graph = {
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
  };

  if (box) {
    // Selective single-face crop-and-stitch: only the active speaker's face is cropped to 512x512
    // and lip-synced; the listener's mouth and background remain bit-exact untouched.
    graph['10'] = {
      class_type: 'SolidMask',
      inputs: { value: 0.0, width: box.videoWidth, height: box.videoHeight },
    };
    graph['11'] = {
      class_type: 'SolidMask',
      inputs: { value: 1.0, width: box.width, height: box.height },
    };
    graph['12'] = {
      class_type: 'MaskComposite',
      inputs: { destination: ['10', 0], source: ['11', 0], x: box.x, y: box.y, operation: 'add' },
    };
    graph['13'] = {
      class_type: 'InpaintCropImproved',
      inputs: {
        image: ['1', 0],
        mask: ['12', 0],
        downscale_algorithm: 'bilinear',
        upscale_algorithm: 'bicubic',
        preresize: false,
        preresize_mode: 'ensure minimum resolution',
        preresize_min_width: 512,
        preresize_min_height: 512,
        mask_fill_holes: true,
        mask_expand_pixels: 24,
        mask_invert: false,
        mask_blend_pixels: 24,
        mask_hipass_filter: 0.1,
        extend_for_outpainting: false,
        context_from_mask_extend_factor: 1.25,
        output_resize_to_target_size: true,
        output_target_width: 512,
        output_target_height: 512,
        output_padding: '32',
      },
    };
    graph['3'] = {
      class_type: nodeClass,
      inputs: {
        images: ['13', 1],
        audio: ['2', 0],
        seed: Number(seed) || 42,
        lips_expression: Number(lipsExp) || 1.5,
        inference_steps: Number(inferenceSteps) || 20,
      },
    };
    graph['14'] = {
      class_type: 'InpaintStitchImproved',
      inputs: {
        stitcher: ['13', 0],
        inpainted_image: ['3', 0],
      },
    };
    graph['4'] = {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['14', 0],
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
    };
    return graph;
  }

  graph['3'] = {
    class_type: nodeClass,
    inputs: {
      images: ['1', 0],
      audio: ['2', 0],
      seed: Number(seed) || 42,
      lips_expression: Number(lipsExp) || 1.5,
      inference_steps: Number(inferenceSteps) || 20,
    },
  };
  graph['4'] = {
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
  };
  return graph;
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
  speakerBbox = null,
  useCropAndStitch = true,
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
      fps: 25,
      speakerBbox,
      useCropAndStitch: Boolean(useCropAndStitch && speakerBbox && detected.hasCropAndStitch),
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

    // 6. Optional Room Acoustics matching on output audio (prefers real afir IR when present, falls back to aecho)
    const irPath = roomAcoustics.resolveIrPath(roomPreset);
    const roomFx = roomAcoustics.buildRoomFilter(roomPreset, roomIntensity);
    let finalOut = rawOut;
    if (irPath && roomPreset && roomPreset !== 'none') {
      const matchedOut = rawOut.replace(/\.mp4$/, `_${roomPreset}_ir.mp4`);
      const fc = roomAcoustics.buildRoomFilterComplex({
        presetId: roomPreset,
        intensity: roomIntensity,
        irPath,
        inputLabel: '[0:a]',
        irInputLabel: '[1:a]',
        outputLabel: '[aout]',
      });
      await new Promise((resolve) => {
        execFile('ffmpeg', [
          '-hide_banner', '-y', '-i', rawOut, '-i', irPath,
          '-filter_complex', fc,
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
          matchedOut,
        ], { windowsHide: true }, (err) => {
          if (!err && fs.existsSync(matchedOut)) finalOut = matchedOut;
          resolve();
        });
      });
    } else if (roomFx) {
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

// Pre-bakes a timeline video clip's trim (srcIn, dur) and manual Time Warp (speed: 0.25x..4.0x)
// into a clean 25 FPS MP4 plate so lip-sync matches the exact time-warped timing on the timeline.
function prepareTimeWarpedClip({ videoPath, srcIn = 0, dur = 0, speed = 1, outPath, ffmpeg = 'ffmpeg' }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const spd = Math.max(0.25, Math.min(4.0, Number(speed) || 1));
  const start = Math.max(0, Number(srcIn) || 0);
  const timelineDur = Math.max(0.25, Number(dur) || 0);
  const srcSpan = timelineDur > 0 ? timelineDur * spd : 0;
  const vf = Math.abs(spd - 1) > 0.005
    ? `setpts=PTS/${spd.toFixed(4)},fps=25`
    : 'fps=25';
  const args = ['-hide_banner', '-y'];
  if (start > 0.005) args.push('-ss', start.toFixed(3));
  args.push('-i', videoPath);
  if (srcSpan > 0.05) args.push('-t', srcSpan.toFixed(3));
  args.push(
    '-vf', vf,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    outPath,
  );
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true }, (err, _out, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || 'FFmpeg time-warp failed').slice(0, 300) });
      resolve({ ok: true, path: outPath });
    });
  });
}

// Trims an audio clip to its exact timeline range (srcIn..srcIn+dur) as 48 kHz WAV for lip-sync.
function prepareTrimmedAudio({ audioPath, srcIn = 0, dur = 0, outPath, ffmpeg = 'ffmpeg' }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const start = Math.max(0, Number(srcIn) || 0);
  const span = Math.max(0, Number(dur) || 0);
  const args = ['-hide_banner', '-y'];
  if (start > 0.005) args.push('-ss', start.toFixed(3));
  args.push('-i', audioPath);
  if (span > 0.05) args.push('-t', span.toFixed(3));
  args.push('-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', outPath);
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true }, (err, _out, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || 'FFmpeg audio trim failed').slice(0, 300) });
      resolve({ ok: true, path: outPath });
    });
  });
}

module.exports = {
  detectLipSyncEngine,
  computeLoopRepeats,
  prepareLoopedPlate,
  prepareTimeWarpedClip,
  prepareTrimmedAudio,
  probeDuration,
  buildLatentSyncGraph,
  runLipSyncJob,
};
