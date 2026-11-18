// The progress strip at the bottom of the window. It shows the newest running task, its label,
// and a bar that fills as the task moves forward. Other running tasks are counted next to it.
// Listens for "zaude:task" events (tasks.js) and for the text to video events (ai-ui.js).
const bar = document.getElementById('taskbar');
const tasks = new Map(); // id -> { label, progress, order }
let order = 0;

function render() {
  if (!bar) return;
  const list = [...tasks.values()].sort((a, b) => b.order - a.order);
  if (!list.length) {
    bar.hidden = true;
    return;
  }
  const top = list[0];
  const pct = typeof top.progress === 'number' ? Math.round(top.progress * 100) : null;
  bar.hidden = false;
  bar.querySelector('.task-label').textContent = top.label;
  bar.querySelector('.task-pct').textContent = pct === null ? '' : pct + '%';
  bar.querySelector('.task-track').classList.toggle('indeterminate', pct === null);
  bar.querySelector('.task-fill').style.width = pct === null ? '' : pct + '%';
  bar.querySelector('.task-more').textContent = list.length > 1 ? `+${list.length - 1} more` : '';
  bar.setAttribute('aria-label', `${top.label}${pct === null ? '' : ', ' + pct + '%'}`);
}

function upsert(id, patch) {
  const prev = tasks.get(id);
  tasks.set(id, {
    label: patch.label ?? prev?.label ?? '',
    progress: 'progress' in patch ? patch.progress : (prev ? prev.progress : null),
    order: prev ? prev.order : ++order,
  });
  render();
}

window.addEventListener('zaude:task', (e) => {
  const d = e.detail || {};
  if (!d.id) return;
  if (d.done) {
    tasks.delete(d.id);
    render();
    return;
  }
  upsert(d.id, d);
});

// The text to video render reports through zaude:t2v (see ai-ui.js and actions.generationEvent).
window.addEventListener('zaude:t2v', (e) => {
  const d = e.detail || {};
  if (d.type === 'start') return upsert('t2v', { label: `Generating a ${d.seconds} s clip with Mannimmate`, progress: null });
  if (d.type === 'progress') return upsert('t2v', { label: d.label || 'Generating clip', progress: typeof d.progress === 'number' ? d.progress : null });
  if (d.type === 'done' || d.type === 'error' || d.type === 'cancelled') {
    tasks.delete('t2v');
    render();
  }
});
