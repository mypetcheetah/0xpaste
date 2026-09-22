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

  // Dock lifecycle - main watches the cursor and decides when to open, the
  // renderer decides when it is safe to close
  dockCollapse: () => ipcRenderer.send('dock:collapse'),
  dockPin: (pinned) => ipcRenderer.send('dock:pin', { pinned }),
  dockHold: (held) => ipcRenderer.send('dock:hold', { held }),

  // Monitor selection
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  setDisplays: (ids) => ipcRenderer.send('displays:set', { ids }),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key, value) => ipcRenderer.send('settings:update', { key, value }),

  // Updates
  getUpdate: () => ipcRenderer.invoke('update:get'),
  openUpdate: () => ipcRenderer.send('update:open'),

  // Listeners
  onNewItem: (cb) => ipcRenderer.on('clipboard:new-item', (_, item) => cb(item)),
  onInitialHistory: (cb) => ipcRenderer.on('clipboard:initial-history', (_, history) => cb(history)),
  onRefreshHistory: (cb) => ipcRenderer.on('clipboard:refresh', (_, history) => cb(history)),
  onPinUpdated: (cb) => ipcRenderer.on('clipboard:pin-updated', (_, data) => cb(data)),
  onDockExpanded: (cb) => ipcRenderer.on('dock:set-expanded', (_, expanded) => cb(expanded)),
  onDockArmed: (cb) => ipcRenderer.on('dock:armed', (_, armed) => cb(armed)),
  onDockCursorOut: (cb) => ipcRenderer.on('dock:cursor-out', () => cb()),
  onDockPeek: (cb) => ipcRenderer.on('dock:peek', () => cb()),
  onDockInfo: (cb) => ipcRenderer.on('dock:info', (_, info) => cb(info)),
  onDisplaysChanged: (cb) => ipcRenderer.on('displays:changed', () => cb()),
  onTypingProgress: (cb) => ipcRenderer.on('typing:progress', (_, percent) => cb(percent)),
  onTypingDone: (cb) => ipcRenderer.on('typing:done', (_, data) => cb(data)),
  onAccentColor: (cb) => ipcRenderer.on('settings:accent-color', (_, color) => cb(color)),
  onTheme: (cb) => ipcRenderer.on('settings:theme', (_, theme) => cb(theme)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, data) => cb(data)),

  // Glass theme: capture screenshot of the area behind the panel
  captureBackground: () => ipcRenderer.invoke('screen:capture-overlay'),

  // Remove listeners (cleanup)
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
