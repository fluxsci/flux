'use strict';
const { qualifiedNativeBounds } = require('./nativeWindowQualification.cjs');
// These scenarios assert production UI/files/pixels, never timing or OS pointer placement.
const FUNCTIONAL = new Set(['semantics', 'field', 'paper', 'source']);
function nativeModelWindowPolicy(scenario, displays, primary) {
  const requested = { x: 10, y: 10, width: 1440, height: 1040 };
  try {
    return { qualification: 'native-display', requested, bounds: qualifiedNativeBounds(displays, primary, requested.width, requested.height) };
  } catch (error) {
    if (error.code !== 'NATIVE_DISPLAY_UNAVAILABLE' || !FUNCTIONAL.has(scenario)) throw error;
    return { qualification: 'functional-offscreen', requested, bounds: requested, limitation: 'Production Electron UI/state/file/pixel checks only; no OS pointer placement, visible desktop interaction or timing qualification.', displayFailure: error.message };
  }
}
module.exports = { nativeModelWindowPolicy };
