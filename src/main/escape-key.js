'use strict';

// ============================================================
// Escape key - only active while the click/drop target overlay is up
// ============================================================
// This is deliberately not a configurable keybinding: it exists so the
// full-screen targeting overlay can always be dismissed. 0xpaste has no
// global hotkeys - the dock opens on hover.

const { globalShortcut } = require('electron');

const ESCAPE_KEY = 'Escape';

let escapeCallback = null;
let escapeActive   = false;

function registerEscape(callback) {
  if (escapeActive) return;
  escapeCallback = callback;

  const success = globalShortcut.register(ESCAPE_KEY, () => {
    if (escapeCallback) escapeCallback();
  });

  if (success) escapeActive = true;
}

function unregisterEscape() {
  if (escapeActive) {
    globalShortcut.unregister(ESCAPE_KEY);
    escapeActive   = false;
    escapeCallback = null;
  }
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  escapeActive = false;
}

module.exports = { registerEscape, unregisterEscape, unregisterAll };
