const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('api', {
  openVideoDialog: () => invoke('dialog:openVideo'),
  openMediaDialog: (kind) => invoke('dialog:openMedia', kind),
  saveDialog: (input, format) => invoke('dialog:save', { input, format }),
  mediaKind: (file) => invoke('media:kind', file),
  probe: (file) => invoke('media:probe', file),
  thumbnails: (file, duration, count) => invoke('media:thumbnails', { file, duration, count }),
  waveform: (file, track) => invoke('media:waveform', { file, track }),
  extractAudio: (file, track) => invoke('media:extractAudio', { file, track }),
  makeProxy: (file, duration) => invoke('media:proxy', { file, duration }),
  fileUrl: (file) => invoke('media:fileUrl', file),
  analyzeExport: (job, format) => invoke('export:analyze', { job, format }),
  exportVideo: (job) => invoke('export:run', job),
  cancelExport: () => invoke('export:cancel'),
  showInFolder: (file) => invoke('shell:show', file),
  openPath: (file) => invoke('shell:open', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
});
