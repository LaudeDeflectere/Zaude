// Drag a bin tile onto a timeline track. Pointer events are used (not HTML5 drag), so the drag works the
// same in the desktop app and the browser preview. While dragging, a line shows where the clip will start,
// snapped to clip edges when snapping is on. Releasing over a track adds the file there.
const DRAG_START_PX = 5;

export function installBinDrag(root, { store, actions }) {
  root.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.bin-tile[data-bin]');
    if (!tile || e.button !== 0) return;
    const path = tile.dataset.bin;
    const name = tile.getAttribute('title') || path;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost = null;
    let line = null;
    let hilite = null;

    const dropAt = (x, y) => {
      const trk = document.elementFromPoint(x, y)?.closest('.trk[data-track]');
      const canvas = document.querySelector('.timeline .canvas');
      if (!trk || !canvas) return null;
      const s = store.get();
      const t = (x - canvas.getBoundingClientRect().left) / s.pps;
      return { track: trk.dataset.track, trk, time: actions.snapTime(Math.max(0, t), s.pps) };
    };

    const showLine = (drop) => {
      const scroller = document.querySelector('.timeline .scroller');
      if (!drop || !scroller) {
        if (line) line.hidden = true;
        if (hilite) hilite.classList.remove('drop-target');
        hilite = null;
        return;
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'drop-line';
        document.body.appendChild(line);
      }
      const canvasLeft = document.querySelector('.timeline .canvas').getBoundingClientRect().left;
      const r = scroller.getBoundingClientRect();
      line.hidden = false;
      line.style.left = canvasLeft + drop.time * store.get().pps + 'px';
      line.style.top = r.top + 'px';
      line.style.height = r.height + 'px';
      if (hilite !== drop.trk) {
        if (hilite) hilite.classList.remove('drop-target');
        drop.trk.classList.add('drop-target');
        hilite = drop.trk;
      }
    };

    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = name;
        document.body.appendChild(ghost);
        tile.classList.add('dragging');
      }
      ghost.style.left = ev.clientX + 14 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      showLine(dropAt(ev.clientX, ev.clientY));
    };

    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      ghost?.remove();
      line?.remove();
      hilite?.classList.remove('drop-target');
      tile.classList.remove('dragging');
    };

    const up = (ev) => {
      const drop = ghost ? dropAt(ev.clientX, ev.clientY) : null;
      finish();
      if (drop) actions.addBinItemAt(path, drop.track, drop.time);
    };
    const cancel = () => finish();

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}
