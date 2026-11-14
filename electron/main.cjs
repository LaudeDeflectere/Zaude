// Desktop shell for Zaude. Starts a tiny local server for the editor files and opens them in a window.
// A local server is used because browsers refuse ES module scripts loaded from file:// URLs.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const remote = require('./remote-analysis.cjs');
const media = require('./media.cjs');
const project = require('./project.cjs');
const render = require('./render.cjs');
const mediaHandler = media.createMediaHandler(() => mediaRoots());
let serverPort = 0;

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
const os = require('node:os');

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

let activeJob = null; // { id, cancel }

// Folders the editor may play media from: the Zaude output folder and Mannimmate's default output.
function mediaRoots() {
  const s = loadSettings();
  return [s.outDir, path.join(os.homedir(), 'Videos', 'Mannimmate'), ...projectFolders()];
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

  ipcMain.handle('ai:textToVideo:cancel', (_e, id) => {
    if (!activeJob || activeJob.id !== id) return { ok: false, error: 'That render is not running.' };
    activeJob.cancel();
    return { ok: true };
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

  // ---------- render the timeline to an MP4 (NVIDIA encoder when available) ----------
  ipcMain.handle('render:start', async (event, input) => {
    if (!input || !Array.isArray(input.clips)) return { ok: false, error: 'No timeline to render.' };
    const folders = projectFolders();
    const folder = input.folder && folders.includes(input.folder) ? input.folder : loadSettings().outDir;
    fs.mkdirSync(folder, { recursive: true });
    const safeName = String(input.name || 'zaude').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 60) || 'zaude';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const output = path.join(folder, `${safeName}-${stamp}.mp4`);
    const sender = event.sender;
    return render.renderTimeline({
      clips: input.clips,
      resolution: input.resolution,
      output,
      onProgress: (p) => { if (!sender.isDestroyed()) sender.send('render:progress', p); },
    });
  });

  ipcMain.handle('ai:reveal', (_e, filePath) => {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return { ok: false, error: 'File not found.' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}

registerRemoteHandlers();
registerAiHandlers();
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
