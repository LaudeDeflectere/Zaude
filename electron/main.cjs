// Desktop shell for Zaude. Starts a tiny local server for the editor files and opens them in a window.
// A local server is used because browsers refuse ES module scripts loaded from file:// URLs.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');

// Identify Zaude as its own audio client in PipeWire/PulseAudio (avoids inheriting
// a stale/low saved stream volume for generic "Chromium" in WirePlumber).
app.setName('Zaude');
if (!process.env.PULSE_PROP) process.env.PULSE_PROP = 'application.name=Zaude';

// Enable hardware GPU rasterization and WebGL while capping the JS heap on 16 GB laptops.
// (Linux VA-API zero-copy decode flags are omitted to avoid hybrid Intel/NVIDIA GPU SIGSEGVs.)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1536');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const remote = require('./remote-analysis.cjs');
const media = require('./media.cjs');
const project = require('./project.cjs');
const waveform = require('./waveform.cjs');
const beats = require('./beats.cjs');
const zdFormat = require('./zd-format.cjs');
const touchpad = require('./touchpad.cjs');
const tipsStore = require('./tips.cjs');
const aiChat = require('./ai-chat.cjs');
const render = require('./render.cjs');
const updater = require('./updater.cjs');
const { spawn } = require('node:child_process');
const mediaHandler = media.createMediaHandler(() => mediaRoots());
let serverPort = 0;
const bridgeToken = crypto.randomBytes(16).toString('hex');
const pendingBridge = new Map(); // reqId -> { resolve, timer }
let activeChat = null;

const bridgeFile = () => path.join(app.getPath('userData'), 'bridge.json');
const tipsFile = () => path.join(app.getPath('userData'), 'ai-tips.json');
const mcpServerPath = () => path.join(__dirname, 'mcp-server.cjs');

function broadcastTips() {
  const tips = tipsStore.loadTips(tipsFile());
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('tips:updated', tips);
  }
  return tips;
}

function askRenderer(channel, payload, timeoutMs = 10000) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'No open Zaude editor window.' });
  }
  const reqId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingBridge.delete(reqId);
      resolve({ ok: false, error: 'Zaude editor did not respond in time.' });
    }, timeoutMs);
    pendingBridge.set(reqId, { resolve, timer });
    win.webContents.send(channel, { reqId, payload });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2 * 1024 * 1024) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleApiRequest(req, res) {
  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.headers['x-zaude-token'] !== bridgeToken) {
    return sendJson(401, { ok: false, error: 'Unauthorized' });
  }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(200, await askRenderer('bridge:getState', {}));
    }
    if (req.method === 'POST' && pathname === '/api/tool') {
      const body = await readJsonBody(req);
      return sendJson(200, await askRenderer('bridge:execTool', body));
    }
    if (req.method === 'GET' && pathname === '/api/tips') {
      return sendJson(200, { ok: true, tips: tipsStore.loadTips(tipsFile()) });
    }
    if (req.method === 'POST' && pathname === '/api/tips') {
      const body = await readJsonBody(req);
      const added = tipsStore.addTip(tipsFile(), body);
      if (added.ok) broadcastTips();
      return sendJson(added.ok ? 200 : 400, added);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/tips/')) {
      const id = decodeURIComponent(pathname.slice('/api/tips/'.length));
      const resDel = tipsStore.removeTip(tipsFile(), id);
      broadcastTips();
      return sendJson(200, resDel);
    }
    return sendJson(404, { ok: false, error: 'Unknown API route' });
  } catch (err) {
    return sendJson(500, { ok: false, error: err.message || String(err) });
  }
}

const ROOT = path.join(__dirname, '..');
const ALLOWED = /^(index\.html|styles\.css|src\/.+\.js)$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) return handleApiRequest(req, res);
      if (req.url.startsWith('/media/')) return mediaHandler(req, res);
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!ALLOWED.test(rel)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      fs.readFile(path.join(ROOT, rel), (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- remote machines ----------
// Saved in the app's data folder as JSON. Each machine keeps its last analysis report,
// so the app knows its capabilities on the next start without connecting again.

const storeFile = () => path.join(app.getPath('userData'), 'remote-machines.json');

function loadMachines() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(data.machines) ? data.machines : [];
  } catch {
    return [];
  }
}

function saveMachines(machines) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  const tmp = storeFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, machines }, null, 2));
  fs.renameSync(tmp, storeFile());
}

function registerRemoteHandlers() {
  ipcMain.handle('remote:list', () => loadMachines());

  ipcMain.handle('remote:add', (_e, input) => {
    const checked = remote.validateMachineInput(input);
    if (!checked.ok) return checked;
    const machine = { id: crypto.randomUUID(), ...checked.value, report: null, analyzedAt: null, lastError: null };
    const machines = loadMachines();
    machines.push(machine);
    saveMachines(machines);
    return { ok: true, machine };
  });

  ipcMain.handle('remote:remove', (_e, id) => {
    const machines = loadMachines().filter((m) => m.id !== id);
    saveMachines(machines);
    return { ok: true, machines };
  });

  // Runs the analysis again. Used for the first analysis and for Reconfigure.
  ipcMain.handle('remote:analyze', async (_e, id) => {
    const machines = loadMachines();
    const machine = machines.find((m) => m.id === id);
    if (!machine) return { ok: false, error: 'That machine is no longer saved.' };
    const result = await remote.runAnalysis(machine);
    if (result.ok) {
      machine.report = result.report;
      machine.analyzedAt = new Date().toISOString();
      machine.lastError = null;
    } else {
      machine.lastError = { message: result.error, at: new Date().toISOString() };
    }
    saveMachines(machines);
    return { ok: result.ok, machine, error: result.ok ? null : result.error };
  });
}

async function createWindow() {
  const server = await startServer();
  const { port } = server.address();
  serverPort = port;
  try {
    fs.mkdirSync(path.dirname(bridgeFile()), { recursive: true });
    fs.writeFileSync(bridgeFile(), JSON.stringify({
      port,
      token: bridgeToken,
      pid: process.pid,
      mcpServerPath: mcpServerPath(),
      updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    title: 'Zaude',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#121218',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => server.close());
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------- AI: text to video ----------
// One render at a time, since the GPU runs one job. Progress goes to the window as "ai:job" events.
const textToVideo = require('./text-to-video.cjs');
const mannimmate = require('./mannimmate.cjs');
const refmodsLib = require('./refmods.cjs');
const os = require('node:os');

const refmodsRoot = () => path.join(ROOT, 'refmods');
const previewRoot = () => path.join(app.getPath('userData'), 'ai-previews');
const pickedMediaDirs = new Set();
const mediaUrlFor = (filePath) => (filePath && serverPort
  ? `http://127.0.0.1:${serverPort}/media/${media.encodeMediaPath(filePath)}`
  : null);

const settingsFile = () => path.join(app.getPath('userData'), 'zaude-settings.json');
const defaultMannimmateDir = () => path.join(os.homedir(), 'Documents', 'MeineProgramme', 'mannimmate');
const defaultOutDir = () => path.join(os.homedir(), 'Videos', 'Zaude');

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    saved = {};
  }
  return {
    mannimmateDir: saved.mannimmateDir || defaultMannimmateDir(),
    python: saved.python || (process.platform === 'win32' ? 'python' : 'python3'),
    outDir: saved.outDir || defaultOutDir(),
    projectFolders: Array.isArray(saved.projectFolders) ? saved.projectFolders : [],
  };
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

let activeJob = null; // { id, cancel, estSec }
const jobQueue = [];  // queued Mannimmate jobs: [{ id, input, settings, sender, estSec }]
const zdSessionDirs = new Set();

// Folders the editor may play media from: the Zaude output folder, Mannimmate's default output,
// RefMod preview folders, live AI previews, picked input image/video folders, opened project folders, and unpacked .zd sessions.
function mediaRoots() {
  const s = loadSettings();
  return [
    s.outDir,
    path.join(os.homedir(), 'Videos', 'Mannimmate'),
    refmodsRoot(),
    previewRoot(),
    ...pickedMediaDirs,
    ...projectFolders(),
    ...zdSessionDirs,
  ];
}

function projectFolders() {
  return loadSettings().projectFolders || [];
}

function registerAiHandlers() {
  ipcMain.handle('ai:settings:get', () => loadSettings());

  ipcMain.handle('ai:settings:set', (_e, input) => {
    const current = loadSettings();
    const mannimmateDir = String((input && input.mannimmateDir) || '').trim() || current.mannimmateDir;
    const outDir = String((input && input.outDir) || '').trim() || current.outDir;
    const next = { ...current, mannimmateDir, outDir };
    saveSettings(next);
    return { ok: true, settings: next };
  });

  ipcMain.handle('ai:textToVideo:start', (event, input) => {
    if (activeJob) return { ok: false, error: 'A render is already running. Wait for it or cancel it.' };
    const checked = textToVideo.validateRequest(input);
    if (!checked.ok) return checked;

    const settings = loadSettings();
    const id = crypto.randomUUID();
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:job', { id, ...payload });
    };
    const job = textToVideo.runTextToVideo({
      mannimmateDir: settings.mannimmateDir,
      python: settings.python,
      request: checked.value,
      promptDir: path.join(app.getPath('userData'), 'ai-prompts'),
      outDir: settings.outDir,
      onEvent: send,
    });
    activeJob = { id, cancel: job.cancel };
    job.promise.then((result) => {
      activeJob = null;
      if (result.ok) send({ type: 'done', path: result.path });
      else send({ type: result.cancelled ? 'cancelled' : 'error', message: result.error });
    });
    return { ok: true, id };
  });

  function broadcastQueueStatus() {
    let cumEta = activeJob ? (activeJob.remainingEta ?? activeJob.estSec ?? 60) : 0;
    if (activeJob && activeJob.send) {
      activeJob.send({ type: 'queue', queuePos: 1, queueTotal: 1 + jobQueue.length, etaSec: cumEta });
    }
    jobQueue.forEach((item, idx) => {
      cumEta += item.estSec;
      item.send({
        type: 'queue',
        queuePos: idx + (activeJob ? 2 : 1),
        queueTotal: (activeJob ? 1 : 0) + jobQueue.length,
        etaSec: cumEta,
      });
    });
  }

  function pumpJobQueue() {
    if (activeJob || !jobQueue.length) return;
    const next = jobQueue.shift();
    const { id, input, mannimmateDir, settings, send, estSec } = next;
    const job = mannimmate.runJob({
      mannimmateDir,
      python: settings.python,
      request: input,
      promptDir: path.join(app.getPath('userData'), 'ai-prompts'),
      previewDir: previewRoot(),
      jobId: id,
      outDir: settings.outDir,
      onEvent: (ev) => {
        if (ev.etaSec && activeJob && activeJob.id === id) activeJob.remainingEta = ev.etaSec;
        if (ev.type === 'preview' && ev.previewPath) {
          pickedMediaDirs.add(path.dirname(ev.previewPath));
          send({ ...ev, previewUrl: mediaUrlFor(ev.previewPath) });
        } else {
          send(ev);
        }
      },
    });
    activeJob = { id, cancel: job.cancel, send, estSec, remainingEta: estSec };
    broadcastQueueStatus();
    job.promise.then((result) => {
      activeJob = null;
      if (result.ok) send({ type: 'done', path: result.path, dryRun: Boolean(result.dryRun), code: result.code });
      else send({ type: result.cancelled ? 'cancelled' : 'error', message: result.error, code: result.code });
      pumpJobQueue();
      broadcastQueueStatus();
    });
  }

  ipcMain.handle('ai:textToVideo:cancel', (_e, id) => {
    if (activeJob && activeJob.id === id) {
      activeJob.cancel();
      return { ok: true };
    }
    const qIdx = jobQueue.findIndex((j) => j.id === id);
    if (qIdx >= 0) {
      const [removed] = jobQueue.splice(qIdx, 1);
      removed.send({ type: 'cancelled', message: 'Removed from queue.' });
      broadcastQueueStatus();
      return { ok: true };
    }
    return { ok: false, error: 'That render is not running or queued.' };
  });

  // ---------- Visual RefMod Library (<appRoot>/refmods/<slug>/) ----------
  ipcMain.handle('ai:refmods:list', async (_e, dirOverride) => {
    const settings = loadSettings();
    const mannimmateDir = String(dirOverride || '').trim() || settings.mannimmateDir;
    const optRes = await mannimmate.fetchOptions({ mannimmateDir, python: settings.python });
    const rawMods = optRes && optRes.data && Array.isArray(optRes.data.mods) ? optRes.data.mods : [];
    const entries = refmodsLib.syncRefMods(refmodsRoot(), rawMods).map((item) => ({
      ...item,
      headshotUrl: item.headshotPath ? mediaUrlFor(item.headshotPath) : null,
      walkUrl: item.walkPath ? mediaUrlFor(item.walkPath) : null,
    }));
    return {
      ok: true,
      refmodsDir: refmodsRoot(),
      refmods: entries,
      options: optRes && optRes.data ? optRes.data : null,
      optionsError: optRes && !optRes.ok ? optRes.error : null,
    };
  });

  ipcMain.handle('ai:refmods:add', (_e, input) => {
    const entry = refmodsLib.createRefModFolder(refmodsRoot(), input || {});
    return {
      ok: true,
      entry: {
        ...entry,
        headshotUrl: entry.headshotPath ? mediaUrlFor(entry.headshotPath) : null,
        walkUrl: entry.walkPath ? mediaUrlFor(entry.walkPath) : null,
      },
    };
  });

  let activeRefmodPreview = null; // { slug, cancel }
  const refmodPreviewQueue = [];  // [{ mod, mannimmateDir, settings, sender }]

  function broadcastRefmodQueue(sender) {
    const queuedSlugs = [
      ...(activeRefmodPreview ? [activeRefmodPreview.slug] : []),
      ...refmodPreviewQueue.map((x) => x.mod.slug),
    ];
    if (sender && !sender.isDestroyed()) {
      sender.send('ai:refmodProgress', {
        type: 'queue',
        activeSlug: activeRefmodPreview ? activeRefmodPreview.slug : null,
        queuedSlugs,
        remaining: queuedSlugs.length,
      });
    }
  }

  function pumpRefmodPreviewQueue() {
    if (activeRefmodPreview || !refmodPreviewQueue.length) return;
    const item = refmodPreviewQueue.shift();
    const { mod, mannimmateDir, settings, sender } = item;
    const send = (payload) => {
      if (sender && !sender.isDestroyed()) sender.send('ai:refmodProgress', { slug: mod.slug, ...payload });
    };
    const job = refmodsLib.generateRefModAssets({
      refmodsRoot: refmodsRoot(),
      mannimmateDir,
      python: settings.python,
      mod,
      onEvent: send,
    });
    activeRefmodPreview = { slug: mod.slug, cancel: job.cancel, sender };
    send({ type: 'start', label: `Generating preview for ${mod.firstName || mod.slug}…` });
    broadcastRefmodQueue(sender);

    job.promise.then((res) => {
      activeRefmodPreview = null;
      if (res && res.ok && res.entry) {
        send({
          type: 'done',
          entry: {
            ...res.entry,
            headshotUrl: res.entry.headshotPath ? mediaUrlFor(res.entry.headshotPath) : null,
            walkUrl: res.entry.walkPath ? mediaUrlFor(res.entry.walkPath) : null,
          },
        });
      } else {
        send({ type: 'error', error: (res && res.error) || 'Preview failed' });
      }
      broadcastRefmodQueue(sender);
      pumpRefmodPreviewQueue();
    });
  }

  ipcMain.handle('ai:refmods:generatePreview', async (event, input) => {
    const settings = loadSettings();
    const mannimmateDir = String((input && input.mannimmateDir) || '').trim() || settings.mannimmateDir;
    const mod = input && input.mod;
    if (!mod || !mod.file) return { ok: false, error: 'No RefMod specified.' };
    const slug = mod.slug || refmodsLib.slugForRefMod(mod.file);
    const already = (activeRefmodPreview && activeRefmodPreview.slug === slug)
      || refmodPreviewQueue.some((x) => x.mod.slug === slug);
    if (!already) {
      refmodPreviewQueue.push({ mod: { ...mod, slug }, mannimmateDir, settings, sender: event.sender });
      broadcastRefmodQueue(event.sender);
      pumpRefmodPreviewQueue();
    }
    return { ok: true, queued: 1 };
  });

  ipcMain.handle('ai:refmods:generateMissing', (event, input) => {
    const settings = loadSettings();
    const mannimmateDir = String((input && input.mannimmateDir) || '').trim() || settings.mannimmateDir;
    const mods = Array.isArray(input && input.mods) ? input.mods : [];
    let added = 0;
    for (const mod of mods) {
      if (!mod || !mod.file) continue;
      if (mod.hasHeadshot && mod.hasWalk) continue;
      const slug = mod.slug || refmodsLib.slugForRefMod(mod.file);
      const already = (activeRefmodPreview && activeRefmodPreview.slug === slug)
        || refmodPreviewQueue.some((x) => x.mod.slug === slug);
      if (already) continue;
      refmodPreviewQueue.push({ mod: { ...mod, slug }, mannimmateDir, settings, sender: event.sender });
      added++;
    }
    broadcastRefmodQueue(event.sender);
    pumpRefmodPreviewQueue();
    return { ok: true, queued: added, total: (activeRefmodPreview ? 1 : 0) + refmodPreviewQueue.length };
  });

  ipcMain.handle('ai:refmods:cancelQueue', (event) => {
    refmodPreviewQueue.length = 0;
    if (activeRefmodPreview) {
      activeRefmodPreview.cancel();
    }
    broadcastRefmodQueue(event.sender);
    return { ok: true };
  });

  // ---------- Unified Mannimmate AI Studio (Text->Video, RefMod, Auto, Coverage) ----------
  ipcMain.handle('ai:mannimmate:options', async (_e, dirOverride) => {
    const settings = loadSettings();
    const mannimmateDir = String(dirOverride || '').trim() || settings.mannimmateDir;
    return mannimmate.fetchOptions({ mannimmateDir, python: settings.python });
  });

  ipcMain.handle('ai:mannimmate:doctor', async (_e, dirOverride) => {
    const settings = loadSettings();
    const mannimmateDir = String(dirOverride || '').trim() || settings.mannimmateDir;
    return mannimmate.runDoctor({ mannimmateDir, python: settings.python });
  });

  ipcMain.handle('ai:mannimmate:pickFile', async (event, kind) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const filters = kind === 'video'
      ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'] }]
      : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
    const res = await dialog.showOpenDialog(win, {
      title: kind === 'video' ? 'Choose source video' : 'Choose reference image',
      properties: ['openFile'],
      filters,
    });
    if (res.canceled || !res.filePaths.length) return null;
    const chosen = res.filePaths[0];
    pickedMediaDirs.add(path.dirname(chosen));
    return { path: chosen, url: mediaUrlFor(chosen) };
  });

  ipcMain.handle('ai:mannimmate:start', (event, input) => {
    const settings = loadSettings();
    const mannimmateDir = String((input && input.mannimmateDir) || '').trim() || settings.mannimmateDir;
    if (mannimmateDir !== settings.mannimmateDir) {
      saveSettings({ ...settings, mannimmateDir });
    }
    const id = crypto.randomUUID();
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:job', { id, ...payload });
    };
    const estSec = mannimmate.estimateJobSeconds(input);
    const queuePos = (activeJob ? 1 : 0) + jobQueue.length + 1;
    jobQueue.push({ id, input, mannimmateDir, settings, send, estSec });
    pumpJobQueue();
    broadcastQueueStatus();
    return { ok: true, id, queuePos, etaSec: estSec };
  });

  // Gives the editor a URL it can play. Only files inside the output folders are allowed.
  ipcMain.handle('ai:mediaUrl', (_e, filePath) => {
    if (!media.isAllowedMedia(filePath, mediaRoots())) return { ok: false, error: 'Not a playable file in the output folders.' };
    return { ok: true, url: `http://127.0.0.1:${serverPort}/media/${media.encodeMediaPath(filePath)}` };
  });

  // ---------- project folders ----------
  ipcMain.handle('project:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a project folder' });
    if (result.canceled || !result.filePaths.length) return null;
    const folder = result.filePaths[0];
    const current = loadSettings();
    if (!current.projectFolders.includes(folder)) {
      saveSettings({ ...current, projectFolders: [...current.projectFolders, folder] });
    }
    return folder;
  });

  ipcMain.handle('project:scan', async (_e, folder) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.scanFolder(folder);
  });

  ipcMain.handle('project:load', (_e, folder) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.loadProject(folder);
  });

  ipcMain.handle('project:save', (_e, folder, data) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'No folder given.' };
    return project.saveProject(folder, data, projectFolders());
  });

  ipcMain.handle('project:waveform', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !media.isAllowedMedia(filePath, mediaRoots())) {
      return { ok: false, error: 'Not an allowed media file.' };
    }
    return waveform.extractWaveform(filePath);
  });

  ipcMain.handle('project:detectBeats', async (_e, filePath, opts) => {
    if (typeof filePath !== 'string' || !media.isAllowedMedia(filePath, mediaRoots())) {
      return { ok: false, error: 'Not an allowed media file.' };
    }
    const beatsPerBar = opts && Number(opts.beatsPerBar) >= 2 && Number(opts.beatsPerBar) <= 8
      ? Math.round(Number(opts.beatsPerBar))
      : 4;
    return beats.detectBeats(filePath, { beatsPerBar });
  });

  ipcMain.handle('project:saveZd', async (event, input) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Nothing to save.' };
    const win = BrowserWindow.fromWebContents(event.sender);
    let targetPath = typeof input.filePath === 'string' && input.filePath.trim() ? input.filePath.trim() : null;
    if (!targetPath || input.saveAs) {
      const safeName = String(input.name || 'Untitled').replace(/[^A-Za-z0-9 _.-]/g, '_').trim() || 'Untitled';
      const defaultPath = targetPath || path.join(os.homedir(), 'Videos', `${safeName}.zd`);
      const res = await dialog.showSaveDialog(win, {
        title: 'Save Zaude Project (.zd)',
        defaultPath,
        filters: [{ name: 'Zaude Project (*.zd)', extensions: ['zd'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
      targetPath = res.filePath.toLowerCase().endsWith('.zd') ? res.filePath : res.filePath + '.zd';
    }
    return zdFormat.writeZdFile(targetPath, {
      name: input.name || path.basename(targetPath, '.zd'),
      format: input.format,
      resolution: input.resolution,
      clips: input.clips,
      media: input.media,
    });
  });

  ipcMain.handle('project:openZd', async (event, maybePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let targetPath = typeof maybePath === 'string' && maybePath.trim() ? maybePath.trim() : null;
    if (!targetPath) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Open Zaude Project (.zd)',
        properties: ['openFile'],
        filters: [{ name: 'Zaude Project (*.zd)', extensions: ['zd'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      targetPath = res.filePaths[0];
    }
    const extractRoot = path.join(app.getPath('userData'), 'zd-sessions');
    const opened = await zdFormat.readZdFile(targetPath, extractRoot);
    if (opened.ok && opened.sessionDir) {
      zdSessionDirs.add(opened.sessionDir);
    }
    return opened;
  });

  // ---------- render the timeline to an MP4 (NVIDIA encoder when available) ----------
  // A project's caption file must be a plain file name inside the project folder.
  function captionsPath(folder, name) {
    if (!name || typeof name !== 'string' || /[\\/]/.test(name) || !/\.(ass|srt)$/i.test(name)) return null;
    const p = path.join(folder, name);
    return fs.existsSync(p) ? p : null;
  }

  ipcMain.handle('render:start', async (event, input) => {
    if (!input || !Array.isArray(input.clips)) return { ok: false, error: 'No timeline to render.' };
    const folders = projectFolders();
    const folder = input.folder && folders.includes(input.folder) ? input.folder : loadSettings().outDir;
    fs.mkdirSync(folder, { recursive: true });
    const safeName = String(input.name || 'zaude').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 60) || 'zaude';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = String(input.format || 'MP4').toUpperCase() === 'MOV' ? 'mov' : 'mp4';
    const output = path.join(folder, `${safeName}-${stamp}.${ext}`);
    const sender = event.sender;
    renderRunning = true;
    try {
      return await render.renderTimeline({
        clips: input.clips,
        resolution: input.resolution,
        width: input.width,
        height: input.height,
        fps: input.fps,
        quality: input.quality,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        subtitles: captionsPath(folder, input.captions),
        output,
        onProgress: (p) => { if (!sender.isDestroyed()) sender.send('render:progress', p); },
      });
    } finally {
      renderRunning = false;
    }
  });

  ipcMain.handle('ai:reveal', (_e, filePath) => {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return { ok: false, error: 'File not found.' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}

// ---------- updates ----------
// Checks the newest GitHub release shortly after start and then every 6 hours. Nothing is installed
// without the user's OK: the Update button asks first, downloads the build, then the app restarts on it.
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
let renderRunning = false;
let update = { busy: false, message: '', available: false, latest: null, tag: null, assetName: null, assetUrl: null, checkedAt: null, error: null };

function updateStatus() {
  return {
    ...update,
    current: app.getVersion(),
    canInstall: Boolean(updater.installTarget(process.platform, process.env)),
  };
}

function broadcastUpdate() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('update:status', updateStatus());
  }
}

async function checkForUpdate() {
  if (update.busy) return updateStatus();
  update = { ...update, busy: true, message: 'Checking GitHub…', error: null };
  broadcastUpdate();
  const release = await updater.fetchLatestRelease();
  const checkedAt = new Date().toISOString();
  if (!release.ok) {
    update = { ...update, busy: false, message: '', available: false, error: release.error, checkedAt };
  } else {
    const asset = updater.pickAsset(release.assets, process.platform);
    const newer = updater.isNewer(release.version, app.getVersion());
    const error = newer && !asset ? 'A newer version exists but has no build for this system yet.' : null;
    update = {
      ...update,
      busy: false,
      message: '',
      available: newer && Boolean(asset),
      latest: release.version,
      tag: release.tag,
      assetName: asset ? asset.name : null,
      assetUrl: asset ? asset.url : null,
      error,
      checkedAt,
    };
  }
  broadcastUpdate();
  return updateStatus();
}

async function installUpdate(event) {
  if (update.busy) return { ok: false, error: 'Wait for the current update step to finish.' };
  if (!update.available || !update.tag || !update.assetName || !update.assetUrl) return { ok: false, error: 'No update is ready. Check for updates first.' };
  const target = updater.installTarget(process.platform, process.env);
  if (!target) return { ok: false, error: 'This copy runs from source, so it cannot replace itself. Use git pull instead.' };
  if (activeJob || renderRunning) return { ok: false, error: 'A render is running. Wait for it to finish, then update.' };

  const win = BrowserWindow.fromWebContents(event.sender);
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Update and restart', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Zaude',
    message: `Zaude ${update.latest} is ready.`,
    detail: 'Zaude downloads the new version, closes, replaces itself and starts again. Save your project first (Bin > Save project) if you have changes.',
  });
  if (choice.response !== 0) return { ok: true, cancelled: true };

  update = { ...update, busy: true, message: `Downloading Zaude ${update.latest}…`, error: null };
  broadcastUpdate();
  try {
    const dir = path.join(app.getPath('temp'), 'zaude-update');
    const file = await updater.downloadBuild({
      asset: { name: update.assetName, url: update.assetUrl },
      platform: process.platform,
      dir,
    });
    const logFile = path.join(app.getPath('userData'), 'update.log');
    const args = { pid: process.pid, newFile: file, target, logFile };
    let scriptPath;
    let child;
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      scriptPath = path.join(dir, 'zaude-update.ps1');
      fs.writeFileSync(scriptPath, updater.windowsScript(args));
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      scriptPath = path.join(dir, 'zaude-update.sh');
      fs.writeFileSync(scriptPath, updater.linuxScript(args), { mode: 0o755 });
      child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    }
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    update = { ...update, busy: false, message: 'Restarting…' };
    setTimeout(() => app.quit(), 200);
    return { ok: true };
  } catch (err) {
    update = { ...update, busy: false, message: '', error: err.message || String(err) };
    broadcastUpdate();
    return { ok: false, error: update.error };
  }
}

function registerUpdateHandlers() {
  ipcMain.handle('update:status', () => updateStatus());
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:install', (event) => installUpdate(event));
}

let touchpadWatcher = null;

function startTouchpad() {
  touchpadWatcher = touchpad.startTouchpadWatcher((deltaAngle) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send('touchpad:rotate', { deltaAngle });
    }
  });
  ipcMain.handle('touchpad:status', () => ({
    available: Boolean(touchpadWatcher && touchpadWatcher.available),
    device: touchpadWatcher ? touchpadWatcher.device || null : null,
    reason: touchpadWatcher ? touchpadWatcher.reason || null : null,
  }));
}

function registerAgentHandlers() {
  ipcMain.on('bridge:reply', (_e, { reqId, result }) => {
    const entry = pendingBridge.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingBridge.delete(reqId);
    entry.resolve(result);
  });

  ipcMain.handle('agent:info', () => ({
    ...aiChat.detectProviders(),
    mcpServerPath: mcpServerPath(),
    bridgePort: serverPort,
    nodePath: process.execPath,
  }));

  ipcMain.handle('agent:chat', async (_e, input) => {
    if (activeChat) return { ok: false, error: 'An AI request is already running. Wait or click Cancel.' };
    const job = aiChat.runAiChat({
      provider: input && input.provider,
      userMessage: String((input && input.message) || '').trim(),
      state: input && input.state,
      history: input && input.history,
      mcpServerPath: mcpServerPath(),
      cwd: (input && input.projectFolder) || ROOT,
    });
    activeChat = job;
    try {
      return await job.promise;
    } finally {
      activeChat = null;
    }
  });

  ipcMain.handle('agent:cancel', () => {
    if (activeChat) { activeChat.cancel(); return { ok: true }; }
    return { ok: false };
  });

  ipcMain.handle('tips:list', () => tipsStore.loadTips(tipsFile()));
  ipcMain.handle('tips:add', (_e, input) => {
    const res = tipsStore.addTip(tipsFile(), input);
    if (res.ok) broadcastTips();
    return res;
  });
  ipcMain.handle('tips:remove', (_e, id) => {
    const res = tipsStore.removeTip(tipsFile(), id);
    broadcastTips();
    return res;
  });
}

registerRemoteHandlers();
registerAiHandlers();
registerUpdateHandlers();
registerAgentHandlers();
app.whenReady().then(async () => {
  startTouchpad();
  await createWindow();
  setTimeout(() => checkForUpdate(), 15000).unref();
  setInterval(() => checkForUpdate(), UPDATE_EVERY_MS).unref();
});
app.on('window-all-closed', () => {
  if (touchpadWatcher) touchpadWatcher.stop();
  try { fs.unlinkSync(bridgeFile()); } catch { /* ignore */ }
  app.quit();
});
