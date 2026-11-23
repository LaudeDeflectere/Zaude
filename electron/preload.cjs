// Exposes a small, fixed API to the editor page. The page cannot reach Node or the file system directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaudeRemote', {
  list: () => ipcRenderer.invoke('remote:list'),
  add: (input) => ipcRenderer.invoke('remote:add', input),
  remove: (id) => ipcRenderer.invoke('remote:remove', id),
  analyze: (id) => ipcRenderer.invoke('remote:analyze', id),
});

contextBridge.exposeInMainWorld('zaudeProject', {
  pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
  scan: (folder) => ipcRenderer.invoke('project:scan', folder),
  load: (folder) => ipcRenderer.invoke('project:load', folder),
  save: (folder, data) => ipcRenderer.invoke('project:save', folder, data),
  waveform: (filePath) => ipcRenderer.invoke('project:waveform', filePath),
  detectBeats: (filePath, opts) => ipcRenderer.invoke('project:detectBeats', filePath, opts),
  saveZd: (input) => ipcRenderer.invoke('project:saveZd', input),
  openZd: (filePath) => ipcRenderer.invoke('project:openZd', filePath),
});

contextBridge.exposeInMainWorld('zaudeRender', {
  start: (input) => ipcRenderer.invoke('render:start', input),
  onProgress: (callback) => {
    const listener = (_event, p) => callback(p);
    ipcRenderer.on('render:progress', listener);
    return () => ipcRenderer.removeListener('render:progress', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeUpdate', {
  status: () => ipcRenderer.invoke('update:status'),
  check: () => ipcRenderer.invoke('update:check'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeAI', {
  getSettings: () => ipcRenderer.invoke('ai:settings:get'),
  setSettings: (input) => ipcRenderer.invoke('ai:settings:set', input),
  startTextToVideo: (input) => ipcRenderer.invoke('ai:textToVideo:start', input),
  cancelTextToVideo: (id) => ipcRenderer.invoke('ai:textToVideo:cancel', id),
  mannimmateOptions: (dir) => ipcRenderer.invoke('ai:mannimmate:options', dir),
  mannimmateDoctor: (dir) => ipcRenderer.invoke('ai:mannimmate:doctor', dir),
  mannimmateStart: (input) => ipcRenderer.invoke('ai:mannimmate:start', input),
  mannimmatePickFile: (kind) => ipcRenderer.invoke('ai:mannimmate:pickFile', kind),
  extractFrame: (input) => ipcRenderer.invoke('ai:extractFrame', input),
  refmodsList: (dir) => ipcRenderer.invoke('ai:refmods:list', dir),
  refmodsAdd: (input) => ipcRenderer.invoke('ai:refmods:add', input),
  refmodsGeneratePreview: (input) => ipcRenderer.invoke('ai:refmods:generatePreview', input),
  refmodsGenerateMissing: (input) => ipcRenderer.invoke('ai:refmods:generateMissing', input),
  refmodsCancelQueue: () => ipcRenderer.invoke('ai:refmods:cancelQueue'),
  onRefmodProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:refmodProgress', listener);
    return () => ipcRenderer.removeListener('ai:refmodProgress', listener);
  },
  reveal: (filePath) => ipcRenderer.invoke('ai:reveal', filePath),
  mediaUrl: (filePath) => ipcRenderer.invoke('ai:mediaUrl', filePath),
  onJob: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:job', listener);
    return () => ipcRenderer.removeListener('ai:job', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeTouchpad', {
  status: () => ipcRenderer.invoke('touchpad:status'),
  onRotate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('touchpad:rotate', listener);
    return () => ipcRenderer.removeListener('touchpad:rotate', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeAgent', {
  info: () => ipcRenderer.invoke('agent:info'),
  chat: (input) => ipcRenderer.invoke('agent:chat', input),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  listTips: () => ipcRenderer.invoke('tips:list'),
  addTip: (input) => ipcRenderer.invoke('tips:add', input),
  removeTip: (id) => ipcRenderer.invoke('tips:remove', id),
  onTipsUpdated: (callback) => {
    const listener = (_event, tips) => callback(tips);
    ipcRenderer.on('tips:updated', listener);
    return () => ipcRenderer.removeListener('tips:updated', listener);
  },
  onGetState: (handler) => {
    const listener = async (_event, { reqId }) => {
      try {
        ipcRenderer.send('bridge:reply', { reqId, result: await handler() });
      } catch (err) {
        ipcRenderer.send('bridge:reply', { reqId, result: { ok: false, error: err.message || String(err) } });
      }
    };
    ipcRenderer.on('bridge:getState', listener);
    return () => ipcRenderer.removeListener('bridge:getState', listener);
  },
  onExecTool: (handler) => {
    const listener = async (_event, { reqId, payload }) => {
      try {
        ipcRenderer.send('bridge:reply', { reqId, result: await handler(payload) });
      } catch (err) {
        ipcRenderer.send('bridge:reply', { reqId, result: { ok: false, error: err.message || String(err) } });
      }
    };
    ipcRenderer.on('bridge:execTool', listener);
    return () => ipcRenderer.removeListener('bridge:execTool', listener);
  },
});
