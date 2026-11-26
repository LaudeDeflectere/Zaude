import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCameraAngle } from '../src/camera-gizmo-3d.js';

test('describeCameraAngle maps 3D orbit azimuth/elevation/distance to accurate cinematic angles', () => {
  const front = describeCameraAngle(0, 5, 3.0);
  assert.match(front.promptSnippet, /Medium shot.*front-facing.*eye-level/);

  const topDown = describeCameraAngle(45, 70, 4.8);
  assert.match(topDown.promptSnippet, /Wide full-body shot.*three-quarter right.*top-down/);

  const lowProfile = describeCameraAngle(-90, -25, 1.8);
  assert.match(lowProfile.promptSnippet, /Close-up shot.*left side profile.*low-angle/);

  const rear = describeCameraAngle(175, 10, 3.0);
  assert.match(rear.promptSnippet, /rear view from behind/);
});
