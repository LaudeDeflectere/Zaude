// Ctrl controls for values. Hold Ctrl and drag, or Ctrl and scroll, over a value to change it.
// - Clip blocks on the timeline: Ctrl + vertical scroll changes the clip's volume. Ctrl + horizontal
//   scroll changes the clip's length, and Shift and Alt scroll move and slip it (see gestures below).
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
    if (blk && e.ctrlKey) {
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
    const onTimeline = e.target.closest('.timeline .scroller');
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
