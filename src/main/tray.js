'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let trayInstance   = null;
let _onToggleBar   = null;
let _onQuit        = null;
let _onCancelType  = null;
let _updateVersion = null;  // e.g. 'v1.1.0'
let _onOpenUpdate  = null;
let _barVisible    = true;
let _typing        = false;

function buildMenu() {
  const items = [];

  if (_updateVersion) {
    items.push({
      label: 'Update available (' + _updateVersion + ') - click to download',
      type: 'normal',
      click: () => { if (_onOpenUpdate) _onOpenUpdate(); }
    });
    items.push({ type: 'separator' });
  }

  if (_typing) {
    items.push({
      label: 'Stop typing',
      type: 'normal',
      click: () => { if (_onCancelType) _onCancelType(); }
    });
    items.push({ type: 'separator' });
  }

  items.push({
    label: _barVisible ? 'Hide bar' : 'Show bar',
    type: 'normal',
    click: () => { if (_onToggleBar) _onToggleBar(); }
  });
  items.push({ type: 'separator' });

  items.push({
    label: 'Quit 0xpaste',
    type: 'normal',
    click: () => { if (_onQuit) _onQuit(); }
  });

  return Menu.buildFromTemplate(items);
}

function refresh() {
  if (!trayInstance) return;
  trayInstance.setContextMenu(buildMenu());
}

function tooltip() {
  if (_typing)        return '0xpaste - typing... (right-click to stop)';
  if (_updateVersion) return '0xpaste - Update available: ' + _updateVersion;
  if (!_barVisible)   return '0xpaste - bar hidden (click to show)';
  return '0xpaste - hover the left edge of your screen';
}

function createTray({ onToggleBar, onQuit, onCancelType }) {
  _onToggleBar  = onToggleBar;
  _onQuit       = onQuit;
  _onCancelType = onCancelType;

  const iconPath = path.join(__dirname, '../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  trayInstance = new Tray(icon);
  trayInstance.setToolTip(tooltip());
  trayInstance.setContextMenu(buildMenu());

  // Left-click shows or hides the bar
  trayInstance.on('click', () => {
    if (_onToggleBar) _onToggleBar();
  });

  return trayInstance;
}

function setTypingMode(active) {
  _typing = !!active;
  if (!trayInstance) return;
  trayInstance.setToolTip(tooltip());
  refresh();
}

function setBarVisible(visible) {
  _barVisible = !!visible;
  if (!trayInstance) return;
  trayInstance.setToolTip(tooltip());
  refresh();
}

function setUpdateAvailable(version, onOpen) {
  _updateVersion = version;
  _onOpenUpdate  = onOpen;
  if (!trayInstance) return;
  trayInstance.setToolTip(tooltip());
  refresh();
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

module.exports = { createTray, destroyTray, getTray, setTypingMode, setBarVisible, setUpdateAvailable };
