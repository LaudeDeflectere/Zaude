// Starts the editor: state, playback, the window layout, panels, and keyboard shortcuts.
import * as T from './timeline.js';
import { createStore } from './store.js';
import { createEngine } from './engine.js';
import { createActions, initialState } from './actions.js';
import { createWorkspace } from './workspace.js';
import { PANEL_BUILDERS } from './panels.js';
import { installScrub } from './scrub.js';
import { createThumbCache } from './thumbs.js';
import { createWaveformCache } from './waveform.js';
import { installAgentBridge } from './agent-bridge.js';
import { initAudioPortal } from './audio-portal.js';

const store = createStore(initialState());
const engine = createEngine(store);
const actions = createActions(store, engine);
const thumbs = createThumbCache({
  getMediaUrl: engine.getMediaUrl,
  isPaused: () => Boolean(store.get().playing),
});
store.subscribe((s) => {
  if (!s.playing) thumbs.resume();
});
const waveforms = createWaveformCache({
  fetchWaveform: (filePath) => (window.zaudeProject && window.zaudeProject.waveform ? window.zaudeProject.waveform(filePath) : Promise.resolve(null)),
});

const ctx = {
  store,
  actions,
  engine,
  thumbs,
  waveforms,
  openRemote: () => document.getElementById('remote-open').click(),
};

const workspaceEl = document.getElementById('workspace');
const workspace = createWorkspace(workspaceEl, {
  store,
  createPanel: (type) => PANEL_BUILDERS[type](ctx),
  onLayoutChange: () => engine.sync(),
});
ctx.workspace = workspace;
workspace.init();
installScrub(workspaceEl, { store, actions });
installAgentBridge({ store, actions, workspace });
initAudioPortal({ store, actions });

document.getElementById('windows-open').addEventListener('click', (e) => {
  workspace.openWindowsMenu(e.currentTarget);
});
document.getElementById('open-zd').addEventListener('click', () => actions.openZd());
document.getElementById('save-zd').addEventListener('click', (e) => actions.saveZd(e.shiftKey));
// Floating AI Chat window (draggable, resizable, toggleable from top bar)
let floatingChatPanel = null;
const chatFloat = document.getElementById('aichat-float');
const chatFloatBody = document.getElementById('aichat-float-body');
const chatFloatHead = document.getElementById('aichat-float-head');
document.getElementById('aichat-open').addEventListener('click', () => {
  if (!chatFloat || !chatFloatBody) return workspace.ensurePanel('aichat');
  if (!floatingChatPanel) {
    floatingChatPanel = PANEL_BUILDERS.aichat(ctx);
    chatFloatBody.appendChild(floatingChatPanel.el);
    if (floatingChatPanel.update) floatingChatPanel.update(store.get());
  }
  chatFloat.hidden = !chatFloat.hidden;
});
document.getElementById('aichat-float-close')?.addEventListener('click', () => { if (chatFloat) chatFloat.hidden = true; });
document.getElementById('aichat-float-dock')?.addEventListener('click', () => {
  if (chatFloat) chatFloat.hidden = true;
  workspace.ensurePanel('aichat');
});
if (chatFloatHead && chatFloat) {
  chatFloatHead.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const r = chatFloat.getBoundingClientRect();
    const ox = e.clientX - r.left;
    const oy = e.clientY - r.top;
    chatFloat.style.right = 'auto';
    chatFloat.style.bottom = 'auto';
    chatFloat.style.left = r.left + 'px';
    chatFloat.style.top = r.top + 'px';
    const onMove = (ev) => {
      chatFloat.style.left = Math.max(8, Math.min(window.innerWidth - 120, ev.clientX - ox)) + 'px';
      chatFloat.style.top = Math.max(8, Math.min(window.innerHeight - 60, ev.clientY - oy)) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
document.getElementById('help-open').addEventListener('click', () => workspace.ensurePanel('help'));
document.getElementById('export-top').addEventListener('click', () => {
  workspace.ensurePanel('inspector');
  actions.toggleExport();
});

// Expose active timeline clip info for AI Studio's Stylize segment picker
window.__zaudeGetStylizeSource = async () => {
  const s = store.get();
  const sel = s.selected ? T.findClip(s.clips, s.selected) : null;
  const atHead = T.clipAt(s.clips.filter((c) => c.kind === 'video' && c.path), s.playhead);
  const clip = (sel && sel.kind === 'video' && sel.path) ? sel : (atHead || s.clips.find((c) => c.kind === 'video' && c.path));
  if (!clip) return null;
  const url = await engine.getMediaUrl(clip.path);
  const srcDur = Number(clip.srcDur) || Number(clip.dur) || 10;
  const segStart = Math.max(0, Math.round((Number(clip.srcIn) || 0) * 100) / 100);
  const segEnd = Math.min(srcDur, Math.round((segStart + Math.min(clip.dur || 5, 7)) * 100) / 100);
  return {
    clipId: clip.id,
    name: clip.name,
    path: clip.path,
    url,
    srcDur,
    clipStart: clip.start,
    start: segStart,
    end: Math.max(segStart + 0.5, segEnd),
  };
};

// AI render events come from the text to video dialog (ai-ui.js)
window.addEventListener('zaude:t2v', (e) => actions.generationEvent(e.detail));

// keyboard shortcuts, ignored while typing or in a dialog
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.target.closest('.modal')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); return e.shiftKey ? actions.redo() : actions.undo(); }
  if (mod && key === 'y') { e.preventDefault(); return actions.redo(); }
  if (mod && key === 's') { e.preventDefault(); return actions.saveZd(e.shiftKey); }
  if (mod && key === 'o') { e.preventDefault(); return actions.openZd(); }
  if (mod) return;
  if (e.key === 'Escape' && store.get().eyedropper) { e.preventDefault(); return actions.setEyedropper(false); }
  if (e.key === ' ') { e.preventDefault(); return actions.togglePlay(); }
  if (key === 's') { e.preventDefault(); return actions.split(); }
  if (key === 'm') { e.preventDefault(); return actions.addBeatMarker(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); return actions.stepBy(e.shiftKey ? -1 : -1 / T.FPS); }
  if (e.key === 'ArrowRight') { e.preventDefault(); return actions.stepBy(e.shiftKey ? 1 : 1 / T.FPS); }
  if (e.key === 'Home') { e.preventDefault(); return actions.seekTo(0); }
  if (e.key === 'End') { e.preventDefault(); return actions.seekTo(T.projectEnd(store.get().clips)); }
  if (e.key === '=' || e.key === '+') return actions.zoomIn();
  if (e.key === '-' || e.key === '_') return actions.zoomOut();
  if (e.key === 'Delete' || e.key === 'Backspace') { if (store.get().selected) actions.deleteSelected(); }
});

// the wheel and drag gestures are installed by installScrub; the Windows menu closes itself on outside clicks
window.zaudeEditor = { store, actions, engine, workspace };
