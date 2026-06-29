import type { Element, TextElement } from "./types";

// Shared offscreen canvas for fast text measurement.
let ctx: CanvasRenderingContext2D | null = null;
function context(): CanvasRenderingContext2D {
  if (!ctx) {
    const c = document.createElement("canvas");
    ctx = c.getContext("2d")!;
  }
  return ctx;
}

export function measureText(e: TextElement): { width: number; height: number } {
  const c = context();
  c.font = `${e.fontStyle} ${e.fontWeight} ${e.fontSize}px ${e.fontFamily}`;
  const lines = (e.text || " ").split("\n");
  let w = 0;
  for (const ln of lines) w = Math.max(w, c.measureText(ln || " ").width);
  const lineH = e.fontSize * 1.2;
  return { width: Math.ceil(w) + 2, height: Math.ceil(lines.length * lineH) };
}

// If the element is an auto-width text box, resize it to hug its content.
export function applyAutoWidth(el: Element) {
  if (el.type !== "text" || !el.autoWidth) return;
  const m = measureText(el);
  el.width = m.width;
  el.height = m.height;
}
