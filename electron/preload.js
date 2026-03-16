'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scrapper', {
  install: () => ipcRenderer.send('setup:install'),
  continue: () => ipcRenderer.send('setup:continue'),
  onProgress: cb => ipcRenderer.on('setup:progress', (_, msg) => cb(msg)),
  onDone: cb => ipcRenderer.once('setup:done', (_, result) => cb(result)),
});
