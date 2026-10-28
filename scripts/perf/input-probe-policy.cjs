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
// The proxy carries the rendered camera while the live SVG is frozen. This
// pure projection is stringified into the renderer-side diagnostic reader.
function renderedCamera({ proxy, matrix, baked }) {
  const values = value => Array.isArray(value) ? value : String(value).split(' ').map(Number);
  if (proxy) {
    const box = values(proxy.worldBox), size = values(proxy.rasterSize), m = proxy.matrix;
    if (box.length !== 4 || size.length !== 2 || ![...box,...size,m.a,m.e,m.f].every(Number.isFinite) || !(box[2]>0&&box[3]>0&&size[0]>0&&size[1]>0&&m.a>0)) throw Error('Invalid rendered proxy camera');
    const zoom=m.a*size[0]/box[2];
    return {zoom,panX:m.e-zoom*box[0],panY:m.f-zoom*box[1],proxy:true};
  }
  if (![matrix.a,matrix.e,matrix.f,baked].every(Number.isFinite)||!(matrix.a>0&&baked>0)) throw Error('Invalid rendered live camera');
  return {zoom:matrix.a*baked,panX:matrix.e,panY:matrix.f,proxy:false};
}
function deepZoomNotches(zoom) {
  if (!Number.isFinite(zoom)||!(zoom>0)) throw RangeError('Invalid deep zoom start');
  return Math.max(1,Math.ceil(Math.log(16/zoom)/.18));
}
// Default diagnostic stress remains the original 8ms injection. A qualified
// portable fixture may explicitly use the display's 60Hz (16ms) cadence so
// Chromium's notch-wheel dispatch queue does not dominate end-to-end timing.
function wheelBurstCadence({ fixture = false, value = '8' } = {}) {
  const cadence = Number(value);
  if (cadence === 8 || fixture && cadence === 16) return cadence;
  throw RangeError('Wheel burst cadence must be 8ms, or explicit 16ms for the dense fixture');
}
function deepZoomDelivered(phase) {
  const cycles=phase.deepZoom?.cycles;
  if (phase.deepZoom?.target!==16||!Array.isArray(cycles)||cycles.length!==3) return false;
  let delivered=0;
  for (const row of cycles) {
    if (!Number.isFinite(row.afterIn?.zoom)||row.afterIn.zoom<16||row.afterIn.zoom>16*Math.exp(.18)+1e-4||row.out?.sent!==36||!row.inBatches?.length) return false;
    for (const batch of [...row.inBatches,row.out]) {
      if (!batch.complete||!Number.isInteger(batch.delivered)||batch.delivered<1||!Number.isInteger(batch.sent)||batch.sent<1||(!phase.preciseWheel&&batch.delivered!==batch.sent)) return false;
      delivered+=batch.delivered;
    }
  }
  return phase.wheels===delivered;
}
module.exports = { configureWindow, assertWindow: assertFocusedWindow, renderedCamera, deepZoomNotches, deepZoomDelivered, wheelBurstCadence };
