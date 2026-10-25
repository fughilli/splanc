// Splanc Bridge Flasher — Electron main process.
// Adapted from td-deploy Studio (app/electron/main.js, MIT): spawns the Python
// sidecar (frozen binary in the packaged app, ../sidecar.py in dev), bridges its
// JSON-lines protocol to the window, and owns the native dialogs.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

let win = null;
let sidecar = null;

function sidecarCommand() {
  const exe = process.platform === 'win32' ? 'splanc-flasher-sidecar.exe' : 'splanc-flasher-sidecar';
  const bundled = path.join(process.resourcesPath || '', 'sidecar', exe);
  if (fs.existsSync(bundled)) return { cmd: bundled, args: [] };
  const py = process.env.SPLANC_FLASHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return { cmd: py, args: [path.join(__dirname, '..', 'sidecar.py')] };
}

function send(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('sidecar-event', evt);
}

function startSidecar() {
  const { cmd, args } = sidecarCommand();
  sidecar = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });
  const rl = readline.createInterface({ input: sidecar.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      send(JSON.parse(line));
    } catch (e) {
      /* ignore stray non-JSON output */
    }
  });
  sidecar.on('exit', (code) => send({ type: 'fatal', message: `The flasher's helper stopped (${code}).` }));
  sidecar.on('error', (err) => send({ type: 'fatal', message: `Couldn't start the flasher's helper: ${err.message}` }));
}

function toSidecar(obj) {
  if (sidecar && sidecar.stdin.writable) sidecar.stdin.write(JSON.stringify(obj) + '\n');
}

const APP_ICON = path.join(__dirname, 'build', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'Splanc Bridge Flasher',
    backgroundColor: '#0e0e12',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Never navigate the app window; links open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  createWindow();
  startSidecar();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (sidecar) sidecar.kill();
  app.quit();
});

ipcMain.on('command', (_e, obj) => toSidecar(obj));

ipcMain.handle('confirm-erase', async (_e, { name, size }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Erase and write'],
    defaultId: 0,
    cancelId: 0,
    title: 'Erase this card?',
    message: `Erase “${name}” (${size}) and write the Splanc bridge onto it?`,
    detail: 'Everything on it will be deleted. Your computer will ask for your password to write the card.',
  });
  return r.response === 1;
});

ipcMain.handle('confirm-large', async (_e, { name, size }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'It is the SD card'],
    defaultId: 0,
    cancelId: 0,
    title: 'That is a big disk',
    message: `“${name}” is ${size} — much bigger than a typical SD card.`,
    detail: 'Is this really the SD card for your Pi, and not a backup or external drive?',
  });
  return r.response === 1;
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a Splanc bridge image',
    properties: ['openFile'],
    filters: [{ name: 'SD card image', extensions: ['img', 'zst'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

const LINKS = new Set([
  'https://github.com/Studio-Fug/splanc/blob/main/docs/guides/cloud-agent.md',
  'https://github.com/Studio-Fug/splanc/blob/main/docs/pi-bridge.md',
  'https://github.com/Studio-Fug/splanc/releases',
]);
ipcMain.handle('open-link', (_e, url) => {
  if (LINKS.has(url)) shell.openExternal(url);
});
