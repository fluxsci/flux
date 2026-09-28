'use strict';
function unavailable(message) { const error = new Error(message); error.code = 'NATIVE_DISPLAY_UNAVAILABLE'; return error; }
function assertUsableDisplay(displays) {
  if (!displays.some(d => Number.isFinite(d.bounds.width) && Number.isFinite(d.bounds.height) && d.bounds.width > 0 && d.bounds.height > 0)) throw unavailable('Native qualification requires a usable nonzero display; no input timing cohort was started');
}
function assertFocusedWindow(win, observations) {
  if (!win.isVisible() || !win.isFocused() || !observations.length || observations.some(o => o.visible !== 'visible' || o.focused !== true)) throw unavailable('Input qualification lost its visible focused native window');
}
module.exports = { assertUsableDisplay, assertFocusedWindow };
