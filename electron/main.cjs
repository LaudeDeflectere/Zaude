// Desktop shell for Zaude. Starts a tiny local server for the editor files and opens them in a window.
// A local server is used because browsers refuse ES module scripts loaded from file:// URLs.
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const remote = require('./remote-analysis.cjs');

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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 740,
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

registerRemoteHandlers();
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
