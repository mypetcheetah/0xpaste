'use strict';

// ============================================================
// 0xpaste Overlay Renderer
// ============================================================

const api = window.electronAPI;

// ---- State ----
let history = [];
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
const settingsBtn    = document.getElementById('settings-btn');
const clipboardView  = document.getElementById('clipboard-view');
const settingsView   = document.getElementById('settings-view');
const headerHotkey   = document.getElementById('header-hotkey');
const resetBtn       = document.getElementById('reset-defaults-btn');

// ============================================================
// Settings toggle
// ============================================================
settingsBtn.addEventListener('click', () => {
  settingsVisible = !settingsVisible;
  settingsBtn.classList.toggle('active', settingsVisible);
  clipboardView.style.display = settingsVisible ? 'none' : '';
  settingsView.classList.toggle('visible', settingsVisible);
  resetBtn.classList.toggle('visible', settingsVisible);
});

// ============================================================
// Overlay show / hide (driven by main)
// ============================================================
api.onOverlayShow(() => {
  _overlayOpen = true;
  panel.classList.remove('hiding');
  // Force reflow so transition fires
  void panel.offsetWidth;
  panel.classList.add('visible');
  searchInput.focus();
});

api.onOverlayHide(() => {
  panel.classList.remove('visible');
  panel.classList.add('hiding');

  panel.addEventListener('transitionend', function onEnd() {
    panel.removeEventListener('transitionend', onEnd);
    panel.classList.remove('hiding');
    _overlayOpen = false;
    // Tell main the hide animation is done
    api.hideOverlayDone();
    // Reset search on close
    clearSearch();
    selectedItemId = null;
  }, { once: true });
});

// ============================================================
// Clipboard history
// ============================================================
api.onInitialHistory((h) => {
  history = h;
  renderList();
  updateStatus();
});

api.onNewItem((item) => {
  history.unshift(item);
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

api.onTypingDone(() => {
  typingInd.classList.remove('visible');
  selectedItemId = null;
  renderList();
});

// ============================================================
// Accent color push from main (when changed while overlay visible)
// ============================================================
api.onAccentColor((color) => {
  applyAccentColor(color);
});

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

function buildCardHTML(item) {
  const isHidden  = hiddenItems.has(item.id);
  const preview   = isHidden
    ? '•'.repeat(Math.min(item.text.length, 32))
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
  statusText.textContent = `:: ${total}/50 items`;
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
// Settings — theme helper + WebGL glass renderer lifecycle
// ============================================================
let _glassInited  = false;
let _overlayOpen  = false;

function _glassInit() {
  if (_glassInited || !window.glassRenderer) return false;
  const canvas = document.getElementById('glass-canvas');
  if (!canvas) return false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(320 * dpr);
  canvas.height = Math.round(450 * dpr);
  if (!window.glassRenderer.init(canvas)) return false;
  _glassInited = true;
  // Mouse tracking — forward panel-relative coords to renderer
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
// Settings — accent color helper
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
// Settings — hotkey display helper
// ============================================================
function acceleratorToDisplay(acc) {
  return acc
    .replace(/CommandOrControl/g, 'ctrl')
    .replace(/CmdOrCtrl/g, 'ctrl')
    .replace(/Ctrl/g, 'ctrl')
    .replace(/Alt/g, 'alt')
    .replace(/Shift/g, 'shift')
    .replace(/Super/g, 'win')
    .replace(/\+/g, ' + ')
    .toLowerCase();
}

// ============================================================
// Settings — hotkey capture
// ============================================================
let capturingHotkey = false;
let hotkeyKeydownHandler = null;

function startHotkeyCapture() {
  if (capturingHotkey) return;
  capturingHotkey = true;

  const display = document.getElementById('hotkey-display');
  const btn     = document.getElementById('hotkey-capture-btn');

  display.textContent = 'press keys...';
  display.classList.add('capturing');
  btn.textContent = 'cancel';

  // Temporarily disable global hotkey so it doesn't interfere
  api.hotkeyCapture(true);

  // Cancel if overlay loses focus
  window.addEventListener('blur', cancelHotkeyCapture, { once: true });

  hotkeyKeydownHandler = (e) => {
    // Only modifier keys pressed — wait
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cancelHotkeyCapture();
      return;
    }

    // Require at least one modifier
    if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return;

    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey)  parts.push('Super');

    const specialKeys = {
      'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
      'Enter': 'Return', ' ': 'Space',
      'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
      'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
      'Backspace': 'Backspace', 'Delete': 'Delete', 'Tab': 'Tab',
      'Insert': 'Insert', 'Home': 'Home', 'End': 'End',
      'PageUp': 'PageUp', 'PageDown': 'PageDown'
    };

    const key = specialKeys[e.key] ?? (e.key.length === 1 ? e.key : e.key);
    parts.push(key);

    const accelerator = parts.join('+');

    // Stop capture
    document.removeEventListener('keydown', hotkeyKeydownHandler, true);
    window.removeEventListener('blur', cancelHotkeyCapture);
    capturingHotkey = false;

    display.textContent = acceleratorToDisplay(accelerator);
    display.classList.remove('capturing');
    btn.textContent = 'set';

    // Save — main will re-register the new hotkey via settings:update handler
    api.updateSetting('hotkey', accelerator);

    // Update header display
    if (headerHotkey) headerHotkey.textContent = `toggle: ${acceleratorToDisplay(accelerator)}`;
  };

  document.addEventListener('keydown', hotkeyKeydownHandler, true);
}

function cancelHotkeyCapture() {
  if (!capturingHotkey) return;
  capturingHotkey = false;

  if (hotkeyKeydownHandler) {
    document.removeEventListener('keydown', hotkeyKeydownHandler, true);
    hotkeyKeydownHandler = null;
  }
  window.removeEventListener('blur', cancelHotkeyCapture);

  const display = document.getElementById('hotkey-display');
  const btn     = document.getElementById('hotkey-capture-btn');
  if (display) display.classList.remove('capturing');
  if (btn)     btn.textContent = 'set';

  // Tell main to re-register old hotkey
  api.hotkeyCapture(false);
}

// ============================================================
// Settings — reset to defaults
// ============================================================
const DEFAULTS = {
  typingSpeed:    'fast',
  initialDelay:   100,
  startWithWindows: true,
  maxHistory:     50,
  hotkey:         'CommandOrControl+Space',
  accentColor:    '#7C3AED',
  panelPosition:  'bottom-right',
  theme:          'default'
};

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

  // Update UI controls to reflect defaults
  setSegGroup('speed-group', DEFAULTS.typingSpeed);

  const delaySlider = document.getElementById('delay-slider');
  const delayValue  = document.getElementById('delay-value');
  if (delaySlider) { delaySlider.value = DEFAULTS.initialDelay; }
  if (delayValue)  { delayValue.textContent = `${DEFAULTS.initialDelay}ms`; }

  const winToggle = document.getElementById('start-windows-toggle');
  if (winToggle) winToggle.checked = DEFAULTS.startWithWindows;

  setSegGroup('history-group', DEFAULTS.maxHistory);

  const hotkeyDisplay = document.getElementById('hotkey-display');
  if (hotkeyDisplay) hotkeyDisplay.textContent = acceleratorToDisplay(DEFAULTS.hotkey);
  if (headerHotkey)  headerHotkey.textContent  = `toggle: ${acceleratorToDisplay(DEFAULTS.hotkey)}`;

  const colorInput = document.getElementById('accent-color-input');
  if (colorInput) { colorInput.value = DEFAULTS.accentColor; applyAccentColor(DEFAULTS.accentColor); }

  setSegGroup('position-group', DEFAULTS.panelPosition);

  setSegGroup('theme-group', DEFAULTS.theme);
  applyTheme(DEFAULTS.theme);
});

// ============================================================
// Settings — segmented button group helper
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
// Settings — initialise all controls from stored settings
// ============================================================
function initSettings(settings) {
  // Typing speed
  initSegGroup('speed-group', settings.typingSpeed, (val) => {
    api.updateSetting('typingSpeed', val);
  });

  // Initial delay slider
  const delaySlider = document.getElementById('delay-slider');
  const delayValue  = document.getElementById('delay-value');
  if (delaySlider) {
    delaySlider.value = settings.initialDelay;
    delayValue.textContent = `${settings.initialDelay}ms`;

    let delayTimer = null;
    delaySlider.addEventListener('input', () => {
      const val = parseInt(delaySlider.value, 10);
      delayValue.textContent = `${val}ms`;
      clearTimeout(delayTimer);
      delayTimer = setTimeout(() => {
        api.updateSetting('initialDelay', val);
      }, 300);
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
  initSegGroup('history-group', settings.maxHistory, (val) => {
    api.updateSetting('maxHistory', parseInt(val, 10));
  });

  // Hotkey display
  const hotkeyDisplay = document.getElementById('hotkey-display');
  if (hotkeyDisplay && settings.hotkey) {
    hotkeyDisplay.textContent = acceleratorToDisplay(settings.hotkey);
  }
  if (headerHotkey && settings.hotkey) {
    headerHotkey.textContent = `toggle: ${acceleratorToDisplay(settings.hotkey)}`;
  }

  // Hotkey capture button
  const captureBtn = document.getElementById('hotkey-capture-btn');
  if (captureBtn) {
    captureBtn.addEventListener('click', () => {
      if (capturingHotkey) {
        cancelHotkeyCapture();
      } else {
        startHotkeyCapture();
      }
    });
  }

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

  // Panel position
  initSegGroup('position-group', settings.panelPosition, (val) => {
    api.updateSetting('panelPosition', val);
  });

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
