'use strict';

const { app, BrowserWindow, ipcMain, screen, nativeImage } = require('electron');

// Prevent setInterval from being throttled when the app is in the background.
// Without this, clipboard polling (500ms) can stall on some Windows setups.
app.commandLine.appendSwitch('disable-background-timer-throttling');
const path = require('path');

const settingsStore = require('./settings-store');
const clipboardMonitor = require('./clipboard-monitor');
const typingEngine = require('./typing-engine');
const hotkey = require('./hotkey');
const { createTray, destroyTray } = require('./tray');

// Windows
let overlayWindow  = null;
let captureWindows = []; // one BrowserWindow per display — avoids multi-monitor DPI event issues
let settingsWindow = null;

// State
let overlayVisible = false;
let typingPending  = null; // { text, mode } for capture -> typing handoff

// ---------- Auto-start (Windows registry via Electron) ----------
function applyAutoStart(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: app.getPath('exe'),
    name: '0xpaste'
  });
}

// ---------- Overlay window ----------
function getOverlayBounds(position) {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const W = 320;
  const H = 450;
  const MARGIN = 16;

  const pos = position || settingsStore.getSettings().panelPosition || 'bottom-right';

  let x, y;
  switch (pos) {
    case 'bottom-left':
      x = workArea.x + MARGIN;
      y = workArea.y + workArea.height - H - MARGIN;
      break;
    case 'top-right':
      x = workArea.x + workArea.width - W - MARGIN;
      y = workArea.y + MARGIN;
      break;
    case 'top-left':
      x = workArea.x + MARGIN;
      y = workArea.y + MARGIN;
      break;
    default: // bottom-right
      x = workArea.x + workArea.width - W - MARGIN;
      y = workArea.y + workArea.height - H - MARGIN;
  }

  return { width: W, height: H, x, y };
}

function createOverlayWindow() {
  const bounds = getOverlayBounds();

  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    const history = clipboardMonitor.getHistory();
    overlayWindow.webContents.send('clipboard:initial-history', history);
  });
}

// ---------- Capture windows (one per display) ----------
// Each display gets its own fullscreen transparent BrowserWindow so that
// mouseup events are received correctly regardless of per-monitor DPI differences.
// A single giant window spanning all monitors fails to receive events on
// secondary monitors in Chromium's Win32 event routing.

function buildCaptureWin(display) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/capture-preload.js')
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver', 2);
  win.loadFile(path.join(__dirname, '../renderer/capture/index.html'));
  return win;
}

function createCaptureWindows() {
  const primary = screen.getPrimaryDisplay();
  const all     = screen.getAllDisplays();
  // Primary display first so captureWindows[0] is always the primary
  const sorted  = [primary, ...all.filter(d => d.id !== primary.id)];
  captureWindows = sorted.map(buildCaptureWin);
}

function recreateCaptureWindows() {
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  captureWindows = [];
  createCaptureWindows();
}

// ---------- Settings window ----------
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    maximizable: false,
    title: '0xpaste — Settings',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/settings-preload.js')
    }
  });

  const iconPath = path.join(__dirname, '../assets/icon.png');
  settingsWindow.setIcon(nativeImage.createFromPath(iconPath));
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings/index.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- Overlay toggle ----------
function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Always recompute position from primary display so multi-monitor setups
  // never place the panel on a secondary screen.
  overlayWindow.setBounds(getOverlayBounds());
  overlayVisible = true;
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('overlay:show');
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay:hide');
}

function toggleOverlay() {
  if (overlayVisible) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

// ---------- Capture flow ----------
function showCaptureWindows(mode, text) {
  for (const win of captureWindows) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('capture:init', { mode, text });
    win.show();
  }
  // Focus the primary display's capture window so it can receive keyboard (Escape)
  const primary = captureWindows[0];
  if (primary && !primary.isDestroyed()) primary.focus();

  hotkey.registerEscape(() => cancelCapture());
}

function hideCaptureWindows() {
  hotkey.unregisterEscape();
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) win.hide();
  }
}

function cancelCapture() {
  hideCaptureWindows();
  typingPending = null;
  showOverlay();
}

async function executeTyping(x, y) {
  if (!typingPending) return;

  const { text } = typingPending;
  typingPending = null;

  const settings = settingsStore.getSettings();

  hotkey.registerEscape(() => typingEngine.cancel());

  const progressCallback = (percent) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('typing:progress', percent);
    }
  };

  // Convert DIP logical pixels -> physical pixels.
  // screen.getCursorScreenPoint() returns DIP coords; dipToScreenPoint() converts
  // correctly for per-monitor DPI setups without manual * scaleFactor (which
  // double-scales and causes clicks to overshoot toward the bottom of the screen).
  const phys = screen.dipToScreenPoint({ x, y });

  try {
    await typingEngine.startTyping(text, phys.x, phys.y, settings, progressCallback);
  } finally {
    hotkey.unregisterEscape();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('typing:done');
    }
    // Bring the overlay back so the user can paste the next item without
    // pressing the hotkey again. Only the hotkey will close it.
    showOverlay();
  }
}

// ---------- IPC Handlers ----------
function setupIPC() {
  ipcMain.handle('clipboard:get-history', () => {
    return clipboardMonitor.getHistory();
  });

  ipcMain.on('clipboard:delete-item', (_, { id }) => {
    clipboardMonitor.deleteItem(id);
  });

  ipcMain.on('clipboard:clear-all', () => {
    clipboardMonitor.clearAll();
  });

  ipcMain.on('clipboard:toggle-pin', (_, { id }) => {
    const item = clipboardMonitor.togglePin(id);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('clipboard:pin-updated', {
        id,
        pinned: item ? item.pinned : false
      });
    }
  });

  ipcMain.on('typing:start-drag', (_, { text }) => {
    typingPending = { text, mode: 'drag' };
    // Hide overlay FIRST — Win32 releases mouse capture when window is hidden.
    // This allows the capture windows to receive subsequent mouse events.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      overlayVisible = false;
    }
    showCaptureWindows('drag', text);
  });

  ipcMain.on('typing:start-click', (_, { text }) => {
    typingPending = { text, mode: 'click' };
    // Animate out first, then hard-hide
    hideOverlay();
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
        overlayVisible = false;
      }
      showCaptureWindows('click', text);
    }, 220);
  });

  ipcMain.on('capture:drop-target', (_) => {
    // Use getCursorScreenPoint() from the main process — guaranteed logical pixels.
    // Renderer's event.screenX/Y can be physical pixels depending on DPI mode,
    // causing double-scaling errors that grow larger toward the bottom of the screen.
    const point = screen.getCursorScreenPoint();
    hideCaptureWindows();
    if (overlayVisible) {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
        overlayVisible = false;
      }
    }
    executeTyping(point.x, point.y);
  });

  ipcMain.on('capture:cancel', () => {
    cancelCapture();
  });

  ipcMain.on('overlay:hide-done', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      overlayVisible = false;
    }
  });

  ipcMain.on('typing:cancel', () => {
    typingEngine.cancel();
  });

  ipcMain.handle('settings:get', () => {
    return settingsStore.getSettings();
  });

  ipcMain.on('settings:update', (_, { key, value }) => {
    settingsStore.updateSetting(key, value);

    switch (key) {
      case 'startWithWindows':
        applyAutoStart(value);
        break;

      case 'hotkey':
        hotkey.updateHotkey(value);
        break;

      case 'accentColor':
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('settings:accent-color', value);
        }
        break;

      case 'panelPosition':
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.setBounds(getOverlayBounds(value));
        }
        break;

      case 'maxHistory':
        clipboardMonitor.setMaxHistory(value);
        break;
    }
  });

  // Hotkey capture: temporarily disable global hotkey so it doesn't interfere
  ipcMain.on('hotkey:capture', (_, { active }) => {
    if (active) {
      hotkey.unregisterHotkey();
    } else {
      // Re-register from stored settings (called on cancel)
      const settings = settingsStore.getSettings();
      hotkey.updateHotkey(settings.hotkey);
    }
  });

  ipcMain.on('open:settings', () => {
    openSettingsWindow();
  });
}

// ---------- App lifecycle ----------
// Single instance lock — must be before app.whenReady
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    toggleOverlay();
  });

  app.whenReady().then(() => {
    const settings = settingsStore.getSettings();

    // Apply persistent settings
    applyAutoStart(settings.startWithWindows);
    clipboardMonitor.setMaxHistory(settings.maxHistory);

    // Detect fresh install: key absent means the store file was just created
    const isFirstRun = !settingsStore.store.has('firstRun');
    if (isFirstRun) {
      settingsStore.store.set('firstRun', false);
    }

    createOverlayWindow();
    createCaptureWindows();

    // Recreate capture windows whenever the display configuration changes
    screen.on('display-added',          recreateCaptureWindows);
    screen.on('display-removed',        recreateCaptureWindows);
    screen.on('display-metrics-changed', recreateCaptureWindows);

    // On first install, show the overlay as soon as it is ready
    if (isFirstRun) {
      overlayWindow.once('ready-to-show', showOverlay);
    }

    createTray(
      toggleOverlay,
      openSettingsWindow,
      () => { app.quit(); }
    );

    // Register hotkey with persisted binding
    hotkey.registerHotkey(toggleOverlay, settings.hotkey);

    clipboardMonitor.start((item) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('clipboard:new-item', item);
      }
    });

    setupIPC();
  });

  app.on('window-all-closed', () => {
    // Do not quit — app lives in system tray
  });

  app.on('will-quit', () => {
    hotkey.unregisterAll();
    clipboardMonitor.stop();
    destroyTray();
  });
}
