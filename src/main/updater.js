'use strict';

const { net, app, shell } = require('electron');

const RELEASES_URL = 'https://github.com/mypetcheetah/0xpaste/releases';
const API_URL      = 'https://api.github.com/repos/mypetcheetah/0xpaste/releases/latest';

function parseVersion(tag) {
  return tag.replace(/^v/i, '').split('.').map(Number);
}

function isNewer(remote, current) {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] || 0;
    const cv = c[i] || 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false;
}

function checkForUpdates(onUpdateAvailable) {
  try {
    const request = net.request({ url: API_URL, method: 'GET' });

    request.setHeader('User-Agent', '0xpaste-updater');
    request.setHeader('Accept', 'application/vnd.github+json');

    let body = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          const data       = JSON.parse(body);
          const remoteTag  = data.tag_name;
          const current    = app.getVersion();
          if (remoteTag && isNewer(remoteTag, current)) {
            onUpdateAvailable(remoteTag, RELEASES_URL);
          }
        } catch (_) { /* ignore parse errors */ }
      });
    });

    request.on('error', () => { /* silent on network error */ });
    request.end();
  } catch (_) { /* silent if net.request unavailable */ }
}

function openReleasesPage() {
  shell.openExternal(RELEASES_URL);
}

module.exports = { checkForUpdates, openReleasesPage };
