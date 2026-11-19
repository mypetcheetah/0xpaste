'use strict';

// ============================================================
// Typing speed - what each slider position really means
// ============================================================
// Loaded as a plain <script> by the overlay renderer and requirable from
// Node, so the arithmetic can be checked without any UI around it.
//
// The speed slider used to be "pause per character in milliseconds", which
// promised more than Windows delivered: every key event inside SendKeys costs
// one timer tick of about 15.6ms, and any pause was rounded up to that same
// tick. Out of 151 slider positions only eleven were really different, and
// the fastest one took about 41ms per character whatever the label said.
//
// The slider now walks through positions that are honestly different, fastest
// first, and the number next to it is the real time one character takes:
//
//   fast range    - the typing process asks Windows for a 1ms tick, so a key
//                   event costs about 2ms. Each stop is a time budget per
//                   character: no pause at all (about 5ms), then 6ms to 36ms.
//   classic range - exactly how every version up to 1.2.0 typed. Each stop is
//                   a whole number of 15.6ms ticks of pause per character,
//                   starting at none: the old turbo, about 41ms.
//
// Nothing changes for anyone who leaves the slider alone: an existing
// charDelay still means what it meant, and the fast range is only ever used
// when it has been picked.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TYPING_SPEED = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // What one key event costs inside SendKeys: one Windows timer tick.
  const TICK_CLASSIC_MS = 15.6;   // the default tick
  const TICK_FAST_MS    = 2.0;    // with the 1ms timer (4,000 characters measured at about 20s)
  const TICK_EXACT_MS   = 15.625;

  // Key events per character for command-line text: 2 for a plain key, 4 with
  // Shift, 6 to 8 for the quote characters. Counted on a real PowerShell
  // one-liner of 3,743 characters, which came to 9,926 events.
  const EVENTS_PER_CHAR = 2.65;

  // The fast range as time budgets per character. 0 is no pause at all. Below
  // 6ms the keys themselves take longer than the budget, so nothing is listed
  // there. The steps widen towards the slow end, where a single millisecond
  // no longer makes a difference anyone would notice.
  const FAST_BUDGETS_MS = [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 33, 36];

  const CLASSIC_STEP_MS = 15;    // rounds up to exactly one more tick per step
  const CLASSIC_STEPS   = 10;    // 150ms, the old slider's far end

  // Every slider position, fastest first
  const STOPS = FAST_BUDGETS_MS.map((ms) => ({ mode: 'fast', fastCharMs: ms }));
  for (let k = 0; k <= CLASSIC_STEPS; k++) {
    STOPS.push({ mode: 'classic', ticks: k, charDelay: k * CLASSIC_STEP_MS });
  }

  const OLD_TURBO_INDEX = STOPS.findIndex((s) => s.mode === 'classic');

  function clampIndex(index) {
    const n = parseInt(index, 10);
    if (isNaN(n)) return OLD_TURBO_INDEX;
    return Math.max(0, Math.min(STOPS.length - 1, n));
  }

  // The real time one character takes at a slider position, in milliseconds:
  // the keys themselves plus whatever pause the position adds.
  function msPerChar(index) {
    const stop = STOPS[clampIndex(index)];
    if (stop.mode === 'classic') return (EVENTS_PER_CHAR + stop.ticks) * TICK_CLASSIC_MS;
    return Math.max(stop.fastCharMs, EVENTS_PER_CHAR * TICK_FAST_MS);
  }

  // Stored settings -> slider position. Old configs only have charDelay, and
  // any value Windows used to round to the same tick lands on the same stop.
  function indexFromSettings(settings) {
    const fast = Number(settings && settings.fastCharMs);
    if (Number.isFinite(fast) && fast >= 0) {
      // The nearest stop - a hand-edited config may hold a value in between
      let best = 0;
      for (let i = 1; i < FAST_BUDGETS_MS.length; i++) {
        if (Math.abs(FAST_BUDGETS_MS[i] - fast) < Math.abs(FAST_BUDGETS_MS[best] - fast)) best = i;
      }
      return best;
    }
    const delay = Math.max(0, Number(settings && settings.charDelay) || 0);
    const ticks = Math.min(CLASSIC_STEPS, Math.ceil(delay / TICK_EXACT_MS));
    return OLD_TURBO_INDEX + ticks;
  }

  // Slider position -> the settings to store. Leaving the fast range always
  // switches it off explicitly, so the two can never both seem selected.
  function settingsFromIndex(index) {
    const stop = STOPS[clampIndex(index)];
    return stop.mode === 'fast'
      ? { fastCharMs: stop.fastCharMs }
      : { fastCharMs: -1, charDelay: stop.charDelay };
  }

  // The number next to the slider
  function label(index) {
    return Math.round(msPerChar(index)) + 'ms/char';
  }

  return {
    STOPS,
    OLD_TURBO_INDEX,
    clampIndex,
    msPerChar,
    indexFromSettings,
    settingsFromIndex,
    label
  };
});
