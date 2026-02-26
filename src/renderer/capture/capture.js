'use strict';

const api = window.electronAPI;

const dragGhost  = document.getElementById('drag-ghost');
const ghostText  = document.getElementById('ghost-text');
const clickHint  = document.getElementById('click-hint');

let mode = null; // 'drag' | 'click'

// ---- Init ----
api.onInit(({ mode: m, text }) => {
  mode = m;

  if (mode === 'drag') {
    ghostText.textContent = text.length > 60 ? text.slice(0, 60) + '...' : text;
    dragGhost.classList.add('visible');
    clickHint.classList.remove('visible');
    document.body.style.cursor = 'grabbing';
  } else if (mode === 'click') {
    dragGhost.classList.remove('visible');
    clickHint.classList.add('visible');
    document.body.style.cursor = 'crosshair';
  }
});

// ---- Mouse tracking ----
document.addEventListener('mousemove', (e) => {
  if (mode === 'drag') {
    // Position ghost offset from cursor so it's not under the mouse
    dragGhost.style.left = (e.clientX + 14) + 'px';
    dragGhost.style.top  = (e.clientY - 8)  + 'px';
  }
});

// Hide ghost when cursor leaves this monitor's window (it will appear
// in whichever other capture window the cursor enters next).
document.addEventListener('mouseleave', () => {
  if (mode === 'drag') dragGhost.classList.remove('visible');
});

document.addEventListener('mouseenter', () => {
  if (mode === 'drag') dragGhost.classList.add('visible');
});

// ---- Drop / Click target ----
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (mode !== 'drag' && mode !== 'click') return;

  // Main process reads getCursorScreenPoint() at this moment for accurate coords
  api.dropTarget();
  cleanup();
});

// ---- Escape to cancel ----
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    api.cancelCapture();
    cleanup();
  }
});

function cleanup() {
  dragGhost.classList.remove('visible');
  clickHint.classList.remove('visible');
  mode = null;
}
