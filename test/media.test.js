import { test as mtest } from 'node:test';
import mediaAssert from 'node:assert/strict';
import fsm from 'node:fs';
import osm from 'node:os';
import pathm from 'node:path';
import httpm from 'node:http';
import media from '../electron/media.cjs';

mtest('encode and decode round-trip a path', () => {
  const p = '/home/x/Videos/Zaude/a b.mp4';
  mediaAssert.equal(media.decodeMediaPath(media.encodeMediaPath(p)), p);
});

mtest('isAllowedMedia only accepts media files inside a root', () => {
  const root = '/home/x/Videos/Zaude';
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/clip.mp4', [root]), true);
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/../secret.mp4', [root]), false);
  mediaAssert.equal(media.isAllowedMedia('/etc/passwd', [root]), false);
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/clip.txt', [root]), false);
});

mtest('parseRange handles full, open, and suffix ranges', () => {
  mediaAssert.deepEqual(media.parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  mediaAssert.deepEqual(media.parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  mediaAssert.deepEqual(media.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  mediaAssert.equal(media.parseRange('bytes=2000-', 1000), 'invalid');
  mediaAssert.equal(media.parseRange('lines=1-2', 1000), 'invalid');
});

mtest('the media server serves allowed files, ranges, and refuses everything else', async () => {
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'zaude-media-'));
  const file = pathm.join(dir, 'clip.mp4');
  fsm.writeFileSync(file, Buffer.alloc(1000, 7));
  const server = httpm.createServer(media.createMediaHandler(() => [dir]));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/media/`;
  try {
    const url = base + media.encodeMediaPath(file);
    const full = await fetch(url);
    mediaAssert.equal(full.status, 200);
    mediaAssert.equal((await full.arrayBuffer()).byteLength, 1000);

    const part = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    mediaAssert.equal(part.status, 206);
    mediaAssert.equal(part.headers.get('content-range'), 'bytes 0-99/1000');
    mediaAssert.equal((await part.arrayBuffer()).byteLength, 100);

    const outside = await fetch(base + media.encodeMediaPath('/etc/passwd'));
    mediaAssert.equal(outside.status, 404);
    const traversal = await fetch(base + media.encodeMediaPath(pathm.join(dir, '..', 'x.mp4')));
    mediaAssert.equal(traversal.status, 404);
  } finally {
    server.close();
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});
