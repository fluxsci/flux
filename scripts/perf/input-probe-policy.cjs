'use strict';
const { assertUsableDisplay, assertFocusedWindow } = require('../lib/nativeWindowQualification.cjs');
/** Test-run policy only. Never changes Flux product window defaults. */
function configureWindow({ qualify, win, displays }) {
  if (!qualify) {
    win.webContents.setBackgroundThrottling(false);
    return { mode: 'diagnostic', productBackgroundThrottlingPreserved: false };
  }
  assertUsableDisplay(displays);
  return { mode: 'qualified', productBackgroundThrottlingPreserved: true };
}
module.exports = { configureWindow, assertWindow: assertFocusedWindow };
