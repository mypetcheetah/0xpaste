'use strict';

const { globalShortcut } = require('electron');

const DEFAULT_HOTKEY = 'CommandOrControl+-';
const ESCAPE_KEY     = 'Escape';

let currentHotkey   = DEFAULT_HOTKEY;
let toggleCallback  = null;
let escapeCallback  = null;
let hotkeyActive    = false;
let escapeActive    = false;
let cooldown        = false;
const COOLDOWN_MS   = 300;

function registerHotkey(callback, hotkeyStr) {
  if (hotkeyStr) currentHotkey = hotkeyStr;
  toggleCallback = callback;

  const success = globalShortcut.register(currentHotkey, () => {
    if (cooldown) return;
    cooldown = true;
    setTimeout(() => { cooldown = false; }, COOLDOWN_MS);
    if (toggleCallback) toggleCallback();
  });

  if (!success) {
    console.warn('[hotkey] Failed to register hotkey:', currentHotkey);
  } else {
    hotkeyActive = true;
    console.log('[hotkey] Registered hotkey:', currentHotkey);
  }

  return success;
}

function unregisterHotkey() {
  if (hotkeyActive) {
    globalShortcut.unregister(currentHotkey);
    hotkeyActive = false;
  }
}

function updateHotkey(newHotkey) {
  if (!newHotkey) return false;

  if (hotkeyActive) {
    globalShortcut.unregister(currentHotkey);
    hotkeyActive = false;
  }

  currentHotkey = newHotkey;

  if (toggleCallback) {
    const success = globalShortcut.register(currentHotkey, () => {
      if (cooldown) return;
      cooldown = true;
      setTimeout(() => { cooldown = false; }, COOLDOWN_MS);
      if (toggleCallback) toggleCallback();
    });
    if (success) hotkeyActive = true;
    console.log('[hotkey] Updated hotkey to:', currentHotkey, success ? 'OK' : 'FAILED');
    return success;
  }

  return true;
}

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
  hotkeyActive = false;
  escapeActive = false;
}

module.exports = {
  registerHotkey,
  unregisterHotkey,
  updateHotkey,
  registerEscape,
  unregisterEscape,
  unregisterAll,
  get HOTKEY() { return currentHotkey; }
};
