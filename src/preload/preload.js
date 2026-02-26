'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Clipboard history
  getHistory: () => ipcRenderer.invoke('clipboard:get-history'),
  deleteItem: (id) => ipcRenderer.send('clipboard:delete-item', { id }),
  clearAll: () => ipcRenderer.send('clipboard:clear-all'),
  togglePin: (id) => ipcRenderer.send('clipboard:toggle-pin', { id }),

  // Typing flows
  startDrag: (text) => ipcRenderer.send('typing:start-drag', { text }),
  startClick: (text) => ipcRenderer.send('typing:start-click', { text }),
  cancelTyping: () => ipcRenderer.send('typing:cancel'),

  // Overlay lifecycle
  hideOverlayDone: () => ipcRenderer.send('overlay:hide-done'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key, value) => ipcRenderer.send('settings:update', { key, value }),
  hotkeyCapture: (active) => ipcRenderer.send('hotkey:capture', { active }),

  // Listeners
  onNewItem: (cb) => ipcRenderer.on('clipboard:new-item', (_, item) => cb(item)),
  onInitialHistory: (cb) => ipcRenderer.on('clipboard:initial-history', (_, history) => cb(history)),
  onPinUpdated: (cb) => ipcRenderer.on('clipboard:pin-updated', (_, data) => cb(data)),
  onOverlayShow: (cb) => ipcRenderer.on('overlay:show', () => cb()),
  onOverlayHide: (cb) => ipcRenderer.on('overlay:hide', () => cb()),
  onTypingProgress: (cb) => ipcRenderer.on('typing:progress', (_, percent) => cb(percent)),
  onTypingDone: (cb) => ipcRenderer.on('typing:done', () => cb()),
  onAccentColor: (cb) => ipcRenderer.on('settings:accent-color', (_, color) => cb(color)),

  // Glass theme: capture screenshot of the area behind the overlay panel
  captureBackground: () => ipcRenderer.invoke('screen:capture-overlay'),

  // Remove listeners (cleanup)
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
