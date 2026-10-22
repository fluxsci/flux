// Finite, hardware-cursor-only feedback. No pointer position rendering, model
// writes, capture ownership or inherited custom-property animation. The canvas
// host's existing .el firewall bounds style work during capture. After release
// only the hit LEAF may carry the return frames, never a plot subtree.
import { settings } from "../settings";
import { cursorParamsFromSettings } from "./cursorTheme";
import { CURSOR_PRESS_DEFAULTS, drawArrowPress, type CursorParams } from "./cursorFamily";
const STEPS = 16;
type Frames = { normal: string[]; copy: string[]; images: HTMLImageElement[] };
let cachedKey = "";
let cachedFrames: Frames | null = null;

function prepareFrames(params: Partial<CursorParams>, depth: number): Frames {
  const key = JSON.stringify([params, depth]);
  if (cachedFrames && key === cachedKey) return cachedFrames;
  const frames: Frames = { normal: [], copy: [], images: [] };
  for (const copy of [false, true]) for (let i = 0; i <= STEPS; i++) {
    const drawing = drawArrowPress(params, i / STEPS, depth, copy);
    (copy ? frames.copy : frames.normal).push(drawing.css);
    // Warm Chromium's image cache off the input path. Keep images alive along
    // with the frame table; movement still belongs entirely to the OS.
    const img = new Image();
    img.src = `data:image/svg+xml,${drawing.svg}`;
    void img.decode().catch(() => {});
    frames.images.push(img);
  }
  cachedKey = key;
  return cachedFrames = frames;
}

const isArrow = (cursor: string) => cursor.includes("data:image/svg+xml") && / 3 3, (default|copy)$/.test(cursor);
const canAnimate = (cursor: string) => /--cursor-(cross|move)/.test(cursor) || isArrow(cursor);
type Styled = HTMLElement | SVGElement;

/** Svelte action; `base` stays the gesture's authoritative cursor. Also used by
 * the Settings trial pad, so the preview has exactly the canvas's timing. */
export function cursorPress(host: HTMLElement, base: string) {
  const win = host.ownerDocument.defaultView!;
  const doc = host.ownerDocument;
  let enabled = false;
  let frames: Frames | null = null;
  let returnMs: number = CURSOR_PRESS_DEFAULTS.returnMs;
  let configKey = "";
  let raf = 0;
  let pointer: number | null = null;
  let released = false;
  let phase: "down" | "held" | "up" = "held";
  let amount = 0;
  let started = 0;
  let from = 0;
  let x = 0, y = 0;
  let hostOwned = false;
  let leaf: { node: Styled; value: string; priority: string; written: string } | null = null;

  function clearLeaf() {
    if (!leaf) return;
    // Don't erase an intervening owner (e.g. an inline text editor).
    if (leaf.node.style.cursor === leaf.written) {
      if (leaf.value) leaf.node.style.setProperty("cursor", leaf.value, leaf.priority);
      else leaf.node.style.removeProperty("cursor");
    }
    leaf = null;
  }
  function reset() {
    win.cancelAnimationFrame(raf);
    raf = 0;
    pointer = null;
    amount = 0;
    clearLeaf();
    if (hostOwned) host.style.setProperty("cursor", base);
    hostOwned = false;
  }
  function adoptLeaf(target: EventTarget | null) {
    clearLeaf();
    if (!(target instanceof Element) || target === host || !host.contains(target) ||
        target.childElementCount || !("style" in target) || !isArrow(win.getComputedStyle(target).cursor)) return;
    const node = target as Styled;
    leaf = { node, value: node.style.cursor, priority: node.style.getPropertyPriority("cursor"), written: "" };
  }
  function paint() {
    if (!frames) return;
    const copy = base.includes("move-copy");
    const cursor = (copy ? frames.copy : frames.normal)[Math.round(amount * STEPS)];
    if (host.style.cursor !== cursor || !hostOwned) host.style.setProperty("cursor", cursor, "important");
    hostOwned = true;
    if (leaf) {
      leaf.node.style.setProperty("cursor", cursor, "important");
      leaf.written = leaf.node.style.cursor;
    }
  }
  function startReturn(now: number) {
    phase = "up";
    from = amount;
    started = now;
  }
  function step(now: number) {
    raf = 0;
    if (pointer === null || !host.isConnected) { reset(); return; }
    const duration = phase === "down" ? returnMs * 0.45 : returnMs;
    const t = Math.min(1, (now - started) / duration);
    // Fast initial travel with a firm stop; release is a quiet, critically
    // damped-looking return, with no bounce or overshoot at the aiming tip.
    const ease = 1 - (1 - t) ** 3;
    amount = phase === "down" ? from + (1 - from) * ease : from * (1 - ease);
    paint();
    if (t === 1) {
      if (phase === "up") { reset(); return; }
      phase = "held";
      if (!released) return; // zero callbacks while holding, as well as at rest
      startReturn(now);
    }
    raf = win.requestAnimationFrame(step);
  }
  function down(e: PointerEvent) {
    if (!enabled || e.button !== 0 || !e.isPrimary || e.pointerType === "touch" || !canAnimate(base)) return;
    if (!(e.target instanceof Element) || !isArrow(win.getComputedStyle(e.target).cursor)) return;
    reset();
    pointer = e.pointerId;
    released = false;
    x = e.clientX; y = e.clientY;
    phase = "down";
    started = win.performance.now();
    from = amount = 0.18; // acknowledgment in this input turn, before the first rAF
    adoptLeaf(e.target);
    paint();
    raf = win.requestAnimationFrame(step);
  }
  function up(e: PointerEvent) {
    if (pointer !== e.pointerId || e.button !== 0) return;
    released = true;
    x = e.clientX; y = e.clientY;
    // Capture ends with this event. Hand only the visual return to its actual
    // hit leaf; never prolong capture or delay the editor's release/commit.
    adoptLeaf(doc.elementFromPoint(x, y));
    paint();
    if (phase === "held") {
      startReturn(win.performance.now());
      raf = win.requestAnimationFrame(step);
    }
  }
  function move(e: PointerEvent) {
    if (pointer !== e.pointerId) return;
    if ((released && (e.clientX !== x || e.clientY !== y)) || (!released && !(e.buttons & 1))) reset();
    else if (host.hasPointerCapture(e.pointerId)) clearLeaf();
  }
  function lost(e: PointerEvent) {
    if (pointer === e.pointerId && !released) reset();
  }
  function key(e: KeyboardEvent) { if (e.key === "Escape") reset(); }
  function visibility() { if (doc.hidden) reset(); }
  const unsubscribe = settings.subscribe((s) => {
    const params = cursorParamsFromSettings(s);
    const nextKey = JSON.stringify([params, s.cursorPressEnabled, s.cursorPressDepth, s.cursorPressReturnMs]);
    if (nextKey === configKey) return;
    reset();
    configKey = nextKey;
    enabled = s.cursorStyle === "classic" && s.cursorPressEnabled;
    returnMs = s.cursorPressReturnMs;
    frames = enabled ? prepareFrames(params, s.cursorPressDepth) : null;
  });
  const controller = new AbortController();
  const options = { capture: true, passive: true, signal: controller.signal };
  host.addEventListener("pointerdown", down, options);
  host.addEventListener("lostpointercapture", lost, options);
  win.addEventListener("pointerup", up, options);
  win.addEventListener("pointermove", move, options);
  win.addEventListener("pointercancel", reset, options);
  win.addEventListener("blur", reset, options);
  win.addEventListener("pagehide", reset, options);
  win.addEventListener("contextmenu", reset, options);
  win.addEventListener("keydown", key, options);
  doc.addEventListener("visibilitychange", visibility, options);
  return {
    update(nextBase: string) {
      base = nextBase;
      if (!canAnimate(base)) reset();
      // Svelte's style:cursor directive may write after action.update in the
      // same flush (notably when a click becomes a move). Reassert the held
      // image after that flush, still before paint, without a resting rAF.
      else if (pointer !== null) queueMicrotask(() => { if (pointer !== null) paint(); });
    },
    destroy() { reset(); unsubscribe(); controller.abort(); },
  };
}
