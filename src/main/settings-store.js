'use strict';

const Store = require('electron-store');

// Schema ranges are a deliberate superset of every value older builds could
// have stored, so a pre-existing config never fails validation on load. The
// UI enforces the real, tighter ranges (initialDelay 1-4000, charDelay 1-200).
const schema = {
  initialDelay: {
    type: 'number',
    default: 1,
    minimum: 0,
    maximum: 10000
  },
  charDelay: {
    type: 'number',
    default: 1,
    minimum: 1,
    maximum: 1000
  },
  startWithWindows: {
    type: 'boolean',
    default: true
  },
  maxHistory: {
    type: 'number',
    default: 50,
    minimum: 10,
    maximum: 75
  },
  hotkey: {
    type: 'string',
    default: 'CommandOrControl+Space'
  },
  accentColor: {
    type: 'string',
    default: '#7C3AED'
  },
  panelPosition: {
    type: 'string',
    default: 'bottom-right'
  },
  theme: {
    type: 'string',
    default: 'default'
  },
  autoEnter: {
    type: 'boolean',
    default: false
  }
};

const store = new Store({
  name: 'config',
  schema,
  defaults: {
    initialDelay: 1,
    charDelay: 1,
    startWithWindows: true,
    maxHistory: 50,
    hotkey: 'CommandOrControl+Space',
    accentColor: '#7C3AED',
    panelPosition: 'bottom-right',
    theme: 'default',
    autoEnter: false
  }
});

function getSettings() {
  return {
    initialDelay: store.get('initialDelay'),
    charDelay: store.get('charDelay'),
    startWithWindows: store.get('startWithWindows'),
    maxHistory: store.get('maxHistory'),
    hotkey: store.get('hotkey'),
    accentColor: store.get('accentColor'),
    panelPosition: store.get('panelPosition'),
    theme: store.get('theme'),
    autoEnter: store.get('autoEnter')
  };
}

function updateSetting(key, value) {
  if (!(key in schema)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  store.set(key, value);
}

module.exports = { getSettings, updateSetting, store };
