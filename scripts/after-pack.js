/**
 * after-pack.js
 * Stamps the app icon and version metadata into 0xpaste.exe.
 *
 * electron-builder would normally do this itself, but only with
 * signAndEditExecutable on, and that pulls in its winCodeSign toolchain -
 * an archive full of macOS symlinks that Windows refuses to unpack without
 * developer mode or admin rights. So that stays off and rcedit is called
 * here directly, which needs none of it.
 *
 * Without this the executable keeps Electron's default atom icon, which is
 * what the taskbar, the start menu and alt-tab all show.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const ICON = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // v5 is ESM and exports a named function, v4 is CommonJS with a default
  // export. A dynamic import handles both without pinning either.
  const mod    = await import('rcedit');
  const rcedit = mod.rcedit || mod.default;

  const appInfo = context.packager.appInfo;
  const exe     = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);

  if (!fs.existsSync(exe))  throw new Error(`[after-pack] executable not found: ${exe}`);
  if (!fs.existsSync(ICON)) throw new Error(`[after-pack] icon not found: ${ICON}. Run npm run setup-icon.`);

  await rcedit(exe, {
    icon: ICON,
    'file-version':    appInfo.version,
    'product-version': appInfo.version,
    'version-string': {
      ProductName:      appInfo.productName,
      FileDescription:  appInfo.description,
      CompanyName:      appInfo.companyName || 'mypetcheetah',
      LegalCopyright:   appInfo.copyright,
      OriginalFilename: `${appInfo.productFilename}.exe`
    }
  });

  console.log(`[after-pack] Stamped icon and version info into ${path.basename(exe)}`);
};
