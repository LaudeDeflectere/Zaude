// Ctrl controls for values. Hold Ctrl and drag, or Ctrl and scroll, over a value to change it.
// - Timeline: Ctrl + vertical scroll zooms the time axis around the cursor, like FL Studio.
//   Ctrl + horizontal scroll changes the selected clip's length. Shift and Alt scroll move and slip it.
// - Clip blocks on the timeline: Alt + vertical scroll changes the clip's volume.
// - Value fields (the inspector): Ctrl + any direction changes the value.
import * as T from './timeline.js';

export const SENS_WHEEL = 0.002; // value per scroll pixel
export const SENS_DRAG = 0.005;  // value per dragged pixel

// The scroll amount along the dominant axis, positive meaning "up" or "right".
export function dominantScroll(e) {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
  const px = (vertical ? -e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
  return { vertical, px };
}

export function scrubbedValue(clip, prop, amount) {
  const def = T.PROPS[prop];
  const v = T.propValue(clip, prop) + amount;
  return Math.min(def.max, Math.max(def.min, v));
}

// Trackpad length/move/slip gestures on the timeline (Ctrl, Shift, Alt with a horizontal swipe).
export function gestureMode(e) {
  if (e.ctrlKey) return 'length';
  if (e.shiftKey) return 'move';
  if (e.altKey) return 'slip';
  return null;
}

export function installScrub(root, { store, actions }) {
  // Zooms the time axis by one wheel step, keeping the time under the cursor where it was.
  function zoomTimeline(scroller, e) {
    const before = store.get().pps;
    actions.setZoom(before * T.zoomFactor(e.deltaY, e.deltaMode));
    const after = store.get().pps;
    const anchor = e.clientX - scroller.getBoundingClientRect().left;
    scroller.scrollLeft = T.zoomScrollLeft(before, after, scroller.scrollLeft, anchor);
  }

  // Ctrl + scroll over a value (inspector) or a clip block (timeline volume)
  root.addEventListener('wheel', (e) => {
    const s = store.get();
    const field = e.target.closest('[data-scrub-prop]');
    const blk = e.target.closest('.blk[data-clip]');
    if (field && e.ctrlKey) {
      e.preventDefault();
      const clip = T.findClip(s.clips, field.dataset.scrubClip);
      if (!clip) return;
      const prop = field.dataset.scrubProp;
      const { px } = dominantScroll(e);
      actions.setProp(clip.id, prop, scrubbedValue(clip, prop, px * SENS_WHEEL));
      return;
    }
    // Ctrl + vertical scroll on the timeline zooms the time axis. Ctrl + horizontal falls through to length.
    const scroller = e.target.closest('.timeline .scroller');
    if (scroller && e.ctrlKey && dominantScroll(e).vertical) {
      e.preventDefault();
      zoomTimeline(scroller, e);
      return;
    }
    // Alt + vertical scroll on a clip changes its volume
    if (blk && e.altKey) {
      const { vertical, px } = dominantScroll(e);
      if (vertical) {
        e.preventDefault();
        const clip = T.findClip(s.clips, blk.dataset.clip);
        if (clip && (clip.kind === 'audio' || clip.kind === 'video')) {
          actions.setProp(clip.id, 'volume', scrubbedValue(clip, 'volume', px * SENS_WHEEL));
        }
        return;
      }
    }
    // length, move, and slip on the selected clip
    const onTimeline = scroller;
    const mode = onTimeline ? gestureMode(e) : null;
    if (mode) {
      const { px } = { px: e.deltaX * (e.deltaMode === 1 ? 16 : 1) };
      if (Math.abs(px) <= Math.abs(e.deltaY)) { e.preventDefault(); return; } // pinch and vertical scroll
      e.preventDefault();
      actions.gesture(mode, px, e.deltaX);
    }
  }, { passive: false });

  // Ctrl + drag over a value field
  root.addEventListener('pointerdown', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field || !e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    const s = store.get();
    const clip = T.findClip(s.clips, field.dataset.scrubClip);
    if (!clip) return;
    const prop = field.dataset.scrubProp;
    const start = T.propValue(clip, prop);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      const amount = ((ev.clientX - x0) - (ev.clientY - y0)) * SENS_DRAG;
      actions.setProp(clip.id, prop, Math.min(T.PROPS[prop].max, Math.max(T.PROPS[prop].min, start + amount)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
