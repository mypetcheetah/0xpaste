'use strict';

const { clipboard } = require('electron');
const { nanoid } = require('nanoid');

let maxHistory = 50;
const POLL_INTERVAL_MS = 500;

let history = [];
let lastText = '';
let pollTimer = null;
let onNewItem = null;

function start(callback) {
  onNewItem = callback;
  lastText = clipboard.readText() || '';
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function poll() {
  let text;
  try {
    text = clipboard.readText();
  } catch (e) {
    return;
  }

  if (!text || text === lastText) return;
  lastText = text;

  const item = {
    id: nanoid(),
    text,
    timestamp: Date.now(),
    pinned: false
  };

  addToHistory(item);

  if (onNewItem) {
    onNewItem(item);
  }
}

function addToHistory(item) {
  if (!item.text.trim()) return;

  // Remove FIFO unpinned items if at limit
  const unpinned = history.filter(i => !i.pinned);
  if (unpinned.length >= maxHistory) {
    const oldest = unpinned[unpinned.length - 1];
    history = history.filter(i => i.id !== oldest.id);
  }

  history.unshift(item);
}

function setMaxHistory(n) {
  maxHistory = n;
  // Trim existing history if over new limit
  const unpinned = history.filter(i => !i.pinned);
  if (unpinned.length > maxHistory) {
    const toRemove = unpinned.slice(maxHistory);
    const removeIds = new Set(toRemove.map(i => i.id));
    history = history.filter(i => !removeIds.has(i.id));
  }
}

function getHistory() {
  const pinned = history.filter(i => i.pinned);
  const unpinned = history.filter(i => !i.pinned);
  return [...pinned, ...unpinned];
}

function deleteItem(id) {
  history = history.filter(i => i.id !== id);
}

function clearAll() {
  history = history.filter(i => i.pinned);
}

function togglePin(id) {
  const item = history.find(i => i.id === id);
  if (item) {
    item.pinned = !item.pinned;
  }
  return item;
}

module.exports = { start, stop, getHistory, deleteItem, clearAll, togglePin, setMaxHistory };
