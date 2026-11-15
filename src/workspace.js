// Draws the window layout: areas separated by seams. Seams can be dragged to resize,
// clicked to add a window, and a window dragged below MIN_AREA_PX is removed.
import * as L from './layout.js';

const SAVE_KEY = 'zaude.layout';

export function createWorkspace(root, { createPanel, store }) {
  let tree = loadTree();
  const instances = new Map(); // area id -> { type, panel }
  let activeArea = null;
  let popup = null;

  function loadTree() {
    try {
      return L.deserialize(localStorage.getItem(SAVE_KEY) || '');
    } catch {
      return L.defaultLayout();
    }
  }

  function saveTree() {
    try { localStorage.setItem(SAVE_KEY, L.serialize(tree)); } catch { /* storage not available */ }
  }

  function panelFor(area) {
    let inst = instances.get(area.id);
    if (!inst || inst.type !== area.type) {
      if (inst && inst.panel.destroy) inst.panel.destroy();
      inst = { type: area.type, panel: createPanel(area.type) };
      instances.set(area.id, inst);
    }
    return inst.panel;
  }

  function renderNode(node) {
    if (node.kind === 'area') {
      const panel = panelFor(node);
      const el = document.createElement('section');
      el.className = 'area';
      el.dataset.area = node.id;
      el.innerHTML = `
        <header class="area-head">
          <select class="area-type" aria-label="Window type">
            ${L.WINDOW_TYPES.map((t) => `<option value="${t.id}" ${t.id === node.type ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
          <span class="grow"></span>
          <button class="area-close" aria-label="Close window" title="Close window">×</button>
        </header>`;
      const body = document.createElement('div');
      body.className = 'area-body';
      body.appendChild(panel.el);
      el.appendChild(body);
      el.addEventListener('pointerdown', () => { activeArea = node.id; }, true);
      el.querySelector('.area-type').addEventListener('change', (e) => {
        tree = L.setType(tree, node.id, e.target.value);
        commit();
      });
      el.querySelector('.area-close').addEventListener('click', () => {
        if (L.allAreas(tree).length <= 1) return;
        tree = L.removeNode(tree, node.id);
        commit();
      });
      return el;
    }

    const wrap = document.createElement('div');
    wrap.className = 'split ' + (node.dir === 'row' ? 'split-row' : 'split-col');
    wrap.dataset.split = node.id;
    const a = renderNode(node.a);
    const b = renderNode(node.b);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    const seam = document.createElement('div');
    seam.className = 'seam ' + (node.dir === 'row' ? 'seam-v' : 'seam-h');
    seam.title = 'Drag to resize. Click to add a window.';
    seam.setAttribute('role', 'separator');
    seam.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
    seam.addEventListener('pointerdown', (e) => startSeamDrag(e, node, wrap, a, b));
    wrap.append(a, seam, b);
    return wrap;
  }

  function render() {
    closePopup();
    root.innerHTML = '';
    // drop panels for areas that no longer exist
    const live = new Set(L.allAreas(tree).map((a) => a.id));
    for (const [id, inst] of instances) {
      if (!live.has(id)) {
        if (inst.panel.destroy) inst.panel.destroy();
        instances.delete(id);
      }
    }
    root.appendChild(renderNode(tree));
    updatePanels();
  }

  function updatePanels() {
    for (const inst of instances.values()) {
      if (inst.panel.update) inst.panel.update(store.get());
    }
  }

  function commit() {
    saveTree();
    render();
  }

  // ---------- seams ----------

  function startSeamDrag(e, node, wrap, a, b) {
    if (e.button !== 0) return;
    e.preventDefault();
    const vertical = node.dir === 'row';
    const rect = wrap.getBoundingClientRect();
    const total = vertical ? rect.width : rect.height;
    const startPos = vertical ? e.clientX : e.clientY;
    const startRatio = node.ratio;
    let moved = false;
    let removed = false;
    const seam = e.currentTarget;
    try { seam.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }

    const onMove = (ev) => {
      if (removed) return;
      const pos = vertical ? ev.clientX : ev.clientY;
      const delta = pos - startPos;
      if (Math.abs(delta) > 3) moved = true;
      if (!moved) return;
      const aPx = total * startRatio + delta;
      const bPx = total - aPx;
      if (aPx < L.MIN_AREA_PX || bPx < L.MIN_AREA_PX) {
        // the smaller side is removed, its neighbour takes the space
        const small = aPx < bPx ? a : b;
        const smallNode = findChildNode(node, small);
        tree = L.removeNode(tree, smallNode.id);
        removed = true;
        commit();
        return;
      }
      const ratio = aPx / total;
      a.style.flex = `${ratio} 1 0`;
      b.style.flex = `${1 - ratio} 1 0`;
      seam.dataset.ratio = String(ratio);
    };

    const onUp = () => {
      seam.removeEventListener('pointermove', onMove);
      seam.removeEventListener('pointerup', onUp);
      seam.removeEventListener('pointercancel', onUp);
      if (removed) return;
      if (moved) {
        const ratio = seam.dataset.ratio ? Number(seam.dataset.ratio) : startRatio;
        tree = L.setRatio(tree, node.id, ratio);
        commit();
      } else {
        openSeamMenu(e.clientX, e.clientY, node.id);
      }
    };
    seam.addEventListener('pointermove', onMove);
    seam.addEventListener('pointerup', onUp);
    seam.addEventListener('pointercancel', onUp);
  }

  function findChildNode(splitNode, domSide) {
    // the DOM side element belongs to the tree child whose area id or split id matches
    const id = domSide.dataset.area || domSide.dataset.split;
    return L.findNode(splitNode, id)?.node || splitNode.a;
  }

  // ---------- menus ----------

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function openMenu(x, y, title, onPick) {
    closePopup();
    popup = document.createElement('div');
    popup.className = 'menu';
    popup.setAttribute('role', 'menu');
    popup.innerHTML = `<div class="menu-title">${title}</div>` +
      L.WINDOW_TYPES.map((t) => `<button role="menuitem" data-type="${t.id}">${t.label}</button>`).join('');
    document.body.appendChild(popup);
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    popup.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    popup.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    popup.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      const type = btn.dataset.type;
      closePopup();
      onPick(type);
    });
    setTimeout(() => document.addEventListener('pointerdown', outsideClose, { once: true, capture: true }), 0);
  }

  function outsideClose(e) {
    if (popup && !popup.contains(e.target)) closePopup();
  }

  function openSeamMenu(x, y, splitId) {
    openMenu(x, y, 'Add window here', (type) => {
      tree = L.insertAtSeam(tree, splitId, type);
      commit();
    });
  }

  // The Windows tab (top left): adds a window next to the active one.
  function openWindowsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, 'Add a window', (type) => {
      const areas = L.allAreas(tree);
      const target = areas.find((a) => a.id === activeArea) || areas[areas.length - 1];
      tree = L.addBeside(tree, target.id, type, 'row');
      commit();
    });
  }

  function init() {
    render();
    window.addEventListener('resize', updatePanels);
  }

  store.subscribe(() => updatePanels());
  store.subscribeTime((s) => {
    for (const inst of instances.values()) {
      if (inst.panel.updateTime) inst.panel.updateTime(s);
    }
  });

  return {
    init,
    render,
    openWindowsMenu,
    getTree: () => tree,
  };
}
