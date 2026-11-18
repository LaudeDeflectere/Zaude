// Background work reports to the progress strip at the bottom of the window.
// Any part of the editor can call reportTask; the strip (taskbar.js) listens for the event.
// progress is 0 to 1 when known, null when the length of the work is not known.
export function reportTask(id, detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('zaude:task', { detail: { id, ...detail } }));
}

export function finishTask(id) {
  reportTask(id, { done: true });
}
