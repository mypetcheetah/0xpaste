'use strict';

const Store = require('electron-store');

const schema = {
  initialDelay: {
    type: 'number',
    default: 100,
    minimum: 0,
    maximum: 10000
  },
  charDelay: {
    type: 'number',
    default: 15,
    minimum: 10,
    maximum: 1000
  },
  startWithWindows: {
    type: 'boolean',
    default: true
  },
  typingSpeed: {
    type: 'string',
    default: 'fast'
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
  }
};

const store = new Store({
  name: 'config',
  schema,
  defaults: {
    initialDelay: 100,
    charDelay: 15,
    startWithWindows: true,
    typingSpeed: 'fast',
    maxHistory: 50,
    hotkey: 'CommandOrControl+Space',
    accentColor: '#7C3AED',
    panelPosition: 'bottom-right',
    theme: 'default'
  }
});

const SPEED_TO_DELAY = { slow: 100, medium: 50, fast: 15 };

function getSettings() {
  const typingSpeed = store.get('typingSpeed');
  return {
    initialDelay: store.get('initialDelay'),
    charDelay: SPEED_TO_DELAY[typingSpeed] ?? store.get('charDelay'),
    startWithWindows: store.get('startWithWindows'),
    typingSpeed,
    maxHistory: store.get('maxHistory'),
    hotkey: store.get('hotkey'),
    accentColor: store.get('accentColor'),
    panelPosition: store.get('panelPosition'),
    theme: store.get('theme')
  };
}

function updateSetting(key, value) {
  if (!(key in schema)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  store.set(key, value);
}

module.exports = { getSettings, updateSetting, store };
