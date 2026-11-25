// Room Acoustics Presets & Continuous Room-Tone Bed Generator (100% local FFmpeg).
// Solves MiniMax-H3 audio room mismatch ("voices sounding outdoors / printer in another room")
// by applying calibrated proximity EQ + tight early-reflection room acoustics per clip
// and generating an unbroken Opus .ogg room-tone bed for track A2.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOM_PRESETS = {
  none: {
    id: 'none',
    label: 'None (Original Audio)',
    icon: '—',
    description: 'Leave clip audio completely untouched.',
    toneDb: -40,
  },
  'dim-bar': {
    id: 'dim-bar',
    label: 'Dim Wooden Bar / Billiard Hall',
    icon: '🍺',
    description: 'Warm close-mic wood room body, rolls off outdoor hiss, tight 18ms/37ms wooden early reflections.',
    eq: 'highpass=f=85,equalizer=f=210:t=q:w=1.2:g=2.5,equalizer=f=3400:t=q:w=1.4:g=-1.5,lowpass=f=9500',
    delaysMs: [18, 37],
    decays: [0.22, 0.11],
    toneColor: 'brown',
    toneFilter: 'highpass=f=65,lowpass=f=480,equalizer=f=140:t=q:w=1.0:g=3,volume=-32dB',
  },
  'small-office': {
    id: 'small-office',
    label: 'Small Office / Back-Bar Nook',
    icon: '🖨️',
    description: 'Tight enclosed office nook reflections (11ms/23ms), subtle desk proximity warmth, tames harsh clatter.',
    eq: 'highpass=f=90,equalizer=f=240:t=q:w=1.1:g=2.0,equalizer=f=5200:t=q:w=1.5:g=-2.0,lowpass=f=9000',
    delaysMs: [11, 23],
    decays: [0.24, 0.12],
    toneColor: 'pink',
    toneFilter: 'highpass=f=80,lowpass=f=900,equalizer=f=180:t=q:w=2.0:g=4,volume=-35dB',
  },
  'outdoor-street': {
    id: 'outdoor-street',
    label: 'Outdoor Street / Afternoon Air',
    icon: '🌳',
    description: 'Clean wind low-cut, crisp open-air top end, zero indoor reflection tail.',
    eq: 'highpass=f=115,equalizer=f=6500:t=q:w=1.2:g=1.5',
    delaysMs: [],
    decays: [],
    toneColor: 'pink',
    toneFilter: 'highpass=f=140,lowpass=f=2600,volume=-36dB',
  },
  hallway: {
    id: 'hallway',
    label: 'Tiled Hallway / Corridor',
    icon: '🚪',
    description: 'Reflective hard-surface corridor reflections (35ms/78ms/125ms) with crisp midrange.',
    eq: 'highpass=f=95,equalizer=f=1200:t=q:w=1.3:g=1.8,lowpass=f=11000',
    delaysMs: [35, 78, 125],
    decays: [0.26, 0.15, 0.08],
    toneColor: 'brown',
    toneFilter: 'highpass=f=70,lowpass=f=700,volume=-36dB',
  },
  'podcast-booth': {
    id: 'podcast-booth',
    label: 'Studio / Podcast Booth',
    icon: '🎙️',
    description: 'Tight broadcast vocal warmth, de-boomed lows, clean presence, zero room echo.',
    eq: 'highpass=f=80,equalizer=f=170:t=q:w=1.1:g=2.2,equalizer=f=3200:t=q:w=1.2:g=1.6,acompressor=threshold=-18dB:ratio=2.5:attack=10:release=120',
    delaysMs: [],
    decays: [],
    toneColor: 'brown',
    toneFilter: 'highpass=f=60,lowpass=f=300,volume=-44dB',
  },
};

function listRoomPresets() {
  return Object.values(ROOM_PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    icon: p.icon,
    description: p.description,
  }));
}

function buildRoomFilter(presetId = 'none', intensity = 1.0) {
  const preset = ROOM_PRESETS[String(presetId || 'none')];
  if (!preset || preset.id === 'none') return '';
  const mix = Math.max(0, Math.min(1, Number.isFinite(Number(intensity)) ? Number(intensity) : 1.0));
  if (mix <= 0.01) return '';

  const parts = [];
  if (preset.eq) parts.push(preset.eq);
  if (Array.isArray(preset.delaysMs) && preset.delaysMs.length) {
    const delays = preset.delaysMs.join('|');
    const decays = preset.decays.map((d) => Math.max(0.02, Math.min(0.85, Number((d * mix).toFixed(3))))).join('|');
    parts.push(`aecho=0.85:0.78:${delays}:${decays}`);
  }
  return parts.join(',');
}

// Generates a seamless continuous Opus .ogg room-tone bed for Zaude's A2 track.
function generateRoomToneBed({ presetId = 'dim-bar', durationSec = 30, outPath, ffmpeg = 'ffmpeg' }) {
  const preset = ROOM_PRESETS[String(presetId || 'dim-bar')] || ROOM_PRESETS['dim-bar'];
  const dur = Math.max(1, Math.min(3600, Number(durationSec) || 30));
  if (!outPath) return Promise.resolve({ ok: false, error: 'Output path is required.' });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const noiseColor = preset.toneColor || 'brown';
  const toneFilter = preset.toneFilter || 'highpass=f=70,lowpass=f=500,volume=-34dB';
  const fadeD = Math.min(0.8, dur * 0.15).toFixed(2);
  const fadeOutSt = Math.max(0, dur - Number(fadeD)).toFixed(2);
  const fullAf = `${toneFilter},afade=t=in:st=0:d=${fadeD},afade=t=out:st=${fadeOutSt}:d=${fadeD}`;

  const args = [
    '-hide_banner', '-y',
    '-f', 'lavfi',
    '-i', `anoisesrc=d=${dur.toFixed(2)}:c=${noiseColor}:r=48000:a=0.4`,
    '-af', fullAf,
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', '128k',
    outPath,
  ];

  return new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: (stderr || err.message || 'FFmpeg failed').trim().slice(0, 300) });
      }
      resolve({
        ok: true,
        path: outPath,
        presetId: preset.id,
        label: preset.label,
        duration: dur,
      });
    });
  });
}

module.exports = {
  ROOM_PRESETS,
  listRoomPresets,
  buildRoomFilter,
  generateRoomToneBed,
};
