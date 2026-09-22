'use strict';

const { app, BrowserWindow, Menu, ipcMain, screen, desktopCapturer } = require('electron');

// Remove the default application menu (File, Edit, View, Window, Help)
Menu.setApplicationMenu(null);

// Prevent setInterval from being throttled when the app is in the background.
// Without this, clipboard polling (500ms) can stall on some Windows setups.
app.commandLine.appendSwitch('disable-background-timer-throttling');
const path = require('path');

const settingsStore    = require('./settings-store');
const clipboardMonitor = require('./clipboard-monitor');
const typingEngine     = require('./typing-engine');
const escapeKey        = require('./escape-key');
const GEO              = require('../shared/dock-geometry');
const { createTray, destroyTray, setTypingMode, setUpdateAvailable, setBarVisible } = require('./tray');
const { checkForUpdates, openReleasesPage } = require('./updater');

// ---------- Windows ----------
// One dock per selected display: { win, displayId, index, pinned }
let dockWindows    = [];
let captureWindows = []; // one BrowserWindow per display - avoids multi-monitor DPI event issues

// ---------- State ----------
let barVisible     = true;  // false when the user hides the bar from the tray
let docksParked    = false; // true while the targeting overlay / typing owns the screen
let expandedWcId   = null;  // webContents id of the dock that is currently expanded
let hoverWatch     = null;  // interval that watches where the cursor actually is
let armedEntry     = null;  // dock whose bar the cursor is currently dwelling on
let armedSince     = 0;     // when that dwell started
let peekUntil      = 0;     // the launch peek widens the target until this time
let typingPending  = null;  // { text, mode, originWc } for capture -> typing handoff
let typingDock     = null;  // the dock showing progress for the paste in flight
let typingHold     = false; // that panel is a progress display - leave it alone
let isQuitting     = false;
let pendingUpdate  = null;  // { version, url } when a newer release exists

// ---------- Auto-start (Windows registry via Electron) ----------
function applyAutoStart(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: app.getPath('exe'),
    name: '0xpaste'
  });
}

// ---------- Quit ----------
// Dock windows are created with closable:false, which makes the close() that
// app.quit() sends a no-op - the quit sequence never completes and the app
// keeps running in the tray. Destroy every window explicitly so quit always
// takes effect, and abort any in-flight typing first.
function quitApp() {
  if (isQuitting) return;
  isQuitting = true;

  try { typingEngine.cancel(); } catch (_) {}
  stopHoverWatch();

  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
  }
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) win.destroy();
  }

  app.quit();
}

// ============================================================
// Display selection
// ============================================================
// Displays are stored by id. Ids are not stable across reboots or cable
// swaps, so a stored id that no longer exists is simply ignored, and an
// empty result always falls back to the primary display - the bar can
// never end up on no monitor at all.

function displaysInOrder() {
  return screen.getAllDisplays()
    .slice()
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
}

function selectedDisplays() {
  const stored = (settingsStore.getSettings().dockDisplays || []).map(String);
  if (!stored.length) return [screen.getPrimaryDisplay()];

  const picked = displaysInOrder().filter(d => stored.includes(String(d.id)));
  return picked.length ? picked : [screen.getPrimaryDisplay()];
}

function describeDisplays() {
  const order     = displaysInOrder();
  const primaryId = screen.getPrimaryDisplay().id;
  const active    = new Set(selectedDisplays().map(d => String(d.id)));

  return order.map((d, i) => ({
    id:       String(d.id),
    index:    i + 1,
    width:    d.bounds.width,
    height:   d.bounds.height,
    primary:  d.id === primaryId,
    selected: active.has(String(d.id))
  }));
}

// ============================================================
// Dock windows
// ============================================================
function dockBoundsFor(display) {
  const wa     = display.workArea;
  const width  = GEO.PANEL_W + GEO.PAD_RIGHT;
  const height = GEO.PANEL_H + (GEO.PAD_Y * 2);

  return {
    x: wa.x,
    y: Math.round(Math.max(wa.y, wa.y + (wa.height - height) / 2)),
    width,
    height
  };
}

function buildDockWindow(display, index) {
  const win = new BrowserWindow({
    ...dockBoundsFor(display),
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

  win.setAlwaysOnTop(true, 'screen-saver', 1);

  // Collapsed docks are click-through, so everything underneath stays
  // clickable. Opening is driven by the cursor watcher below, not by mouse
  // events on this window - see the note there.
  win.setIgnoreMouseEvents(true);

  win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));

  // pinned: the user clicked [pin].  held: a native dialog this dock opened
  // is up, so the cursor being elsewhere means nothing.
  const entry = { win, displayId: String(display.id), index, pinned: false, held: false };

  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('clipboard:initial-history', clipboardMonitor.getHistory());
    win.webContents.send('dock:info', { index: entry.index, total: dockWindows.length });
    if (pendingUpdate) win.webContents.send('update:available', pendingUpdate);
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && barVisible && !docksParked) win.showInactive();
  });

  return entry;
}

// Create/destroy only what actually changed, so the dock the user is currently
// working in survives a monitor being added, removed or toggled elsewhere.
function syncDockWindows() {
  const wanted    = selectedDisplays();
  const wantedIds = new Set(wanted.map(d => String(d.id)));

  for (const entry of dockWindows) {
    if (!wantedIds.has(entry.displayId) && entry.win && !entry.win.isDestroyed()) {
      if (entry.win.webContents.id === expandedWcId) expandedWcId = null;
      if (armedEntry === entry) armedEntry = null;
      entry.win.destroy();
    }
  }
  dockWindows = dockWindows.filter(e => wantedIds.has(e.displayId) && e.win && !e.win.isDestroyed());

  wanted.forEach((display, i) => {
    const existing = dockWindows.find(e => e.displayId === String(display.id));
    if (existing) {
      existing.index = i + 1;
      existing.win.setBounds(dockBoundsFor(display));
    } else {
      dockWindows.push(buildDockWindow(display, i + 1));
    }
  });

  // Keep the order stable so index numbering matches the physical layout
  dockWindows.sort((a, b) => a.index - b.index);

  dockBroadcast('displays:changed');
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) {
      entry.win.webContents.send('dock:info', { index: entry.index, total: dockWindows.length });
    }
  }

  syncHoverWatch();
}

function dockBroadcast(channel, payload) {
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.webContents.send(channel, payload);
  }
}

function dockByWebContents(id) {
  return dockWindows.find(e => e.win && !e.win.isDestroyed() && e.win.webContents.id === id) || null;
}

// ---------- Expand / collapse ----------
function expandDock(entry) {
  if (!entry || !barVisible || docksParked) return;
  if (!entry.win || entry.win.isDestroyed()) return;
  if (expandedWcId === entry.win.webContents.id) return;

  // Only one dock is open at a time
  for (const other of dockWindows) {
    if (other !== entry) collapseDock(other);
  }

  armedEntry = null;
  entry.win.setIgnoreMouseEvents(false);
  entry.win.webContents.send('dock:armed', false);
  entry.win.webContents.send('dock:set-expanded', true);
  expandedWcId = entry.win.webContents.id;
}

function collapseDock(entry) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return;

  entry.pinned = false;
  entry.held   = false;
  entry.win.setIgnoreMouseEvents(true);
  entry.win.webContents.send('dock:set-expanded', false);

  if (expandedWcId === entry.win.webContents.id) expandedWcId = null;
}

function collapseAllDocks() {
  for (const entry of dockWindows) collapseDock(entry);
}

// ============================================================
// Hover watcher
// ============================================================
// A click-through window is WS_EX_TRANSPARENT, so Windows sends it no mouse
// messages at all. Electron can forward them anyway, but only by installing a
// global low-level mouse hook - unreliable, and exactly the sort of hook
// endpoint protection takes an interest in. So the main process just looks at
// where the cursor is, the same call the typing killswitch already relies on.
// It reports facts; the renderer decides what they mean, because it is the
// side that knows about pinning and in-flight drags.

function startHoverWatch() {
  if (hoverWatch) return;
  hoverWatch = setInterval(tickHover, GEO.POLL_MS);
}

function stopHoverWatch() {
  if (hoverWatch) {
    clearInterval(hoverWatch);
    hoverWatch = null;
  }
  setArmed(null);
}

function syncHoverWatch() {
  if (barVisible && !docksParked && dockWindows.length) startHoverWatch();
  else stopHoverWatch();
}

// The bar, plus a margin so it does not need pixel-perfect aiming. While the
// panel is peeking open on launch, the whole panel counts as the target, so
// reaching for what you can see does the obvious thing.
function hitTab(entry, p) {
  const b = entry.win.getBounds();

  if (Date.now() < peekUntil) {
    return p.x >= b.x - 1 && p.x <= b.x + GEO.PANEL_W &&
           p.y >= b.y + GEO.PAD_Y && p.y <= b.y + GEO.PAD_Y + GEO.PANEL_H;
  }

  const midY  = b.y + (b.height / 2);
  const halfH = (GEO.TAB_H / 2) + GEO.HOT_PAD_Y;
  return p.x >= b.x - 1 && p.x <= b.x + GEO.TAB_W + GEO.HOT_PAD_X &&
         p.y >= midY - halfH && p.y <= midY + halfH;
}

function hitPanel(entry, p) {
  const b = entry.win.getBounds();
  const g = GEO.GRACE;
  return p.x >= b.x - g && p.x <= b.x + GEO.PANEL_W + g &&
         p.y >= b.y + GEO.PAD_Y - g && p.y <= b.y + GEO.PAD_Y + GEO.PANEL_H + g;
}

function setArmed(entry) {
  if (armedEntry === entry) return;
  if (armedEntry && armedEntry.win && !armedEntry.win.isDestroyed()) {
    armedEntry.win.webContents.send('dock:armed', false);
  }
  armedEntry = entry;
  armedSince = Date.now();
  if (entry && entry.win && !entry.win.isDestroyed()) {
    entry.win.webContents.send('dock:armed', true);
  }
}

function tickHover() {
  if (!barVisible || docksParked || !dockWindows.length) return;

  const p    = screen.getCursorScreenPoint();
  const open = dockByWebContents(expandedWcId);

  if (open) {
    if (!open.pinned && !open.held && !typingHold && !hitPanel(open, p)) {
      open.win.webContents.send('dock:cursor-out');
    }
    return;
  }

  for (const entry of dockWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    if (!hitTab(entry, p)) continue;

    setArmed(entry);
    if (Date.now() - armedSince >= GEO.HOVER_INTENT) expandDock(entry);
    return;
  }

  setArmed(null);
}

function peekDocks() {
  peekUntil = Date.now() + GEO.PEEK_MS;
  dockBroadcast('dock:peek');
}

// ---------- Park / restore (typing flow and tray toggle) ----------
// Win32 only releases mouse capture when the window is actually hidden, so the
// drag-to-target flow needs a real hide() rather than just a visual collapse.
function parkDocks() {
  docksParked = true;
  typingHold  = false;
  stopHoverWatch();
  collapseAllDocks();
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.hide();
  }
}

function restoreDocks() {
  docksParked = false;
  if (!barVisible) return;
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) {
      entry.win.setIgnoreMouseEvents(true);
      entry.win.webContents.send('dock:set-expanded', false);
      entry.win.showInactive();
    }
  }
  syncHoverWatch();
}

function hideBar() {
  stopHoverWatch();
  collapseAllDocks();
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.hide();
  }
}

function toggleBar() {
  barVisible = !barVisible;
  setBarVisible(barVisible);
  if (barVisible) {
    restoreDocks();
    peekDocks();
  } else {
    hideBar();
  }
}

function showBar() {
  if (!barVisible) {
    toggleBar();
    return;
  }
  if (!docksParked) {
    restoreDocks();
    peekDocks();
  }
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

function onDisplayLayoutChanged() {
  recreateCaptureWindows();
  syncDockWindows();
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

  escapeKey.registerEscape(() => cancelCapture());
}

function hideCaptureWindows() {
  escapeKey.unregisterEscape();
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) win.hide();
  }
}

function cancelCapture() {
  hideCaptureWindows();
  typingPending = null;
  typingHold    = false;
  typingDock    = null;
  restoreDocks();
}

// Put the panel back up while the typing runs, so its progress counter is
// actually visible - it was being hidden for the whole paste, which is the
// one moment it has something to say.
//
// Deliberately click-through and never focused: the keystrokes have to keep
// going to the target window, and moving the mouse at all would trip the
// killswitch anyway. This is a readout, not a control.
function showTypingPanel(origin) {
  if (typingHold) return;

  const entry = pickTypingDock(origin);
  if (!entry) return;

  typingHold = true;
  typingDock = entry;
  entry.win.setIgnoreMouseEvents(true);
  entry.win.showInactive();
  entry.win.webContents.send('dock:set-expanded', true);
  expandedWcId = entry.win.webContents.id;
}

// The one on the screen the text is landing on, so it is where the user is
// already looking. Failing that, the one the item was dragged out of.
function pickTypingDock(origin) {
  const live = dockWindows.filter(e => e.win && !e.win.isDestroyed());
  if (!live.length) return null;

  if (origin && origin.point) {
    const display = screen.getDisplayNearestPoint(origin.point);
    const onScreen = live.find(e => e.displayId === String(display.id));
    if (onScreen) return onScreen;
  }
  if (origin && origin.wc) {
    const fromDock = live.find(e => e.win.webContents.id === origin.wc);
    if (fromDock) return fromDock;
  }
  return live[0];
}

async function executeTyping(x, y) {
  if (!typingPending) return;

  const { text, originWc } = typingPending;
  const origin = { wc: originWc, point: { x, y } };
  typingPending = null;

  const settings = settingsStore.getSettings();

  setTypingMode(true);

  // Mouse-movement killswitch - works even in RDP where keyboard shortcuts
  // are intercepted. Poll local cursor position; if it moves > 80px from the
  // drop point, cancel typing immediately.
  const CANCEL_DIST = 80;
  const startMouse  = screen.getCursorScreenPoint();
  const mousePoll   = setInterval(() => {
    const cur  = screen.getCursorScreenPoint();
    const dist = Math.hypot(cur.x - startMouse.x, cur.y - startMouse.y);
    if (dist > CANCEL_DIST) typingEngine.cancel();
  }, 80);

  // The first tick means the target has been clicked, focused and is taking
  // keystrokes, so it is safe to put the panel back on screen.
  const progressCallback = (percent) => {
    showTypingPanel(origin);
    dockBroadcast('typing:progress', percent);
  };

  const phys = screen.dipToScreenPoint({ x, y });

  let wasCancelled = false;
  try {
    await typingEngine.startTyping(text, phys.x, phys.y, settings, progressCallback);
  } catch (_) {
    wasCancelled = true;
  } finally {
    clearInterval(mousePoll);
    wasCancelled = wasCancelled || typingEngine.wasCancelled();
    setTypingMode(false);
    dockBroadcast('typing:done', { cancelled: wasCancelled });

    // Let the result stand long enough to read, then tuck everything away.
    // The cursor is sitting in the target window by now, so leaving the panel
    // open would only be in the way - one flick to the left edge brings it
    // back for the next paste.
    const linger = typingHold ? (wasCancelled ? 1500 : 1000) : 0;
    setTimeout(() => {
      typingHold = false;
      typingDock = null;
      restoreDocks();
    }, linger);
  }
}

// ---------- IPC Handlers ----------
function setupIPC() {
  ipcMain.handle('clipboard:get-history', () => {
    return clipboardMonitor.getHistory();
  });

  ipcMain.on('clipboard:delete-item', (e, { id }) => {
    clipboardMonitor.deleteItem(id);
    dockBroadcastExcept(e.sender.id, 'clipboard:refresh', clipboardMonitor.getHistory());
  });

  ipcMain.on('clipboard:clear-all', (e) => {
    clipboardMonitor.clearAll();
    dockBroadcastExcept(e.sender.id, 'clipboard:refresh', clipboardMonitor.getHistory());
  });

  ipcMain.on('clipboard:toggle-pin', (_, { id }) => {
    const item = clipboardMonitor.togglePin(id);
    dockBroadcast('clipboard:pin-updated', { id, pinned: item ? item.pinned : false });
  });

  // ---- Dock hover lifecycle ----
  // Opening is decided by the hover watcher; the renderer only ever asks to
  // close, because only it knows whether something is mid-interaction.
  ipcMain.on('dock:collapse', (e) => {
    collapseDock(dockByWebContents(e.sender.id));
  });

  ipcMain.on('dock:pin', (e, { pinned }) => {
    const entry = dockByWebContents(e.sender.id);
    if (entry) entry.pinned = !!pinned;
  });

  // The renderer opened a native dialog of its own - the colour picker. That
  // dialog is a separate OS window, so the cursor sitting in it reads as the
  // cursor having left the panel. Hold the dock open until it is done with.
  ipcMain.on('dock:hold', (e, { held }) => {
    const entry = dockByWebContents(e.sender.id);
    if (entry) entry.held = !!held;
  });

  // ---- Monitor selection ----
  ipcMain.handle('displays:list', () => describeDisplays());

  ipcMain.on('displays:set', (_, { ids }) => {
    const clean = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!clean.length) return; // the bar must live on at least one monitor
    settingsStore.updateSetting('dockDisplays', clean);
    syncDockWindows();
  });

  ipcMain.on('typing:start-drag', (e, { text }) => {
    typingPending = { text, mode: 'drag', originWc: e.sender.id };
    // Park FIRST - Win32 releases mouse capture when the window is hidden.
    // This allows the capture windows to receive subsequent mouse events.
    parkDocks();
    showCaptureWindows('drag', text);
  });

  ipcMain.on('typing:start-click', (e, { text }) => {
    typingPending = { text, mode: 'click', originWc: e.sender.id };
    // Animate the panel out first, then hard-hide
    collapseAllDocks();
    setTimeout(() => {
      parkDocks();
      showCaptureWindows('click', text);
    }, 220);
  });

  ipcMain.on('capture:drop-target', () => {
    // Use getCursorScreenPoint() from the main process - guaranteed logical pixels.
    // Renderer's event.screenX/Y can be physical pixels depending on DPI mode,
    // causing double-scaling errors that grow larger toward the bottom of the screen.
    const point = screen.getCursorScreenPoint();
    hideCaptureWindows();
    executeTyping(point.x, point.y);
  });

  ipcMain.on('capture:cancel', () => {
    cancelCapture();
  });

  ipcMain.on('typing:cancel', () => {
    typingEngine.cancel();
  });

  ipcMain.handle('settings:get', () => {
    return settingsStore.getSettings();
  });

  ipcMain.on('settings:update', (e, { key, value }) => {
    settingsStore.updateSetting(key, value);

    switch (key) {
      case 'startWithWindows':
        applyAutoStart(value);
        break;

      case 'accentColor':
        dockBroadcastExcept(e.sender.id, 'settings:accent-color', value);
        break;

      case 'theme':
        dockBroadcastExcept(e.sender.id, 'settings:theme', value);
        break;

      case 'maxHistory':
        clipboardMonitor.setMaxHistory(value);
        break;
    }
  });

  // Update notification: the dock asks on load, and opens the release page.
  ipcMain.handle('update:get', () => pendingUpdate);
  ipcMain.on('update:open', () => openReleasesPage(pendingUpdate && pendingUpdate.url));

  // Screen capture for the WebGL glass lens - crops the screenshot of the
  // display this dock lives on down to exactly the panel area.
  ipcMain.handle('screen:capture-overlay', async (e) => {
    try {
      const entry = dockByWebContents(e.sender.id);
      if (!entry) return null;

      const display = screen.getAllDisplays().find(d => String(d.id) === entry.displayId)
                   || screen.getPrimaryDisplay();
      const sf = display.scaleFactor;
      const b  = entry.win.getBounds();

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width:  Math.round(display.bounds.width  * sf),
          height: Math.round(display.bounds.height * sf)
        }
      });

      if (!sources.length) return null;
      const source = sources.find(s => String(s.display_id) === entry.displayId) || sources[0];

      // Window rect -> display-relative -> the panel area inside that window
      const cropped = source.thumbnail.crop({
        x:      Math.round((b.x - display.bounds.x) * sf),
        y:      Math.round((b.y - display.bounds.y + GEO.PAD_Y) * sf),
        width:  Math.round(GEO.PANEL_W * sf),
        height: Math.round(GEO.PANEL_H * sf)
      });

      return cropped.toDataURL();
    } catch (err) {
      console.error('[glass] screen capture failed:', err.message);
      return null;
    }
  });
}

function dockBroadcastExcept(wcId, channel, payload) {
  for (const entry of dockWindows) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents.id !== wcId) {
      entry.win.webContents.send(channel, payload);
    }
  }
}

// ---------- App lifecycle ----------
// Single instance lock - must be before app.whenReady
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showBar();
  });

  app.whenReady().then(() => {
    const settings = settingsStore.getSettings();

    // Apply persistent settings
    applyAutoStart(settings.startWithWindows);
    clipboardMonitor.setMaxHistory(settings.maxHistory);

    syncDockWindows();
    createCaptureWindows();

    // Rebuild both sets whenever the display configuration changes
    screen.on('display-added',           onDisplayLayoutChanged);
    screen.on('display-removed',         onDisplayLayoutChanged);
    screen.on('display-metrics-changed', onDisplayLayoutChanged);

    // Peek the panel open briefly on launch so the bar is easy to find.
    setTimeout(peekDocks, 900);

    createTray({
      onToggleBar:  toggleBar,
      onQuit:       quitApp,
      onCancelType: () => { typingEngine.cancel(); }
    });

    // Check for updates in the background - silent on any error. Only fires the
    // callback when a strictly newer release actually exists.
    checkForUpdates((version, url) => {
      pendingUpdate = { version, url: url || null };
      setUpdateAvailable(version, () => openReleasesPage(pendingUpdate.url));
      dockBroadcast('update:available', pendingUpdate);
    });

    clipboardMonitor.start((item) => {
      dockBroadcast('clipboard:new-item', item);
    });

    setupIPC();
  });

  app.on('window-all-closed', () => {
    // Do not quit - app lives in system tray
  });

  app.on('will-quit', () => {
    escapeKey.unregisterAll();
    clipboardMonitor.stop();
    stopHoverWatch();
    destroyTray();
  });
}
