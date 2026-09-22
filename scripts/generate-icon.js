/**
 * generate-icon.js
 * Renders assets/icon.svg into the raster icons the app and the installer
 * need: src/assets/icon.png (tray, window) and src/assets/icon.ico
 * (executable, NSIS installer and uninstaller).
 *
 * The SVG is the only source - there is no master PNG to keep in sync.
 *
 * Run: npm run setup-icon
 * Requires: npm install (png-to-ico and sharp are devDependencies)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT       = path.join(__dirname, '..');
const SRC_SVG    = path.join(ROOT, 'assets', 'icon.svg');
const ASSETS_DIR = path.join(ROOT, 'src', 'assets');
const DEST_PNG   = path.join(ASSETS_DIR, 'icon.png');
const DEST_ICO   = path.join(ASSETS_DIR, 'icon.ico');

const PNG_SIZE  = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  if (!fs.existsSync(SRC_SVG)) {
    console.error('[generate-icon] assets/icon.svg not found.');
    process.exit(1);
  }

  let pngToIco, sharp;
  try {
    pngToIco = require('png-to-ico');
    sharp    = require('sharp');
  } catch (e) {
    console.error('[generate-icon] png-to-ico or sharp not found. Run: npm install');
    process.exit(1);
  }

  const svg = fs.readFileSync(SRC_SVG);

  // Rasterise straight from the SVG at each size rather than downscaling one
  // big bitmap, so the small ones stay crisp where it matters most.
  const render = (size) => sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  fs.writeFileSync(DEST_PNG, await render(PNG_SIZE));
  console.log(`[generate-icon] Wrote src/assets/icon.png (${PNG_SIZE}x${PNG_SIZE})`);

  const buffers = [];
  for (const size of ICO_SIZES) {
    buffers.push(await render(size));
    console.log(`[generate-icon] Rendered ${size}x${size}`);
  }

  fs.writeFileSync(DEST_ICO, await pngToIco(buffers));
  console.log('[generate-icon] Wrote src/assets/icon.ico');
  console.log('[generate-icon] Done!');
}

main().catch(err => {
  console.error('[generate-icon] Error:', err);
  process.exit(1);
});
