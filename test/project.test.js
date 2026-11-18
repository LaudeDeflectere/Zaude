import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import project from '../electron/project.cjs';

test('scanFolder reports progress once per file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-scan-'));
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'b.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const seen = [];
  const res = await project.scanFolder(dir, async () => ({ duration: 3, hasVideo: true, hasAudio: true }), (p) => seen.push(p));
  assert.equal(res.ok, true);
  assert.equal(res.media.length, 2);
  assert.deepEqual(seen.map((p) => p.done), [1, 2]);
  assert.equal(seen[1].total, 2);
});
