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

test('createScrewDetector NEVER rotates on single-finger mouse motion even with stale/ghost slots', () => {
  const angles = [];
  const det = TP.createScrewDetector((d) => angles.push(d));

  // Stray coordinate on slot 1 without tracking ID must NOT create a ghost finger
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 1);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, 500);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, 500);
  det.feedEvent(TP.EV_SYN, TP.SYN_REPORT, 0);

  // Single finger moving in an arc around (500, 500)
  det.feedEvent(TP.EV_KEY, TP.BTN_TOUCH, 1);
  det.feedEvent(TP.EV_KEY, TP.BTN_TOOL_FINGER, 1);
  for (let deg = 0; deg <= 90; deg += 10) {
    const rad = (deg * Math.PI) / 180;
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 0);
    if (deg === 0) det.feedEvent(TP.EV_ABS, TP.ABS_MT_TRACKING_ID, 10);
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, Math.round(500 + Math.cos(rad) * 200));
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, Math.round(500 + Math.sin(rad) * 200));
    det.feedEvent(TP.EV_SYN, TP.SYN_REPORT, 0);
  }
  assert.equal(angles.length, 0, 'single finger must never trigger rotation');

  // Even if 2 slots exist in the map, BTN_TOOL_FINGER=1 / BTN_TOOL_DOUBLETAP=0 must block rotation
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 1);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_TRACKING_ID, 11);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, 500);
  det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, 500);
  det.feedEvent(TP.EV_KEY, TP.BTN_TOOL_DOUBLETAP, 0);
  det.feedEvent(TP.EV_KEY, TP.BTN_TOOL_FINGER, 1);
  for (let deg = 0; deg <= 45; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 0);
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, Math.round(500 + Math.cos(rad) * 200));
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, Math.round(500 + Math.sin(rad) * 200));
    det.feedEvent(TP.EV_SYN, TP.SYN_REPORT, 0);
  }
  assert.equal(angles.length, 0, 'BTN_TOOL_FINGER=1 must block rotation');

  // Once BTN_TOOL_DOUBLETAP=1 and BTN_TOOL_FINGER=0 (true 2-finger anchored orbit), rotation works!
  det.feedEvent(TP.EV_KEY, TP.BTN_TOOL_FINGER, 0);
  det.feedEvent(TP.EV_KEY, TP.BTN_TOOL_DOUBLETAP, 1);
  for (let deg = 0; deg <= 45; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_SLOT, 0);
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_X, Math.round(500 + Math.cos(rad) * 200));
    det.feedEvent(TP.EV_ABS, TP.ABS_MT_POSITION_Y, Math.round(500 + Math.sin(rad) * 200));
    det.feedEvent(TP.EV_SYN, TP.SYN_REPORT, 0);
  }
  const total = angles.reduce((a, b) => a + b, 0);
  assert.ok(total > 30 && total < 50, `expected ~45 deg rotation with 2 fingers down, got ${total}`);
});
