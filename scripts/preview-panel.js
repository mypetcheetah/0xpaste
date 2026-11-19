'use strict';

/**
 * preview-panel.js - the panel in an ordinary browser, for development.
 *
 *   node scripts/preview-panel.js [port]      (default 4313)
 *   then open  http://localhost:4313/renderer/overlay/index.html
 *
 * Serves src/ as static files and slips a stand-in for the preload bridge in
 * front of the panel's own scripts. No Electron, no typing process, and not a
 * single keystroke or click is ever generated - which is the point: the UI can
 * be exercised on machines where synthetic input must not be produced.
 *
 * The stand-in is generated from src/preload/preload.js every time the page is
 * requested, so it can never fall behind the real bridge. A method the panel
 * calls but the stand-in lacks would stop the renderer half way and make
 * everything look broken for the wrong reason.
 *
 * In the browser console:
 *   __fire('dock:set-expanded', true)      open the panel
 *   __fire('typing:done', { cancelled: false })
 *   __calls                                 every message the panel sent to main
 *   __state.settings                        the settings as "stored"
 * Settings can be preset from the address bar: ?charDelay=0&fastCharMs=8
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..', 'src');
const PRELOAD = path.join(ROOT, 'preload', 'preload.js');
const PORT    = parseInt(process.argv[2], 10) || 4313;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Read the bridge the real app exposes and build the same surface, minus IPC
function buildStub() {
  const source  = fs.readFileSync(PRELOAD, 'utf8');
  const pattern = /^\s*(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send|on|removeAllListeners)\((?:'([^']+)')?/gm;
  const methods = [];
  let m;
  while ((m = pattern.exec(source)) !== null) {
    methods.push({ name: m[1], kind: m[2], channel: m[3] || null });
  }
  if (!methods.length) throw new Error('no bridge methods found in preload.js');

  return `'use strict';
(function () {
  var METHODS = ${JSON.stringify(methods)};
  var query = new URLSearchParams(location.search);
  var num = function (key, fallback) { return query.has(key) ? Number(query.get(key)) : fallback; };

  var state = window.__state = {
    settings: {
      initialDelay: 1,
      charDelay: num('charDelay', 1),
      fastCharMs: num('fastCharMs', -1),
      startWithWindows: true,
      maxHistory: 50,
      accentColor: '#7C3AED',
      dockDisplays: [],
      theme: query.get('theme') || 'default',
      autoEnter: false,
      breakTyping: 'mouse'
    },
    history: [
      { id: 'a1', text: 'Get-Service W3SVC | Restart-Service -Force', timestamp: Date.now() - 42000, pinned: true, isPassword: false },
      { id: 'a2', text: 'iisreset /stop', timestamp: Date.now() - 180000, pinned: false, isPassword: false },
      { id: 'a3', text: 'Sup3r-S3cret!pass', timestamp: Date.now() - 3600000, pinned: false, isPassword: true }
    ]
  };

  var answers = {
    'clipboard:get-history': function () { return state.history; },
    'settings:get':          function () { return Object.assign({}, state.settings); },
    'displays:list':         function () { return [{ id: '1', index: 1, width: 1920, height: 1080, primary: true, selected: true }]; },
    'update:get':            function () { return null; },
    'screen:capture-overlay': function () { return null; }
  };

  var listeners = {};
  window.__calls = [];
  window.__fire = function (channel, payload) {
    if (!listeners[channel]) { console.warn('[preview] nothing listens to ' + channel); return false; }
    listeners[channel](payload);
    return true;
  };

  var api = {};
  METHODS.forEach(function (method) {
    if (method.kind === 'on') {
      api[method.name] = function (cb) { listeners[method.channel] = cb; };
    } else if (method.kind === 'invoke') {
      api[method.name] = function () {
        var answer = answers[method.channel];
        if (!answer) console.warn('[preview] no canned answer for ' + method.channel);
        return Promise.resolve(answer ? answer() : null);
      };
    } else if (method.kind === 'send') {
      api[method.name] = function () {
        var args = Array.prototype.slice.call(arguments);
        window.__calls.push({ method: method.name, channel: method.channel, args: args });
        if (method.channel === 'settings:update') state.settings[args[0]] = args[1];
      };
    } else {
      api[method.name] = function () {};
    }
  });
  window.electronAPI = api;
})();
`;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' ) {
    res.writeHead(302, { Location: '/renderer/overlay/index.html' });
    return res.end();
  }

  if (url.pathname === '/__preview-bridge.js') {
    try {
      return send(res, 200, TYPES['.js'], buildStub());
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', String(err.message));
    }
  }

  // Static file from src/, and nothing outside it
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'text/plain', 'forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'not found');

    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      // The bridge has to exist before the panel's first script runs
      const html = data.toString('utf8').replace(
        /<script src=/,
        '<script src="/__preview-bridge.js"></script>\n  <script src='
      );
      return send(res, 200, TYPES['.html'], html);
    }
    send(res, 200, TYPES[ext] || 'application/octet-stream', data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`0xpaste panel preview: http://localhost:${PORT}/renderer/overlay/index.html`);
});
