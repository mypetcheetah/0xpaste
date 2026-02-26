'use strict';

const Store = require('electron-store');

const schema = {
  initialDelay: {
    type: 'number',
    default: 2000,
    minimum: 0,
    maximum: 10000
  },
  charDelay: {
    type: 'number',
    default: 50,
    minimum: 10,
    maximum: 1000
  },
  startWithWindows: {
    type: 'boolean',
    default: true
  },
  typingSpeed: {
    type: 'string',
    default: 'medium'
  },
  maxHistory: {
    type: 'number',
    default: 50,
    minimum: 10,
    maximum: 75
  },
  hotkey: {
    type: 'string',
    default: 'CommandOrControl+-'
  },
  accentColor: {
    type: 'string',
    default: '#7C3AED'
  },
  panelPosition: {
    type: 'string',
    default: 'bottom-right'
  }
};

const store = new Store({
  name: 'config',
  schema,
  defaults: {
    initialDelay: 2000,
    charDelay: 50,
    startWithWindows: true,
    typingSpeed: 'medium',
    maxHistory: 50,
    hotkey: 'CommandOrControl+-',
    accentColor: '#7C3AED',
    panelPosition: 'bottom-right'
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
    panelPosition: store.get('panelPosition')
  };
}

function updateSetting(key, value) {
  if (!(key in schema)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  store.set(key, value);
}

module.exports = { getSettings, updateSetting, store };
