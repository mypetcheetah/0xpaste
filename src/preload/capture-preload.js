'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  dropTarget: () => ipcRenderer.send('capture:drop-target'),
  cancelCapture: () => ipcRenderer.send('capture:cancel'),

  onInit: (cb) => ipcRenderer.on('capture:init', (_, data) => cb(data))
});
