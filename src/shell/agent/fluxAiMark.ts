// The Flux AI mark: a small living network. Ten points of the Flux bloom (the logo's own golden-
// angle spiral) tied along BOTH of its spiral families, so the two sets of arms weave into a
// closed mesh: every point sits on a loop and nothing dangles. It sits top-left of every agent
// surface (Ask, Annotate, Inbox), marks every agent in a thread, and is the icon of every
// "send this to Flux AI" control.
//
// Owner, 2026-11-18/19, over three rounds in a click-to-try viewer (notes/icon_sampler/
// flux-ai-mark-round{2,3}.html): the first network "could all unfold into a straight line" (it
// was a tree: eleven points, ten links, no loop); the firing should be "a glow pulse that
// travels down the connection", not "a bunch of little white marbles". Shape, firing style and
// every number below are the owner's final pick, to the digit.
//
// HOW IT IS DRAWN, and why: the network is not drawn at all. Its shape (points and links) is a
// MASK on one box (`.fam-net`); inside that box are plain coloured layers: the resting colours
// (`.fam-base`), two soft fronts that drift across (`.fam-flow`), and, per point, a flash and a
// lingering tint. Everything that moves is a `transform` or an `opacity` on an HTML element,
// which the compositor runs by itself: no painting and no script per frame. (An SVG whose
// circles change colour would repaint on the main thread at every frame, for as long as an
// agent surface is open; a continuous main-thread frame loop is also what adds input latency to
// the editor beside it.)
//
// TWO LEVELS OF LIFE:
//   - CSS only (app.css): the network turns and the fronts drift. No script at all. This is what
//     a mark shows before the engine attaches, and all a mark shows when the engine may not run.
//   - The engine (fluxAiMarkEngine.ts): points fire, the signal travels down links as a glow
//     with a warm trail, colour passes from point to point, and the mark REPORTS what agents are
//     doing (a claim, a question, a finish, a failure, something sent). It wakes only at the
//     instant a point fires, in the browser's idle time; it never runs a frame loop.
//
// This file is the description of the mark and is free of the DOM at import time (a pure gate
// imports it): geometry, colours, the numbers, and a builder for the mark's elements, because
// Ask's synchronous bootstrap builds its header by hand before any component has loaded.
//
// TONE is what the colour says:
//   ready  the bloom's own colours: nothing is running
//   live   blue, and quicker: an agent is working, or will pick this up as you send it
//   wait   the annotation gold: something is waiting for you
//   done   green: finished
//   error  red

export type FluxAiTone = "ready" | "live" | "wait" | "done" | "error";
export type Rgb = [number, number, number];

const GOLDEN = 137.508, D2R = Math.PI / 180;

/** The feel, as the owner set it (round 2 knobs, round 3 signal knobs, final message). */
export const FLUX_AI_FEEL = {
  /** Turns a minute at rest. */ spin: 2.5,
  /** How much each firing speeds the turn. */ kick: 0.1,
  /** Spontaneous firings a second. */ rate: 1.3,
  /** Chance a firing sets off a flurry. */ burst: 0.2,
  /** Chance a firing passes down each link. */ spread: 0.38,
  /** ms to cross a link of average length. */ hop: 165,
  /** ms a point's flash lasts. */ decay: 590,
  /** Flash diameter, as a share of the mark. */ glow: 0.85,
  /** How much of its colour a signal keeps as it arrives. */ influence: 0.75,
  /** Seconds a point keeps the colour that passed through. */ memory: 2.4,
  /** Opacity of the two drifting fronts. */ fronts: 0.26,
  /** Opacity of the resting colours. */ rest: 0.85,
  /** How far links bow (share of their length). */ curve: 0.141,
  /** Link weight, in the 32-unit box. */ line: 1.21,
  /** Point size multiplier. */ node: 1.05,
  /** Travelling glow: diameter as a share of the mark. */ glowWidth: 0.28,
  /** ... how far it stretches along the link. */ glowLength: 2.2,
  /** ... its peak opacity. */ glowStrength: 1,
  /** 0 = pure colour, 1 = white-hot core. */ heat: 0.45,
  /** ms a link stays warm after a signal passed. */ warm: 320,
} as const;

/** The network, in a 32-unit box centred on (16, 16): the bloom's first ten points. */
export const FLUX_AI_NODES: { x: number; y: number; r: number }[] = Array.from({ length: 10 }, (_, k) => {
  const i = k + 1, a = i * GOLDEN * D2R, d = 4.05 * Math.sqrt(i);
  return { x: 16 + d * Math.cos(a), y: 16 + d * Math.sin(a), r: 2.4 - 0.08 * i };
});
/** Its links: every three-step and every five-step tie of the spiral (its two families of arms),
 *  and the first two points to each other. Thirteen links on ten points: four loops, no loose
 *  end. Indices into FLUX_AI_NODES. */
export const FLUX_AI_EDGES: [number, number][] = [[0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [6, 9], [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [0, 1]];
/** Who each point is tied to. */
export const FLUX_AI_ADJACENT: number[][] = FLUX_AI_NODES.map((_, i) => FLUX_AI_EDGES.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : [])));
const length = (a: number, b: number) => Math.hypot(FLUX_AI_NODES[a].x - FLUX_AI_NODES[b].x, FLUX_AI_NODES[a].y - FLUX_AI_NODES[b].y);
export const FLUX_AI_MEAN_LINK = FLUX_AI_EDGES.reduce((sum, [a, b]) => sum + length(a, b), 0) / FLUX_AI_EDGES.length;

/** The control point of a link's curve: every link bows the same way round the centre, so the
 *  whole network leans into its turn. */
export function fluxAiControl(a: number, b: number): { x: number; y: number } {
  const p = FLUX_AI_NODES[a], q = FLUX_AI_NODES[b], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  let nx = -(q.y - p.y), ny = q.x - p.x;
  if (nx * -(my - 16) + ny * (mx - 16) < 0) { nx = -nx; ny = -ny; }
  return { x: mx + nx * FLUX_AI_FEEL.curve, y: my + ny * FLUX_AI_FEEL.curve };
}

/** The network's shape as a CSS mask image: what lets colour move THROUGH it. */
export const FLUX_AI_MASK = (() => {
  const n = (v: number) => v.toFixed(2);
  const lines = FLUX_AI_EDGES.map(([a, b]) => { const p = FLUX_AI_NODES[a], q = FLUX_AI_NODES[b], c = fluxAiControl(a, b); return `<path d='M${n(p.x)} ${n(p.y)}Q${n(c.x)} ${n(c.y)} ${n(q.x)} ${n(q.y)}'/>`; }).join("");
  const dots = FLUX_AI_NODES.map((d) => `<circle cx='${n(d.x)}' cy='${n(d.y)}' r='${n(d.r * FLUX_AI_FEEL.node)}'/>`).join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><g fill='none' stroke='#000' stroke-width='${FLUX_AI_FEEL.line}' stroke-linecap='round' opacity='.68'>${lines}</g>${dots}</svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
})();

// ---- colour ---------------------------------------------------------------------------------
const BLOOM = ["#d14d41", "#da702c", "#d0a215", "#879a39", "#3aa99f", "#4385be", "#8b7ec8", "#ce5d97"];
/** The resting colours of each tone, laid round the network as a conic gradient. */
export const FLUX_AI_PALETTE: Record<FluxAiTone, string[]> = {
  ready: BLOOM,
  live: ["#4385be", "#3aa99f", "#5b9bd5", "#8b7ec8", "#66a0c8", "#3aa99f"],
  wait: ["#d0a215", "#da702c", "#e0b83a", "#c98b12"],
  done: ["#879a39", "#3aa99f", "#a0af54", "#66800b"],
  error: ["#d14d41", "#da702c", "#e06a5e", "#af3029"],
};
/** The two drifting fronts of each tone. */
export const FLUX_AI_FRONTS: Record<FluxAiTone, [string, string]> = {
  ready: ["#ffd36b", "#55d6ff"], live: ["#bfe9ff", "#6ff5e2"], wait: ["#ffe58a", "#ff9d47"], done: ["#d9f58a", "#63dbb8"], error: ["#ff9b8a", "#ffb163"],
};
/** The colour each working agent holds its point in, in order of arrival. */
export const FLUX_AI_AGENT_COLOURS = ["#55d6ff", "#c9a2ff", "#ff9fd6", "#7df0c8"];
/** How fast each tone fires and turns, against the resting pace. */
export const FLUX_AI_TONE_RATE: Record<FluxAiTone, number> = { ready: 1, live: 2.1, wait: 0.35, done: 1.2, error: 0.12 };
export const FLUX_AI_TONE_SPIN: Record<FluxAiTone, number> = { ready: 1, live: 1.7, wait: 0.7, done: 1.2, error: 0.4 };

export const fluxAiHex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const fluxAiMix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const fluxAiCss = (c: Rgb): string => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
export const fluxAiHash = (s: string): number => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

/** An agent's own colouring of the mark: three neighbouring bloom colours and a pose, both from
 *  its name, so hamerkop always looks like hamerkop. */
export function fluxAiAgentLook(name: string): { palette: string[]; from: number } {
  const h = fluxAiHash(name);
  return { palette: [BLOOM[h % 8], BLOOM[(h + 1) % 8], BLOOM[(h + 7) % 8]], from: h % 360 };
}
export const fluxAiConic = (palette: readonly string[], from = 200): string => `conic-gradient(from ${from}deg, ${[...palette, palette[0]].join(", ")})`;
/** The colour the base paints under a point: the conic gradient, sampled at the point's bearing. */
export function fluxAiSample(palette: readonly string[], node: { x: number; y: number }, from = 200): Rgb {
  const clockwise = (Math.atan2(node.x - 16, -(node.y - 16)) / D2R + 360) % 360; // CSS conic: 0 = up
  const t = ((((clockwise - from) % 360) + 360) % 360) / 360 * palette.length, k = Math.floor(t) % palette.length;
  return fluxAiMix(fluxAiHex(palette[k]), fluxAiHex(palette[(k + 1) % palette.length]), t - Math.floor(t));
}

// ---- things that happen once ------------------------------------------------------------------
/** `sent`: the user sent something to Flux AI. `tool`: an agent used a tool. Every live mark
 *  answers (a pulse inward; one sharp pulse down a link). */
export type FluxAiSignal = "sent" | "tool";
const listeners = new Set<(kind: FluxAiSignal) => void>();
export function onFluxAiSignal(listener: (kind: FluxAiSignal) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function fluxAiSignal(kind: FluxAiSignal): void { for (const listener of listeners) listener(kind); }

// ---- the mark's elements ----------------------------------------------------------------------
/** The layers that are always there, in paint order (class names; app.css styles them). */
export const FLUX_AI_LAYERS = ["fam-base", "fam-fade", "fam-flow f1", "fam-flow f2"] as const;

export interface FluxAiMarkLook {
  size?: number;
  tone?: FluxAiTone;
  /** At rest (a button's icon, a row in a list): the network in its colours, nothing moving. */
  still?: boolean;
  /** Draw it in this agent's own colouring and pose. */
  agent?: string;
}
/** Set what a mark's root carries: size, mask, colours, pose. Shared by the component and the
 *  hand-built bootstrap so the two can never draw different things. */
export function fluxAiMarkStyle(look: FluxAiMarkLook): Record<string, string> {
  const tone = look.tone ?? "ready", own = look.agent && tone === "ready" ? fluxAiAgentLook(look.agent) : null;
  const fronts = FLUX_AI_FRONTS[tone];
  return {
    "--fam-size": `${look.size ?? 18}px`,
    "--fam-mask": FLUX_AI_MASK,
    "--fam-base": fluxAiConic(own?.palette ?? FLUX_AI_PALETTE[tone], own?.from ?? 200),
    "--fam-flow-1": fronts[0],
    "--fam-flow-2": fronts[1],
    "--fam-pose": `${look.agent ? fluxAiAgentLook(look.agent).from : 0}deg`,
    // One pace in CSS. A tone that turns faster does it through the animation's playback rate
    // (the engine): changing the DURATION of a running turn would make it jump to another angle.
    "--fam-turn": `${(60 / FLUX_AI_FEEL.spin).toFixed(2)}s`,
  };
}
/** The mark as plain DOM, for code that runs before any component is available. */
export function fluxAiMarkElement(doc: Document, size = 18, tone: FluxAiTone = "ready", still = false, agent?: string): HTMLSpanElement {
  const mark = doc.createElement("span");
  mark.className = still ? "flux-ai-mark still" : "flux-ai-mark";
  mark.dataset.tone = tone;
  mark.setAttribute("aria-hidden", "true");
  for (const [name, value] of Object.entries(fluxAiMarkStyle({ size, tone, still, agent }))) mark.style.setProperty(name, value);
  const net = doc.createElement("span");
  net.className = "fam-net";
  for (const name of still ? FLUX_AI_LAYERS.slice(0, 1) : FLUX_AI_LAYERS) { const layer = doc.createElement("i"); layer.className = name; net.append(layer); }
  mark.append(net);
  return mark;
}
