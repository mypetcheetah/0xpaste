'use strict';

// ============================================================
// Dock geometry - single source of truth
// ============================================================
// Required by the main process (CommonJS) and loaded as a plain <script>
// by the overlay renderer, which then mirrors these numbers into CSS
// custom properties. Keeping one copy avoids the window bounds and the
// panel layout drifting apart.

(function (root, factory) {
  const geo = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = geo;
  } else {
    root.DOCK_GEO = geo;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    // Expanded panel
    PANEL_W: 320,
    PANEL_H: 450,

    // Transparent margin around the panel so the drop shadow has room to
    // fade out instead of being clipped by the window edge. The panel sits
    // flush against the screen edge, so its shadow is thrown to the right;
    // nothing is needed on the left, where it would be off-screen anyway.
    // Keep these >= the largest --panel-shadow extent of any theme
    // (currently 48 right, 34 vertical).
    // Window: PANEL_W + PAD_RIGHT wide, PANEL_H + 2*PAD_Y tall.
    PAD_RIGHT: 52,
    PAD_Y: 38,

    // Collapsed bar - the sliver that sticks out at the screen edge
    TAB_W: 8,
    TAB_H: 160,

    // Hover hotzone around the bar, so it does not need pixel-perfect aiming
    HOT_PAD_X: 12,
    HOT_PAD_Y: 18,

    // Hover intent: a quick sweep along the screen edge should not open it
    HOVER_INTENT: 90,

    // Slack around the expanded panel before the cursor counts as "left".
    // Deliberately small: the window is only SHADOW px wider than the panel, so
    // a large value would leave no room to move off it at all. Overshoot while
    // dragging a slider is covered by the held-button check, not by this.
    GRACE: 6,

    // Wait this long before collapsing, so a brief overshoot does not close it
    COLLAPSE_DELAY: 180,

    // How long the bar peeks open at startup to show where it lives
    PEEK_MS: 1600
  };
});
