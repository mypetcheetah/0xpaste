'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  dropTarget: () => ipcRenderer.send('capture:drop-target'),
  cancelCapture: () => ipcRenderer.send('capture:cancel'),

  onInit: (cb) => ipcRenderer.on('capture:init', (_, data) => cb(data)),
  onAccent: (cb) => ipcRenderer.on('capture:accent', (_, hex) => cb(hex))
});
