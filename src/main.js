const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ff = require('./ffmpeg');

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mts', 'm2ts', 'ts', '3gp', 'mpg', 'mpeg'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'];

let win;
const tempDir = path.join(app.getPath('temp'), `cortito-${process.pid}`);

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0b0b10',
    title: 'Cortito',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b10', symbolColor: '#c9c9d9', height: 46 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Permite «Abrir con…» y arrastrar un vídeo sobre el .exe
  const fileArg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
  if (fileArg) win.webContents.once('did-finish-load', () => send('open-file', path.resolve(fileArg)));
  if (process.env.CORTITO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  ff.setTempRoot(tempDir);
  createWindow();
});

app.on('window-all-closed', () => {
  ff.cancelExport();
  app.quit();
});
app.on('quit', () => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* nada */ }
});

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

ipcMain.handle('dialog:openVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir vídeo',
    properties: ['openFile'],
    filters: [{ name: 'Vídeos', extensions: VIDEO_EXT }, { name: 'Todos los archivos', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:openMedia', async (_e, kind) => {
  const filters = kind === 'audio'
    ? [{ name: 'Audio', extensions: [...AUDIO_EXT, ...VIDEO_EXT] }]
    : [{ name: 'Imágenes y vídeos', extensions: [...IMAGE_EXT, ...VIDEO_EXT] }];
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'audio' ? 'Añadir audio' : 'Añadir imagen o vídeo',
    properties: ['openFile'],
    filters: [...filters, { name: 'Todos los archivos', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:save', async (_e, { input, format }) => {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  const names = { mp4: 'Vídeo MP4', mov: 'Vídeo QuickTime', mkv: 'Vídeo Matroska' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar vídeo',
    defaultPath: path.join(dir, `${base}_editado.${format}`),
    filters: [{ name: names[format] || 'Vídeo', extensions: [format] }],
  });
  if (r.canceled) return null;
  if (path.resolve(r.filePath).toLowerCase() === path.resolve(input).toLowerCase()) {
    throw new Error('No se puede sobrescribir el vídeo original mientras se edita. Elige otro nombre.');
  }
  return r.filePath;
});

ipcMain.handle('media:kind', (_e, file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'video';
});
ipcMain.handle('media:probe', (_e, file) => ff.probe(file));
ipcMain.handle('media:thumbnails', (_e, { file, duration, count }) => ff.thumbnails(file, duration, count));
ipcMain.handle('media:waveform', (_e, { file, track }) => ff.waveform(file, track));
ipcMain.handle('media:extractAudio', (_e, { file, track }) => ff.extractAudio(file, track));
ipcMain.handle('media:proxy', (_e, { file, duration }) =>
  ff.makeProxy(file, duration, (p) => send('progress', { kind: 'proxy', value: p })));
ipcMain.handle('media:fileUrl', (_e, file) => pathToFileURL(file).href);
ipcMain.handle('export:analyze', (_e, { job, format }) => ff.copyAnalysis(job, format));

ipcMain.handle('export:run', async (_e, job) => {
  const t0 = Date.now();
  win.setProgressBar(0);
  try {
    const r = await ff.exportVideo(job, (p) => {
      send('progress', { kind: 'export', value: p });
      win.setProgressBar(p);
    });
    const size = fs.statSync(job.outPath).size;
    return { ok: true, ...r, size, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { ok: false, cancelled: !!e.cancelled, error: e.message };
  } finally {
    win.setProgressBar(-1);
  }
});
ipcMain.handle('export:cancel', () => ff.cancelExport());
ipcMain.handle('shell:show', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('shell:open', (_e, file) => shell.openPath(file));
