'use strict';

// ============================================================
// 0xpaste Overlay Renderer
// ============================================================

const api = window.electronAPI;

// ---- State ----
let history = [];
let maxHistory = 50;
let searchQuery = '';
let selectedItemId = null;
let clearConfirmTimer = null;
let settingsVisible = false;
const hiddenItems = new Set(); // IDs of items whose preview is masked

// Drag state
const drag = {
  active: false,
  itemId: null,
  text: '',
  startX: 0,
  startY: 0,
  moved: false
};

// ---- DOM refs ----
const panel          = document.getElementById('overlay-panel');
const searchInput    = document.getElementById('search-input');
const searchClear    = document.getElementById('search-clear');
const clearAllBtn    = document.getElementById('clear-all-btn');
const itemList       = document.getElementById('item-list');
const statusText     = document.getElementById('status-text');
const typingInd      = document.getElementById('typing-indicator');
const cancelHint     = document.getElementById('cancel-hint');
const settingsBtn    = document.getElementById('settings-btn');
const clipboardView  = document.getElementById('clipboard-view');
const settingsView   = document.getElementById('settings-view');
const resetBtn       = document.getElementById('reset-defaults-btn');
const root           = document.getElementById('overlay-root');
const headerMonitor  = document.getElementById('header-monitor');
const pinBtn         = document.getElementById('pin-btn');

// ============================================================
// Settings toggle
// ============================================================
function setSettingsView(on) {
  settingsVisible = on;
  settingsBtn.classList.toggle('active', on);
  clipboardView.style.display = on ? 'none' : '';
  settingsView.classList.toggle('visible', on);
  resetBtn.classList.toggle('visible', on);
}

settingsBtn.addEventListener('click', () => setSettingsView(!settingsVisible));

// ============================================================
// Dock: hover the bar to open, move away to close
// ============================================================
// The window is always there, parked against the left edge and click-through
// while collapsed. A click-through window receives no mouse messages at all,
// so main watches the real cursor and decides when to open. This side decides
// when it is safe to close, because only it knows whether a drag is in flight
// or a button is being held. Main echoes every state change back through
// dock:set-expanded, so the window state and the visuals cannot disagree.

const GEO = window.DOCK_GEO;

// Mirror the geometry into CSS so the stylesheet and the hit tests agree
(function applyGeometry() {
  const s = document.documentElement.style;
  s.setProperty('--panel-w',    GEO.PANEL_W + 'px');
  s.setProperty('--panel-h',    GEO.PANEL_H + 'px');
  s.setProperty('--pad-right',  GEO.PAD_RIGHT + 'px');
  s.setProperty('--pad-y',      GEO.PAD_Y     + 'px');
  s.setProperty('--tab-w',      GEO.TAB_W   + 'px');
  s.setProperty('--tab-h',      GEO.TAB_H   + 'px');
})();

let expanded      = false;
let pinned        = false;
let peeking       = false;
let pointerDown   = false;
let peekTimer     = null;
let collapseTimer = null;

// Panel rect inside the window, with slack so a brief overshoot while
// reaching for a control does not slam it shut.
function inPanelZone(x, y) {
  const g = GEO.GRACE;
  return x >= -g && x <= GEO.PANEL_W + g &&
         y >= GEO.PAD_Y - g && y <= GEO.PAD_Y + GEO.PANEL_H + g;
}

function endPeek() {
  if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
  peeking = false;
}

function requestCollapse() {
  if (pinned || drag.active || pointerDown) return;
  if (!expanded && !peeking) return;
  if (collapseTimer) return;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (pinned || drag.active || pointerDown) return;
    endPeek();
    api.dockCollapse();
  }, GEO.COLLAPSE_DELAY);
}

// The cursor is dwelling on the bar - light it up while main counts down
api.onDockArmed((on) => root.classList.toggle('armed', !!on));

// Main is the single source of truth for the expanded state
api.onDockExpanded((on) => {
  expanded = !!on;
  root.classList.toggle('expanded', expanded);
  endPeek();

  if (expanded) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  } else {
    root.classList.remove('armed');
    setPinned(false);
    setSettingsView(false);
    clearSearch();
    selectedItemId = null;
    renderList();
  }
});

// Backstop from main: the real cursor left this window. Main only reports
// it - whether that should close anything is decided right here.
api.onDockCursorOut(() => requestCollapse());

// Short look-at-me on launch so the bar is easy to find. Main widens the
// hover target to the whole panel for as long as this lasts.
api.onDockPeek(() => {
  if (expanded || pinned) return;
  peeking = true;
  root.classList.add('expanded');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (peeking && !expanded) {
      peeking = false;
      root.classList.remove('expanded');
    }
  }, GEO.PEEK_MS);
});

// Which monitor this copy of the bar lives on
api.onDockInfo(({ index, total }) => {
  if (!headerMonitor) return;
  headerMonitor.textContent = total > 1 ? 'monitor ' + index + '/' + total : '';
});

// Only meaningful once the panel is open - at that point the window is
// interactive and real mouse events arrive, which closes it a poll tick
// sooner than the watcher in main would.
document.addEventListener('mousemove', (e) => {
  // Self-heal: a button released outside the window never reaches us
  if (pointerDown && e.buttons === 0) pointerDown = false;
  if (!expanded) return;

  if (inPanelZone(e.clientX, e.clientY)) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  } else {
    requestCollapse();
  }
});

document.addEventListener('mouseleave', () => requestCollapse());

document.addEventListener('mousedown', () => { pointerDown = true; });
document.addEventListener('mouseup',   () => { pointerDown = false; });
window.addEventListener('blur',        () => { pointerDown = false; });

// ---- Pin ----
function setPinned(on) {
  pinned = !!on;
  if (pinBtn) {
    pinBtn.classList.toggle('active', pinned);
    pinBtn.textContent = pinned ? '[pinned]' : '[pin]';
  }
  api.dockPin(pinned);
}

if (pinBtn) {
  pinBtn.addEventListener('click', () => setPinned(!pinned));
}

// ============================================================
// Clipboard history
// ============================================================
api.onInitialHistory((h) => {
  history = h;
  // Auto-mask items flagged as passwords
  history.forEach(item => { if (item.isPassword) hiddenItems.add(item.id); });
  renderList();
  updateStatus();
});

// Another dock deleted or cleared something - take its word for the new list
api.onRefreshHistory((h) => {
  history = h;
  history.forEach(item => { if (item.isPassword) hiddenItems.add(item.id); });
  renderList();
  updateStatus();
});

api.onNewItem((item) => {
  if (item.isPassword) hiddenItems.add(item.id);
  history.unshift(item);
  // Trim oldest unpinned items if over the limit
  const unpinned = history.filter(i => !i.pinned);
  if (unpinned.length > maxHistory) {
    const removeIds = new Set(unpinned.slice(maxHistory).map(i => i.id));
    history = history.filter(i => !removeIds.has(i.id));
  }
  renderList();
  updateStatus();
  // Flash the new item
  const card = document.querySelector(`[data-id="${item.id}"]`);
  if (card) {
    card.classList.add('new-flash');
    card.addEventListener('animationend', () => card.classList.remove('new-flash'), { once: true });
  }
});

api.onPinUpdated(({ id, pinned }) => {
  const item = history.find(i => i.id === id);
  if (item) {
    item.pinned = pinned;
    renderList();
  }
});

// ============================================================
// Typing progress / done
// ============================================================
api.onTypingProgress((percent) => {
  typingInd.textContent = `[typing... ${percent}%]`;
  typingInd.classList.add('visible');
});

api.onTypingDone(({ cancelled } = {}) => {
  if (cancelled) {
    typingInd.textContent = '[cancelled]';
    typingInd.classList.add('visible');
    setTimeout(() => typingInd.classList.remove('visible'), 1200);
  } else {
    typingInd.classList.remove('visible');
  }
  selectedItemId = null;
  renderList();
});

// ============================================================
// Accent color push from main (when changed while overlay visible)
// ============================================================
api.onAccentColor((color) => {
  applyAccentColor(color);
  const input = document.getElementById('accent-color-input');
  if (input) input.value = color;
});

api.onTheme((theme) => {
  applyTheme(theme);
  setSegGroup('theme-group', theme);
});

// ============================================================
// Update notification banner - shown only when a newer release exists
// ============================================================
const updateBanner = document.getElementById('update-banner');

function showUpdateBanner(info) {
  if (!info || !info.version || !updateBanner) return;
  const vEl = document.getElementById('update-version');
  if (vEl) vEl.textContent = info.version;
  updateBanner.classList.add('visible');
}

(function initUpdateBanner() {
  if (!updateBanner) return;
  const dl      = document.getElementById('update-download-btn');
  const dismiss = document.getElementById('update-dismiss-btn');
  if (dl)      dl.addEventListener('click', () => api.openUpdate());
  if (dismiss) dismiss.addEventListener('click', () => updateBanner.classList.remove('visible'));

  // Push: main sends this if the check completes while the overlay is open.
  api.onUpdateAvailable((info) => showUpdateBanner(info));

  // Pull: in case the check already finished before this renderer loaded.
  api.getUpdate().then((info) => { if (info) showUpdateBanner(info); }).catch(() => {});
})();

// ============================================================
// Search
// ============================================================
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  searchClear.classList.toggle('visible', searchQuery.length > 0);
  renderList();
});

searchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
});

searchClear.addEventListener('click', clearSearch);

function clearSearch() {
  searchInput.value = '';
  searchQuery = '';
  searchClear.classList.remove('visible');
  renderList();
}

// ============================================================
// Clear all
// ============================================================
clearAllBtn.addEventListener('click', () => {
  if (clearAllBtn.classList.contains('confirm')) {
    clearTimeout(clearConfirmTimer);
    clearAllBtn.classList.remove('confirm');
    clearAllBtn.textContent = '[clear all]';
    api.clearAll();
    history = history.filter(i => i.pinned);
    renderList();
    updateStatus();
  } else {
    clearAllBtn.classList.add('confirm');
    clearAllBtn.textContent = '[confirm?]';
    clearConfirmTimer = setTimeout(() => {
      clearAllBtn.classList.remove('confirm');
      clearAllBtn.textContent = '[clear all]';
    }, 2000);
  }
});

// ============================================================
// Relative time helper
// ============================================================
function relativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ============================================================
// Render
// ============================================================
function getFilteredHistory() {
  const pinned   = history.filter(i => i.pinned);
  const unpinned = history.filter(i => !i.pinned);
  const all = [...pinned, ...unpinned];

  if (!searchQuery) return all;

  const q = searchQuery.toLowerCase();
  return all.filter(i => i.text.toLowerCase().includes(q));
}

function renderList() {
  const filtered = getFilteredHistory();

  if (filtered.length === 0) {
    itemList.innerHTML = `
      <div class="empty-state">
        <div class="empty-symbol">[ ]</div>
        ${searchQuery ? '// no matches' : '// clipboard is empty'}
      </div>`;
    return;
  }

  const html = filtered.map(item => buildCardHTML(item)).join('');
  itemList.innerHTML = html;

  for (const item of filtered) {
    attachCardEvents(item);
  }
}

function buildMaskedPreview(text) {
  const visible = escapeHTML(text.slice(0, 4));
  const dots    = '•'.repeat(Math.min(text.length - 4, 24));
  return `<span class="preview-visible">${visible}</span><span class="preview-dots">${dots}</span>`;
}

function buildCardHTML(item) {
  const isHidden  = hiddenItems.has(item.id);
  const preview   = isHidden
    ? buildMaskedPreview(item.text)
    : escapeHTML(item.text);
  const charCount = item.text.length;
  const ts        = relativeTime(item.timestamp);
  const pinClass  = item.pinned ? 'btn-pin pinned' : 'btn-pin';
  const eyeClass  = isHidden ? 'btn-eye hidden' : 'btn-eye';
  const selectedClass = item.id === selectedItemId ? ' selected' : '';
  const pinnedClass   = item.pinned ? ' pinned' : '';

  return `
    <div class="item-card${selectedClass}${pinnedClass}" data-id="${item.id}">
      <div class="item-preview">${preview}</div>
      <div class="item-meta">
        <span class="item-charcount">(${charCount})</span>
        <span class="item-timestamp">${ts}</span>
      </div>
      <div class="item-actions">
        <button class="${pinClass}" data-id="${item.id}" title="Toggle pin">⚲</button>
        <button class="btn-delete" data-id="${item.id}" title="Delete">x</button>
        <button class="${eyeClass}" data-id="${item.id}" title="Toggle visibility">👁</button>
      </div>
    </div>`;
}

function attachCardEvents(item) {
  const card = document.querySelector(`.item-card[data-id="${item.id}"]`);
  if (!card) return;

  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.btn-pin') || e.target.closest('.btn-delete') || e.target.closest('.btn-eye')) return;

    drag.active  = true;
    drag.itemId  = item.id;
    drag.text    = item.text;
    drag.startX  = e.clientX;
    drag.startY  = e.clientY;
    drag.moved   = false;

    e.preventDefault();
  });

  const pinBtn = card.querySelector('.btn-pin');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.togglePin(item.id);
    });
  }

  const delBtn = card.querySelector('.btn-delete');
  if (delBtn) {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeItem(item.id, card);
    });
  }

  const eyeBtn = card.querySelector('.btn-eye');
  if (eyeBtn) {
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hiddenItems.has(item.id)) {
        hiddenItems.delete(item.id);
      } else {
        hiddenItems.add(item.id);
      }
      const newHtml = buildCardHTML(item);
      const tmp = document.createElement('div');
      tmp.innerHTML = newHtml.trim();
      const newCard = tmp.firstElementChild;
      card.replaceWith(newCard);
      attachCardEvents(item);
    });
  }
}

function removeItem(id, cardEl) {
  cardEl.classList.add('removing');
  cardEl.addEventListener('animationend', () => {
    history = history.filter(i => i.id !== id);
    api.deleteItem(id);
    renderList();
    updateStatus();
  }, { once: true });
}

function updateStatus() {
  const total = history.length;
  statusText.textContent = `:: ${total}/${maxHistory} items`;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================
// Global mouse events for drag detection
// ============================================================
document.addEventListener('mousemove', (e) => {
  if (!drag.active) return;

  const dx = Math.abs(e.clientX - drag.startX);
  const dy = Math.abs(e.clientY - drag.startY);

  if ((dx > 5 || dy > 5) && !drag.moved) {
    drag.moved = true;
    const card = document.querySelector(`.item-card[data-id="${drag.itemId}"]`);
    if (card) card.classList.add('dragging');
    api.startDrag(drag.text);
  }
});

document.addEventListener('mouseup', (e) => {
  if (!drag.active) return;

  const wasDrag = drag.moved;

  const card = document.querySelector(`.item-card[data-id="${drag.itemId}"]`);
  if (card) card.classList.remove('dragging');

  const capturedId   = drag.itemId;
  const capturedText = drag.text;

  drag.active = false;
  drag.moved  = false;

  if (!wasDrag) {
    selectedItemId = capturedId;
    renderList();
    api.startClick(capturedText);
  }
});

// ============================================================
// Settings - theme helper + WebGL glass renderer lifecycle
// ============================================================
let _glassInited  = false;

function _glassInit() {
  if (_glassInited || !window.glassRenderer) return false;
  const canvas = document.getElementById('glass-canvas');
  if (!canvas) return false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(320 * dpr);
  canvas.height = Math.round(450 * dpr);
  if (!window.glassRenderer.init(canvas)) return false;
  _glassInited = true;
  // Mouse tracking - forward panel-relative coords to renderer
  const panelEl = document.getElementById('overlay-panel');
  panelEl.addEventListener('mousemove', (e) => {
    if (document.documentElement.getAttribute('data-theme') !== 'glass') return;
    const r = panelEl.getBoundingClientRect();
    window.glassRenderer.setMouse(e.clientX - r.left, e.clientY - r.top);
  });
  return true;
}

function _glassCapture() {
  api.captureBackground().then(dataURL => {
    if (dataURL && _glassInited) window.glassRenderer.loadTexture(dataURL);
  }).catch(() => {});
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'default');
}

// ============================================================
// Settings - accent color helper
// ============================================================
function applyAccentColor(hex) {
  // Parse hex to HSL for deriving glow (lighter) and muted (darker) variants
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  function toHex(hh, ss, ll) {
    let rr, gg, bb;
    if (ss === 0) {
      rr = gg = bb = ll;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
      const p = 2 * ll - q;
      rr = hue2rgb(p, q, hh + 1 / 3);
      gg = hue2rgb(p, q, hh);
      bb = hue2rgb(p, q, hh - 1 / 3);
    }
    return '#' + [rr, gg, bb].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }

  document.documentElement.style.setProperty('--accent-primary', hex);
  document.documentElement.style.setProperty('--accent-glow', toHex(h, s, Math.min(l + 0.08, 1)));
  document.documentElement.style.setProperty('--accent-muted', toHex(h, s, Math.max(l - 0.08, 0)));
}

// ============================================================
// Settings - monitor picker
// ============================================================
const MONITOR_HINT = 'the bar appears on every selected monitor';

function setMonitorHint(text, warn) {
  const hint = document.getElementById('monitor-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('warn', !!warn);
}

async function renderMonitors() {
  const list = document.getElementById('monitor-list');
  if (!list) return;

  let displays;
  try {
    displays = await api.listDisplays();
  } catch (_) {
    return;
  }

  list.innerHTML = '';
  for (const d of displays) {
    const btn = document.createElement('button');
    btn.className   = 'monitor-btn' + (d.selected ? ' active' : '');
    btn.dataset.id  = d.id;
    btn.innerHTML   =
      '<span class="mon-name"><span class="mon-check">[x]</span>monitor ' + d.index + '</span>' +
      '<span class="mon-meta">' + d.width + 'x' + d.height + (d.primary ? ' / primary' : '') + '</span>';
    btn.addEventListener('click', () => toggleMonitor(d.id));
    list.appendChild(btn);
  }

  updateMonitorSummary();
  setMonitorHint(MONITOR_HINT, false);
}

function updateMonitorSummary() {
  const list    = document.getElementById('monitor-list');
  const summary = document.getElementById('monitor-summary');
  if (!list || !summary) return;
  const all = list.querySelectorAll('.monitor-btn');
  const on  = list.querySelectorAll('.monitor-btn.active');
  summary.textContent = on.length + ' of ' + all.length;
}

function toggleMonitor(id) {
  const list = document.getElementById('monitor-list');
  if (!list) return;

  const btns   = Array.from(list.querySelectorAll('.monitor-btn'));
  const target = btns.find(b => b.dataset.id === id);
  if (!target) return;

  const turnOn   = !target.classList.contains('active');
  const selected = btns.filter(b => b.classList.contains('active')).map(b => b.dataset.id);
  const next     = turnOn ? selected.concat([id]) : selected.filter(x => x !== id);

  // The bar has to live somewhere - refuse to switch off the last one
  if (!next.length) {
    setMonitorHint('at least one monitor has to stay selected', true);
    return;
  }

  api.setDisplays(next);
  target.classList.toggle('active', turnOn);
  updateMonitorSummary();
  setMonitorHint(MONITOR_HINT, false);
}

// A monitor was plugged in or unplugged, or another dock changed the choice
api.onDisplaysChanged(() => renderMonitors());

// ============================================================
// Settings - reset to defaults
// ============================================================
const DEFAULTS = {
  charDelay:      1,
  initialDelay:   1,
  autoEnter:      false,
  startWithWindows: true,
  maxHistory:     50,
  accentColor:    '#7C3AED',
  theme:          'default'
};

const CHAR_DELAY_MIN = 0;  // 0 is turbo: no pause between keystrokes
const CHAR_DELAY_MAX = 150;
const INIT_DELAY_MIN = 1;
const INIT_DELAY_MAX = 4000;

function speedLabel(ms) {
  return ms === 0 ? 'turbo' : ms + 'ms/char';
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function setSegGroup(groupId, val) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === String(val));
  });
}

resetBtn.addEventListener('click', () => {
  // Persist all defaults
  Object.entries(DEFAULTS).forEach(([key, val]) => api.updateSetting(key, val));

  // Typing speed (charDelay)
  const speedSlider = document.getElementById('speed-slider');
  const speedValue  = document.getElementById('speed-value');
  if (speedSlider) speedSlider.value = DEFAULTS.charDelay;
  if (speedValue)  speedValue.textContent = speedLabel(DEFAULTS.charDelay);

  // Initial delay (slider + number)
  const delaySlider = document.getElementById('delay-slider');
  const delayInput  = document.getElementById('delay-input');
  if (delaySlider) delaySlider.value = DEFAULTS.initialDelay;
  if (delayInput)  delayInput.value  = DEFAULTS.initialDelay;

  // Auto enter
  const autoEnterToggle = document.getElementById('auto-enter-toggle');
  if (autoEnterToggle) autoEnterToggle.checked = DEFAULTS.autoEnter;

  const winToggle = document.getElementById('start-windows-toggle');
  if (winToggle) winToggle.checked = DEFAULTS.startWithWindows;

  setSegGroup('history-group', DEFAULTS.maxHistory);
  maxHistory = DEFAULTS.maxHistory;

  const colorInput = document.getElementById('accent-color-input');
  if (colorInput) { colorInput.value = DEFAULTS.accentColor; applyAccentColor(DEFAULTS.accentColor); }

  // The monitor choice is placement, not styling - reset leaves it alone.

  setSegGroup('theme-group', DEFAULTS.theme);
  applyTheme(DEFAULTS.theme);
});

// ============================================================
// Settings - segmented button group helper
// ============================================================
function initSegGroup(groupId, currentVal, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;

  group.querySelectorAll('.seg-btn').forEach(btn => {
    if (btn.dataset.val === String(currentVal)) {
      btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
      group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.val);
    });
  });
}

// ============================================================
// Settings - initialise all controls from stored settings
// ============================================================
function initSettings(settings) {
  // Typing speed = charDelay in ms (left = fast/low delay, right = slow/high delay)
  const speedSlider = document.getElementById('speed-slider');
  const speedValue  = document.getElementById('speed-value');
  if (speedSlider) {
    const cd = clampInt(settings.charDelay, CHAR_DELAY_MIN, CHAR_DELAY_MAX, DEFAULTS.charDelay);
    speedSlider.value = cd;
    speedValue.textContent = speedLabel(cd);

    let speedTimer = null;
    speedSlider.addEventListener('input', () => {
      const val = clampInt(speedSlider.value, CHAR_DELAY_MIN, CHAR_DELAY_MAX, DEFAULTS.charDelay);
      speedValue.textContent = speedLabel(val);
      clearTimeout(speedTimer);
      speedTimer = setTimeout(() => api.updateSetting('charDelay', val), 250);
    });
  }

  // Initial delay: slider + exact number input, kept in sync (1 - 4000ms)
  const delaySlider = document.getElementById('delay-slider');
  const delayInput  = document.getElementById('delay-input');
  if (delaySlider && delayInput) {
    const id0 = clampInt(settings.initialDelay, INIT_DELAY_MIN, INIT_DELAY_MAX, DEFAULTS.initialDelay);
    delaySlider.value = id0;
    delayInput.value  = id0;

    let delayTimer = null;
    const commitDelay = (val) => {
      clearTimeout(delayTimer);
      delayTimer = setTimeout(() => api.updateSetting('initialDelay', val), 250);
    };

    delaySlider.addEventListener('input', () => {
      const val = clampInt(delaySlider.value, INIT_DELAY_MIN, INIT_DELAY_MAX, DEFAULTS.initialDelay);
      delayInput.value = val;
      commitDelay(val);
    });

    delayInput.addEventListener('change', () => {
      const val = clampInt(delayInput.value, INIT_DELAY_MIN, INIT_DELAY_MAX, DEFAULTS.initialDelay);
      delayInput.value  = val;
      delaySlider.value = val;
      commitDelay(val);
    });
    // Stop the global keydown handler from swallowing digits typed in the field
    delayInput.addEventListener('keydown', (e) => e.stopPropagation());
  }

  // Auto enter
  const autoEnterToggle = document.getElementById('auto-enter-toggle');
  if (autoEnterToggle) {
    autoEnterToggle.checked = settings.autoEnter ?? false;
    autoEnterToggle.addEventListener('change', () => {
      api.updateSetting('autoEnter', autoEnterToggle.checked);
    });
  }

  // Start with Windows
  const winToggle = document.getElementById('start-windows-toggle');
  if (winToggle) {
    winToggle.checked = settings.startWithWindows;
    winToggle.addEventListener('change', () => {
      api.updateSetting('startWithWindows', winToggle.checked);
    });
  }

  // Max history
  maxHistory = settings.maxHistory ?? 50;
  initSegGroup('history-group', settings.maxHistory, (val) => {
    maxHistory = parseInt(val, 10);
    api.updateSetting('maxHistory', maxHistory);
  });

  // Monitors the bar lives on
  renderMonitors();

  // Accent color
  const colorInput = document.getElementById('accent-color-input');
  if (colorInput) {
    colorInput.value = settings.accentColor || '#7C3AED';
    applyAccentColor(colorInput.value);

    let colorTimer = null;
    colorInput.addEventListener('input', () => {
      applyAccentColor(colorInput.value);
      clearTimeout(colorTimer);
      colorTimer = setTimeout(() => {
        api.updateSetting('accentColor', colorInput.value);
      }, 400);
    });
  }

  // Theme
  applyTheme(settings.theme);
  initSegGroup('theme-group', settings.theme, (val) => {
    api.updateSetting('theme', val);
    applyTheme(val);
  });
}

// ============================================================
// Initial load
// ============================================================
(async () => {
  try {
    const [h, settings] = await Promise.all([
      api.getHistory(),
      api.getSettings()
    ]);
    history = h;
    renderList();
    updateStatus();
    initSettings(settings);
  } catch (e) {
    console.error('Failed to load:', e);
  }
})();
