// Exposes a small, fixed API to the editor page. The page cannot reach Node or the file system directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zaudeRemote', {
  list: () => ipcRenderer.invoke('remote:list'),
  add: (input) => ipcRenderer.invoke('remote:add', input),
  remove: (id) => ipcRenderer.invoke('remote:remove', id),
  analyze: (id) => ipcRenderer.invoke('remote:analyze', id),
});
