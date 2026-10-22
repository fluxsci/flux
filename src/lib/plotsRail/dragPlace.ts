// Drag-to-place from the Plots rail onto the canvas (a pointer drag, not HTML5 drag-and-drop —
// whose OS drag image can neither resize nor follow the canvas zoom).
//
// Past a 4 px threshold a ghost follows the pointer: the tile's thumbnail over the rail, and
// over the canvas the plot at its TRUE PLACED SIZE at the current zoom (placed px from the header
// probe × zoom) — you see exactly how big it lands. The frame under the pointer lights (the OS
// file drop's highlight). Release over a frame places the plot so the point you grabbed lands
// under the pointer; release elsewhere is the OS drop's "Drop onto a figure" note; Esc cancels.
// The canvas host box is read once at drag start — no layout read per move.

import type { HitBridgeHolder } from "../interact/canvasHitBridge";
import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotationVisibility";
import type { Figure } from "../types";

export const DRAG_THRESHOLD = 4;

export interface DragSource {
  /** Files to place, in order (the dragged tile first). */
  paths: string[];
  /** The dragged tile's thumbnail (may be ""). */
  thumbUrl: string;
  /** The dragged tile's on-screen box (the grab point is relative to it). */
  tileRect: DOMRect;
  /** The first plot's placed size in CSS px (96/in), when known. */
  placed: { w: number; h: number } | null;
  /** Backdrop colour for the ghost page. */
  backdrop: string | null;
}

export interface DragCallbacks {
  /** A drop on a frame: the figure, the figure-local point, and the grab fractions. */
  onDrop(fig: Figure, at: { x: number; y: number; fx: number; fy: number }, paths: string[]): void;
  /** Released over the canvas outside every frame. */
  onMiss(): void;
  /** The drag began (past the threshold) — the click that follows must not count. */
  onStart?(): void;
  onEnd?(): void;
}

/** Call from a tile's pointerdown. Returns nothing; the drag owns the pointer until release. */
export function beginPlotDrag(e: PointerEvent, source: () => DragSource | null, bridge: HitBridgeHolder | null, cb: DragCallbacks): void {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const node = e.currentTarget as HTMLElement;
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  const sx = e.clientX, sy = e.clientY, pointer = e.pointerId;
  let src: DragSource | null = null;
  let ghost: HTMLDivElement | null = null;
  let host: DOMRect | null = null;
  let fx = 0.5, fy = 0.5;
  let lit: string | null = null;
  let started = false;
  let raf = 0;
  let last = { x: sx, y: sy };

  const light = (id: string | null) => { if (id !== lit) { lit = id; bridge?.get()?.setDropHighlight(id); } };

  function start() {
    src = source();
    if (!src) return false;
    started = true;
    cb.onStart?.();
    host = bridge?.get()?.hostRect() ?? null;
    const r = src.tileRect;
    fx = r.width ? Math.min(1, Math.max(0, (sx - r.left) / r.width)) : 0.5;
    fy = r.height ? Math.min(1, Math.max(0, (sy - r.top) / r.height)) : 0.5;
    ghost = doc.createElement("div");
    ghost.className = "plots-rail-ghost";
    ghost.setAttribute("data-plots-rail-ghost", "");
    Object.assign(ghost.style, {
      position: "fixed", left: "0", top: "0", zIndex: "400", pointerEvents: "none",
      backgroundColor: src.backdrop ?? "transparent", opacity: "0.85",
      boxShadow: "0 0 0 1px var(--c-accent), var(--elev-2)", backgroundRepeat: "no-repeat",
      backgroundSize: "100% 100%", backgroundImage: src.thumbUrl ? `url("${src.thumbUrl}")` : "none",
      willChange: "transform",
    } as Partial<CSSStyleDeclaration>);
    if (src.paths.length > 1) {
      const badge = doc.createElement("span");
      badge.textContent = String(src.paths.length);
      Object.assign(badge.style, { position: "absolute", right: "-8px", top: "-8px", minWidth: "18px", height: "18px", padding: "0 4px", borderRadius: "9px", background: "var(--c-accent)", color: "var(--c-on-accent)", font: "600 11px/18px var(--font-mono)", textAlign: "center" } as Partial<CSSStyleDeclaration>);
      ghost.appendChild(badge);
    }
    doc.body.appendChild(ghost);
    doc.body.style.userSelect = "none";
    // Route the drag's moves to the tile, not the canvas beneath the pointer (no hover churn).
    try { node.setPointerCapture(pointer); } catch { /* synthetic pointer */ }
    return true;
  }

  function overCanvas(x: number, y: number) {
    return !!host && x >= host.left && x <= host.right && y >= host.top && y <= host.bottom;
  }

  function paint() {
    raf = 0;
    if (!ghost || !src) return;
    const { x, y } = last;
    const hits = bridge?.get();
    let w = src.tileRect.width, h = src.tileRect.height;
    if (hits && host && overCanvas(x, y)) {
      if (src.placed) { const z = hits.zoom(); w = src.placed.w * z; h = src.placed.h * z; }
      light(hits.figureAt(x, y, host)?.id ?? null);
    } else light(null);
    ghost.style.width = `${Math.max(8, w)}px`;
    ghost.style.height = `${Math.max(8, h)}px`;
    ghost.style.transform = `translate(${x - fx * w}px, ${y - fy * h}px)`;
  }

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    last = { x: ev.clientX, y: ev.clientY };
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      if (!start()) { finish(); return; }
    }
    if (!raf) raf = win.requestAnimationFrame(paint);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    if (started && src) {
      const hits = bridge?.get();
      if (hits && host && overCanvas(ev.clientX, ev.clientY)) {
        const fig = hits.figureAt(ev.clientX, ev.clientY, host);
        if (fig) cb.onDrop(fig, { ...hits.toFigure(fig, ev.clientX, ev.clientY, host), fx, fy }, src.paths);
        else cb.onMiss();
      }
    }
    finish();
  };
  const key = (ev: KeyboardEvent) => {
    if (yieldsToShellModal(ev) || isAnnotateChord(ev)) return;
    if (ev.key === "Escape" && started) { ev.preventDefault(); ev.stopImmediatePropagation(); finish(); }
  };
  function finish() {
    win.removeEventListener("pointermove", move, true);
    win.removeEventListener("pointerup", up, true);
    win.removeEventListener("pointercancel", cancel, true);
    win.removeEventListener("keydown", key, true);
    win.removeEventListener("blur", cancel);
    if (raf) win.cancelAnimationFrame(raf);
    light(null);
    ghost?.remove();
    ghost = null;
    try { if (node.hasPointerCapture?.(pointer)) node.releasePointerCapture(pointer); } catch { /* gone */ }
    if (started) { doc.body.style.userSelect = ""; cb.onEnd?.(); }
  }
  const cancel = () => finish();
  win.addEventListener("pointermove", move, true);
  win.addEventListener("pointerup", up, true);
  win.addEventListener("pointercancel", cancel, true);
  win.addEventListener("keydown", key, true);
  win.addEventListener("blur", cancel);
}
