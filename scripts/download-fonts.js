/**
 * download-fonts.js
 * Downloads Silkscreen font files from Google Fonts for local use.
 *
 * Run: node scripts/download-fonts.js
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const FONTS_DIR = path.join(__dirname, '..', 'src', 'assets', 'fonts');

const FONTS = [
  {
    name: 'Silkscreen-Regular.ttf',
    url:  'https://fonts.gstatic.com/s/silkscreen/v4/m8JXjfVPf62XiF7kO-i9ULRvamBfZOy5EQ.ttf'
  },
  {
    name: 'Silkscreen-Bold.ttf',
    url:  'https://fonts.gstatic.com/s/silkscreen/v4/m8JUjfVPf62XiF7kO-i9UAAC-GSRP4LRVuX.ttf'
  }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  fs.mkdirSync(FONTS_DIR, { recursive: true });

  for (const font of FONTS) {
    const dest = path.join(FONTS_DIR, font.name);
    if (fs.existsSync(dest)) {
      console.log(`[download-fonts] Already exists: ${font.name}`);
      continue;
    }
    console.log(`[download-fonts] Downloading ${font.name}...`);
    try {
      await download(font.url, dest);
      console.log(`[download-fonts] Saved: ${font.name}`);
    } catch (e) {
      console.error(`[download-fonts] Failed to download ${font.name}:`, e.message);
    }
  }

  console.log('[download-fonts] Done!');
  console.log('[download-fonts] Note: Update overlay.css and settings.css to use local fonts');
  console.log('[download-fonts] Add this to your CSS:');
  console.log("  @font-face { font-family: 'Silkscreen'; src: url('../assets/fonts/Silkscreen-Regular.ttf'); }");
}

main().catch(console.error);
