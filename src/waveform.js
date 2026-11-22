// Frontend audio waveform / spectral graph cache and canvas renderer.
import { generateBeatGrid, volumeAt } from './timeline.js';

// Slices a file's full peaks/spectral arrays to the portion visible in `clip`.
export function sliceWaveform(data, clip) {
  if (!data || !Array.isArray(data.peaks) || !data.peaks.length) return { peaks: [], spectral: [] };
  const n = data.peaks.length;
  const srcDur = Number(clip && clip.srcDur) || Number(clip && clip.dur) || 0;
  if (srcDur <= 0) return { peaks: data.peaks, spectral: data.spectral || [] };

  const startSec = Math.max(0, Number(clip.srcIn) || 0);
  const usedSec = Math.max(0.01, (Number(clip.dur) || 0) * (Number(clip.speed) || 1));
  const startIdx = Math.max(0, Math.min(n - 1, Math.floor((startSec / srcDur) * n)));
  const endIdx = Math.max(startIdx + 1, Math.min(n, Math.ceil(((startSec + usedSec) / srcDur) * n)));

  return {
    peaks: data.peaks.slice(startIdx, endIdx),
    spectral: Array.isArray(data.spectral) ? data.spectral.slice(startIdx, endIdx) : [],
  };
}

// Draws a spectral-colored bar graph onto `canvas` for the given clip and waveform data,
// optionally overlaying beat/bar/subdivision ticks, fade-in/out ramps, and volume keyframes.
export function drawWaveform(canvas, data, clip, beats = null) {
  if (!canvas || !data) return;
  const sliced = sliceWaveform(data, clip);
  if (!sliced.peaks.length) return;

  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(16, Math.round(rect.width || canvas.clientWidth || 120));
  const cssH = Math.max(12, Math.round(rect.height || canvas.clientHeight || 28));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const barStep = Math.max(2 * dpr, Math.floor(3 * dpr));
  const barW = Math.max(1 * dpr, barStep - 1 * dpr);
  const bars = Math.max(1, Math.floor(w / barStep));
  const { peaks, spectral } = sliced;
  const n = peaks.length;
  const isAudioOnly = clip.kind === 'audio';
  const dur = Math.max(0.01, Number(clip.dur) || 0.01);
  const start = Number(clip.start) || 0;

  for (let i = 0; i < bars; i++) {
    const idx = Math.min(n - 1, Math.floor((i / bars) * n));
    const t = start + ((i + 0.5) / bars) * dur;
    const vol = volumeAt(clip, t);
    const amp = peaks[idx] * vol;
    const spec = spectral[idx] ?? 0.4;
    const clamped = Math.min(1, amp);
    const barH = Math.max(1.5 * dpr, clamped * (h - 2 * dpr));

    // Spectral color: low frequencies -> cyan/teal (#22D3EE), mid -> indigo, high -> bright violet (#C084FC)
    // Clipped (> 100% volume) -> warm coral (#FB7185)
    if (amp > 1.02) {
      ctx.fillStyle = 'rgba(251, 113, 133, 0.9)';
    } else {
      const r = Math.round(34 + spec * (178 - 34));
      const g = Math.round(211 - spec * (211 - 122));
      const b = Math.round(238 + spec * (252 - 238));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${isAudioOnly ? 0.85 : 0.82})`;
    }

    const x = i * barStep;
    const y = isAudioOnly ? (h - barH) / 2 : (h - barH);
    ctx.fillRect(x, y, barW, barH);
  }

  // Beat / downbeat / subdivision lines directly on the waveform
  if (beats && beats.enabled) {
    const grid = generateBeatGrid(beats, start + dur);
    for (const g of grid) {
      if (g.time < start - 1e-4 || g.time > start + dur + 1e-4) continue;
      const x = Math.round(((g.time - start) / dur) * w);
      if (g.kind === 'downbeat') {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.75)';
        ctx.fillRect(x, 0, Math.max(1.5 * dpr, 2), h);
      } else if (g.kind === 'beat') {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.32)';
        ctx.fillRect(x, 0, Math.max(1, dpr), h);
      } else if (w / dur > 35 * dpr) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fillRect(x, Math.round(h * 0.55), 1, Math.round(h * 0.45));
      }
    }
  }

  // Fade-in & fade-out ramp overlays
  const fadeIn = Math.max(0, Math.min(dur, Number(clip.fadeIn) || 0));
  const fadeOut = Math.max(0, Math.min(dur, Number(clip.fadeOut) || 0));
  if (fadeIn > 0.005) {
    const fw = Math.round((fadeIn / dur) * w);
    ctx.save();
    ctx.fillStyle = 'rgba(10, 12, 18, 0.52)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(fw, 0);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(fw, 0);
    ctx.stroke();
    ctx.restore();
  }
  if (fadeOut > 0.005) {
    const fw = Math.round((fadeOut / dur) * w);
    ctx.save();
    ctx.fillStyle = 'rgba(10, 12, 18, 0.52)';
    ctx.beginPath();
    ctx.moveTo(w, 0);
    ctx.lineTo(w - fw, 0);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.beginPath();
    ctx.moveTo(w - fw, 0);
    ctx.lineTo(w, h);
    ctx.stroke();
    ctx.restore();
  }

  // Volume keyframe envelope curve & keyframe dots
  const kfs = Array.isArray(clip.volumeKeyframes) ? clip.volumeKeyframes : [];
  if (kfs.length > 0 && !clip.muted) {
    const yForVol = (v) => {
      // Map 0..2 linear volume to bottom..top (above 200% clamps at top edge)
      const norm = Math.max(0, Math.min(1, v / 2));
      return Math.round((1 - norm) * (h - 6 * dpr) + 3 * dpr);
    };
    ctx.save();
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)';
    ctx.lineWidth = Math.max(1.5, 1.75 * dpr);
    ctx.beginPath();
    ctx.moveTo(0, yForVol(kfs[0].value));
    for (const kf of kfs) {
      const x = Math.round((kf.t / dur) * w);
      ctx.lineTo(x, yForVol(kf.value));
    }
    ctx.lineTo(w, yForVol(kfs[kfs.length - 1].value));
    ctx.stroke();

    for (const kf of kfs) {
      const x = Math.round((kf.t / dur) * w);
      const y = yForVol(kf.value);
      ctx.fillStyle = '#34d399';
      ctx.strokeStyle = '#0b1020';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, 3.2 * dpr), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function createWaveformCache({ fetchWaveform }) {
  const cache = new Map();
  const pending = new Map();

  function getCached(filePath) {
    return cache.get(filePath) || null;
  }

  function request(filePath) {
    if (!filePath || !fetchWaveform) return Promise.resolve(null);
    if (cache.has(filePath)) return Promise.resolve(cache.get(filePath));
    if (pending.has(filePath)) return pending.get(filePath);
    const p = Promise.resolve()
      .then(() => fetchWaveform(filePath))
      .then((res) => {
        const val = res && res.ok && Array.isArray(res.peaks) ? { peaks: res.peaks, spectral: res.spectral || [] } : null;
        cache.set(filePath, val);
        pending.delete(filePath);
        return val;
      })
      .catch(() => {
        cache.set(filePath, null);
        pending.delete(filePath);
        return null;
      });
    pending.set(filePath, p);
    return p;
  }

  return { getCached, request };
}
