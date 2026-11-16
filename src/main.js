// Starts the editor: state, playback, the window layout, panels, and keyboard shortcuts.
import { createStore } from './store.js';
import { createEngine } from './engine.js';
import { createActions, initialState } from './actions.js';
import { createWorkspace } from './workspace.js';
import { PANEL_BUILDERS } from './panels.js';
import { installScrub } from './scrub.js';
import { installBinDrag } from './dragdrop.js';

const store = createStore(initialState());
const engine = createEngine(store);
const actions = createActions(store, engine);

const ctx = {
  store,
  actions,
  engine,
  openRemote: () => document.getElementById('remote-open').click(),
};

const workspaceEl = document.getElementById('workspace');
const workspace = createWorkspace(workspaceEl, {
  store,
  createPanel: (type) => PANEL_BUILDERS[type](ctx),
});
workspace.init();
installScrub(workspaceEl, { store, actions });
installBinDrag(workspaceEl, { store, actions });

document.getElementById('windows-open').addEventListener('click', (e) => {
  workspace.openWindowsMenu(e.currentTarget);
});
document.getElementById('export-top').addEventListener('click', () => actions.exportRender());

// AI render events come from the text to video dialog (ai-ui.js)
window.addEventListener('zaude:t2v', (e) => actions.generationEvent(e.detail));

// keyboard shortcuts, ignored while typing or in a dialog
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.target.closest('.modal')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); return e.shiftKey ? actions.redo() : actions.undo(); }
  if (mod && key === 'y') { e.preventDefault(); return actions.redo(); }
  if (mod) return;
  if (e.key === ' ') { e.preventDefault(); return actions.togglePlay(); }
  if (e.key === '=' || e.key === '+') return actions.zoomIn();
  if (e.key === '-' || e.key === '_') return actions.zoomOut();
  if (e.key === 'Delete' || e.key === 'Backspace') { if (store.get().selected) actions.deleteSelected(); }
});

// the wheel and drag gestures are installed by installScrub; the Windows menu closes itself on outside clicks
window.zaudeEditor = { store, actions, engine, workspace };
