// Beat & tempo detector for music edits.
// Decodes mono 8 kHz s16le PCM via ffmpeg (compact, low-RAM) and computes:
// - BPM estimate via autocorrelation of low-frequency-weighted onset flux
// - Bar 1 downbeat phase offset
// - Editable beat & downbeat markers across the track duration
const { spawn } = require('node:child_process');

const SAMPLE_RATE = 8000;
const HOP_SAMPLES = 80; // 10 ms frame step (100 Hz onset envelope)
const ENV_RATE = SAMPLE_RATE / HOP_SAMPLES; // 100 Hz
const MAX_BYTES = 16 * 1024 * 1024; // ~17 minutes at 8 kHz s16le mono
const MAX_CACHE = 40;

const cache = new Map();

function setCache(key, value) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

// Pure PCM beat analyzer: takes 16-bit signed little-endian mono PCM and returns
// { bpm, offset, duration, beatsPerBar, markers }.
function analyzeBeatsFromPcm(pcmBuffer, { sampleRate = SAMPLE_RATE, beatsPerBar = 4 } = {}) {
  const totalSamples = Math.floor((pcmBuffer ? pcmBuffer.length : 0) / 2);
  const duration = totalSamples / sampleRate;
  if (totalSamples < sampleRate * 1.5) {
    return { bpm: 120, offset: 0, duration, beatsPerBar, markers: [] };
  }

  const hop = Math.max(16, Math.round(sampleRate / 100)); // ~10 ms frames
  const envRate = sampleRate / hop;
  const frameCount = Math.floor(totalSamples / hop);
  if (frameCount < 40) {
    return { bpm: 120, offset: 0, duration, beatsPerBar, markers: [] };
  }

  // 1. Compute full-band + low-pass (kick-weighted) energy envelope
  const fullEnv = new Float32Array(frameCount);
  const lowEnv = new Float32Array(frameCount);
  // 1-pole low-pass around ~160 Hz: alpha = dt / (RC + dt)
  const rc = 1 / (2 * Math.PI * 160);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  let lp = 0;

  for (let f = 0; f < frameCount; f++) {
    const base = f * hop;
    let sumFull = 0;
    let sumLow = 0;
    for (let i = 0; i < hop; i++) {
      const s = pcmBuffer.readInt16LE((base + i) * 2) / 32768;
      lp += alpha * (s - lp);
      sumFull += s * s;
      sumLow += lp * lp;
    }
    fullEnv[f] = Math.sqrt(sumFull / hop);
    lowEnv[f] = Math.sqrt(sumLow / hop);
  }

  // 2. Half-wave rectified onset flux (65% low-band kick + 35% full-band transient)
  const rawFlux = new Float32Array(frameCount);
  const lowFlux = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const df = Math.max(0, fullEnv[f] - fullEnv[f - 1]);
    const dl = Math.max(0, lowEnv[f] - lowEnv[f - 1]);
    rawFlux[f] = 0.65 * dl + 0.35 * df;
    lowFlux[f] = dl;
  }

  // Adaptive local mean subtraction (window = ±20 frames = ±0.2s)
  const flux = new Float32Array(frameCount);
  const win = 20;
  let runningSum = 0;
  let maxFlux = 0;
  for (let f = 0; f < frameCount; f++) {
    if (f === 0) {
      for (let k = 0; k <= Math.min(frameCount - 1, win); k++) runningSum += rawFlux[k];
    } else {
      const addIdx = f + win;
      const remIdx = f - win - 1;
      if (addIdx < frameCount) runningSum += rawFlux[addIdx];
      if (remIdx >= 0) runningSum -= rawFlux[remIdx];
    }
    const count = Math.min(frameCount - 1, f + win) - Math.max(0, f - win) + 1;
    const v = Math.max(0, rawFlux[f] - (runningSum / Math.max(1, count)) * 1.15);
    flux[f] = v;
    if (v > maxFlux) maxFlux = v;
  }

  if (maxFlux < 1e-5) {
    return { bpm: 120, offset: 0, duration, beatsPerBar, markers: [] };
  }
  for (let f = 0; f < frameCount; f++) flux[f] /= maxFlux;

  // 3. Tempo estimation via autocorrelation across 65..185 BPM
  const minLag = Math.max(10, Math.round((60 / 185) * envRate));
  const maxLag = Math.min(Math.floor(frameCount / 3), Math.round((60 / 65) * envRate));
  let bestLag = Math.round((60 / 120) * envRate);
  let bestScore = -1;

  // Analyze up to the first 90 seconds for fast, stable tempo estimation
  const corrLen = Math.min(frameCount, Math.round(90 * envRate));
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = corrLen - lag;
    for (let i = 0; i < limit; i++) {
      sum += flux[i] * flux[i + lag];
    }
    const norm = limit > 0 ? sum / limit : 0;
    // Gentle Gaussian prior around 120 BPM (sigma ~ 38 BPM) to avoid half/double-time errors
    const candBpm = (60 * envRate) / lag;
    const prior = Math.exp(-0.5 * Math.pow((candBpm - 120) / 42, 2));
    // Also add harmonic reinforcement at 2x lag (two-beat / bar periodicity)
    let harm = 0;
    if (lag * 2 < corrLen) {
      const lim2 = corrLen - lag * 2;
      for (let i = 0; i < lim2; i++) harm += flux[i] * flux[i + lag * 2];
      harm /= Math.max(1, lim2);
    }
    const score = (norm + 0.35 * harm) * (0.72 + 0.28 * prior);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Parabolic refinement around bestLag for sub-frame BPM accuracy
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const evalLag = (lag) => {
      let s = 0;
      const lim = corrLen - lag;
      for (let i = 0; i < lim; i++) s += flux[i] * flux[i + lag];
      return lim > 0 ? s / lim : 0;
    };
    const y0 = evalLag(bestLag - 1);
    const y1 = evalLag(bestLag);
    const y2 = evalLag(bestLag + 1);
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-9) {
      const delta = Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom));
      refinedLag = bestLag + delta;
    }
  }

  const bpm = Math.round(((60 * envRate) / refinedLag) * 10) / 10;
  const beatFrames = (60 / bpm) * envRate;

  // 4. Phase alignment: find the beat phase (0 .. beatFrames) maximizing onset energy
  const phaseSteps = Math.max(12, Math.round(beatFrames));
  let bestPhase = 0;
  let bestPhaseScore = -1;
  const phaseLimit = Math.min(frameCount, Math.round(90 * envRate));
  for (let p = 0; p < phaseSteps; p++) {
    let score = 0;
    let hits = 0;
    for (let pos = p; pos < phaseLimit - 1; pos += beatFrames) {
      const idx = Math.round(pos);
      const local = Math.max(
        flux[Math.max(0, idx - 1)] || 0,
        flux[idx] || 0,
        flux[Math.min(frameCount - 1, idx + 1)] || 0
      );
      score += local;
      hits++;
    }
    const avg = hits > 0 ? score / hits : 0;
    if (avg > bestPhaseScore) {
      bestPhaseScore = avg;
      bestPhase = p;
    }
  }

  // 5. Downbeat selection: pick which beat mod beatsPerBar has strongest low-frequency kick energy
  let bestBarMod = 0;
  let bestBarScore = -1;
  for (let m = 0; m < beatsPerBar; m++) {
    let score = 0;
    let hits = 0;
    let idxNum = 0;
    for (let pos = bestPhase; pos < phaseLimit - 1; pos += beatFrames) {
      if (idxNum % beatsPerBar === m) {
        const idx = Math.round(pos);
        score += (lowFlux[idx] || 0) + 0.5 * (lowEnv[idx] || 0);
        hits++;
      }
      idxNum++;
    }
    const avg = hits > 0 ? score / hits : 0;
    if (avg > bestBarScore) {
      bestBarScore = avg;
      bestBarMod = m;
    }
  }

  const beatDur = 60 / bpm;
  let offset = (bestPhase / envRate) + bestBarMod * beatDur;
  // Pull offset back to the first bar >= 0 if possible
  const barDur = beatDur * beatsPerBar;
  while (offset - barDur >= -0.005) offset -= barDur;
  offset = Math.max(0, Math.round(offset * 1000) / 1000);

  // 6. Generate editable markers (downbeats + beats)
  const markers = [];
  const firstBeat = offset - Math.floor(offset / beatDur) * beatDur;
  let beatIndex = -Math.floor(offset / beatDur);
  for (let t = firstBeat; t <= duration + 0.001; t += beatDur) {
    const time = Math.round(Math.max(0, t) * 1000) / 1000;
    const mod = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const kind = mod === 0 ? 'downbeat' : 'beat';
    const bar = Math.floor(beatIndex / beatsPerBar) + 1;
    markers.push({
      id: `bm_${markers.length + 1}`,
      time,
      kind,
      bar: Math.max(1, bar),
      beat: mod + 1,
    });
    beatIndex++;
  }

  return { bpm, offset, duration, beatsPerBar, markers };
}

function detectBeats(filePath, { ffmpeg = 'ffmpeg', beatsPerBar = 4 } = {}) {
  const key = `${filePath}|${beatsPerBar}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, [
        '-v', 'error',
        '-i', filePath,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 's16le',
        'pipe:1',
      ], { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message });
    }

    const chunks = [];
    let totalBytes = 0;
    child.stdout.on('data', (chunk) => {
      if (totalBytes >= MAX_BYTES) return;
      const take = totalBytes + chunk.length > MAX_BYTES ? chunk.subarray(0, MAX_BYTES - totalBytes) : chunk;
      chunks.push(take);
      totalBytes += take.length;
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const pcm = chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0);
      const analysis = analyzeBeatsFromPcm(pcm, { sampleRate: SAMPLE_RATE, beatsPerBar });
      const res = { ok: true, ...analysis };
      setCache(key, res);
      resolve(res);
    });
  });
}

module.exports = { SAMPLE_RATE, analyzeBeatsFromPcm, detectBeats };
