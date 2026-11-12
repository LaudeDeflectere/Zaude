// Exposes a small, fixed API to the editor page. The page cannot reach Node or the file system directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaudeRemote', {
  list: () => ipcRenderer.invoke('remote:list'),
  add: (input) => ipcRenderer.invoke('remote:add', input),
  remove: (id) => ipcRenderer.invoke('remote:remove', id),
  analyze: (id) => ipcRenderer.invoke('remote:analyze', id),
});

contextBridge.exposeInMainWorld('zaudeAI', {
  getSettings: () => ipcRenderer.invoke('ai:settings:get'),
  setSettings: (input) => ipcRenderer.invoke('ai:settings:set', input),
  startTextToVideo: (input) => ipcRenderer.invoke('ai:textToVideo:start', input),
  cancelTextToVideo: (id) => ipcRenderer.invoke('ai:textToVideo:cancel', id),
  reveal: (filePath) => ipcRenderer.invoke('ai:reveal', filePath),
  mediaUrl: (filePath) => ipcRenderer.invoke('ai:mediaUrl', filePath),
  onJob: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:job', listener);
    return () => ipcRenderer.removeListener('ai:job', listener);
  },
});
