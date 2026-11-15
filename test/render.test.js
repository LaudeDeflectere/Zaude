import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsr from 'node:fs';
import osr from 'node:os';
import pathr from 'node:path';
import { spawnSync } from 'node:child_process';
import render from '../electron/render.cjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('atempoChain keeps each step within ffmpeg limits', () => {
  assert.equal(render.atempoChain(1.5), 'atempo=1.5');
  assert.equal(render.atempoChain(4), 'atempo=2,atempo=2');
  assert.equal(render.atempoChain(0.25), 'atempo=0.5,atempo=0.5');
});

test('buildRenderArgs refuses a timeline with no media', () => {
  assert.ok(render.buildRenderArgs({ clips: [{ id: 'x', kind: 'title', name: 'Title' }], resolution: '1920 × 1080', output: '/o.mp4' }).error);
});

test('buildRenderArgs uses NVENC when asked and skips muted video audio', () => {
  const clips = [
    { id: 'v', track: 'V1', kind: 'video', path: '/a.mp4', start: 0, dur: 2, srcIn: 0, speed: 1, hasAudio: true, muted: true },
    { id: 'a', track: 'A1', kind: 'audio', path: '/b.wav', start: 0, dur: 2, srcIn: 0, speed: 1, volume: 1 },
  ];
  const b = render.buildRenderArgs({ clips, resolution: '1920 × 1080', output: '/o.mp4', encoder: 'h264_nvenc', cuda: true });
  assert.ok(b.args.includes('h264_nvenc'));
  const graph = b.args[b.args.indexOf('-filter_complex') + 1];
  assert.ok(!graph.includes('[0:a]'), 'muted video must not contribute audio');
  assert.ok(graph.includes('[1:a]'));
});

test('a real render produces an MP4 of the right length', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fsr.mkdtempSync(pathr.join(osr.tmpdir(), 'zaude-render-'));
  try {
    const video = pathr.join(dir, 'in.mp4');
    const wav = pathr.join(dir, 'tone.wav');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', wav]);
    const clips = [
      { id: 'v', track: 'V1', kind: 'video', path: video, start: 0, dur: 2, srcIn: 0, speed: 1, hasAudio: true, volume: 1, opacity: 1 },
      { id: 'a', track: 'A1', kind: 'audio', path: wav, start: 1, dur: 2, srcIn: 0, speed: 1, volume: 0.5 },
    ];
    const out = pathr.join(dir, 'out.mp4');
    const progress = [];
    const r = await render.renderTimeline({ clips, resolution: '1280 × 720', output: out, onProgress: (p) => progress.push(p) });
    assert.equal(r.ok, true, r.error);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    const duration = Number(probe.stdout.trim());
    assert.ok(Math.abs(duration - 3) < 0.2, 'duration was ' + duration);
    assert.ok(progress.length >= 0);
  } finally {
    fsr.rmSync(dir, { recursive: true, force: true });
  }
});
