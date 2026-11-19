// The Flux AI mark's life: points fire, the signal travels down links as a glow with a warm
// trail, colour passes from point to point, and the mark reports what agents are doing.
// fluxAiMark.ts says what the mark IS; this file is only what makes it move.
//
// THE PERFORMANCE CONTRACT (owner, 2026-11-19: "be absolutely CERTAIN that the performance of
// flux itself is not at all affected"). Gated by scripts/verify-flux-ai-mark-gui.mjs:
//   1. No frame loop. Nothing here runs per frame: no requestAnimationFrame, no interval at
//      rest. Every moving thing is a WAAPI animation of `transform` / `opacity` on an HTML
//      element, which the compositor runs without the main thread.
//   2. Script runs only at the instant a point fires, and only in the browser's IDLE time
//      (requestIdleCallback, no timeout): when the main thread is busy with typing, a drag or
//      a render, the mark simply fires later. It can never be in front of the user's work.
//   3. Bounded work per firing: one flash, one lingering tint, and at most a glow and a trail
//      per link (pooled elements: nothing is created or destroyed while it runs). A cap on
//      signals in flight and on firings a second, so a burst can never pile up.
//   4. HANDS OFF while the user's hands are busy. While a key was pressed, a button or the wheel
//      was used in the last QUIET_MS, or a pointer is held down (a drag, a pan), the engine
//      starts NOTHING: no firing, no signal, no report. And what is in flight is SETTLED: all
//      of the engine's layers live in one box (`.fam-live`), which fades out in 140 ms and is
//      then emptied of animations, because a fading layer costs a little in EVERY frame the app
//      renders while it exists, script or no script (measured in the real app, typing with the
//      mark at its busiest: +0.4 ms a key from firing, and still +0.8 ms from the glows already
//      in flight after firing was stopped). Its turn and its drifting fronts are PAUSED too
//      (`.held`): compositor animations are not free either where compositing is done on the
//      CPU (measured on a software-rendered display: +0.9 ms a key for the plain turn). So
//      while the user works, the mark is a still picture, on any machine; it comes back to
//      life a third of a second after their hands stop. A report that arrives meanwhile (a
//      claim, a finish, something sent) waits for the pause.
//   5. Nothing when it cannot be seen: off screen, in a hidden window, or unmounted, there is
//      no timer at all. Its box is `contain: strict`, so nothing in it can touch layout or
//      paint outside it.
//   6. At most MAX_ENGINES marks fire at once; any further live mark only turns (and holds
//      still with the rest).
import {
  FLUX_AI_ADJACENT, FLUX_AI_AGENT_COLOURS, FLUX_AI_FEEL as F, FLUX_AI_MEAN_LINK, FLUX_AI_NODES, FLUX_AI_PALETTE, FLUX_AI_TONE_RATE,
  FLUX_AI_TONE_SPIN, fluxAiAgentLook, fluxAiConic, fluxAiControl, fluxAiCss, fluxAiHex, fluxAiMix, fluxAiSample, type FluxAiSignal as FluxAiMarkSignal, type FluxAiTone, type Rgb,
} from "./fluxAiMark";

export interface FluxAiMarkState {
  tone: FluxAiTone;
  /** The agents at work, by name: each holds one point, lit in its own colour. */
  agents?: readonly string[];
  /** An agent is waiting for the user: the gold heartbeat. */
  waiting?: boolean;
  /** What kind of work is happening, when it is known: it sets the rhythm. */
  activity?: "thinking" | "writing" | "tool" | null;
}
export interface FluxAiMarkController {
  set(state: FluxAiMarkState): void;
  signal(kind: FluxAiMarkSignal): void;
  destroy(): void;
  /** False when this mark is over the limit of live marks and stays on its CSS-only life. */
  readonly alive: boolean;
}

const MAX_ENGINES = 3, MAX_IN_FLIGHT = 14, MAX_FIRES_A_SECOND = 12, QUIET_MS = 350, REPORT_WAITS_MS = 8000;
const WHITE: Rgb = [255, 255, 255];
const N = FLUX_AI_NODES.length;
const engines = new Set<Engine>();
const whenIdle: (run: () => void) => void = typeof requestIdleCallback === "function" ? (run) => { requestIdleCallback(() => run()); } : (run) => { setTimeout(run, 0); };
// The user's hands: the time of the last key, button or wheel, and whether a pointer is down.
// One passive capture listener per event per window (a number written per input, nothing else).
let lastInput = -Infinity, pointersDown = 0;
const watched = new WeakSet<Window>();
function watchHands(win: Window | null): void {
  if (!win || watched.has(win)) return;
  watched.add(win);
  // `was` is read BEFORE the press is counted: a press must not see itself as "already busy".
  const touched = (pointers = 0) => { const was = handsBusy(); pointersDown = Math.max(0, pointersDown + pointers); lastInput = performance.now(); if (!was) for (const engine of engines) engine.hold(); };
  for (const type of ["keydown", "wheel"]) win.addEventListener(type, () => touched(), { capture: true, passive: true });
  win.addEventListener("pointerdown", () => touched(1), { capture: true, passive: true });
  for (const type of ["pointerup", "pointercancel"]) win.addEventListener(type, () => touched(-1), { capture: true, passive: true });
  win.addEventListener("blur", () => { pointersDown = 0; }, { passive: true });
}
const handsBusy = (): boolean => pointersDown > 0 || performance.now() - lastInput < QUIET_MS;

/** What a gate reads and sets to hold the contract: three counters, and a switch that keeps
 *  every mark on its CSS-only life (the "without it" side of a with/without measurement). */
export const fluxAiMarkStats = { fires: 0, idleRuns: 0, engines: 0, disabled: false };
/** The marks that are alive now (for gates: to put one into a state and watch it). */
export const fluxAiMarkEngines = (): FluxAiMarkController[] => [...engines];

const INERT: FluxAiMarkController = { set() {}, signal() {}, destroy() {}, alive: false };

/** Bring a mark's root (`.flux-ai-mark` with its `.fam-net`) to life. Returns an inert
 *  controller for a still mark or outside a browser. Beyond the limit of firing marks the mark
 *  is attached `quiet`: it only turns, and holds still with the others. */
export function attachFluxAiMark(root: HTMLElement, size: number, state: FluxAiMarkState, agent?: string): FluxAiMarkController {
  const net = root.querySelector<HTMLElement>(".fam-net");
  if (!net || typeof net.animate !== "function" || root.classList.contains("still")) return INERT;
  const firing = [...engines].filter((e) => !e.quiet).length;
  return new Engine(root, net, size, state, agent, firing >= MAX_ENGINES || fluxAiMarkStats.disabled);
}

class Engine implements FluxAiMarkController {
  alive = true;
  private tone: FluxAiTone;
  private home: Rgb[] = [];
  private agents: string[] = [];
  private waiting = false;
  private activity: FluxAiMarkState["activity"] = null;
  private readonly k: number;
  private readonly mem: HTMLElement[] = [];
  private readonly flash: HTMLElement[] = [];
  private readonly presence = new Map<number, { el: HTMLElement; anim: Animation; colour: string }>();
  private readonly pool: Record<"glow" | "trail", HTMLElement[]> = { glow: [], trail: [] };
  private readonly fade: HTMLElement | null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly refractory = new Array<number>(N).fill(0);
  private tick: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  private budget = MAX_FIRES_A_SECOND;
  private budgetAt = 0;
  private kick = 0;
  private kickAt = 0;
  private relax: ReturnType<typeof setTimeout> | undefined;
  private spin: Animation | null | undefined;
  private visible = true;
  private observer: IntersectionObserver | null = null;
  private lastPoke = 0;
  /** Everything the engine draws: one box, so it can be faded and emptied as one. */
  private readonly live: HTMLElement;
  private held = false;

  constructor(private readonly root: HTMLElement, private readonly net: HTMLElement, private readonly size: number, state: FluxAiMarkState, private readonly agent: string | undefined, readonly quiet: boolean) {
    this.k = size / 32;
    this.tone = state.tone;
    this.fade = net.querySelector<HTMLElement>(".fam-fade");
    const doc = root.ownerDocument;
    const at = (cls: string, i: number) => { const el = doc.createElement("i"); el.className = cls; el.style.left = `${(FLUX_AI_NODES[i].x / 32) * 100}%`; el.style.top = `${(FLUX_AI_NODES[i].y / 32) * 100}%`; return el; };
    for (let i = 0; i < N; i++) { this.mem.push(at("fam-mem", i)); this.flash.push(at("fam-flash", i)); }
    this.live = doc.createElement("i"); this.live.className = "fam-live";
    this.live.append(...this.mem, ...this.flash);
    net.append(this.live);
    this.colours();
    engines.add(this); fluxAiMarkStats.engines = engines.size;
    // Its own window and the app's: a pinned Inbox lives in a second window on the same thread.
    watchHands(doc.defaultView); if (typeof window !== "undefined") watchHands(window);
    root.addEventListener("pointermove", this.poke, { passive: true });
    doc.addEventListener("visibilitychange", this.wake);
    if (typeof IntersectionObserver === "function") { this.observer = new IntersectionObserver((entries) => { this.visible = entries[entries.length - 1].isIntersecting; this.wake(); }); this.observer.observe(root); }
    this.apply(state, true);
    this.wake();
    if (handsBusy()) this.hold(); // born while the user is busy (a chord opened its surface): start held
  }

  // ---- state ---------------------------------------------------------------------------------
  set(state: FluxAiMarkState): void { if (this.alive) this.apply(state, false); }
  private apply(state: FluxAiMarkState, first: boolean): void {
    const tone = state.tone, agents = [...(state.agents ?? [])].slice(0, FLUX_AI_AGENT_COLOURS.length), waiting = !!state.waiting;
    const toneChanged = tone !== this.tone, arrived = agents.filter((name) => !this.agents.includes(name));
    if (toneChanged) {
      // The old colours fade out over the new ones: you see the change arrive, not a swap.
      if (!first && this.fade) { this.fade.style.background = fluxAiConic(this.palette().palette, this.palette().from); this.fade.animate([{ opacity: F.rest }, { opacity: 0 }], { duration: 900, easing: "ease-out" }); }
      this.tone = tone; this.colours(); this.pace();
    }
    this.activity = state.activity ?? null;
    if (agents.join("\n") !== this.agents.join("\n")) { this.agents = agents; this.pin(); }
    if (!first && this.firing()) {
      // An agent claimed something: a wave from ITS point, in its colour, crosses the network.
      for (const name of arrived) { const held = [...this.presence].find(([, p]) => p.colour === FLUX_AI_AGENT_COLOURS[this.agents.indexOf(name)]); if (held) this.later(() => this.sweep(held[0], (i) => fluxAiMix(fluxAiHex(held[1].colour), this.bright(i, 0.3), 0.45)), 0, true); }
      if (toneChanged && tone === "done") this.later(() => this.lap(), 0, true);
      if (toneChanged && tone === "error") this.later(() => this.flicker(), 0, true);
    }
    if (waiting !== this.waiting) { this.waiting = waiting; this.heartbeat(); }
    if (toneChanged || first) this.schedule();
  }
  signal(kind: FluxAiMarkSignal): void {
    if (!this.firing()) return;
    if (kind === "sent") this.later(() => this.sweep(this.rim(), (i) => fluxAiMix(this.home[i], WHITE, 0.6), Math.max(60, F.hop * 0.6), false), 0, true);
    else if (!handsBusy()) { const from = Math.floor(Math.random() * N), next = FLUX_AI_ADJACENT[from]; const to = next[Math.floor(Math.random() * next.length)]; this.flashAt(from, this.bright(from), 0.8); this.travel(from, to, this.bright(from), F.hop * 0.7); }
  }
  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.tick); clearTimeout(this.beat); clearTimeout(this.relax);
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.root.removeEventListener("pointermove", this.poke);
    this.root.ownerDocument.removeEventListener("visibilitychange", this.wake);
    this.observer?.disconnect();
    for (const a of this.live.getAnimations({ subtree: true })) a.cancel();
    this.live.remove();
    this.root.classList.remove("held");
    try { this.spin?.updatePlaybackRate(1); } catch { /* the animation went with its element */ }
    engines.delete(this); fluxAiMarkStats.engines = engines.size;
  }

  // ---- colour --------------------------------------------------------------------------------
  private palette(): { palette: readonly string[]; from: number } { const own = this.agent && this.tone === "ready" ? fluxAiAgentLook(this.agent) : null; return { palette: own?.palette ?? FLUX_AI_PALETTE[this.tone], from: own?.from ?? 200 }; }
  private colours(): void { const { palette, from } = this.palette(); this.home = FLUX_AI_NODES.map((node) => fluxAiSample(palette, node, from)); }
  private bright(i: number, by = 0.1): Rgb { return fluxAiMix(this.home[i], WHITE, by); }
  private colourAt(i: number): Rgb { const held = this.presence.get(i); return held ? fluxAiMix(fluxAiHex(held.colour), WHITE, 0.2) : this.bright(i); }
  private paint(el: HTMLElement, c: Rgb): void { el.style.setProperty("--c", fluxAiCss(c)); el.style.setProperty("--h", fluxAiCss(fluxAiMix(c, WHITE, F.heat))); }

  // ---- hands off -------------------------------------------------------------------------------
  /** The user's hands just became busy (called from the input listener: it only sets a flag and
   *  asks for idle time). Fade everything the engine drew, as ONE layer, then empty it. */
  hold(): void {
    if (this.held || !this.alive) return;
    this.held = true;
    this.schedule(); // from now on, look for the hands to stop (and drop the firing that was due)
    whenIdle(() => {
      if (!this.alive || !this.held) return;
      this.root.classList.add("held"); // the turn and the drifting fronts stop where they are
      const out = this.live.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-out", fill: "forwards" });
      const id = setTimeout(() => {
        this.timers.delete(id);
        if (!this.alive || !this.held) { out.cancel(); return; }
        for (const a of this.live.getAnimations({ subtree: true })) if (a !== out) { if ((a.effect?.getComputedTiming().iterations ?? 1) === Infinity) a.pause(); else a.cancel(); }
        this.live.style.opacity = "0"; out.cancel();
      }, 150);
      this.timers.add(id);
    });
  }
  /** The hands are idle again: what the mark holds (an agent's point) comes back; firing resumes. */
  private release(): void {
    if (!this.held) return;
    this.held = false;
    this.root.classList.remove("held");
    this.live.style.opacity = "";
    for (const { anim } of this.presence.values()) anim.play();
    this.live.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }

  // ---- when it may run -----------------------------------------------------------------------
  private running(): boolean { return this.alive && this.visible && !this.root.ownerDocument.hidden; }
  /** May it fire and report? (A quiet mark only turns.) */
  private firing(): boolean { return !this.quiet && this.running(); }
  private readonly wake = (): void => {
    if (this.running()) { this.schedule(); this.heartbeat(); }
    else { clearTimeout(this.tick); this.tick = undefined; clearTimeout(this.beat); this.beat = undefined; }
  };
  /** Run `work` after `ms`, in idle time, if the mark may still run then. While the user's
   *  hands are busy, ordinary work (a signal arriving at the next point) is dropped; a `report`
   *  (something the mark has to tell) waits for the pause instead, for a few seconds at most. */
  private later(work: () => void, ms: number, report = false, waited = 0): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.running()) return;
      if (handsBusy()) { if (report && waited < REPORT_WAITS_MS) this.later(work, 160, true, waited + 160); return; }
      whenIdle(() => { if (this.running() && !handsBusy()) { this.release(); fluxAiMarkStats.idleRuns++; work(); } });
    }, ms);
    this.timers.add(id);
  }
  private allowed(): boolean {
    const now = performance.now();
    this.budget = Math.min(MAX_FIRES_A_SECOND, this.budget + ((now - this.budgetAt) / 1000) * MAX_FIRES_A_SECOND); this.budgetAt = now;
    if (this.budget < 1) return false;
    this.budget -= 1;
    return true;
  }

  // ---- spontaneous activity ------------------------------------------------------------------
  private rate(): number {
    const rhythm = this.activity === "thinking" ? 0.45 : this.activity === "writing" ? 1.9 : 1;
    return F.rate * FLUX_AI_TONE_RATE[this.tone] * rhythm * (this.agent ? 0.6 : 1);
  }
  private schedule(): void {
    clearTimeout(this.tick); this.tick = undefined;
    if (!this.running()) return;
    const rate = this.quiet ? 0 : this.rate();
    if (rate <= 0.02 && !this.held) return; // nothing to fire and nothing to come back from: no timer at all
    // Held: look again four times a second, so it comes back promptly when the hands stop
    // (each look is one comparison). Otherwise: the next spontaneous firing, at random.
    const wait = this.held ? 250 : rate > 0.02 ? Math.min(6000, (-Math.log(1 - Math.random()) / rate) * 1000) : QUIET_MS;
    this.tick = setTimeout(() => {
      this.tick = undefined;
      if (!this.running()) return;
      if (handsBusy()) return this.schedule(); // not now: ask again later, and do nothing meanwhile
      whenIdle(() => { if (!this.running()) return; if (!handsBusy()) { this.release(); fluxAiMarkStats.idleRuns++; if (rate > 0.02) this.spontaneous(); } this.schedule(); });
    }, wait);
  }
  private anyPoint(): number {
    const held = [...this.presence.keys()];
    return held.length && Math.random() < 0.6 ? held[Math.floor(Math.random() * held.length)] : Math.floor(Math.random() * N);
  }
  private spontaneous(): void {
    const i = this.anyPoint();
    // Failed is red and QUIET: a lone, dim flash now and then, no flurry, nothing passed on.
    if (this.tone === "error") { if (this.allowed()) this.flashAt(i, this.colourAt(i), 0.5); return; }
    this.fire(i, this.colourAt(i), 1);
    if (Math.random() < F.burst) for (let n = 1, more = 2 + Math.floor(Math.random() * 3); n <= more; n++) this.later(() => { const j = this.anyPoint(); this.fire(j, this.colourAt(j), 0.9); }, n * (70 + Math.random() * 90));
  }
  /** A point fires: it flashes, and may pass the signal (and some of its colour) down each link.
   *  Writing is many small firings: it spreads less. */
  private fire(i: number, c: Rgb, energy: number, from = -1): void {
    const now = performance.now();
    if (now < this.refractory[i] || !this.allowed()) return;
    this.refractory[i] = now + Math.max(240, F.decay * 0.75);
    this.flashAt(i, c, energy);
    if (energy < 0.24) return;
    const spread = this.activity === "writing" ? F.spread * 0.5 : F.spread;
    for (const j of FLUX_AI_ADJACENT[i]) {
      if (j === from || Math.random() > spread) continue;
      const ms = F.hop * (0.55 + (0.9 * Math.hypot(FLUX_AI_NODES[i].x - FLUX_AI_NODES[j].x, FLUX_AI_NODES[i].y - FLUX_AI_NODES[j].y)) / FLUX_AI_MEAN_LINK);
      this.travel(i, j, c, ms);
      const carried = fluxAiMix(this.home[j], c, F.influence);
      this.later(() => this.fire(j, carried, energy * 0.74, i), ms);
    }
  }
  private flashAt(i: number, c: Rgb, energy: number, linger = true): void {
    fluxAiMarkStats.fires++;
    const flash = this.flash[i];
    this.paint(flash, c);
    flash.animate([{ opacity: 0, transform: "translate(-50%,-50%) scale(.25)" }, { opacity: Math.min(1, 0.5 + 0.5 * energy), transform: "translate(-50%,-50%) scale(.72)", offset: 0.14 }, { opacity: 0, transform: "translate(-50%,-50%) scale(1.2)" }], { duration: F.decay, easing: "cubic-bezier(.2,.7,.3,1)" });
    if (linger) { const mem = this.mem[i]; mem.style.setProperty("--c", fluxAiCss(c)); mem.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: F.memory * 1000, easing: "cubic-bezier(.3,0,.7,1)" }); }
    this.nudge();
  }
  /** The signal on its way down a link: a soft glow that leads, and the link warm behind it. */
  private travel(a: number, b: number, c: Rgb, ms: number): void {
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    const k = this.k, p = FLUX_AI_NODES[a], q = FLUX_AI_NODES[b], ctl = fluxAiControl(a, b), px = (v: number) => `${v.toFixed(2)}px`;
    const at = (t: number) => ({ x: ((1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * ctl.x + t * t * q.x) * k, y: ((1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * ctl.y + t * t * q.y) * k });
    const heading = (t: number) => (Math.atan2((1 - t) * (ctl.y - p.y) + t * (q.y - ctl.y), (1 - t) * (ctl.x - p.x) + t * (q.x - ctl.x)) * 180) / Math.PI;
    const on = (t: number, shape: string) => { const o = at(t); return `translate(${px(o.x)}, ${px(o.y)}) rotate(${heading(t).toFixed(1)}deg) ${shape}`; };
    const length = Math.hypot(q.x - p.x, q.y - p.y), d = Math.max(3, F.glowWidth * this.size), strength = F.glowStrength;
    this.send("glow", c, { width: px(d), height: px(d), margin: `${px(-d / 2)} 0 0 ${px(-d / 2)}` }, [
      { transform: on(0, "scale(.7, .7)"), opacity: 0 }, { transform: on(0.22, `scale(${F.glowLength}, 1)`), opacity: strength, offset: 0.22 },
      { transform: on(0.78, `scale(${F.glowLength}, 1)`), opacity: strength, offset: 0.78 }, { transform: on(1, "scale(.9, .9)"), opacity: 0.15 }], ms);
    // The link itself, between the two points' edges: a bar grown from the firing end, then cooled.
    const direction = Math.atan2(q.y - p.y, q.x - p.x), inset0 = Math.max(0, p.r * F.node - 0.5) * k, inset1 = Math.max(0, q.r * F.node - 0.5) * k;
    const height = length * F.curve * k + F.line * k * 2.6 + 1, span = Math.max(1, length * k - inset0 - inset1), total = ms + F.warm;
    const base = `translate(${px(p.x * k + Math.cos(direction) * inset0)}, ${px(p.y * k + Math.sin(direction) * inset0)}) rotate(${((direction * 180) / Math.PI).toFixed(1)}deg)`;
    this.send("trail", c, { width: px(span), height: px(height), margin: `${px(-height / 2)} 0 0 0` }, [
      { transform: `${base} scaleX(.02)`, opacity: 0.8 * strength }, { transform: `${base} scaleX(1)`, opacity: 0.8 * strength, offset: ms / total }, { transform: `${base} scaleX(1)`, opacity: 0 }], total);
  }
  /** One travelling element from the pool: styled, animated, and handed back when it lands. */
  private send(kind: "glow" | "trail", c: Rgb, box: { width: string; height: string; margin: string }, frames: Keyframe[], ms: number): void {
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    let el = this.pool[kind].pop();
    if (!el) { el = this.root.ownerDocument.createElement("i"); el.className = `fam-pulse ${kind}`; this.live.append(el); }
    this.paint(el, c);
    el.style.width = box.width; el.style.height = box.height; el.style.margin = box.margin;
    this.inFlight++;
    const done = el;
    const flight = el.animate(frames, { duration: ms, easing: "linear" }), land = () => { this.inFlight = Math.max(0, this.inFlight - 1); if (this.alive) this.pool[kind].push(done); };
    flight.onfinish = land; flight.oncancel = land;
  }

  // ---- what it reports -----------------------------------------------------------------------
  /** A wave that reaches every point, in order of distance from where it started. */
  private sweep(origin: number, colourOf: (i: number) => Rgb, hop: number = F.hop, linger = true): void {
    const steps = new Array<number>(N).fill(-1), queue = [origin];
    steps[origin] = 0;
    while (queue.length) { const u = queue.shift()!; for (const v of FLUX_AI_ADJACENT[u]) if (steps[v] < 0) { steps[v] = steps[u] + 1; queue.push(v); this.later(() => this.travel(u, v, colourOf(v), hop), steps[u] * hop); } }
    steps.forEach((n, i) => this.later(() => { this.flashAt(i, colourOf(i), 1, linger); this.refractory[i] = performance.now() + 300; }, Math.max(0, n) * hop));
  }
  /** Finished: one green lap round the network. */
  private lap(): void {
    const c = fluxAiMix(fluxAiHex("#d9f58a"), WHITE, 0.25);
    [...FLUX_AI_NODES.keys()].sort((a, b) => Math.atan2(FLUX_AI_NODES[a].y - 16, FLUX_AI_NODES[a].x - 16) - Math.atan2(FLUX_AI_NODES[b].y - 16, FLUX_AI_NODES[b].x - 16))
      .forEach((i, n) => this.later(() => this.flashAt(i, c, 1), n * 65));
  }
  /** Failed: three short flickers, then quiet. */
  private flicker(): void {
    const c = fluxAiMix(fluxAiHex("#ff9b8a"), WHITE, 0.3);
    for (let n = 0; n < 3; n++) this.later(() => { for (let i = 0; i < N; i++) this.flashAt(i, c, 0.9, false); }, n * 190);
  }
  /** Waiting for the user: two quick pulses and a rest. The only regular rhythm the mark has. */
  private heartbeat(): void {
    clearTimeout(this.beat); this.beat = undefined;
    if (!this.waiting || !this.firing()) return;
    const c = fluxAiMix(fluxAiHex("#ffe58a"), WHITE, 0.3), hub = this.hub();
    if (!handsBusy()) { this.later(() => this.sweep(hub, () => c, 70), 0); this.later(() => this.sweep(hub, () => c, 70), 260); } // a beat missed while you type is simply missed
    this.beat = setTimeout(() => this.heartbeat(), 1650);
  }
  /** One point per working agent, spread out, each lit in its agent's colour and breathing. */
  private pin(): void {
    const chosen: number[] = [];
    for (let n = 0; n < this.agents.length; n++) {
      let best = 0, score = -Infinity;
      for (let i = 0; i < N; i++) {
        if (chosen.includes(i)) continue;
        const s = chosen.length ? Math.min(...chosen.map((j) => Math.hypot(FLUX_AI_NODES[i].x - FLUX_AI_NODES[j].x, FLUX_AI_NODES[i].y - FLUX_AI_NODES[j].y))) : FLUX_AI_ADJACENT[i].length * 3 - Math.hypot(FLUX_AI_NODES[i].x - 16, FLUX_AI_NODES[i].y - 16);
        if (s > score) { score = s; best = i; }
      }
      chosen.push(best);
    }
    for (const [i, held] of this.presence) if (!chosen.includes(i) || held.colour !== FLUX_AI_AGENT_COLOURS[chosen.indexOf(i)]) { held.anim.cancel(); held.el.remove(); this.presence.delete(i); }
    chosen.forEach((i, n) => {
      if (this.presence.has(i)) return;
      const el = this.root.ownerDocument.createElement("i"), colour = FLUX_AI_AGENT_COLOURS[n];
      el.className = "fam-pres"; el.style.left = `${(FLUX_AI_NODES[i].x / 32) * 100}%`; el.style.top = `${(FLUX_AI_NODES[i].y / 32) * 100}%`; el.style.setProperty("--c", colour);
      this.live.insertBefore(el, this.flash[0]);
      const anim = el.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 900 + n * 170, direction: "alternate", iterations: Infinity, easing: "ease-in-out" });
      if (this.held) anim.pause();
      this.presence.set(i, { el, colour, anim });
    });
  }
  private rim(): number { let best = 0, far = -1; FLUX_AI_NODES.forEach((node, i) => { const r = Math.hypot(node.x - 16, node.y - 16); if (r > far) { far = r; best = i; } }); return best; }
  private hub(): number { let best = 0, near = Infinity; FLUX_AI_NODES.forEach((node, i) => { const r = Math.hypot(node.x - 16, node.y - 16) - FLUX_AI_ADJACENT[i].length * 0.6; if (r < near) { near = r; best = i; } }); return best; }

  // ---- the turn follows the activity -----------------------------------------------------------
  private turning(): Animation | null {
    if (this.spin === undefined) this.spin = this.net.getAnimations().find((a) => (a as CSSAnimation).animationName === "flux-ai-turn") ?? null;
    return this.spin;
  }
  private pace(): void { try { this.turning()?.updatePlaybackRate(FLUX_AI_TONE_SPIN[this.tone] * (1 + this.kick)); } catch { /* not started yet */ } }
  /** Each firing nudges the turn; it coasts back. Arithmetic at firing time: no timer per frame. */
  private nudge(): void {
    if (F.kick <= 0) return;
    const now = performance.now();
    this.kick = Math.min(2.5, this.kick * Math.pow(0.82, (now - this.kickAt) / 180) + F.kick * 0.45);
    const due = now - this.kickAt > 400;
    if (due) { this.kickAt = now; this.pace(); }
    clearTimeout(this.relax);
    this.relax = setTimeout(() => { this.kick = 0; this.kickAt = performance.now(); if (this.running()) whenIdle(() => this.pace()); }, 1500);
  }
  /** The pointer on the mark: the nearest point fires. Only while the pointer is on it. */
  private readonly poke = (e: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastPoke < 110 || !this.firing() || handsBusy()) return;
    this.lastPoke = now;
    const box = this.root.getBoundingClientRect(), spin = this.turning();
    const timing = spin?.effect?.getComputedTiming(), turn = (((timing?.progress ?? 0) * 360 + (this.agent ? fluxAiAgentLook(this.agent).from : 0)) * Math.PI) / 180;
    const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height / 2), unit = box.width / 32;
    const x = 16 + (dx * Math.cos(-turn) - dy * Math.sin(-turn)) / unit, y = 16 + (dx * Math.sin(-turn) + dy * Math.cos(-turn)) / unit;
    let best = 0, near = Infinity;
    FLUX_AI_NODES.forEach((node, i) => { const d = Math.hypot(node.x - x, node.y - y); if (d < near) { near = d; best = i; } });
    if (near < 9) this.fire(best, this.colourAt(best), 1);
  };
}
