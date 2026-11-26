// Interactive 3D Set Builder & Camera Snapper
// - Story/Location room presets + .glb/.gltf loader + Blank Room Bounds
// - Click-to-select + XYZ / Rot Y movement for Props, Lights, and Directional Character Stand-In boxes (Standing/Sitting)
// - Double-click Minecraft PointerLock WASD Fly Mode (W/A/S/D + Space/Shift + Mouse Look + Esc)
// - Merged 8-View Coverage from Photo drawer + Zero-Training Location RefMod builder
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function focalToVfov(mm) {
  return 2 * Math.atan(24 / (2 * Math.max(12, Number(mm) || 35))) * (180 / Math.PI);
}

const STANDIN_PALETTE = [
  { name: 'Blue', hex: 0x3b82f6 },
  { name: 'Red', hex: 0xef4444 },
  { name: 'Emerald', hex: 0x10b981 },
  { name: 'Amber', hex: 0xf59e0b },
  { name: 'Purple', hex: 0x8b5cf6 },
  { name: 'Cyan', hex: 0x06b6d4 },
];

function buildRoomShell(w, h, d, wallColor = 0x261d19, floorColor = 0x2b1d14) {
  const g = new THREE.Group();
  const matFloor = new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.75 });
  const matWall = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), matWall);
  backWall.position.set(0, h / 2, -d / 2);
  g.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, d), matWall);
  leftWall.position.set(-w / 2, h / 2, 0);
  g.add(leftWall);
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, d), matWall);
  rightWall.position.set(w / 2, h / 2, 0);
  g.add(rightWall);
  return g;
}

function buildStarterBilliardBarScene() {
  const group = buildRoomShell(14, 4.2, 12, 0x261d19, 0x2b1d14);
  group.name = 'StarterBilliardBar';

  const matWoodDark = new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.65, metalness: 0.08 });
  const matFelt = new THREE.MeshStandardMaterial({ color: 0x165b36, roughness: 0.9 });
  const matBeige = new THREE.MeshStandardMaterial({ color: 0xd6cfc2, roughness: 0.55 });
  const matMetal = new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.35, metalness: 0.65 });
  const matScreen = new THREE.MeshStandardMaterial({ color: 0x5da9ff, emissive: 0x2d78e6, emissiveIntensity: 1.4, roughness: 0.2 });
  const matBottleAmber = new THREE.MeshStandardMaterial({ color: 0xd98a2b, emissive: 0x4a2406, emissiveIntensity: 0.45, roughness: 0.25 });

  const barTop = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.14, 0.95), matWoodDark);
  barTop.position.set(2.2, 1.08, -1.6);
  group.add(barTop);
  const barBase = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.04, 0.78), matWoodDark);
  barBase.position.set(2.2, 0.52, -1.6);
  group.add(barBase);
  for (let i = 0; i < 4; i++) {
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.72, 16), matMetal);
    stool.position.set(0.3 + i * 1.25, 0.36, -0.75);
    group.add(stool);
  }
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.08, 0.35), matWoodDark);
  shelf.position.set(2.2, 1.75, -5.2);
  group.add(shelf);
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.34, 10), matBottleAmber);
    b.position.set(0.2 + i * 0.44, 1.96, -5.18);
    group.add(b);
  }
  const poolBase = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.72, 1.45), matWoodDark);
  poolBase.position.set(-3.1, 0.36, 0.5);
  group.add(poolBase);
  const poolFelt = new THREE.Mesh(new THREE.BoxGeometry(2.36, 0.06, 1.22), matFelt);
  poolFelt.position.set(-3.1, 0.75, 0.5);
  group.add(poolFelt);
  const desk = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.78, 0.85), matWoodDark);
  desk.position.set(4.9, 0.39, -3.7);
  group.add(desk);
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.44, 0.05), matScreen);
  monitor.position.set(4.35, 1.18, -3.85);
  group.add(monitor);
  const printer = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.3, 0.46), matBeige);
  printer.position.set(5.35, 0.93, -3.65);
  group.add(printer);

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

function buildClassroomScene() {
  const group = buildRoomShell(12, 3.8, 10, 0x2c333f, 0x3b352d);
  group.name = 'Classroom';
  const board = new THREE.Mesh(new THREE.BoxGeometry(4.8, 1.5, 0.08), new THREE.MeshStandardMaterial({ color: 0x16422b, roughness: 0.85 }));
  board.position.set(0, 1.8, -4.85);
  group.add(board);
  const wood = new THREE.MeshStandardMaterial({ color: 0x8b623f, roughness: 0.7 });
  const teacherDesk = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.78, 0.8), wood);
  teacherDesk.position.set(0, 0.39, -3.4);
  group.add(teacherDesk);
  for (let r = 0; r < 3; r++) {
    for (let c = -1; c <= 1; c++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.72, 0.65), wood);
      d.position.set(c * 2.2, 0.36, -1.2 + r * 1.9);
      group.add(d);
    }
  }
  const pt = new THREE.PointLight(0xeef5ff, 6.0, 14, 1.2);
  pt.position.set(0, 3.4, -0.5);
  group.add(pt);
  return group;
}

function buildApartmentScene() {
  const group = buildRoomShell(10, 3.4, 9, 0x302b28, 0x3a2c20);
  group.name = 'ApartmentLivingRoom';
  const sofaMat = new THREE.MeshStandardMaterial({ color: 0x3b4d63, roughness: 0.85 });
  const sofa = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.85, 1.0), sofaMat);
  sofa.position.set(0, 0.42, -2.5);
  group.add(sofa);
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.42, 0.75), new THREE.MeshStandardMaterial({ color: 0x4e3524, roughness: 0.6 }));
  table.position.set(0, 0.21, -0.8);
  group.add(table);
  const tv = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.08), new THREE.MeshStandardMaterial({ color: 0x161922, emissive: 0x1f3a66, emissiveIntensity: 0.7 }));
  tv.position.set(0, 1.25, 2.8);
  group.add(tv);
  const pt = new THREE.PointLight(0xffdfb8, 5.2, 12, 1.3);
  pt.position.set(0, 3.0, -0.5);
  group.add(pt);
  return group;
}

function buildEmptyRoomScene() {
  const group = buildRoomShell(12, 4.0, 12, 0x22252e, 0x1c1e26);
  group.name = 'BlankRoomBounds';
  const pt = new THREE.PointLight(0xffffff, 5.0, 15, 1.2);
  pt.position.set(0, 3.5, 0);
  group.add(pt);
  return group;
}

// Creates a directional colored Character Stand-In box with a bright Front Face indicator & Standing/Sitting pose
function createCharacterStandIn(idx) {
  const pal = STANDIN_PALETTE[idx % STANDIN_PALETTE.length];
  const g = new THREE.Group();
  g.name = `Char ${idx + 1} (${pal.name})`;
  g.userData = { selectable: true, kind: 'character', pose: 'standing', colorHex: pal.hex };

  const bodyMat = new THREE.MeshStandardMaterial({ color: pal.hex, roughness: 0.45, metalness: 0.1 });
  const frontMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdbeafe, emissiveIntensity: 0.8, roughness: 0.2 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 1.15, 0.34), bodyMat);
  torso.position.y = 0.88;
  torso.name = 'torso';
  g.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.30, 0.28), bodyMat);
  head.position.y = 1.62;
  head.name = 'head';
  g.add(head);

  // Bright Front-Face Visor & Chest Arrow (+Z = Front)
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.10, 0.06), frontMat);
  visor.position.set(0, 1.65, 0.15);
  visor.name = 'visor';
  g.add(visor);

  const frontStripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.05), frontMat);
  frontStripe.position.set(0, 1.05, 0.18);
  frontStripe.name = 'frontStripe';
  g.add(frontStripe);

  g.position.set((idx - 1) * 1.1, 0, 0.5);
  return g;
}

function setCharacterPose(group, pose) {
  if (!group || group.userData.kind !== 'character') return;
  group.userData.pose = pose === 'sitting' ? 'sitting' : 'standing';
  const torso = group.getObjectByName('torso');
  const head = group.getObjectByName('head');
  const visor = group.getObjectByName('visor');
  const stripe = group.getObjectByName('frontStripe');
  const isSit = group.userData.pose === 'sitting';
  if (torso) { torso.scale.y = isSit ? 0.65 : 1.0; torso.position.y = isSit ? 0.62 : 0.88; }
  if (head) head.position.y = isSit ? 1.16 : 1.62;
  if (visor) visor.position.y = isSit ? 1.19 : 1.65;
  if (stripe) stripe.position.y = isSit ? 0.72 : 1.05;
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
  let editableGroup = null;
  let selectedObj = null;
  let selectionHelper = null;
  let rafId = 0;
  let aspectMode = '16:9';
  let focalMm = 35;
  let charCounter = 0;
  let propCounter = 0;

  // Minecraft PointerLock WASD Fly Mode state
  let flyActive = false;
  let flyYaw = 0;
  let flyPitch = 0;
  const flyKeys = new Set();
  let flyHud = null;

  const bookmarks = [
    { name: 'Wide Billiard Bar', pos: [-4.6, 2.0, 4.2], target: [0.6, 1.1, -1.4], focal: 35 },
    { name: 'Bar Counter Two-Shot', pos: [1.8, 1.55, 1.3], target: [2.2, 1.25, -2.0], focal: 50 },
    { name: 'OTS Behind Bar', pos: [0.6, 1.55, -0.6], target: [2.9, 1.3, -2.8], focal: 50 },
    { name: 'Back-Bar Printer Nook', pos: [3.2, 1.55, -2.1], target: [4.85, 1.05, -3.75], focal: 35 },
  ];

  function updateSelectionBar() {
    const bar = $('ai-set3d-sel-bar');
    if (!bar) return;
    if (!selectedObj) {
      bar.hidden = true;
      if (selectionHelper && scene) { scene.remove(selectionHelper); selectionHelper = null; }
      return;
    }
    bar.hidden = false;
    $('ai-set3d-sel-name').textContent = selectedObj.name || 'Object';
    $('ai-set3d-pos-x').value = selectedObj.position.x.toFixed(2);
    $('ai-set3d-pos-y').value = selectedObj.position.y.toFixed(2);
    $('ai-set3d-pos-z').value = selectedObj.position.z.toFixed(2);
    $('ai-set3d-rot-y').value = Math.round(THREE.MathUtils.radToDeg(selectedObj.rotation.y));
    const poseBtn = $('ai-set3d-pose-toggle');
    if (poseBtn) {
      const isChar = selectedObj.userData && selectedObj.userData.kind === 'character';
      poseBtn.hidden = !isChar;
      if (isChar) {
        poseBtn.textContent = selectedObj.userData.pose === 'sitting' ? '🪑 Sitting' : '🧍 Standing';
      }
    }
    if (selectionHelper && scene) scene.remove(selectionHelper);
    selectionHelper = new THREE.BoxHelper(selectedObj, 0x60a5fa);
    scene.add(selectionHelper);
  }

  function enterFlyMode() {
    ensureRenderer();
    if (!renderer || !renderer.domElement.requestPointerLock) return;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    flyYaw = euler.y;
    flyPitch = euler.x;
    renderer.domElement.requestPointerLock();
  }

  function ensureRenderer() {
    if (renderer) return;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x110e15);
    scene.fog = new THREE.FogExp2(0x110e15, 0.032);

    scene.add(new THREE.AmbientLight(0xffe0c2, 0.6));
    const dir = new THREE.DirectionalLight(0xfff1de, 0.9);
    dir.position.set(3, 6, 4);
    scene.add(dir);

    const grid = new THREE.GridHelper(16, 16, 0x3b3556, 0x221f30);
    grid.position.y = 0.005;
    scene.add(grid);

    activeModelGroup = buildStarterBilliardBarScene();
    scene.add(activeModelGroup);

    editableGroup = new THREE.Group();
    editableGroup.name = 'EditablePropsAndCharacters';
    scene.add(editableGroup);

    camera = new THREE.PerspectiveCamera(focalToVfov(focalMm), 16 / 9, 0.1, 120);
    camera.position.set(-4.6, 2.0, 4.2);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    flyHud = document.createElement('div');
    flyHud.className = 'set3d-fly-hud';
    flyHud.hidden = true;
    flyHud.textContent = '🎮 Fly Mode: WASD move · Space up · Shift down · Mouse look · Esc exit';
    host.appendChild(flyHud);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0.6, 1.1, -1.4);
    controls.update();

    // Double-click canvas -> Minecraft WASD Fly Mode
    renderer.domElement.addEventListener('dblclick', () => enterFlyMode());

    // Raycast click-to-select editable objects (Character Stand-Ins, Props, Lights)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = null;
    renderer.domElement.addEventListener('pointerdown', (ev) => {
      if (flyActive) return;
      downPos = { x: ev.clientX, y: ev.clientY };
    });
    renderer.domElement.addEventListener('pointerup', (ev) => {
      if (flyActive || !downPos) return;
      if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(editableGroup.children, true);
      if (hits.length) {
        let obj = hits[0].object;
        while (obj && obj.parent && obj.parent !== editableGroup) obj = obj.parent;
        selectedObj = obj;
      } else {
        selectedObj = null;
      }
      updateSelectionBar();
    });

    document.addEventListener('pointerlockchange', () => {
      flyActive = document.pointerLockElement === renderer.domElement;
      controls.enabled = !flyActive;
      if (flyHud) flyHud.hidden = !flyActive;
      if (!flyActive) {
        flyKeys.clear();
        // Sync OrbitControls target 3m ahead of camera so orbit resumes seamlessly
        const forward = new THREE.Vector3(0, 0, -3).applyQuaternion(camera.quaternion);
        controls.target.copy(camera.position).add(forward);
        controls.update();
      }
    });

    document.addEventListener('mousemove', (ev) => {
      if (!flyActive) return;
      flyYaw -= ev.movementX * 0.0022;
      flyPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, flyPitch - ev.movementY * 0.0022));
      camera.quaternion.setFromEuler(new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ'));
    });

    window.addEventListener('keydown', (ev) => {
      if (!flyActive) return;
      flyKeys.add(ev.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(ev.code)) {
        ev.preventDefault();
      }
    });
    window.addEventListener('keyup', (ev) => { flyKeys.delete(ev.code); });

    resizeViewport();
    renderBookmarks();

    let lastTs = performance.now();
    const tick = (now) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      if (panel.hidden) return;
      if (flyActive) {
        const speed = 4.2 * dt;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        fwd.y = 0;
        if (fwd.lengthSq() > 1e-6) fwd.normalize();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        right.y = 0;
        if (right.lengthSq() > 1e-6) right.normalize();
        if (flyKeys.has('KeyW')) camera.position.addScaledVector(fwd, speed);
        if (flyKeys.has('KeyS')) camera.position.addScaledVector(fwd, -speed);
        if (flyKeys.has('KeyD')) camera.position.addScaledVector(right, speed);
        if (flyKeys.has('KeyA')) camera.position.addScaledVector(right, -speed);
        if (flyKeys.has('Space')) camera.position.y += speed;
        if (flyKeys.has('ShiftLeft') || flyKeys.has('ShiftRight')) camera.position.y = Math.max(0.2, camera.position.y - speed);
      } else {
        controls.update();
      }
      if (selectionHelper) selectionHelper.update();
      renderer.render(scene, camera);
    };
    tick(performance.now());
  }

  function resizeViewport() {
    if (!renderer || !camera) return;
    const w = Math.max(320, host.clientWidth || 720);
    const h = aspectMode === '9:16' ? Math.min(440, Math.round(w * 0.72)) : Math.round(w * 9 / 16);
    const targetAspect = aspectMode === '9:16' ? 9 / 16 : 16 / 9;
    const cw = aspectMode === '9:16' ? Math.round(h * targetAspect) : w;
    renderer.setSize(cw, h, false);
    renderer.domElement.style.width = `${cw}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = targetAspect;
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

  function applyBookmark(idx) {
    const b = bookmarks[idx];
    if (!b || !camera || !controls) return;
    focalMm = b.focal || 35;
    const focalSel = $('ai-set3d-focal');
    if (focalSel) focalSel.value = String(focalMm);
    camera.position.set(b.pos[0], b.pos[1], b.pos[2]);
    controls.target.set(b.target[0], b.target[1], b.target[2]);
    resizeViewport();
    controls.update();
  }

  function loadGlbFile(file) {
    if (!file) return;
    ensureRenderer();
    const url = URL.createObjectURL(file);
    const loader = new GLTFLoader();
    const status = $('ai-set3d-status');
    if (status) status.textContent = `Loading 3D set "${file.name}"…`;
    loader.load(url, (gltf) => {
      URL.revokeObjectURL(url);
      if (activeModelGroup) scene.remove(activeModelGroup);
      activeModelGroup = gltf.scene || gltf.scenes[0];
      activeModelGroup.name = file.name.replace(/\.[^.]+$/, '');
      const box = new THREE.Box3().setFromObject(activeModelGroup);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      const scale = 10 / maxDim;
      activeModelGroup.scale.setScalar(scale);
      activeModelGroup.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      scene.add(activeModelGroup);
      camera.position.set(0, 2.2, 6.5);
      controls.target.set(0, 1.2, 0);
      controls.update();
      if (status) status.textContent = `Loaded 3D set "${file.name}" — double-click to fly or click 📸 Snap → BG.`;
    }, undefined, (err) => {
      URL.revokeObjectURL(url);
      if (status) status.textContent = `Failed to load 3D file: ${err?.message || err}`;
    });
  }

  async function refreshCoverageAngles() {
    const grid = $('ai-set3d-angles');
    const api = window.zaudeAI;
    if (!grid || !api || !api.listCoverageAngles) return;
    const res = await api.listCoverageAngles();
    const list = (res && Array.isArray(res.angles)) ? res.angles : [];
    if (!list.length) {
      grid.innerHTML = `<div class="muted" style="font-size:11px">No saved 3D snapshots or Coverage angles yet. Snap an angle above or run 8-View Coverage.</div>`;
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
    if (selectionHelper) selectionHelper.visible = false;
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    if (selectionHelper) selectionHelper.visible = true;
    const api = window.zaudeAI;
    const status = $('ai-set3d-status');
    if (!api || !api.saveSetSnapshot) return;
    const res = await api.saveSetSnapshot({ dataUrl, label: `set3d_${focalMm}mm` });
    if (!res || !res.ok) {
      if (status) status.textContent = `Snapshot failed: ${res?.error || 'unknown error'}`;
      return;
    }
    if (window.__zaudeSetMediaSlot) {
      window.__zaudeSetMediaSlot(slotName, res.path, res.url);
    }
    if (status) status.textContent = `📸 Snapped ${focalMm}mm angle -> ${slotName === 'firstFrame' ? 'First Frame' : 'BG Picture'} (${res.name})`;
    refreshCoverageAngles();
  }

  // Bind controls
  const fileIn = $('ai-set3d-file');
  if (fileIn) fileIn.addEventListener('change', () => loadGlbFile(fileIn.files && fileIn.files[0]));

  const presetSel = $('ai-set3d-preset');
  if (presetSel) {
    presetSel.addEventListener('change', () => {
      ensureRenderer();
      if (activeModelGroup) scene.remove(activeModelGroup);
      const v = presetSel.value;
      if (v === 'classroom') activeModelGroup = buildClassroomScene();
      else if (v === 'apartment') activeModelGroup = buildApartmentScene();
      else if (v === 'empty') activeModelGroup = buildEmptyRoomScene();
      else activeModelGroup = buildStarterBilliardBarScene();
      scene.add(activeModelGroup);
      const status = $('ai-set3d-status');
      if (status) status.textContent = `Loaded 3D Set preset: ${activeModelGroup.name}`;
    });
  }

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

  // Selected object XYZ & Rot inputs
  ['ai-set3d-pos-x', 'ai-set3d-pos-y', 'ai-set3d-pos-z', 'ai-set3d-rot-y'].forEach((id) => {
    const inp = $(id);
    if (!inp) return;
    inp.addEventListener('input', () => {
      if (!selectedObj) return;
      selectedObj.position.set(
        Number($('ai-set3d-pos-x').value) || 0,
        Number($('ai-set3d-pos-y').value) || 0,
        Number($('ai-set3d-pos-z').value) || 0,
      );
      selectedObj.rotation.y = THREE.MathUtils.degToRad(Number($('ai-set3d-rot-y').value) || 0);
      if (selectionHelper) selectionHelper.update();
    });
  });

  panel.addEventListener('click', (e) => {
    const camBtn = e.target.closest('[data-set3d-cam]');
    if (camBtn) { applyBookmark(Number(camBtn.dataset.set3dCam)); return; }

    if (e.target.closest('#ai-set3d-add-char')) {
      ensureRenderer();
      const ch = createCharacterStandIn(charCounter++);
      editableGroup.add(ch);
      selectedObj = ch;
      updateSelectionBar();
      const status = $('ai-set3d-status');
      if (status) status.textContent = `Added ${ch.name} (white visor = Front Face). Adjust XYZ / Rot° or toggle Standing/Sitting.`;
      return;
    }
    if (e.target.closest('#ai-set3d-add-prop')) {
      ensureRenderer();
      const prop = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.75, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.65 }),
      );
      prop.name = `Prop ${++propCounter}`;
      prop.position.set(0, 0.375, 0);
      prop.userData = { selectable: true, kind: 'prop' };
      editableGroup.add(prop);
      selectedObj = prop;
      updateSelectionBar();
      return;
    }
    if (e.target.closest('#ai-set3d-add-light')) {
      ensureRenderer();
      const g = new THREE.Group();
      g.name = `Light ${++propCounter}`;
      g.userData = { selectable: true, kind: 'light' };
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffe082 })));
      g.add(new THREE.PointLight(0xffdca8, 5.0, 10, 1.3));
      g.position.set(0, 2.5, 0);
      editableGroup.add(g);
      selectedObj = g;
      updateSelectionBar();
      return;
    }
    if (e.target.closest('#ai-set3d-pose-toggle') && selectedObj) {
      const nextPose = selectedObj.userData.pose === 'sitting' ? 'standing' : 'sitting';
      setCharacterPose(selectedObj, nextPose);
      updateSelectionBar();
      return;
    }
    if (e.target.closest('#ai-set3d-del-obj') && selectedObj && editableGroup) {
      editableGroup.remove(selectedObj);
      selectedObj = null;
      updateSelectionBar();
      return;
    }
    if (e.target.closest('#ai-set3d-fly-btn')) {
      enterFlyMode();
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
    if (e.target.closest('#ai-set3d-snap-bg')) { snapToSlot('backgroundImage'); return; }
    if (e.target.closest('#ai-set3d-snap-first')) { snapToSlot('firstFrame'); return; }

    // Merged 8-View Coverage from a single photo
    if (e.target.closest('#ai-set3d-run-coverage')) {
      (async () => {
        const api = window.zaudeAI;
        const status = $('ai-set3d-status');
        if (!api || !api.mannimmatePickFile || !api.mannimmateRun) return;
        const chosen = await api.mannimmatePickFile('image');
        if (!chosen || !chosen.path) return;
        if (status) status.textContent = `📷 Generating 8 Coverage angles from "${chosen.path.split(/[\\/]/).pop()}"…`;
        const form = $('t2v-form');
        await api.mannimmateRun({
          mode: 'coverage',
          image: chosen.path,
          mannimmateDir: form && form.elements.mannimmateDir ? form.elements.mannimmateDir.value.trim() : '',
        });
      })();
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
        const savedPos = camera.position.clone();
        const savedTarget = controls.target.clone();
        const radius = Math.max(2.5, savedPos.distanceTo(savedTarget));
        const elevY = Math.max(1.3, savedPos.y);
        const imagePaths = [];
        for (let i = 0; i < 8; i++) {
          const theta = (i / 8) * Math.PI * 2;
          camera.position.set(savedTarget.x + Math.cos(theta) * radius, elevY, savedTarget.z + Math.sin(theta) * radius);
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
        if (status) status.textContent = `✅ Built Location RefMod "${res.refmodFile}" (${res.viewsUsed} views)!`;
        refreshCoverageAngles();
      })();
      return;
    }
    if (e.target.closest('#ai-set3d-refresh-angles')) { refreshCoverageAngles(); return; }
    const angleCard = e.target.closest('.set3d-angle-card');
    if (angleCard && window.__zaudeSetMediaSlot) {
      window.__zaudeSetMediaSlot('backgroundImage', angleCard.dataset.anglePath, angleCard.dataset.angleUrl);
      const status = $('ai-set3d-status');
      if (status) status.textContent = `🌆 Set BG Picture to "${angleCard.textContent.trim()}" — switch to RefMod / Stylize to render!`;
    }
  });

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
