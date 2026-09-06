import type { Figure } from '../types';
import type { Rect } from '../geometry';
import type { Handle } from './handles';

/** Change the export boundary while pinning every element and guide in world
 * coordinates. Even hidden, locked and out-of-bounds content is retained. */
export function validateFrameBounds(box: Rect): void {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w < 1 || box.h < 1)
    throw new Error('Figure bounds must be finite with positive width and height.');
}
export function resizeFrame(figure: Figure, box: Rect): void {
  validateFrameBounds(box);
  const dx = figure.x - box.x, dy = figure.y - box.y;
  if (dx || dy) {
    for (const element of figure.elements) { element.x += dx; element.y += dy; }
    if (figure.guides) {
      if (figure.guides.x) figure.guides.x = figure.guides.x.map(x => x + dx);
      if (figure.guides.y) figure.guides.y = figure.guides.y.map(y => y + dy);
    }
  }
  figure.x = box.x;
  figure.y = box.y;
  figure.width = box.w;
  figure.height = box.h;
}

/** Screen-space hit areas stay outside the content boundary, so an object at
 * the edge wins over frame resizing. Corners get the same fixed 8px target. */
export function frameHandleRect(handle: Handle, box: Rect, size = 8): Rect {
  if (handle.length === 2) return {
    x: handle.includes('w') ? box.x - size : box.x + box.w,
    y: handle.includes('n') ? box.y - size : box.y + box.h, w: size, h: size,
  };
  if (handle === 'n' || handle === 's') return {
    x: box.x, y: handle === 'n' ? box.y - size : box.y + box.h, w: box.w, h: size,
  };
  return { x: handle === 'w' ? box.x - size : box.x + box.w, y: box.y, w: size, h: box.h };
}
