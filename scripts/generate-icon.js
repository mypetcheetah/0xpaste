extract /**
 * generate-icon.js
 * Converts root icon.png into src/assets/icon.ico (multi-resolution)
 * and copies the PNG.
 *
 * Run: node scripts/generate-icon.js
 * Requires: npm install (png-to-ico and sharp are devDependencies)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT        = path.join(__dirname, '..');
const SRC_PNG     = path.join(ROOT, 'icon.png');
const ASSETS_DIR  = path.join(ROOT, 'src', 'assets');
const DEST_PNG    = path.join(ASSETS_DIR, 'icon.png');
const DEST_ICO    = path.join(ASSETS_DIR, 'icon.ico');

async function main() {
  // Ensure assets directory exists
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  if (!fs.existsSync(SRC_PNG)) {
    console.error('[generate-icon] icon.png not found at project root.');
    process.exit(1);
  }

  // Copy PNG to assets
  fs.copyFileSync(SRC_PNG, DEST_PNG);
  console.log('[generate-icon] Copied icon.png -> src/assets/icon.png');

  // Generate ICO with multiple sizes using sharp + png-to-ico
  let pngToIco;
  let sharp;

  try {
    pngToIco = require('png-to-ico');
  } catch (e) {
    console.error('[generate-icon] png-to-ico not found. Run: npm install');
    process.exit(1);
  }

  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('[generate-icon] sharp not found. Run: npm install');
    process.exit(1);
  }

  // Resize to standard ICO sizes
  const sizes = [16, 32, 48, 64, 128, 256];
  const buffers = [];

  for (const size of sizes) {
    const buf = await sharp(SRC_PNG)
      .resize(size, size, { fit: 'contain', background: { r: 13, g: 13, b: 15, alpha: 1 } })
      .png()
      .toBuffer();
    buffers.push(buf);
    console.log(`[generate-icon] Resized ${size}x${size}`);
  }

  const icoBuf = await pngToIco(buffers);
  fs.writeFileSync(DEST_ICO, icoBuf);
  console.log('[generate-icon] Created src/assets/icon.ico');
  console.log('[generate-icon] Done!');
}

main().catch(err => {
  console.error('[generate-icon] Error:', err);
  process.exit(1);
});
