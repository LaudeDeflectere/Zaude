import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/timeline.js';

test('previewRate plays the whole file in about six seconds, within 2x to 16x', () => {
  assert.equal(T.previewRate(60), 10);
  assert.equal(T.previewRate(12), 2);
  assert.equal(T.previewRate(600), 16);
  assert.equal(T.previewRate(null), 4);
  assert.equal(T.previewRate(0), 4);
});

test('zoomFactor zooms in when scrolling up and out when scrolling down', () => {
  assert.ok(T.zoomFactor(-100) > 1);
  assert.ok(T.zoomFactor(100) < 1);
  assert.equal(T.zoomFactor(0), 1);
  // a line-based wheel (deltaMode 1) counts as 16 px per line
  assert.equal(T.zoomFactor(-1, 1), T.zoomFactor(-16, 0));
});

test('zoomScrollLeft keeps the time under the cursor in place', () => {
  // at 10 px/s, scrolled 100 px, cursor 50 px into the view: time 15 s is under the cursor
  const left = T.zoomScrollLeft(10, 20, 100, 50);
  // at 20 px/s that time must sit at the same 50 px: 15 * 20 - 50 = 250
  assert.equal(left, 250);
  assert.equal(15 * 20 - left, 50);
});

test('zoomScrollLeft never scrolls before the start', () => {
  assert.equal(T.zoomScrollLeft(10, 1, 0, 0), 0);
});
