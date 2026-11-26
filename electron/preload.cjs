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
  localInfo: () => ipcRenderer.invoke('ai:local:info'),
  mannimmateDoctor: (dir) => ipcRenderer.invoke('ai:mannimmate:doctor', dir),
  mannimmateStart: (input) => ipcRenderer.invoke('ai:mannimmate:start', input),
  upscaleClips: (input) => ipcRenderer.invoke('ai:upscaleClips', input),
  upscaleCapabilities: () => ipcRenderer.invoke('ai:upscaleCapabilities'),
  mannimmatePickFile: (kind) => ipcRenderer.invoke('ai:mannimmate:pickFile', kind),
  pickScript: () => ipcRenderer.invoke('ai:pickScript'),
  parseScript: (rawText) => ipcRenderer.invoke('ai:parseScript', rawText),
  buildMultiShotPrompt: (input) => ipcRenderer.invoke('ai:script:buildAgentPrompt', input),
  saveSetSnapshot: (input) => ipcRenderer.invoke('ai:saveSetSnapshot', input),
  listCoverageAngles: () => ipcRenderer.invoke('ai:listCoverageAngles'),
  buildLocationRefMod: (input) => ipcRenderer.invoke('ai:buildLocationRefMod', input),
  pickAudioFile: () => ipcRenderer.invoke('ai:pickAudioFile'),
  lipSyncClip: (input) => ipcRenderer.invoke('ai:lipSyncClip', input),
  generateVoiceAudio: (input) => ipcRenderer.invoke('ai:audio:generateVoice', input),
  estimateVoiceCadence: (text) => ipcRenderer.invoke('ai:audio:estimateCadence', text),
  voiceChangeAudio: (input) => ipcRenderer.invoke('ai:audio:voiceChange', input),
  saveAudioRecording: (input) => ipcRenderer.invoke('ai:audio:saveRecording', input),
  analyzeVideoMotion: (input) => ipcRenderer.invoke('ai:recast:analyze', input),
  buildRecastRequest: (input) => ipcRenderer.invoke('ai:recast:build', input),
  extractFrame: (input) => ipcRenderer.invoke('ai:extractFrame', input),
  trimSeedClip: (input) => ipcRenderer.invoke('ai:trimSeedClip', input),
  clipLatent: (filePath) => ipcRenderer.invoke('ai:clipLatent', filePath),
  refmodsList: (dir) => ipcRenderer.invoke('ai:refmods:list', dir),
  refmodsAdd: (input) => ipcRenderer.invoke('ai:refmods:add', input),
  refmodsSetCategory: (input) => ipcRenderer.invoke('ai:refmods:setCategory', input),
  refmodsSetFolder: (input) => ipcRenderer.invoke('ai:refmods:setFolder', input),
  showcaseLoad: () => ipcRenderer.invoke('ai:showcase:load'),
  showcaseRender: (input) => ipcRenderer.invoke('ai:showcase:render', input),
  stylizeMakeCharSheet: (input) => ipcRenderer.invoke('ai:stylize:makeCharSheet', input),
  refmodsDelete: (input) => ipcRenderer.invoke('ai:refmods:delete', input),
  refmodsPickFiles: (kind) => ipcRenderer.invoke('ai:refmods:pickFiles', kind),
  refmodsBuild: (input) => ipcRenderer.invoke('ai:refmods:build', input),
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

contextBridge.exposeInMainWorld('zaudeAdvisor', {
  analyze: (opts) => ipcRenderer.invoke('advisor:analyze', opts),
  research: (opts) => ipcRenderer.invoke('advisor:research', opts),
  cancelResearch: () => ipcRenderer.invoke('advisor:cancelResearch'),
  install: (opts) => ipcRenderer.invoke('advisor:install', opts),
  cancelInstall: () => ipcRenderer.invoke('advisor:cancelInstall'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('advisor:event', listener);
    return () => ipcRenderer.removeListener('advisor:event', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeAudio', {
  listRoomPresets: () => ipcRenderer.invoke('audio:listRoomPresets'),
  generateRoomToneBed: (input) => ipcRenderer.invoke('audio:generateRoomToneBed', input),
});

contextBridge.exposeInMainWorld('zaudePrompt', {
  advance: (input) => ipcRenderer.invoke('prompt:advance', input),
  cancel: () => ipcRenderer.invoke('prompt:cancel'),
  listMasters: () => ipcRenderer.invoke('prompt:masters'),
  listLibrary: () => ipcRenderer.invoke('prompt:library'),
  listDb: () => ipcRenderer.invoke('prompt:db:list'),
  saveDb: (input) => ipcRenderer.invoke('prompt:db:save', input),
  rateDb: (input) => ipcRenderer.invoke('prompt:db:rate', input),
  removeDb: (id) => ipcRenderer.invoke('prompt:db:remove', id),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('prompt:event', listener);
    return () => ipcRenderer.removeListener('prompt:event', listener);
  },
});

contextBridge.exposeInMainWorld('zaudeModal', {
  status: () => ipcRenderer.invoke('modal:status'),
  usage: () => ipcRenderer.invoke('modal:usage'),
  stopAll: () => ipcRenderer.invoke('modal:stopAll'),
  saveConfig: (input) => ipcRenderer.invoke('modal:saveConfig', input),
  plan: (input) => ipcRenderer.invoke('modal:plan', input),
  estimate: (input) => ipcRenderer.invoke('modal:estimate', input),
  deploy: (input) => ipcRenderer.invoke('modal:deploy', input),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('modal:event', listener);
    return () => ipcRenderer.removeListener('modal:event', listener);
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
