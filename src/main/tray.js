'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let trayInstance  = null;
let _onToggle     = null;
let _onQuit       = null;
let _onCancelType = null;

function buildMenu(typing) {
  const items = [];

  if (typing) {
    items.push({
      label: '⬛ Stop typing',
      type: 'normal',
      click: () => { if (_onCancelType) _onCancelType(); }
    });
    items.push({ type: 'separator' });
  }

  items.push({
    label: 'Quit 0xpaste',
    type: 'normal',
    click: () => { if (_onQuit) _onQuit(); }
  });

  return Menu.buildFromTemplate(items);
}

function createTray(onToggle, onOpenSettings, onQuit, onCancelType) {
  _onToggle     = onToggle;
  _onQuit       = onQuit;
  _onCancelType = onCancelType;

  const iconPath = path.join(__dirname, '../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  trayInstance = new Tray(icon);
  trayInstance.setToolTip('0xpaste — clipboard history');
  trayInstance.setContextMenu(buildMenu(false));

  // Left-click toggles overlay
  trayInstance.on('click', () => {
    if (_onToggle) _onToggle();
  });

  return trayInstance;
}

function setTypingMode(active) {
  if (!trayInstance) return;
  trayInstance.setToolTip(active ? '0xpaste — typing… (right-click to stop)' : '0xpaste — clipboard history');
  trayInstance.setContextMenu(buildMenu(active));
}

function destroyTray() {
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }
}

function getTray() {
  return trayInstance;
}

module.exports = { createTray, destroyTray, getTray, setTypingMode };
