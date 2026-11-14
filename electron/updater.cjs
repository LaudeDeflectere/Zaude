// Update support for the desktop app. Checks the newest GitHub release through the GitHub CLI
// (gh, already signed in on the user's machine), downloads the build for this platform, and
// swaps it in after the app closes. Pure helpers are exported for tests; nothing here imports electron.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO = 'fanboysonyofficial-lgtm/Zaude';
const MIN_BUILD_BYTES = 1024 * 1024;

// "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else -> null
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Picks this platform's build from a release's asset list. Matches by suffix so the
// version number in the file name does not matter.
function pickAsset(assets, platform) {
  const suffix = platform === 'win32' ? '-windows-x64.exe' : platform === 'linux' ? '-linux-x86_64.AppImage' : null;
  if (!suffix || !Array.isArray(assets)) return null;
  return assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix)) || null;
}

// The first bytes of a real build: ELF for AppImage, MZ for a Windows .exe.
function looksLikeBuild(platform, head) {
  if (!head || head.length < 4) return false;
  if (platform === 'win32') return head[0] === 0x4d && head[1] === 0x5a;
  return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
}

function shQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function psQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

// Shell script for Linux. Waits for the running app to exit, copies the new AppImage over the
// old one, and starts it again. If the copy fails, the old version is started so nothing is lost.
function linuxScript({ pid, newFile, target, logFile }) {
  return [
    '#!/bin/sh',
    `PID=${Number(pid)}`,
    `NEW=${shQuote(newFile)}`,
    `TARGET=${shQuote(target)}`,
    `LOG=${shQuote(logFile)}`,
    'i=0',
    'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.5; i=$((i+1)); done',
    'if cp "$NEW" "$TARGET.new" && chmod 755 "$TARGET.new" && mv -f "$TARGET.new" "$TARGET"; then',
    '  echo "updated $(date)" >> "$LOG"',
    'else',
    '  echo "update copy failed $(date)" >> "$LOG"',
    'fi',
    'rm -f "$NEW"',
    '"$TARGET" >/dev/null 2>&1 &',
    '',
  ].join('\n');
}

// PowerShell script for Windows. Same idea: wait for the app to close, replace the portable .exe,
// start it again. Written with a UTF-8 byte order mark so Windows PowerShell reads non-ASCII paths.
function windowsScript({ pid, newFile, target, logFile }) {
  const body = [
    '$ErrorActionPreference = "Stop"',
    `$pidToWait = ${Number(pid)}`,
    `$new = ${psQuote(newFile)}`,
    `$target = ${psQuote(target)}`,
    `$log = ${psQuote(logFile)}`,
    'try { Wait-Process -Id $pidToWait -Timeout 120 -ErrorAction SilentlyContinue } catch {}',
    'Start-Sleep -Milliseconds 500',
    'try {',
    '  Copy-Item -LiteralPath $new -Destination ($target + ".new") -Force',
    '  Move-Item -LiteralPath ($target + ".new") -Destination $target -Force',
    '  Add-Content -LiteralPath $log -Value ("updated " + (Get-Date))',
    '} catch {',
    '  Add-Content -LiteralPath $log -Value ("update copy failed: " + $_.Exception.Message)',
    '}',
    'Remove-Item -LiteralPath $new -ErrorAction SilentlyContinue',
    'Start-Process -FilePath $target',
    '',
  ].join('\r\n');
  return '﻿' + body;
}

// Asks gh for the newest published release. Resolves to { ok, tag, version, assets } or { ok: false, error }.
function fetchLatestRelease(repo = REPO) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['release', 'view', '--repo', repo, '--json', 'tagName,assets'],
      { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim().split('\n')[0];
          if (err.code === 'ENOENT') {
            return resolve({ ok: false, error: 'The GitHub CLI (gh) is not installed. Updates need it.' });
          }
          if (/not logged|authenticat|gh auth login/i.test(detail)) {
            return resolve({ ok: false, error: 'Sign in to GitHub with gh auth login to check for updates.' });
          }
          if (/release not found|no releases/i.test(detail)) {
            return resolve({ ok: false, error: 'No release has been published yet.' });
          }
          return resolve({ ok: false, error: detail || 'Could not reach GitHub.' });
        }
        try {
          const data = JSON.parse(stdout);
          const version = parseVersion(data.tagName) ? data.tagName.replace(/^v/, '') : null;
          if (!version) return resolve({ ok: false, error: `Release tag "${data.tagName}" is not a version like v1.2.3.` });
          resolve({ ok: true, tag: data.tagName, version, assets: data.assets || [] });
        } catch {
          resolve({ ok: false, error: 'GitHub sent a reply Zaude could not read.' });
        }
      }
    );
  });
}

// Downloads the platform build into dir and checks that it is a real program of the right size.
async function downloadBuild({ repo = REPO, tag, asset, platform, dir }) {
  await fs.promises.mkdir(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', dir, '--clobber'],
      { timeout: 30 * 60 * 1000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'Download failed.'));
        resolve();
      }
    );
  });
  const file = path.join(dir, asset.name);
  const stat = await fs.promises.stat(file);
  if (stat.size < MIN_BUILD_BYTES) throw new Error('The downloaded file is too small to be Zaude.');
  const fh = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(4);
  await fh.read(head, 0, 4, 0);
  await fh.close();
  if (!looksLikeBuild(platform, head)) throw new Error('The downloaded file is not a program for this system.');
  return file;
}

// Where the running app lives on disk. AppImage sets APPIMAGE; the electron-builder portable
// .exe sets PORTABLE_EXECUTABLE_FILE. Running from source sets neither, so updates are refused.
function installTarget(platform, env) {
  if (platform === 'linux') return env.APPIMAGE || null;
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE || null;
  return null;
}

module.exports = {
  REPO,
  parseVersion,
  isNewer,
  pickAsset,
  looksLikeBuild,
  linuxScript,
  windowsScript,
  fetchLatestRelease,
  downloadBuild,
  installTarget,
};
