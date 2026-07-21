// The paper caret: an overlay caret with animated motion + a soft idle blink.
// Shipped 2026-07 from the caret-feel lab (owner A/B decision); supersedes the
// old .cm-cursor CSS-transition glide (--flux-caret-ms, removed with it).
//
// Two motion models, Settings › Paper › "Caret motion":
//   chase (default) — frame-rate-independent exponential pursuit
//                     (x += Δ·(1−exp(−dt/τ))): velocity-continuous, arrives
//                     fast and settles softly. τ is regime-split: small
//                     same-line steps chase tighter than navigation moves.
//   smooth          — monkeytype's recipe: a fixed-duration (90ms) near-linear
//                     inOut(1.25) tween that RETARGETS from the caret's
//                     current mid-flight position on every move (never
//                     queues, never waits).
//
// Soft blink is built-in (no setting): the caret is solid while typing/moving,
// pulses gently only after ~0.65s of rest, and the finite iteration count
// stops it solid after 8 cycles (~9s) with no JS timer. The stock steps(1)
// layer blink is neutralized; fallback carets (vim fat cursor, multi-cursor)
// share the soft pulse via the same layer class.
//
// Engineering constraints honored here (guide §4/§6/§9):
// - NO ambient animation loop: the single rAF ticker runs only while a caret
//   tween/chase is in flight and self-terminates on settle (the E43 lesson —
//   a continuous rAF loop deepens the compositor pipeline and taxes editor
//   INP by ~50ms). Measured in real Electron: this overlay undercuts the old
//   left/top CSS transition by ~16ms keystroke-INP p95 (scripts/perf/
//   caret-feel-inp.mjs).
// - The overlay mirrors the geometry CodeMirror's own cursor layer computed
//   (inline left/top/height on .cm-cursor-primary), parsed in the MEASURE
//   WRITE phase: measure reads all run before writes, so the layer's write —
//   queued earlier in the extension tree — has already refreshed the styles,
//   and style-attribute access forces no layout. Bidi/widget caret placement
//   therefore stays byte-identical to stock.
// - State classes live on scrollDOM, never view.dom (CM's updateAttrs
//   rewrites the editor root's class attribute every update — vim's
//   cm-vimMode precedent).
// - Vim: in normal/visual mode (scrollDOM has .cm-vimMode) the fat cursor is
//   vim-layer-drawn and keeps stock behavior; the overlay only ever replaces
//   the thin insert-mode caret. Multi-cursor and unfocused editors fall back
//   to stock.
// - Large jumps (cross-page clicks, Ctrl+Home) TELEPORT instead of gliding,
//   and IME composition teleports (the IME owns the caret mid-composition).
// - Motion is NEVER gated on prefers-reduced-motion (this desktop reports
//   `reduce` — guide §9).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { settings, type Settings } from "../../../../lib/settings";

// ---- tunables --------------------------------------------------------------
const SMOOTH_DUR_MS = 90; // "smooth" tween duration (monkeytype fast=85 / medium=100)
const SMOOTH_EASE_EXP = 1.25; // monkeytype's inOut(1.25) power ease
const TAU_TYPE_MS = 22; // chase τ for typing-sized steps
const TAU_NAV_MS = 40; // chase τ for larger in-page moves
const TYPING_STEP_PX = 32; // ≤ this horizontally & same line ⇒ typing regime
const GATE_DY_LINES = 2.75; // vertical jumps beyond this many lines teleport
const GATE_DX_PX = 1200; // horizontal jumps beyond this teleport
const SETTLE_EPS = 0.35; // px — chase counts as arrived within this
const BLINK_IDLE_MS = 650; // soft blink starts after this much caret rest
const CARET_W = 2; // overlay bar width (stock: 2px border-left)
const CARET_NUDGE = -0.6; // stock .cm-cursor margin-left — keep placement equal

const smoothEase = (t: number): number =>
  t < 0.5 ? Math.pow(2 * t, SMOOTH_EASE_EXP) / 2 : 1 - Math.pow(2 * (1 - t), SMOOTH_EASE_EXP) / 2;

interface Pt {
  x: number;
  y: number;
}

class CaretFeelPlugin {
  private view: EditorView;
  private wrap: HTMLDivElement;
  private el: HTMLDivElement;
  private unsub: () => void;
  private mode: Settings["paperCaretFeel"] = "chase";

  // caret animation state (document-relative px)
  private cur: Pt = { x: 0, y: 0 };
  private target: Pt & { h: number } = { x: 0, y: 0, h: 0 };
  private shown = false;
  private tween: { fx: number; fy: number; t0: number } | null = null;
  private tau = TAU_NAV_MS;

  // ticker (transient — see header)
  private raf = 0;
  private lastT = 0;

  // blink
  private blinkTimer: ReturnType<typeof setTimeout> | 0 = 0;

  private measureReq: { read: () => null; write: () => void; key: object };

  constructor(view: EditorView) {
    this.view = view;
    this.wrap = document.createElement("div");
    this.wrap.className = "flux-caret-glide-layer";
    this.wrap.setAttribute("aria-hidden", "true");
    this.el = document.createElement("div");
    this.el.className = "flux-caret-glide";
    this.el.style.display = "none";
    this.wrap.appendChild(this.el);
    view.scrollDOM.appendChild(this.wrap);
    // Soft blink is unconditional — the class neutralizes the stock steps(1)
    // blink on every cursor layer (incl. vim's) in favor of the idle pulse.
    view.scrollDOM.classList.add("cf-softblink");
    this.measureReq = { read: () => null, write: () => this.syncFromLayer(), key: this };
    this.unsub = settings.subscribe((s) => {
      if (s.paperCaretFeel !== this.mode) {
        this.mode = s.paperCaretFeel;
        this.tween = null;
        this.view.requestMeasure(this.measureReq);
      }
    });
  }

  update(u: ViewUpdate) {
    const caretEvent = u.docChanged || u.transactions.some((tr) => tr.selection);
    if (caretEvent) this.pokeBlink();
    if (caretEvent || u.geometryChanged || u.viewportChanged || u.focusChanged) {
      this.view.requestMeasure(this.measureReq);
    }
  }

  // Layers redraw on doc-view updates that never pass through update() (async
  // layout, widget height settles) — mirror LayerView and re-sync then too.
  docViewUpdate() {
    this.view.requestMeasure(this.measureReq);
  }

  // ---- overlay sync (measure WRITE phase — see header for why) -------------
  private stockCursorNode(): HTMLElement | null {
    const sd = this.view.scrollDOM;
    if (sd.classList.contains("cm-vimMode")) return null; // fat cursor: stock behavior
    for (let c = sd.firstElementChild; c; c = c.nextElementSibling) {
      const cl = (c as HTMLElement).classList;
      if (cl.contains("cm-cursorLayer") && !cl.contains("cm-vimCursorLayer")) {
        const cursors = c.querySelectorAll(".cm-cursor");
        if (cursors.length !== 1) return null; // multi-cursor: stock behavior
        const prim = c.querySelector(".cm-cursor-primary");
        return prim instanceof HTMLElement ? prim : null;
      }
    }
    return null;
  }

  private syncFromLayer() {
    const node = this.view.hasFocus ? this.stockCursorNode() : null;
    const ok = node != null;
    this.view.scrollDOM.classList.toggle("cf-overlay-active", ok);
    if (!node) {
      this.el.style.display = "none";
      this.shown = false;
      return;
    }
    const x = parseFloat(node.style.left) + CARET_NUDGE;
    const y = parseFloat(node.style.top);
    const h = parseFloat(node.style.height);
    if (!isFinite(x) || !isFinite(y) || !isFinite(h)) return;
    const first = !this.shown;
    const dx = x - this.target.x;
    const dy = y - this.target.y;
    this.target = { x, y, h };
    this.el.style.height = `${h}px`;
    if (first || dx !== 0 || dy !== 0) this.retarget(first, dx, dy, h);
  }

  private retarget(first: boolean, dx: number, dy: number, h: number) {
    const lineH = Math.max(this.view.defaultLineHeight, h);
    const teleport =
      first ||
      this.view.composing || // IME owns the caret mid-composition
      Math.abs(dy) > GATE_DY_LINES * lineH ||
      Math.abs(dx) > GATE_DX_PX;
    if (teleport) {
      this.cur = { x: this.target.x, y: this.target.y };
      this.tween = null;
      this.shown = true;
      this.el.style.display = "";
      this.render(true);
      return;
    }
    if (this.mode === "smooth") {
      this.tween = { fx: this.cur.x, fy: this.cur.y, t0: performance.now() };
    } else {
      const typing = Math.abs(dy) < h * 0.6 && Math.abs(dx) <= TYPING_STEP_PX;
      this.tau = typing ? TAU_TYPE_MS : TAU_NAV_MS;
    }
    this.ensureTicker();
  }

  // ---- the transient ticker ------------------------------------------------
  private ensureTicker() {
    if (this.raf) return;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.step);
  }

  private readonly step = (now: number) => {
    const dt = Math.min(50, Math.max(0.1, now - this.lastT));
    this.lastT = now;
    let busy = false;

    if (this.shown) {
      if (this.tween) {
        const t = (now - this.tween.t0) / SMOOTH_DUR_MS;
        if (t >= 1) {
          this.cur = { x: this.target.x, y: this.target.y };
          this.tween = null;
        } else {
          const e = smoothEase(t);
          this.cur = {
            x: this.tween.fx + (this.target.x - this.tween.fx) * e,
            y: this.tween.fy + (this.target.y - this.tween.fy) * e,
          };
          busy = true;
        }
      } else {
        const k = 1 - Math.exp(-dt / this.tau);
        this.cur.x += (this.target.x - this.cur.x) * k;
        this.cur.y += (this.target.y - this.cur.y) * k;
        const done =
          Math.abs(this.target.x - this.cur.x) < SETTLE_EPS &&
          Math.abs(this.target.y - this.cur.y) < SETTLE_EPS;
        if (done) this.cur = { x: this.target.x, y: this.target.y };
        else busy = true;
      }
      this.render(!busy);
    }

    // Self-terminating by design (E43): no in-flight work ⇒ no scheduled frame.
    this.raf = busy ? requestAnimationFrame(this.step) : 0;
  };

  private render(atRest: boolean) {
    let x = this.cur.x;
    let y = this.cur.y;
    if (atRest) {
      // Snap to whole device pixels at rest: crisp bar, no resting blur (the
      // slide composite-glide doctrine — sub-pixel only while in motion).
      const dpr = window.devicePixelRatio || 1;
      x = Math.round(x * dpr) / dpr;
      y = Math.round(y * dpr) / dpr;
    }
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // ---- blink ---------------------------------------------------------------
  private blinkTargets(): HTMLElement[] {
    const out: HTMLElement[] = [this.el];
    for (let c = this.view.scrollDOM.firstElementChild; c; c = c.nextElementSibling) {
      if ((c as HTMLElement).classList.contains("cm-cursorLayer")) out.push(c as HTMLElement);
    }
    return out;
  }

  private pokeBlink() {
    for (const t of this.blinkTargets()) t.classList.remove("cf-blink");
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.blinkTimer = setTimeout(() => {
      this.blinkTimer = 0;
      for (const t of this.blinkTargets()) t.classList.add("cf-blink");
    }, BLINK_IDLE_MS);
  }

  destroy() {
    this.unsub();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.wrap.remove();
    this.view.scrollDOM.classList.remove("cf-overlay-active", "cf-softblink");
  }
}

const caretFeelTheme = EditorView.theme({
  ".flux-caret-glide-layer": {
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "150",
    pointerEvents: "none",
  },
  ".flux-caret-glide": {
    position: "absolute",
    top: "0",
    left: "0",
    width: "2px",
    borderRadius: "1.5px",
    background: "var(--c-accent)",
    willChange: "transform",
  },
  // Overlay active: the stock thin caret hides (geometry keeps updating — we
  // mirror it); vim's fat cursor is in its own layer and stays untouched.
  // State classes sit on .cm-scroller (scrollDOM) — see the header.
  ".cm-scroller.cf-overlay-active .cm-cursorLayer:not(.cm-vimCursorLayer) .cm-cursor-primary": {
    opacity: "0",
  },
  // Soft blink (built-in): neutralize the stock steps(1) layer blink; the
  // plugin's idle timer applies .cf-blink, and the finite iteration count
  // means blinking stops solid on its own (~9s) with no JS involved.
  ".cm-scroller.cf-softblink .cm-cursorLayer": { animation: "none !important" },
  ".cm-scroller.cf-softblink .cm-cursorLayer.cf-blink": {
    animation: "cf-soft-blink 1.15s ease-in-out 8 !important",
  },
  ".flux-caret-glide.cf-blink": { animation: "cf-soft-blink 1.15s ease-in-out 8" },
  "@keyframes cf-soft-blink": {
    "0%": { opacity: "1" },
    "50%": { opacity: "0.08" },
    "100%": { opacity: "1" },
  },
});

export function caretFeel(): Extension {
  return [caretFeelTheme, ViewPlugin.define((view) => new CaretFeelPlugin(view))];
}
