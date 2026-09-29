'use strict';
function unavailable(message) { const error = new Error(message); error.code = 'NATIVE_DISPLAY_UNAVAILABLE'; return error; }
function assertUsableDisplay(displays) {
  if (!displays.some(d => Number.isFinite(d.bounds.width) && Number.isFinite(d.bounds.height) && d.bounds.width > 0 && d.bounds.height > 0)) throw unavailable('Native qualification requires a usable nonzero display; no input timing cohort was started');
}
function assertFocusedWindow(win, observations) {
  if (!win.isVisible() || !win.isFocused() || !observations.length || observations.some(o => o.visible !== 'visible' || o.focused !== true)) throw unavailable('Input qualification lost its visible focused native window');
}
/** Check the actual rounded native-input point, including clipping/overlays. */
function assertNativePointerTarget(win, observation) {
  assertFocusedWindow(win, [observation]);
  const { point: p, rect: r, viewport: v } = observation;
  if (!p || !r || !v || ![p.x,p.y,r.left,r.top,r.right,r.bottom,v.width,v.height].every(Number.isFinite) ||
      r.right <= r.left || r.bottom <= r.top || p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom ||
      p.x < 0 || p.y < 0 || p.x >= v.width || p.y >= v.height || observation.matches !== true || observation.disabled === true) {
    const error = new Error('Native pointer target is clipped, covered, disabled, or outside the viewport');
    error.code = 'NATIVE_TARGET_UNAVAILABLE'; throw error;
  }
}
/** Qualified test windows fit the reported primary work area; never invent a display. */
function qualifiedNativeBounds(displays, primary, requestedWidth, requestedHeight) {
  assertUsableDisplay(displays);
  const area = primary?.workArea, bounds = primary?.bounds;
  const rectangle = r => r && ['x','y','width','height'].every(k=>Number.isFinite(r[k])) && r.width>0 && r.height>0;
  if (!rectangle(area) || !rectangle(bounds) || area.width<=20 || area.height<=20 || area.x<bounds.x || area.y<bounds.y || area.x+area.width>bounds.x+bounds.width || area.y+area.height>bounds.y+bounds.height) throw unavailable('Native qualification requires a positive primary work area contained in its display');
  if (![requestedWidth,requestedHeight].every(n=>Number.isFinite(n)&&n>=1)) throw new RangeError('Qualified native window dimensions must be finite and positive');
  const result={x:Math.ceil(area.x+10),y:Math.ceil(area.y+10),width:Math.floor(Math.min(requestedWidth,area.width-20)),height:Math.floor(Math.min(requestedHeight,area.height-20))};
  if(result.width<1||result.height<1)throw unavailable('Primary work area cannot contain a positive qualified window');
  return result;
}
module.exports = { assertUsableDisplay, assertFocusedWindow, assertNativePointerTarget, qualifiedNativeBounds };
