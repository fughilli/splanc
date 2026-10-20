// The window's only door to the main process (contextIsolation on, no node).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flasher', {
  send: (obj) => ipcRenderer.send('command', obj),
  onEvent: (cb) => ipcRenderer.on('sidecar-event', (_e, evt) => cb(evt)),
  confirmErase: (disk) => ipcRenderer.invoke('confirm-erase', disk),
  confirmLarge: (disk) => ipcRenderer.invoke('confirm-large', disk),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  platform: process.platform,
});
