'use strict';

const { net, app, shell } = require('electron');

const RELEASES_URL = 'https://github.com/mypetcheetah/0xpaste/releases';
const API_URL      = 'https://api.github.com/repos/mypetcheetah/0xpaste/releases/latest';
const TIMEOUT_MS   = 8000;

// Parse a version tag into numeric parts, ignoring a leading v and any
// pre-release / build suffix (e.g. "v1.2.3-beta.1" -> [1, 2, 3]).
function parseVersion(tag) {
  return String(tag)
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]          // drop -beta, +build, etc.
    .split('.')
    .map(n => parseInt(n, 10))
    .map(n => (isNaN(n) ? 0 : n));
}

// True only when remote is strictly higher than current.
function isNewer(remote, current) {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] || 0;
    const cv = c[i] || 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false; // equal
}

function checkForUpdates(onUpdateAvailable) {
  let settled = false;
  const finish = () => { settled = true; };

  try {
    const request = net.request({ url: API_URL, method: 'GET' });
    request.setHeader('User-Agent', '0xpaste-updater');
    request.setHeader('Accept', 'application/vnd.github+json');

    const timer = setTimeout(() => {
      if (!settled) { finish(); try { request.abort(); } catch (_) {} }
    }, TIMEOUT_MS);

    let body = '';
    request.on('response', (response) => {
      // Non-2xx (rate limit, 404 when there are no releases yet): ignore.
      if (response.statusCode < 200 || response.statusCode >= 300) {
        clearTimeout(timer); finish();
        response.on('data', () => {});
        return;
      }
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        finish();
        try {
          const data = JSON.parse(body);
          // Skip drafts and pre-releases - only stable releases count.
          if (data.draft || data.prerelease) return;
          const remoteTag = data.tag_name;
          const current   = app.getVersion();
          if (remoteTag && isNewer(remoteTag, current)) {
            const url = data.html_url || RELEASES_URL;
            onUpdateAvailable(remoteTag, url);
          }
        } catch (_) { /* ignore parse errors */ }
      });
    });

    request.on('error', () => { clearTimeout(timer); finish(); });
    request.end();
  } catch (_) { /* silent if net.request unavailable */ }
}

function openReleasesPage(url) {
  shell.openExternal(url && /^https:\/\/github\.com\//.test(url) ? url : RELEASES_URL);
}

module.exports = { checkForUpdates, openReleasesPage, isNewer, parseVersion };
