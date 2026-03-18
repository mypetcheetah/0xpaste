'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let trayInstance   = null;
let _onToggle      = null;
let _onQuit        = null;
let _onCancelType  = null;
let _updateVersion = null;  // e.g. 'v1.0.5'
let _onOpenUpdate  = null;

function buildMenu(typing) {
  const items = [];

  if (_updateVersion) {
    items.push({
      label: `⬆ Update available (${_updateVersion}) - click to download`,
      type: 'normal',
      click: () => { if (_onOpenUpdate) _onOpenUpdate(); }
    });
    items.push({ type: 'separator' });
  }

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
  trayInstance.setToolTip('0xpaste - clipboard history');
  trayInstance.setContextMenu(buildMenu(false));

  // Left-click toggles overlay
  trayInstance.on('click', () => {
    if (_onToggle) _onToggle();
  });

  return trayInstance;
}

function setTypingMode(active) {
  if (!trayInstance) return;
  const base = _updateVersion ? `0xpaste - Update available: ${_updateVersion}` : '0xpaste - clipboard history';
  trayInstance.setToolTip(active ? '0xpaste - typing… (right-click to stop)' : base);
  trayInstance.setContextMenu(buildMenu(active));
}

function setUpdateAvailable(version, onOpen) {
  _updateVersion = version;
  _onOpenUpdate  = onOpen;
  if (!trayInstance) return;
  trayInstance.setToolTip(`0xpaste - Update available: ${version}`);
  trayInstance.setContextMenu(buildMenu(false));
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

module.exports = { createTray, destroyTray, getTray, setTypingMode, setUpdateAvailable };
