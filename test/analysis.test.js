import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import analysis from '../electron/analysis.cjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('parseSilence pairs starts and ends, and closes a silence that runs to the end', () => {
  const text = '[silencedetect @ 0x1] silence_start: 3.5\n[silencedetect @ 0x1] silence_end: 7.25 | silence_duration: 3.75\nframe=1\n[silencedetect @ 0x1] silence_start: 58';
  assert.deepEqual(analysis.parseSilence(text, 60), [{ from: 3.5, to: 7.25 }, { from: 58, to: 60 }]);
  assert.deepEqual(analysis.parseSilence(text), [{ from: 3.5, to: 7.25 }]);
});

test('padSilences keeps breathing room and drops short leftovers', () => {
  assert.deepEqual(analysis.padSilences([{ from: 0, to: 2 }, { from: 5, to: 5.5 }, { from: 8, to: 10 }], 0.2, 0.3, 10), [{ from: 0, to: 1.8 }, { from: 8.2, to: 10 }]);
});

test('invertRanges returns the parts with sound', () => {
  assert.deepEqual(analysis.invertRanges([{ from: 2, to: 4 }, { from: 9, to: 10 }], 10), [{ from: 0, to: 2 }, { from: 4, to: 9 }]);
});

test('buildWhisperArgs covers both Whisper families', () => {
  const a = analysis.buildWhisperArgs({ command: 'whisper-ctranslate2', wav: '/t/audio.wav', outDir: '/t', language: 'de' });
  assert.deepEqual(a.args, ['/t/audio.wav', '--model', 'small', '--output_format', 'json', '--output_dir', '/t', '--language', 'de']);
  assert.equal(a.jsonFile, path.join('/t', 'audio.json'));
  const b = analysis.buildWhisperArgs({ command: 'C:\\tools\\whisper-cli.exe', wav: '/t/audio.wav', outDir: '/t', model: '/m/ggml.bin' });
  assert.deepEqual(b.args.slice(0, 5), ['-m', '/m/ggml.bin', '-f', '/t/audio.wav', '-oj']);
  assert.ok(analysis.buildWhisperArgs({ command: 'whisper-cli', wav: '/t/a.wav', outDir: '/t' }).error);
});

test('parseWhisperJson reads both output formats', () => {
  const openai = analysis.parseWhisperJson({ language: 'de', segments: [{ start: 0, end: 2.5, text: ' Hallo zusammen.' }, { start: 3, end: 4, text: ' ' }] });
  assert.deepEqual(openai, { language: 'de', segments: [{ start: 0, end: 2.5, text: 'Hallo zusammen.' }] });
  const cpp = analysis.parseWhisperJson({ result: { language: 'de' }, transcription: [{ offsets: { from: 1200, to: 3400 }, text: ' Das Rohr ist undicht.' }] });
  assert.deepEqual(cpp, { language: 'de', segments: [{ start: 1.2, end: 3.4, text: 'Das Rohr ist undicht.' }] });
  assert.equal(analysis.transcriptText(cpp), '[0:01.2–0:03.4] Das Rohr ist undicht.');
});

test('findEngine returns the first program that starts', () => {
  const probe = (name) => (name === 'whisper' ? { status: 0 } : { error: new Error('ENOENT'), status: null });
  assert.equal(analysis.findEngine(probe), 'whisper');
  assert.equal(analysis.findEngine(() => ({ error: new Error('ENOENT'), status: null })), null);
});

test('analysis results are saved next to the project and read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-an-'));
  try {
    analysis.writeAnalysis(dir, path.join(dir, 'a.mp4'), 'silence', { silences: [] });
    assert.deepEqual(analysis.readAnalysis(dir, path.join(dir, 'a.mp4'), 'silence'), { silences: [] });
    assert.equal(analysis.readAnalysis(dir, 'b.mp4', 'silence'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectSilence finds the quiet part of a real file', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-an-'));
  try {
    const wav = path.join(dir, 'a.wav');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "sine=frequency=300:duration=6,volume='if(between(t,2,4),0,1)':eval=frame", wav]);
    const r = await analysis.detectSilence(wav, { duration: 6 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.silences.length, 1);
    assert.ok(Math.abs(r.silences[0].from - 2) < 0.1 && Math.abs(r.silences[0].to - 4) < 0.1, JSON.stringify(r.silences));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
