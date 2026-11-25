// Interactive 3D Set Viewport (.glb camera snapper -> BG Picture / First Frame)
// + Coverage Angle Picker for 100% 3D-consistent backgrounds across multi-shot scenes.
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Convert 35mm full-frame focal length (mm) to vertical FOV (degrees)
function focalToVfov(mm) {
  return 2 * Math.atan(24 / (2 * Math.max(12, Number(mm) || 35))) * (180 / Math.PI);
}

function buildStarterBilliardBarScene() {
  const group = new THREE.Group();
  group.name = 'StarterBilliardBar';

  const matWoodDark = new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.65, metalness: 0.08 });
  const matWall = new THREE.MeshStandardMaterial({ color: 0x261d19, roughness: 0.88 });
  const matFloor = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.72 });
  const matFelt = new THREE.MeshStandardMaterial({ color: 0x165b36, roughness: 0.9 });
  const matBeige = new THREE.MeshStandardMaterial({ color: 0xd6cfc2, roughness: 0.55 });
  const matMetal = new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.35, metalness: 0.65 });
  const matScreen = new THREE.MeshStandardMaterial({ color: 0x5da9ff, emissive: 0x2d78e6, emissiveIntensity: 1.4, roughness: 0.2 });
  const matBottleAmber = new THREE.MeshStandardMaterial({ color: 0xd98a2b, emissive: 0x4a2406, emissiveIntensity: 0.45, roughness: 0.25 });

  // Floor & walls
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const backWall = new THREE.Mesh(new THREE.BoxGeometry(14, 4.2, 0.2), matWall);
  backWall.position.set(0, 2.1, -5.5);
  group.add(backWall);

  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.2, 12), matWall);
  leftWall.position.set(-7, 2.1, 0);
  group.add(leftWall);

  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.2, 12), matWall);
  rightWall.position.set(7, 2.1, 0);
  group.add(rightWall);

  // Polished dark wood bar counter (right-center)
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.14, 0.95), matWoodDark);
  barTop.position.set(2.2, 1.08, -1.6);
  group.add(barTop);
  const barBase = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.04, 0.78), matWoodDark);
  barBase.position.set(2.2, 0.52, -1.6);
  group.add(barBase);

  // Barstools
  for (let i = 0; i < 4; i++) {
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.72, 16), matMetal);
    stool.position.set(0.3 + i * 1.25, 0.36, -0.75);
    group.add(stool);
  }

  // Bottle shelf behind bar
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.08, 0.35), matWoodDark);
  shelf.position.set(2.2, 1.75, -5.2);
  group.add(shelf);
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.34, 10), matBottleAmber);
    b.position.set(0.2 + i * 0.44, 1.96, -5.18);
    group.add(b);
  }

  // Green-felt Billiard Table (left-midground)
  const poolBase = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.72, 1.45), matWoodDark);
  poolBase.position.set(-3.1, 0.36, 0.5);
  group.add(poolBase);
  const poolFelt = new THREE.Mesh(new THREE.BoxGeometry(2.36, 0.06, 1.22), matFelt);
  poolFelt.position.set(-3.1, 0.75, 0.5);
  group.add(poolFelt);

  // Back-bar office nook desk + glowing ON monitor + beige laser printer (far right)
  const desk = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.78, 0.85), matWoodDark);
  desk.position.set(4.9, 0.39, -3.7);
  group.add(desk);
  const monitorStand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.12), matMetal);
  monitorStand.position.set(4.35, 0.9, -3.85);
  group.add(monitorStand);
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.44, 0.05), matScreen);
  monitor.position.set(4.35, 1.18, -3.85);
  group.add(monitor);
  const printer = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.3, 0.46), matBeige);
  printer.position.set(5.35, 0.93, -3.65);
  group.add(printer);

  // Warm amber pendant lights
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffc670 });
  [[-3.1, 2.7, 0.5], [2.2, 2.6, -1.6], [4.9, 2.5, -3.7]].forEach(([x, y, z]) => {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.22, 16), matMetal);
    shade.position.set(x, y, z);
    group.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), bulbMat);
    bulb.position.set(x, y - 0.1, z);
    group.add(bulb);
    const pt = new THREE.PointLight(0xffb45c, 4.5, 9.5, 1.4);
    pt.position.set(x, y - 0.22, z);
    group.add(pt);
  });

  return group;
}

function initSet3dUi() {
  const host = $('ai-set3d-canvas-wrap');
  const panel = $('ai-set3d-panel');
  if (!host || !panel) return;

  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let activeModelGroup = null;
  let rafId = 0;
  let aspectMode = '16:9';
  let focalMm = 35;

  const bookmarks = [
    { name: 'Wide Billiard Bar', pos: [-4.6, 2.0, 4.2], target: [0.6, 1.1, -1.4], focal: 35 },
    { name: 'Bar Counter Two-Shot', pos: [1.8, 1.55, 1.3], target: [2.2, 1.25, -2.0], focal: 50 },
    { name: 'OTS Behind Bar', pos: [0.6, 1.55, -0.6], target: [2.9, 1.3, -2.8], focal: 50 },
    { name: 'Back-Bar Printer Nook', pos: [3.2, 1.55, -2.1], target: [4.85, 1.05, -3.75], focal: 35 },
  ];

  function ensureRenderer() {
    if (renderer) return;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x110e15);
    scene.fog = new THREE.FogExp2(0x110e15, 0.032);

    const amb = new THREE.AmbientLight(0xffe0c2, 0.55);
    scene.add(amb);
    const dir = new THREE.DirectionalLight(0xfff1de, 0.9);
    dir.position.set(3, 6, 4);
    scene.add(dir);

    const grid = new THREE.GridHelper(16, 16, 0x3b3556, 0x221f30);
    grid.position.y = 0.005;
    scene.add(grid);

    activeModelGroup = buildStarterBilliardBarScene();
    scene.add(activeModelGroup);

    camera = new THREE.PerspectiveCamera(focalToVfov(focalMm), 16 / 9, 0.1, 120);
    camera.position.set(-4.6, 2.0, 4.2);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0.6, 1.1, -1.4);
    controls.update();

    resizeViewport();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (panel.hidden) return;
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
  }

  function resizeViewport() {
    if (!renderer || !camera) return;
    const w = Math.max(320, host.clientWidth || 640);
    const h = aspectMode === '9:16' ? Math.min(420, Math.round(w * 0.72)) : Math.round(w * (9 / 16));
    const renderW = aspectMode === '9:16' ? Math.round(h * (9 / 16)) : w;
    renderer.setSize(renderW, h, false);
    renderer.domElement.style.width = `${renderW}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = renderW / h;
    camera.fov = focalToVfov(focalMm);
    camera.updateProjectionMatrix();
  }

  function renderBookmarks() {
    const el = $('ai-set3d-cams');
    if (!el) return;
    el.innerHTML = bookmarks.map((b, idx) => `
      <button type="button" class="pa-master-pill" data-set3d-cam="${idx}" title="${b.focal}mm">🎥 ${esc(b.name)}</button>
    `).join('');
  }
  renderBookmarks();

  function applyBookmark(idx) {
    ensureRenderer();
    const b = bookmarks[idx];
    if (!b || !camera || !controls) return;
    focalMm = b.focal || 35;
    const focalSel = $('ai-set3d-focal');
    if (focalSel) focalSel.value = String(focalMm);
    camera.position.set(b.pos[0], b.pos[1], b.pos[2]);
    controls.target.set(b.target[0], b.target[1], b.target[2]);
    camera.fov = focalToVfov(focalMm);
    camera.updateProjectionMatrix();
    controls.update();
  }

  async function loadGlbFile(file) {
    if (!file) return;
    ensureRenderer();
    const status = $('ai-set3d-status');
    if (status) status.textContent = `Loading ${file.name}…`;
    const buf = await file.arrayBuffer();
    const loader = new GLTFLoader();
    loader.parse(buf, '', (gltf) => {
      if (activeModelGroup) scene.remove(activeModelGroup);
      const root = gltf.scene || gltf.scenes[0];
      // Normalize scale & center on floor y=0
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 8 / maxDim;
      root.scale.setScalar(scale);
      const box2 = new THREE.Box3().setFromObject(root);
      const center = box2.getCenter(new THREE.Vector3());
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= box2.min.y;
      activeModelGroup = root;
      scene.add(activeModelGroup);
      camera.position.set(0, 2.2, 6.5);
      controls.target.set(0, 1.2, 0);
      controls.update();
      if (status) status.textContent = `Loaded 3D set "${file.name}" — orbit to your angle and click 📸 Snap → BG Picture.`;
    }, (err) => {
      if (status) status.textContent = `Could not parse .glb/.gltf: ${(err && err.message) || err}`;
    });
  }

  async function refreshCoverageAngles() {
    const grid = $('ai-set3d-angles');
    const api = window.zaudeAI;
    if (!grid || !api || !api.listCoverageAngles) return;
    const res = await api.listCoverageAngles();
    const list = (res && Array.isArray(res.angles)) ? res.angles : [];
    if (!list.length) {
      grid.innerHTML = `<div class="muted" style="font-size:11px">No saved 3D snapshots or Coverage angles yet. Snap an angle above or run Coverage (8 views).</div>`;
      return;
    }
    grid.innerHTML = list.slice(0, 16).map((a) => `
      <button type="button" class="set3d-angle-card" data-angle-path="${esc(a.path)}" data-angle-url="${esc(a.url || '')}" title="Click to set as BG Picture (${esc(a.name)})">
        <img src="${esc(a.url || '')}" alt="${esc(a.name)}" loading="lazy">
        <span>${esc(a.name.replace(/\.[^.]+$/, '').slice(0, 22))}</span>
      </button>
    `).join('');
  }

  async function snapToSlot(slotName) {
    ensureRenderer();
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const api = window.zaudeAI;
    const status = $('ai-set3d-status');
    if (!api || !api.saveSetSnapshot) return;
    const res = await api.saveSetSnapshot({ dataUrl, label: `set3d_${focalMm}mm` });
    if (!res || !res.ok) {
      if (status) status.textContent = (res && res.error) || 'Failed to save snapshot.';
      return;
    }
    if (window.__zaudeSetMediaSlot) {
      window.__zaudeSetMediaSlot(slotName, res.path, res.url);
    }
    if (status) status.textContent = `📸 Snapped ${focalMm}mm angle -> ${slotName === 'firstFrame' ? 'First Frame' : 'BG Picture'} (${res.name})`;
    refreshCoverageAngles();
  }

  // Wire UI controls
  const fileIn = $('ai-set3d-file');
  if (fileIn) fileIn.addEventListener('change', (e) => loadGlbFile(e.target.files && e.target.files[0]));

  const focalSel = $('ai-set3d-focal');
  if (focalSel) {
    focalSel.addEventListener('change', () => {
      focalMm = Number(focalSel.value) || 35;
      resizeViewport();
    });
  }
  const aspSel = $('ai-set3d-aspect');
  if (aspSel) {
    aspSel.addEventListener('change', () => {
      aspectMode = aspSel.value === '9:16' ? '9:16' : '16:9';
      resizeViewport();
    });
  }

  panel.addEventListener('click', (e) => {
    const camBtn = e.target.closest('[data-set3d-cam]');
    if (camBtn) {
      applyBookmark(Number(camBtn.dataset.set3dCam));
      return;
    }
    if (e.target.closest('#ai-set3d-save-cam')) {
      ensureRenderer();
      const idx = bookmarks.length + 1;
      bookmarks.push({
        name: `Cam ${idx} (${focalMm}mm)`,
        pos: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        focal: focalMm,
      });
      renderBookmarks();
      return;
    }
    if (e.target.closest('#ai-set3d-reset-starter')) {
      ensureRenderer();
      if (activeModelGroup) scene.remove(activeModelGroup);
      activeModelGroup = buildStarterBilliardBarScene();
      scene.add(activeModelGroup);
      applyBookmark(0);
      return;
    }
    if (e.target.closest('#ai-set3d-snap-bg')) {
      snapToSlot('backgroundImage');
      return;
    }
    if (e.target.closest('#ai-set3d-snap-first')) {
      snapToSlot('firstFrame');
      return;
    }
    if (e.target.closest('#ai-set3d-build-locref')) {
      (async () => {
        const api = window.zaudeAI;
        const status = $('ai-set3d-status');
        if (!api || !api.saveSetSnapshot || !api.buildLocationRefMod) return;
        ensureRenderer();
        const setName = (activeModelGroup && activeModelGroup.name) ? activeModelGroup.name : 'set3d_room';
        if (status) status.textContent = `📸 Capturing 8 orbit views of "${setName}" for zero-training Location RefMod…`;

        // Save current camera state, orbit cleanly through 8 evenly spaced azimuth angles, and restore
        const savedPos = camera.position.clone();
        const savedTarget = controls.target.clone();
        const radius = Math.max(2.5, savedPos.distanceTo(savedTarget));
        const elevY = Math.max(1.3, savedPos.y);
        const imagePaths = [];
        for (let i = 0; i < 8; i++) {
          const theta = (i / 8) * Math.PI * 2;
          camera.position.set(
            savedTarget.x + Math.cos(theta) * radius,
            elevY,
            savedTarget.z + Math.sin(theta) * radius,
          );
          camera.lookAt(savedTarget);
          renderer.render(scene, camera);
          const dataUrl = renderer.domElement.toDataURL('image/png');
          const snap = await api.saveSetSnapshot({ dataUrl, label: `${setName}_v${i + 1}` });
          if (snap && snap.ok && snap.path) imagePaths.push(snap.path);
        }
        camera.position.copy(savedPos);
        controls.target.copy(savedTarget);
        controls.update();
        renderer.render(scene, camera);

        if (status) status.textContent = `🧬 Encoding Location RefMod from ${imagePaths.length} views on ComfyUI…`;
        const res = await api.buildLocationRefMod({ name: setName, imagePaths });
        if (!res || !res.ok) {
          if (status) status.textContent = `Location RefMod failed: ${(res && res.error) || 'unknown error'}`;
          return;
        }
        const bgSel = $('ai-bg-refmod');
        if (bgSel && res.refmodFile) {
          const opt = document.createElement('option');
          opt.value = res.refmodFile;
          opt.textContent = `🏛️ ${res.modName} (Location RefMod)`;
          bgSel.appendChild(opt);
          bgSel.value = res.refmodFile;
        }
        if (status) status.textContent = `✅ Built Location RefMod "${res.refmodFile}" (${res.viewsUsed} views) and selected in Background / Set RefMod!`;
        refreshCoverageAngles();
      })();
      return;
    }
    if (e.target.closest('#ai-set3d-refresh-angles')) {
      refreshCoverageAngles();
      return;
    }
    const angleCard = e.target.closest('.set3d-angle-card');
    if (angleCard && window.__zaudeSetMediaSlot) {
      window.__zaudeSetMediaSlot('backgroundImage', angleCard.dataset.anglePath, angleCard.dataset.angleUrl);
      const status = $('ai-set3d-status');
      if (status) status.textContent = `🌆 Set BG Picture to "${angleCard.textContent.trim()}" — switch to RefMod / Stylize to render!`;
    }
  });

  // Boot Three.js lazily when the user clicks the 🏛️ 3D Set tab
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('#ai-mode-tabs button[data-ai-mode="set3d"]');
    if (tabBtn) {
      setTimeout(() => {
        ensureRenderer();
        resizeViewport();
        refreshCoverageAngles();
      }, 40);
    }
  });
  window.addEventListener('resize', () => { if (!panel.hidden) resizeViewport(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSet3dUi);
} else {
  initSet3dUi();
}
