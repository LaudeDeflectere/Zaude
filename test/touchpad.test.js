import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TP = require('../electron/touchpad.cjs');

function sendTouchFrame(det, f0, f1, init = false) {
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 0);
  if (init) det.feedEvent(TP.EV_ABS, TP.ABS_MT_TRACKING_ID, 1);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, f0.x);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, f0.y);

  det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 1);
  if (init) det.feedEvent(TP.EV_ABS, TP.ABS_MT_TRACKING_ID, 2);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, f1.x);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, f1.y);

  det.feedEvent(TP.EV_SYN, TP.SYN_REPORT, 0);
}

test('createScrewDetector detects 1-finger anchored clockwise orbit as rotation', () => {
  const angles = [];
  const det = TP.createScrewDetector((d) => angles.push(d));
  const cx = 500;
  const cy = 500;
  const r = 200;
  for (let deg = 0; deg <= 45; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    sendTouchFrame(det, { x: cx, y: cy }, { x: Math.round(cx + Math.cos(rad) * r), y: Math.round(cy + Math.sin(rad) * r) }, deg === 0);
  }
  const total = angles.reduce((a, b) => a + b, 0);
  assert.ok(total > 35 && total < 50, `expected ~45 deg rotation, got ${total}`);
});

test('createScrewDetector ignores parallel two-finger pan and pure pinch', () => {
  const angles = [];
  const det = TP.createScrewDetector((d) => angles.push(d));
  // Parallel pan
  for (let i = 0; i < 6; i++) {
    sendTouchFrame(det, { x: 200 + i * 20, y: 300 }, { x: 400 + i * 20, y: 300 }, i === 0);
  }
  // Pure radial pinch
  for (let i = 0; i < 6; i++) {
    sendTouchFrame(det, { x: 400 - i * 15, y: 300 }, { x: 600 + i * 15, y: 300 }, false);
  }
  assert.equal(angles.length, 0);
});
