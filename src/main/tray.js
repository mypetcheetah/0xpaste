'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let trayInstance = null;

function createTray(onToggle, onOpenSettings, onQuit) {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  trayInstance = new Tray(icon);
  trayInstance.setToolTip('0xpaste — clipboard history');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '[cfg] Settings',
      type: 'normal',
      click: () => {
        if (onOpenSettings) onOpenSettings();
      }
    },
    { type: 'separator' },
    {
      label: '[ ] Quit 0xpaste',
      type: 'normal',
      click: () => {
        if (onQuit) onQuit();
      }
    }
  ]);

  trayInstance.setContextMenu(contextMenu);

  // Left-click toggles overlay
  trayInstance.on('click', () => {
    if (onToggle) onToggle();
  });

  return trayInstance;
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

module.exports = { createTray, destroyTray, getTray };
