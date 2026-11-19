// The Flux AI mark, as the owner chose it (2026-11-19): its shape, its numbers, and the written
// part of its performance contract (src/shell/agent/fluxAiMark.ts, fluxAiMarkEngine.ts).
// The running part of the contract is scripts/verify-flux-ai-mark-gui.mjs. Run via run-verifies.
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import {
  FLUX_AI_ADJACENT, FLUX_AI_EDGES, FLUX_AI_FEEL, FLUX_AI_MASK, FLUX_AI_NODES, FLUX_AI_PALETTE, fluxAiAgentLook, fluxAiControl, fluxAiMarkStyle,
  fluxAiSample, fluxAiSignal, onFluxAiSignal,
} from "../src/shell/agent/fluxAiMark";

const h = harness("verify-flux-ai-mark");
const N = FLUX_AI_NODES.length;
const connected = (edges: [number, number][]) => {
  const adj = FLUX_AI_NODES.map(() => [] as number[]);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const seen = new Set([0]), queue = [0];
  while (queue.length) for (const v of adj[queue.pop()!]) if (!seen.has(v)) { seen.add(v); queue.push(v); }
  return seen.size === N;
};

h.section("the shape: the owner's pick, link for link");
h.eq(N, 10, "ten points");
h.eq(FLUX_AI_EDGES.map(([a, b]) => `${a}-${b}`).join(","), "0-3,1-4,2-5,3-6,4-7,5-8,6-9,0-5,1-6,2-7,3-8,4-9,0-1", "the thirteen links the owner sent back");
h.eq(FLUX_AI_EDGES.length - N + 1, 4, "four loops");
h.ok(FLUX_AI_ADJACENT.every((next) => next.length >= 2), "no loose end: every point is tied at least twice");
h.ok(connected(FLUX_AI_EDGES), "one network");
h.ok(FLUX_AI_EDGES.every((_, k) => connected(FLUX_AI_EDGES.filter((__, j) => j !== k))), "every link is part of a loop: cut any one and it is still one network (it cannot unfold into a line)");
h.ok(FLUX_AI_NODES.every((n) => Math.hypot(n.x - 16, n.y - 16) + n.r * FLUX_AI_FEEL.node <= 16), "every point lies inside the mark's disc");
h.ok(Math.abs(FLUX_AI_NODES[0].x - (16 + 4.05 * Math.cos((137.508 * Math.PI) / 180))) < 1e-9 && Math.abs(FLUX_AI_NODES[9].r - 1.6) < 1e-9, "the points are the logo's own spiral (golden angle, 4.05·√i), shrinking outward");
const bows = FLUX_AI_EDGES.map(([a, b]) => { const c = fluxAiControl(a, b), p = FLUX_AI_NODES[a], q = FLUX_AI_NODES[b], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2; return (c.x - mx) * -(my - 16) + (c.y - my) * (mx - 16); });
h.ok(bows.every((v) => v >= -1e-9), "every link bows the same way round the centre");

h.section("the numbers: the owner's final settings");
h.eq({ ...FLUX_AI_FEEL }, { spin: 2.5, kick: 0.1, rate: 1.3, burst: 0.2, spread: 0.38, hop: 165, decay: 590, glow: 0.85, influence: 0.75, memory: 2.4, fronts: 0.26, rest: 0.85, curve: 0.141, line: 1.21, node: 1.05, glowWidth: 0.28, glowLength: 2.2, glowStrength: 1, heat: 0.45, warm: 320 },
  "spin, kick, firing, bursts, spread, signal time, flash, glow reach, colour, drift, rest, curve, weight, size, and the glow-with-a-warm-trail knobs");
const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
h.ok(/\.flux-ai-mark \.fam-base \{[^}]*opacity: \.85/.test(css) && /\.flux-ai-mark \.fam-flow \{[^}]*opacity: \.26/.test(css) && /\.flux-ai-mark \.fam-flash \{ width: 85%/.test(css), "the stylesheet carries the same resting light, drifting light and glow reach");

h.section("how it is drawn");
const mask = decodeURIComponent(FLUX_AI_MASK);
h.eq([(mask.match(/<path/g) ?? []).length, (mask.match(/<circle/g) ?? []).length], [13, 10], "the mask holds the thirteen links and the ten points");
h.ok(mask.includes("stroke-width='1.21'") && / Q/.test(mask.replace(/Q/g, " Q")), "links are drawn at the chosen weight, as curves");
const look = fluxAiMarkStyle({ size: 20, tone: "live" });
h.eq([look["--fam-size"], look["--fam-turn"]], ["20px", "24.00s"], "a mark's size and its turn (2.5 a minute) are custom properties on its root");
h.ok(fluxAiMarkStyle({ tone: "ready" })["--fam-turn"] === fluxAiMarkStyle({ tone: "live" })["--fam-turn"], "the turn's duration never changes with tone (a changed duration makes a running turn jump): pace is the animation's rate");
h.ok(look["--fam-base"].startsWith("conic-gradient(from 200deg, #4385be"), "working is blue");
h.eq(Object.keys(FLUX_AI_PALETTE).sort(), ["done", "error", "live", "ready", "wait"], "five tones");
const reds = fluxAiSample(FLUX_AI_PALETTE.error, FLUX_AI_NODES[0]);
h.ok(reds[0] > reds[2], "a point takes the colour the base paints under it");

h.section("each agent has its own colouring");
const a = fluxAiAgentLook("hamerkop"), b = fluxAiAgentLook("heron");
h.eq(fluxAiAgentLook("hamerkop"), a, "the same name always gives the same look");
h.ok(a.from !== b.from || a.palette.join() !== b.palette.join(), "two names give two looks");
h.ok(fluxAiMarkStyle({ agent: "hamerkop" })["--fam-base"] !== fluxAiMarkStyle({})["--fam-base"] && fluxAiMarkStyle({ agent: "hamerkop", tone: "error" })["--fam-base"] === fluxAiMarkStyle({ tone: "error" })["--fam-base"], "an agent's colouring is its resting look; a state (red) overrides it");

h.section("things that happen once");
const heard: string[] = [];
const off = onFluxAiSignal((kind) => heard.push(kind));
fluxAiSignal("sent"); off(); fluxAiSignal("tool");
h.eq(heard, ["sent"], "a signal reaches whoever is listening, and stops with them");

h.section("the performance contract, as written");
const engine = readFileSync(new URL("../src/shell/agent/fluxAiMarkEngine.ts", import.meta.url), "utf8");
const code = engine.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
h.ok(!/requestAnimationFrame/.test(code), "the engine never asks for an animation frame");
h.ok(!/setInterval/.test(code), "and runs no interval");
h.ok(/requestIdleCallback/.test(code) && !/requestIdleCallback\([^)]*timeout/.test(code), "its work is asked for in idle time, with no timeout that could force it in front of the user's work");
h.ok(/MAX_ENGINES = 3\b/.test(code) && /MAX_IN_FLIGHT = \d+/.test(code) && /MAX_FIRES_A_SECOND = \d+/.test(code), "there is a limit on firing marks, on signals in flight and on firings a second");
h.ok(/handsBusy\(\)/.test(code) && /"keydown", "wheel"/.test(code) && /pointerdown/.test(code) && /passive: true/.test(code), "it watches the user's hands with passive listeners");
h.ok(/classList\.add\("held"\)/.test(code) && /\.flux-ai-mark\.held \.fam-net, \.flux-ai-mark\.held \.fam-flow \{ animation-play-state: paused; \}/.test(css), "while they are busy the whole mark is held still");
h.ok(/\n\.flux-ai-mark \{[^}]*contain: strict/.test(css), "its box is strictly contained");
const component = readFileSync(new URL("../src/shell/agent/FluxAiMark.svelte", import.meta.url), "utf8");
h.ok(/import\("\.\/fluxAiMarkEngine"\)/.test(component) && !/^\s*import \{[^}]*\} from "\.\/fluxAiMarkEngine"/m.test(component), "the engine is loaded only when a live mark is on screen (a still mark never loads it)");
h.ok(/if \(still \|\| !el\) return;/.test(component), "a still mark never attaches it");

await h.done();
