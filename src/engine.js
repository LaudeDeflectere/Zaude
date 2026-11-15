// Playback engine: one video element for the picture and sound of the topmost video clip,
// one audio element per audio clip, and a clock that moves the playhead while playing.
// Media files are played through the desktop app's media route (window.zaudeAI.mediaUrl).
import * as T from './timeline.js';

const EPS_SEEK = 0.15; // seconds of drift allowed before the media is moved

export function createEngine(store) {
  const video = document.createElement('video');
  video.className = 'program-video';
  video.playsInline = true;
  video.preload = 'auto';
  video.hidden = true;

  const urlCache = new Map();
  let videoClipId = null;
  let videoToken = 0;
  let audioCtx = null;
  const videoGain = { node: null, tried: false };
  const audioEls = new Map(); // clip id -> { el, gain, path, token }
  let rafId = 0;
  let lastTs = 0;

  const zaudioApi = () => window.zaudeAI || null;

  async function urlFor(filePath) {
    if (urlCache.has(filePath)) return urlCache.get(filePath);
    const api = zaudioApi();
    if (!api || !api.mediaUrl) return null;
    const res = await api.mediaUrl(filePath);
    const url = res && res.ok ? res.url : null;
    if (url) urlCache.set(filePath, url);
    return url;
  }

  function context() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // Routes an element through a gain node so volume can go above 100%.
  function gainFor(el) {
    const ctx = context();
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    return gain;
  }

  const srcTime = (c, t) => c.srcIn + (t - c.start) * (c.speed || 1);
  const isActive = (c, t) => t >= c.start - 1e-6 && t < c.start + c.dur - 1e-6;

  function setGain(gain, clip) {
    if (!gain) return;
    gain.gain.value = clip.muted ? 0 : T.propValue(clip, 'volume');
  }

  function seek(el, want) {
    if (Math.abs(el.currentTime - want) > EPS_SEEK || el.paused) {
      try { el.currentTime = Math.max(0, want); } catch { /* not loaded yet */ }
    }
  }

  function sync() {
    const s = store.get();
    const t = s.playhead;
    const playing = !!s.playing;

    // picture and sound of the topmost video clip with a file
    const vc = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), t);
    if (!vc) {
      video.hidden = true;
      if (!video.paused) video.pause();
      videoClipId = null;
    } else {
      if (videoClipId !== vc.id) {
        videoClipId = vc.id;
        const token = ++videoToken;
        urlFor(vc.path).then((url) => {
          if (token !== videoToken || !url) return;
          if (video.src !== url) video.src = url;
        });
      }
      video.hidden = false;
      video.style.opacity = String(T.propValue(vc, 'opacity'));
      video.style.transform = `scale(${T.propValue(vc, 'zoom')})`;
      const rate = Math.min(16, Math.max(0.1, vc.speed || 1)); // browsers refuse rates outside about 0.1 to 16
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (!videoGain.tried) {
        videoGain.tried = true;
        try { videoGain.node = gainFor(video); } catch { videoGain.node = null; }
      }
      setGain(videoGain.node, vc);
      seek(video, srcTime(vc, t));
      if (playing && video.paused) video.play().catch(() => {});
      if (!playing && !video.paused) video.pause();
    }

    // audio clips: one element each, created when first needed
    const active = new Set();
    for (const c of s.clips) {
      if (c.kind !== 'audio' || !c.path) continue;
      if (!isActive(c, t)) continue;
      active.add(c.id);
      let entry = audioEls.get(c.id);
      if (!entry || entry.path !== c.path) {
        const el = entry ? entry.el : document.createElement('audio');
        entry = { el, gain: entry ? entry.gain : null, path: c.path, token: 0 };
        audioEls.set(c.id, entry);
        const token = ++entry.token;
        urlFor(c.path).then((url) => {
          if (!url || entry.token !== token) return;
          el.src = url;
        });
      }
      if (!entry.gain && !entry.gainTried) {
        entry.gainTried = true;
        try { entry.gain = gainFor(entry.el); } catch { entry.gain = null; }
      }
      setGain(entry.gain, c);
      seek(entry.el, srcTime(c, t));
      if (playing && entry.el.paused) entry.el.play().catch(() => {});
      if (!playing && !entry.el.paused) entry.el.pause();
    }
    for (const [id, entry] of audioEls) {
      if (!active.has(id) && !entry.el.paused) entry.el.pause();
    }
  }

  function stopClock() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function tick(ts) {
    const s = store.get();
    if (!s.playing) { stopClock(); return; }
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const end = T.projectEnd(s.clips);
    if (s.playhead + dt >= end) {
      store.setTime(end);
      store.set({ playing: false });
      sync();
      stopClock();
      return;
    }
    store.setTime(s.playhead + dt);
    sync();
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (store.get().playing) return;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    lastTs = performance.now();
    store.set({ playing: true });
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    if (!store.get().playing) return;
    store.set({ playing: false });
    stopClock();
    sync();
  }

  function toggle() {
    if (store.get().playing) pause();
    else play();
  }

  // Changes the playhead without playing: used by the ruler, the scrub bar, and the keyboard.
  function seekTo(t) {
    const end = T.projectEnd(store.get().clips);
    store.setTime(Math.min(end, Math.max(0, t)));
    sync();
  }

  store.subscribe(() => sync());
  store.subscribeTime(() => sync());

  return { video, play, pause, toggle, seekTo, sync };
}
