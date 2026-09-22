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
let pasteBusy      = false; // an item is on its way to a target, or being typed
let pasteDock      = null;  // the dock held open for the duration of that paste
let expandedWcId   = null;  // webContents id of the dock that is currently expanded
let hoverWatch     = null;  // interval that watches where the cursor actually is
let armedEntry     = null;  // dock whose bar the cursor is currently dwelling on
let armedSince     = 0;     // when that dwell started
let peekUntil      = 0;     // the launch peek widens the target until this time
let typingPending  = null;  // { text, mode } for capture -> typing handoff
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
    if (!win.isDestroyed() && barVisible && !pasteBusy) win.showInactive();
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
  if (!entry || !barVisible || pasteBusy) return;
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
  if (barVisible && !pasteBusy && dockWindows.length) startHoverWatch();
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
  if (!barVisible || pasteBusy || !dockWindows.length) return;

  const p    = screen.getCursorScreenPoint();
  const open = dockByWebContents(expandedWcId);

  if (open) {
    if (!open.pinned && !open.held && !hitPanel(open, p)) {
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

// ============================================================
// Paste lifecycle
// ============================================================
// From picking an item to the last character typed, one dock stays open as a
// fixed point: it shows what is going on and does not move about. It is
// click-through the whole way, which keeps it clear of the targeting overlay
// and - the part that matters - clear of WindowFromPoint when the typing
// engine clicks the target to focus it.
//
// pasteBusy is the single gate: while it is set, the hover watcher does not
// arm, expand or collapse anything.

function beginPaste(originWc) {
  pasteBusy = true;
  stopHoverWatch();

  const origin = dockByWebContents(originWc);
  pasteDock = origin || dockWindows.find(e => e.win && !e.win.isDestroyed()) || null;

  for (const entry of dockWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    entry.pinned = false;
    entry.held   = false;
    entry.win.setIgnoreMouseEvents(true);
    entry.win.webContents.send('dock:set-expanded', entry === pasteDock);
    if (entry === pasteDock) entry.win.showInactive();
  }

  expandedWcId = pasteDock ? pasteDock.win.webContents.id : null;
}

function endPaste() {
  typingPending = null;
  restoreDocks();
}

// Everything that puts the docks back goes through collapseDock, which is the
// only thing that clears expandedWcId. Sending the renderer a collapse without
// it was enough to leave main believing a panel was still open forever, and a
// dock that main thinks is open never arms on hover again.
function restoreDocks() {
  pasteBusy = false;
  pasteDock = null;
  if (!barVisible) return;
  for (const entry of dockWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    collapseDock(entry);
    entry.win.showInactive();
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

// The drag took a Win32 mouse capture, and Windows only hands it back when the
// window is actually hidden - the targeting overlay needs those events. Hide
// and bring it straight back, so the panel does not vanish on the user.
function releaseMouseCapture() {
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
  if (!pasteBusy) {
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

  // New windows start on the stylesheet default until they are told otherwise
  const accent = settingsStore.getSettings().accentColor;
  for (const win of captureWindows) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('capture:accent', accent);
    });
  }
}

function onDisplayLayoutChanged() {
  recreateCaptureWindows();
  syncDockWindows();
}

// ---------- Capture flow ----------
function showCaptureWindows(mode, text) {
  const accent = settingsStore.getSettings().accentColor;
  for (const win of captureWindows) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('capture:init', { mode, text, accent });
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
  endPaste();
}

async function executeTyping(x, y) {
  if (!typingPending) return;

  const { text } = typingPending;
  typingPending = null;

  const settings = settingsStore.getSettings();

  setTypingMode(true);

  // How the user wants to be able to stop a paste half way. Mouse movement is
  // the only thing that reliably works inside RDP, where the remote session
  // swallows key presses - but it also means you cannot touch the mouse while
  // it types, so Esc is offered for everyone not in that situation.
  const byEscape = settings.breakTyping === 'escape';
  let mousePoll  = null;

  if (byEscape) {
    escapeKey.registerEscape(() => typingEngine.cancel());
  } else {
    const CANCEL_DIST = 80;
    const startMouse  = screen.getCursorScreenPoint();
    mousePoll = setInterval(() => {
      const cur  = screen.getCursorScreenPoint();
      const dist = Math.hypot(cur.x - startMouse.x, cur.y - startMouse.y);
      if (dist > CANCEL_DIST) typingEngine.cancel();
    }, 80);
  }

  const progressCallback = (percent) => dockBroadcast('typing:progress', percent);

  const phys = screen.dipToScreenPoint({ x, y });

  let wasCancelled = false;
  try {
    await typingEngine.startTyping(text, phys.x, phys.y, settings, progressCallback);
  } catch (_) {
    wasCancelled = true;
  } finally {
    if (mousePoll) clearInterval(mousePoll);
    if (byEscape) escapeKey.unregisterEscape();
    wasCancelled = wasCancelled || typingEngine.wasCancelled();
    setTypingMode(false);
    dockBroadcast('typing:done', { cancelled: wasCancelled });

    // Let the result stand long enough to read, then tuck everything away.
    // The cursor is sitting in the target window by now, so leaving the panel
    // open would only be in the way - one flick to the left edge brings it
    // back for the next paste.
    setTimeout(endPaste, wasCancelled ? 1500 : 1000);
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
    typingPending = { text, mode: 'drag' };
    releaseMouseCapture();
    showCaptureWindows('drag', text);
    beginPaste(e.sender.id);
  });

  ipcMain.on('typing:start-click', (e, { text }) => {
    // No capture to release here - the button was pressed and released on the
    // card, so the panel can simply stay where it is and wait for the target.
    typingPending = { text, mode: 'click' };
    beginPaste(e.sender.id);
    showCaptureWindows('click', text);
  });

  ipcMain.on('capture:drop-target', () => {
    // Use getCursorScreenPoint() from the main process - guaranteed logical pixels.
    // Renderer's event.screenX/Y can be physical pixels depending on DPI mode,
    // causing double-scaling errors that grow larger toward the bottom of the screen.
    const point = screen.getCursorScreenPoint();
    hideCaptureWindows();

    // Dropping onto the panel itself is not a target, it is a change of mind.
    if (pasteDock && !pasteDock.win.isDestroyed() && hitPanel(pasteDock, point)) {
      endPaste();
      return;
    }

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
        captureBroadcast('capture:accent', value);
        break;

      case 'theme':
        dockBroadcastExcept(e.sender.id, 'settings:theme', value);
        break;

      case 'breakTyping':
        dockBroadcastExcept(e.sender.id, 'settings:break-typing', value);
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

// The targeting overlay is a separate window with its own document, so the
// accent has to be pushed to it as well or it keeps the default purple.
function captureBroadcast(channel, payload) {
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
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
