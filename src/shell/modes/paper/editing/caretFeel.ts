// Caret-feel lab (caret-feel branch, EXPERIMENTAL): alternative caret motion
// models for the paper editor, behind Settings › Paper › "Caret feel".
//
//   classic      — the shipped behavior: CSS transition on .cm-cursor
//                  (left/top var(--flux-caret-ms, 70ms) ease-out, flux-theme.ts).
//                  This plugin draws nothing.
//   monkeytype   — a faithful port of monkeytype's recipe: an overlay caret
//                  driven by a fixed-duration (90ms) near-linear inOut(1.25)
//                  tween that RETARGETS from the caret's current mid-flight
//                  position on every move (never queues, never waits).
//   chase        — frame-rate-independent exponential pursuit
//                  (x += Δ·(1−exp(−dt/τ))): velocity-continuous, arrives fast
//                  and settles softly (the JetBrains-"Snappy" character). τ is
//                  regime-split: small same-line steps chase tighter than
//                  navigation-sized moves.
//   chase-trail  — chase, plus a kitty/Neovide-style smear: the leading edge
//                  runs a fast τ and the trailing edge a slow one, so the bar
//                  stretches into a brief ink-streak on axis-dominant moves.
//
// Shared polish (independent toggles, all modes incl. classic):
//   paperCaretSoftBlink   — replaces the steps(1) hard blink with a soft
//                           opacity pulse that starts after ~0.65s of caret
//                           rest and stops solid after 8 cycles (~9s — the
//                           VS Code finite-iteration trick, no JS timer).
//   paperSmoothLineScroll — when TYPING causes CodeMirror's scrollIntoView to
//                           jump the page by ≤ ~3 lines, replay that jump as a
//                           short exponential scroll instead of a teleport.
//
// Engineering constraints honored here (guide §4/§6/§9):
// - NO ambient animation loop: the single rAF ticker runs only while a caret
//   tween/chase or scroll replay is in flight and self-terminates on settle
//   (the E43 lesson — a continuous rAF loop deepens the compositor pipeline
//   and taxes editor INP by ~50ms).
// - The overlay mirrors the geometry CodeMirror's own cursor layer computed
//   (inline left/top/height on .cm-cursor-primary), parsed in the MEASURE
//   WRITE phase: measure reads all run before writes, so the layer's write —
//   queued earlier in the extension tree — has already refreshed the styles,
//   and style-attribute access forces no layout. Bidi/widget caret placement
//   therefore stays byte-identical to stock.
// - Smooth line scroll detects CM's typing scroll via a microtask queued from
//   the measure cycle: CM applies scrollTarget AFTER plugin measures but
//   inside the same rAF task, so the microtask sees the post-scroll state and
//   rewinds it BEFORE the frame paints (no one-frame flash).
// - Vim: in normal/visual mode (scrollDOM has .cm-vimMode) the fat cursor is
//   vim-layer-drawn and keeps stock behavior; the overlay only ever replaces
//   the thin insert-mode caret. Multi-cursor and unfocused editors fall back
//   to stock.
// - Motion is NEVER gated on prefers-reduced-motion (this desktop reports
//   `reduce` — guide §9).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { settings, type Settings } from "../../../../lib/settings";

// ---- tunables (the experiment surface — tweak these, not the machinery) ----
const MT_DUR_MS = 90; // monkeytype tween duration (their fast=85 / medium=100)
const MT_EASE_EXP = 1.25; // monkeytype's inOut(1.25) power ease
const TAU_TYPE_MS = 22; // chase τ for typing-sized steps
const TAU_NAV_MS = 40; // chase τ for larger in-page moves
const TAU_LEAD_TYPE_MS = 14; // chase-trail leading edge (typing)
const TAU_LEAD_NAV_MS = 26; // chase-trail leading edge (navigation)
const TAU_TRAIL_MS = 48; // chase-trail trailing edge
const TYPING_STEP_PX = 32; // ≤ this horizontally & same line ⇒ typing regime
const GATE_DY_LINES = 2.75; // vertical jumps beyond this many lines teleport
const GATE_DX_PX = 1200; // horizontal jumps beyond this teleport
const SETTLE_EPS = 0.35; // px — chase counts as arrived within this
const SMEAR_MIN_AXIS_PX = 3; // stretch only when the move is this axis-dominant
const SCROLL_TAU_MS = 34; // smooth line scroll τ (≈95% replayed in ~105ms)
const SCROLL_MAX_LINES = 3.2; // only replay typing scrolls up to this size
const SCROLL_ARM_MS = 140; // scroll must follow the keystroke within this
const BLINK_IDLE_MS = 650; // soft blink starts after this much caret rest
const CARET_W = 2; // overlay bar width (stock: 2px border-left)
const CARET_NUDGE = -0.6; // stock .cm-cursor margin-left — keep placement equal

const mtEase = (t: number): number =>
  t < 0.5 ? Math.pow(2 * t, MT_EASE_EXP) / 2 : 1 - Math.pow(2 * (1 - t), MT_EASE_EXP) / 2;

interface Pt {
  x: number;
  y: number;
}

class CaretFeelPlugin {
  private view: EditorView;
  private wrap: HTMLDivElement;
  private el: HTMLDivElement;
  private unsub: () => void;
  private cfg: Pick<Settings, "paperCaretFeel" | "paperCaretSoftBlink" | "paperSmoothLineScroll">;

  // caret animation state (document-relative px)
  private lead: Pt = { x: 0, y: 0 };
  private trail: Pt = { x: 0, y: 0 };
  private target: Pt & { h: number } = { x: 0, y: 0, h: 0 };
  private shown = false;
  private tween: { fx: number; fy: number; t0: number } | null = null;
  private tauLead = TAU_NAV_MS;
  private tauTrail = TAU_TRAIL_MS;

  // ticker (transient — see header)
  private raf = 0;
  private lastT = 0;

  // blink
  private blinkTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private hardAlt = false;

  // smooth line scroll
  private scrollTo: number | null = null;
  private preScroll = 0;
  private typedAt = 0;
  private userScrollAt = 0;
  private expectScroll: number | null = null;
  private scrollCheckQueued = false;

  private measureReq: { read: () => null; write: () => void; key: object };
  private readonly onScroll = () => {
    const st = this.view.scrollDOM.scrollTop;
    if (this.expectScroll != null && Math.abs(st - this.expectScroll) < 1) return; // our own write
    // Anything else (wheel, scrollbar drag, a CM scroll we didn't arm on)
    // cancels an in-flight replay — never fight the user or a fresh target.
    this.scrollTo = null;
    this.userScrollAt = performance.now();
  };
  private readonly onWheel = () => {
    this.scrollTo = null;
    this.userScrollAt = performance.now();
  };

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
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: true });
    this.measureReq = { read: () => null, write: () => this.syncFromLayer(), key: this };
    this.cfg = {
      paperCaretFeel: "classic",
      paperCaretSoftBlink: false,
      paperSmoothLineScroll: false,
    };
    this.unsub = settings.subscribe((s) => this.applyCfg(s));
  }

  private overlayMode(): boolean {
    return this.cfg.paperCaretFeel !== "classic";
  }

  private applyCfg(s: Settings) {
    const prev = this.cfg;
    this.cfg = {
      paperCaretFeel: s.paperCaretFeel,
      paperCaretSoftBlink: s.paperCaretSoftBlink,
      paperSmoothLineScroll: s.paperSmoothLineScroll,
    };
    // State classes live on scrollDOM, NOT view.dom: CM's updateAttrs rewrites
    // the editor root's class attribute every update and wipes foreign classes
    // (vim's cm-vimMode sits on scrollDOM for the same reason).
    this.view.scrollDOM.classList.toggle("cf-softblink", this.cfg.paperCaretSoftBlink);
    if (
      prev.paperCaretFeel !== this.cfg.paperCaretFeel ||
      prev.paperCaretSoftBlink !== this.cfg.paperCaretSoftBlink
    ) {
      this.shown = false; // force a clean teleport under the new mode
      this.applyBlinkStyle();
      this.view.requestMeasure(this.measureReq);
    }
  }

  update(u: ViewUpdate) {
    if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) {
      this.typedAt = performance.now();
      this.preScroll = this.view.scrollDOM.scrollTop; // update() runs pre-measure ⇒ pre-scroll
    }
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
    // Smooth line scroll: CM applies scrollTarget after this write but inside
    // the same rAF task — check from a microtask, still pre-paint.
    if (
      this.cfg.paperSmoothLineScroll &&
      !this.scrollCheckQueued &&
      performance.now() - this.typedAt < SCROLL_ARM_MS
    ) {
      this.scrollCheckQueued = true;
      queueMicrotask(() => {
        this.scrollCheckQueued = false;
        this.checkTypingScroll();
      });
    }

    if (!this.overlayMode()) {
      this.view.scrollDOM.classList.remove("cf-overlay-active");
      this.el.style.display = "none";
      this.shown = false;
      return;
    }
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
    const mode = this.cfg.paperCaretFeel;
    const lineH = Math.max(this.view.defaultLineHeight, h);
    const teleport =
      first ||
      this.view.composing || // IME owns the caret mid-composition
      Math.abs(dy) > GATE_DY_LINES * lineH ||
      Math.abs(dx) > GATE_DX_PX;
    if (teleport) {
      this.lead = { x: this.target.x, y: this.target.y };
      this.trail = { x: this.target.x, y: this.target.y };
      this.tween = null;
      this.shown = true;
      this.el.style.display = "";
      this.render(true);
      return;
    }
    const typing = Math.abs(dy) < h * 0.6 && Math.abs(dx) <= TYPING_STEP_PX;
    if (mode === "monkeytype") {
      this.tween = { fx: this.lead.x, fy: this.lead.y, t0: performance.now() };
      this.trail = this.lead;
    } else if (mode === "chase") {
      this.tauLead = typing ? TAU_TYPE_MS : TAU_NAV_MS;
      this.tauTrail = this.tauLead; // trail rides along (no smear)
    } else {
      this.tauLead = typing ? TAU_LEAD_TYPE_MS : TAU_LEAD_NAV_MS;
      this.tauTrail = TAU_TRAIL_MS;
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

    if (this.shown && this.overlayMode()) {
      if (this.tween) {
        const t = (now - this.tween.t0) / MT_DUR_MS;
        if (t >= 1) {
          this.lead = { x: this.target.x, y: this.target.y };
          this.tween = null;
        } else {
          const e = mtEase(t);
          this.lead = {
            x: this.tween.fx + (this.target.x - this.tween.fx) * e,
            y: this.tween.fy + (this.target.y - this.tween.fy) * e,
          };
          busy = true;
        }
        this.trail = this.lead;
      } else if (this.cfg.paperCaretFeel !== "monkeytype") {
        const kL = 1 - Math.exp(-dt / this.tauLead);
        const kT = 1 - Math.exp(-dt / this.tauTrail);
        this.lead.x += (this.target.x - this.lead.x) * kL;
        this.lead.y += (this.target.y - this.lead.y) * kL;
        this.trail.x += (this.target.x - this.trail.x) * kT;
        this.trail.y += (this.target.y - this.trail.y) * kT;
        const done =
          Math.abs(this.target.x - this.lead.x) < SETTLE_EPS &&
          Math.abs(this.target.y - this.lead.y) < SETTLE_EPS &&
          Math.abs(this.target.x - this.trail.x) < SETTLE_EPS &&
          Math.abs(this.target.y - this.trail.y) < SETTLE_EPS;
        if (done) {
          this.lead = { x: this.target.x, y: this.target.y };
          this.trail = { x: this.target.x, y: this.target.y };
        } else busy = true;
      }
      this.render(!busy);
    }

    if (this.scrollTo != null) {
      const sd = this.view.scrollDOM;
      const st = sd.scrollTop;
      const k = 1 - Math.exp(-dt / SCROLL_TAU_MS);
      const next = st + (this.scrollTo - st) * k;
      const arrived = Math.abs(this.scrollTo - next) < 0.5;
      const v = arrived ? this.scrollTo : next;
      this.expectScroll = v;
      sd.scrollTop = v;
      if (arrived) this.scrollTo = null;
      else busy = true;
    }

    // Self-terminating by design (E43): no in-flight work ⇒ no scheduled frame.
    this.raf = busy ? requestAnimationFrame(this.step) : 0;
  };

  private render(atRest: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    let x = this.lead.x;
    let y = this.lead.y;
    let w = CARET_W;
    let h = this.target.h;
    const dx = this.lead.x - this.trail.x;
    const dy = this.lead.y - this.trail.y;
    if (this.cfg.paperCaretFeel === "chase-trail" && !atRest) {
      // Smear only axis-dominant motion: horizontal glides stretch the bar,
      // vertical glides elongate it; diagonal (wrap/Enter) moves stay a bar.
      if (Math.abs(dx) >= SMEAR_MIN_AXIS_PX && Math.abs(dy) < 2) {
        x = Math.min(this.lead.x, this.trail.x);
        w = Math.abs(dx) + CARET_W;
      } else if (Math.abs(dy) >= SMEAR_MIN_AXIS_PX && Math.abs(dx) < 2) {
        y = Math.min(this.lead.y, this.trail.y);
        h = Math.abs(dy) + this.target.h;
      }
    }
    if (atRest) {
      x = snap(x);
      y = snap(y);
    }
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
  }

  // ---- smooth line scroll --------------------------------------------------
  private checkTypingScroll() {
    const sd = this.view.scrollDOM;
    const st = sd.scrollTop;
    const delta = st - this.preScroll;
    const max = SCROLL_MAX_LINES * this.view.defaultLineHeight;
    if (
      Math.abs(delta) < 0.5 ||
      Math.abs(delta) > max ||
      performance.now() - this.userScrollAt < 300 ||
      this.scrollTo != null
    ) {
      this.preScroll = st;
      return;
    }
    // Rewind CM's jump (pre-paint — we are still inside the frame's task
    // queue) and replay it as a short exponential scroll.
    this.expectScroll = this.preScroll;
    sd.scrollTop = this.preScroll;
    this.scrollTo = st;
    this.preScroll = st;
    this.ensureTicker();
  }

  // ---- blink ---------------------------------------------------------------
  private blinkTargets(): HTMLElement[] {
    if (this.overlayMode()) return [this.el];
    const out: HTMLElement[] = [];
    for (let c = this.view.scrollDOM.firstElementChild; c; c = c.nextElementSibling) {
      if ((c as HTMLElement).classList.contains("cm-cursorLayer")) out.push(c as HTMLElement);
    }
    return out;
  }

  private applyBlinkStyle() {
    // Overlay hard blink (softBlink off) replicates stock: steps(1) 1.2s,
    // phase-reset per caret event via the cm-blink/cm-blink2 name toggle.
    if (this.overlayMode() && !this.cfg.paperCaretSoftBlink) {
      this.el.style.animation = "cf-hard-blink 1.2s steps(1) infinite";
    } else {
      this.el.style.animation = "";
    }
    this.el.classList.remove("cf-blink");
  }

  private pokeBlink() {
    if (this.cfg.paperCaretSoftBlink) {
      for (const t of this.blinkTargets()) t.classList.remove("cf-blink");
      if (this.blinkTimer) clearTimeout(this.blinkTimer);
      this.blinkTimer = setTimeout(() => {
        this.blinkTimer = 0;
        for (const t of this.blinkTargets()) t.classList.add("cf-blink");
      }, BLINK_IDLE_MS);
    } else if (this.overlayMode()) {
      this.hardAlt = !this.hardAlt;
      this.el.style.animationName = this.hardAlt ? "cf-hard-blink2" : "cf-hard-blink";
    }
  }

  destroy() {
    this.unsub();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
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
  // State classes sit on .cm-scroller (scrollDOM) — see applyCfg.
  ".cm-scroller.cf-overlay-active .cm-cursorLayer:not(.cm-vimCursorLayer) .cm-cursor-primary": {
    opacity: "0",
  },
  // Soft blink: neutralize the stock steps(1) layer blink; the plugin's idle
  // timer applies .cf-blink, and the finite iteration count means blinking
  // stops solid on its own (~9s) with no JS involved.
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
  "@keyframes cf-hard-blink": {
    "0%": { opacity: "1" },
    "50%": { opacity: "0" },
    "100%": { opacity: "1" },
  },
  "@keyframes cf-hard-blink2": {
    "0%": { opacity: "1" },
    "50%": { opacity: "0" },
    "100%": { opacity: "1" },
  },
});

export function caretFeel(): Extension {
  return [caretFeelTheme, ViewPlugin.define((view) => new CaretFeelPlugin(view))];
}
