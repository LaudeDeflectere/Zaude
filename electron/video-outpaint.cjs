// Video Outpainting & Virtual Camera Pullback pre-processor for Zaude Stylize (MiniMax-H3 RV2V).
// Converts portrait <-> landscape (or pulls the camera back 1-2 steps) by placing the source video
// centered over a softly blurred, color-matched ambient extension (never hard black bars!) so
// MiniMax-H3 hallucinate/outpaints sharp, consistent scene & body detail into the expanded canvas.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ASPECT_TARGETS = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 960, height: 960 },
};

const even = (n) => Math.max(64, Math.round(n / 2) * 2);

function probeVideoSize(filePath, ffprobe = 'ffprobe') {
  return new Promise((resolve) => {
    execFile(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      filePath,
    ], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ width: 1280, height: 720 });
      const m = String(stdout || '').trim().match(/^(\d+)x(\d+)/);
      if (!m) return resolve({ width: 1280, height: 720 });
      resolve({ width: Number(m[1]) || 1280, height: Number(m[2]) || 720 });
    });
  });
}

function buildOutpaintFilter({ srcWidth = 720, srcHeight = 1280, targetAspect = 'keep', pullback = 1.0 } = {}) {
  const aspect = ['keep', '16:9', '9:16', '1:1'].includes(targetAspect) ? targetAspect : 'keep';
  const zoom = Math.max(0.4, Math.min(1.0, Number(pullback) || 1.0));
  const target = aspect === 'keep'
    ? { width: even(srcWidth), height: even(srcHeight) }
    : ASPECT_TARGETS[aspect];

  // Fit foreground inside target canvas, then apply virtual camera pullback factor (e.g. 0.80 = 1 step back)
  const fitScale = Math.min(target.width / Math.max(1, srcWidth), target.height / Math.max(1, srcHeight));
  const fgW = even(srcWidth * fitScale * zoom);
  const fgH = even(srcHeight * fitScale * zoom);

  const filterComplex = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},boxblur=36:4,eq=brightness=-0.03:saturation=0.92[bgb]`,
    `[fg]scale=${fgW}:${fgH}:flags=lanczos[fgs]`,
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1[vout]`,
  ].join(';');

  return {
    width: target.width,
    height: target.height,
    fgWidth: fgW,
    fgHeight: fgH,
    aspect,
    pullback: zoom,
    filterComplex,
  };
}

function buildOutpaintPromptNote({ outpaintAspect = 'keep', cameraPullback = 1.0 } = {}) {
  const aspect = ['keep', '16:9', '9:16', '1:1'].includes(outpaintAspect) ? outpaintAspect : 'keep';
  const zoom = Math.max(0.4, Math.min(1.0, Number(cameraPullback) || 1.0));
  const notes = [];
  if (aspect !== 'keep') {
    const dir = aspect === '16:9' ? 'left and right sides into a wide 16:9 landscape cinema frame'
      : (aspect === '9:16' ? 'top and bottom into a full 9:16 vertical portrait frame' : 'outer edges into a full 1:1 square frame');
    notes.push(`Outpaint and seamlessly extend the scene across the ${dir}`);
  }
  if (zoom < 0.99) {
    const stepLabel = zoom <= 0.55 ? 'a wide camera pullback showing the full environment and full body'
      : (zoom <= 0.72 ? 'two steps back with a wider camera view revealing much more of the room and body' : 'one step back with a wider framing revealing more of the surrounding scene');
    notes.push(`pull the camera back (${stepLabel}) while preserving the exact choreography, pose timing, and movement of <Video 1>`);
  }
  if (!notes.length) return '';
  return `CAMERA EXPANSION & OUTPAINT: ${notes.join(' and ')}. Invent sharp, coherent, photorealistic detail (architecture, furniture, props, clothing, limbs, lighting, and floor shadows) continuously across the entire frame — strictly NO black bars, NO blurred borders, NO picture-in-picture edges or seams.`;
}

async function prepareOutpaintedVideo({ videoPath, targetAspect = 'keep', pullback = 1.0, outPath, ffmpeg = 'ffmpeg' }) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, error: 'Source video not found for outpaint/pullback.' };
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const { width, height } = await probeVideoSize(videoPath);
  const spec = buildOutpaintFilter({ srcWidth: width, srcHeight: height, targetAspect, pullback });
  return new Promise((resolve) => {
    execFile(ffmpeg, [
      '-hide_banner', '-y',
      '-i', videoPath,
      '-filter_complex', spec.filterComplex,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      outPath,
    ], { windowsHide: true }, (err, _out, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || 'Outpaint pre-process failed').slice(0, 300) });
      resolve({ ok: true, path: outPath, ...spec });
    });
  });
}

module.exports = {
  buildOutpaintFilter,
  buildOutpaintPromptNote,
  prepareOutpaintedVideo,
};
