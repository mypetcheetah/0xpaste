'use strict';

const api = window.electronAPI;

const initialDelayInput   = document.getElementById('initial-delay');
const charDelayInput      = document.getElementById('char-delay');
const startWithWinToggle  = document.getElementById('start-with-windows');
const savedFlash          = document.getElementById('saved-flash');
const aboutVersion        = document.getElementById('about-version');

let saveFlashTimer = null;

function showSaved() {
  savedFlash.classList.add('show');
  clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(() => savedFlash.classList.remove('show'), 1500);
}

async function init() {
  const settings = await api.getSettings();

  initialDelayInput.value    = settings.initialDelay;
  charDelayInput.value       = settings.charDelay;
  startWithWinToggle.checked = settings.startWithWindows;

  // Try to get app version from package.json title attribute
  try {
    const { remote } = window; // not available in contextIsolation
    // Fall back to static display
  } catch (_) {}
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

initialDelayInput.addEventListener('change', () => {
  const val = clamp(parseInt(initialDelayInput.value, 10) || 0, 0, 10000);
  initialDelayInput.value = val;
  api.updateSetting('initialDelay', val);
  showSaved();
});

charDelayInput.addEventListener('change', () => {
  const val = clamp(parseInt(charDelayInput.value, 10) || 50, 10, 1000);
  charDelayInput.value = val;
  api.updateSetting('charDelay', val);
  showSaved();
});

startWithWinToggle.addEventListener('change', () => {
  api.updateSetting('startWithWindows', startWithWinToggle.checked);
  showSaved();
});

init();
