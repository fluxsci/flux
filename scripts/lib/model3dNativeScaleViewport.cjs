'use strict';
/** Plan a native pan without changing the fixture or its scale. A smaller real
 * canvas may first need the ordinary toolbar Zoom out action. */
function nativeScaleCentering({ clip, boxes }, margin = 12) {
  const rect = r => r && ['x', 'y', 'right', 'bottom'].every(k => Number.isFinite(r[k])) && r.right > r.x && r.bottom > r.y;
  if (!rect(clip) || !Array.isArray(boxes) || !boxes.length || boxes.some(r => !rect(r))) throw Error('Native model framing needs finite positive canvas and model bounds');
  if (!Number.isFinite(margin) || margin < 0) throw Error('Invalid native framing margin');
  const union = { x: Math.min(...boxes.map(r => r.x)), y: Math.min(...boxes.map(r => r.y)), right: Math.max(...boxes.map(r => r.right)), bottom: Math.max(...boxes.map(r => r.bottom)) };
  const width = union.right - union.x, height = union.bottom - union.y;
  const availableWidth = clip.right - clip.x - margin * 2, availableHeight = clip.bottom - clip.y - margin * 2;
  if (availableWidth <= 0 || availableHeight <= 0) throw Error('Native canvas has no room for the fixture');
  return { union, fits: width <= availableWidth && height <= availableHeight,
    dx: (clip.x + clip.right - union.x - union.right) / 2,
    dy: (clip.y + clip.bottom - union.y - union.bottom) / 2 };
}
module.exports = { nativeScaleCentering };
