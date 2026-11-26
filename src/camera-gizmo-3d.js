// Pure helper + compact Three.js 3D Character Camera-Angle Gizmo for Text->Video & RefMod.
// Orbit around a directional 3D mannequin with 2-finger trackpad gestures (like Blender) to pick
// exact camera angle (front, 3/4, side profile, top-down, low-angle) and inject into the prompt.

export function describeCameraAngle(azimuthDeg = 0, elevationDeg = 10, distance = 3.2) {
  // Normalize azimuth to [-180, 180], where 0 = looking directly at character's front face
  let az = ((Number(azimuthDeg) || 0) % 360 + 540) % 360 - 180;
  const el = Math.max(-85, Math.min(85, Number(elevationDeg) || 0));
  const dist = Math.max(1.2, Math.min(8.0, Number(distance) || 3.2));

  let horiz;
  const absAz = Math.abs(az);
  if (absAz <= 20) horiz = 'front-facing';
  else if (absAz <= 65) horiz = az > 0 ? 'three-quarter right' : 'three-quarter left';
  else if (absAz <= 115) horiz = az > 0 ? 'right side profile' : 'left side profile';
  else if (absAz <= 155) horiz = az > 0 ? 'over-the-shoulder rear-right' : 'over-the-shoulder rear-left';
  else horiz = 'rear view from behind';

  let vert;
  if (el >= 58) vert = 'top-down bird’s-eye overhead angle';
  else if (el >= 22) vert = 'high-angle looking down';
  else if (el <= -35) vert = 'extreme low worm’s-eye angle looking up';
  else if (el <= -12) vert = 'low-angle upward heroic tilt';
  else vert = 'eye-level angle';

  let framing;
  if (dist <= 2.1) framing = 'Close-up shot';
  else if (dist <= 4.0) framing = 'Medium shot';
  else framing = 'Wide full-body shot';

  const label = `${framing} · ${horiz} · ${vert}`;
  const promptSnippet = `${framing} from a ${horiz}, ${vert}`;
  return { label, promptSnippet, horiz, vert, framing, azimuth: Math.round(az), elevation: Math.round(el) };
}

export async function mountCameraGizmo3D({ container, labelEl, onApply }) {
  if (!container || typeof window === 'undefined') return null;
  const THREE = await import('./vendor/three/three.module.min.js');

  const w = 220;
  const h = 156;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11131a);

  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 40);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xdbeafe, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(2.5, 4.5, 3.5);
  scene.add(key);

  const grid = new THREE.GridHelper(6, 12, 0x3b82f6, 0x262b3a);
  scene.add(grid);

  // Stylized directional character mannequin (blue torso + bright cyan front face + gaze arrow)
  const char = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.45 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.4 });
  const faceMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xca8a04, emissiveIntensity: 0.4 });
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.24), new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.6 }));
  legs.position.y = 0.39;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.28), bodyMat);
  torso.position.y = 1.09;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), headMat);
  head.position.y = 1.58;
  const facePlate = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.04), faceMat);
  facePlate.position.set(0, 1.58, 0.17);
  const gazeArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1.58, 0.2), 0.55, 0xfef08a, 0.18, 0.12);
  char.add(legs, torso, head, facePlate, gazeArrow);
  scene.add(char);

  let az = 28; // degrees (3/4 view default)
  let el = 12;
  let dist = 3.2;

  function renderView() {
    const azRad = (az * Math.PI) / 180;
    const elRad = (el * Math.PI) / 180;
    const targetY = 1.15;
    camera.position.set(
      dist * Math.cos(elRad) * Math.sin(azRad),
      targetY + dist * Math.sin(elRad),
      dist * Math.cos(elRad) * Math.cos(azRad)
    );
    camera.lookAt(0, targetY, 0);
    renderer.render(scene, camera);
    const desc = describeCameraAngle(az, el, dist);
    if (labelEl) labelEl.textContent = desc.label;
    return desc;
  }

  // Blender-style 2-finger trackpad orbit + mouse drag orbit + pinch zoom
  const dom = renderer.domElement;
  dom.style.cursor = 'grab';
  dom.style.borderRadius = '8px';
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      dist = Math.max(1.4, Math.min(6.5, dist * Math.exp(e.deltaY * 0.006)));
    } else {
      az -= e.deltaX * 0.45;
      el = Math.max(-75, Math.min(80, el + e.deltaY * 0.35));
    }
    renderView();
  }, { passive: false });

  let dragging = false;
  let lx = 0;
  let ly = 0;
  dom.addEventListener('pointerdown', (e) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
    dom.setPointerCapture(e.pointerId);
    dom.style.cursor = 'grabbing';
  });
  dom.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    az -= (e.clientX - lx) * 0.65;
    el = Math.max(-75, Math.min(80, el + (e.clientY - ly) * 0.5));
    lx = e.clientX;
    ly = e.clientY;
    renderView();
  });
  const endDrag = () => { dragging = false; dom.style.cursor = 'grab'; };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);

  renderView();
  return {
    getAngle: () => describeCameraAngle(az, el, dist),
    reset: () => { az = 0; el = 10; dist = 3.2; return renderView(); },
    applyNow: () => { const d = describeCameraAngle(az, el, dist); if (onApply) onApply(d); return d; },
  };
}
