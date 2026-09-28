// Total/distributed/random stagger through the shared core, compiler and player.
import { parseHTML, DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";
import * as stagger from "../src/lib/slide/stagger";
import { compileSlide } from "../src/lib/slide/compile";
import { computeSlideAnims, createPlayer } from "../src/lib/slide/player/player";
import { createDeck } from "../src/lib/slide/ops";
import { FLUX_DARK } from "../src/lib/slide/theme";
import { parseCurve, resolveCurve } from "../src/lib/slide/curves";
import type { Track, Slide, Stagger } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import * as core from "../flux-core/index";

const h = harness("verify-slide-stagger");
const track = (s: Stagger): Track => ({ id: "wave", target: "plot", preset: "fade", stagger: s });
for (const count of [2, 3, 4, 7, 60, 1200]) {
  for (const from of ["start", "end", "center", "edges", "random"] as const) {
    const t = track({ totalMs: 800, from });
    const ranks = stagger.staggerRanks(count, from, undefined, stagger.staggerSeed?.(t) ?? 0, true);
    h.eq(stagger.staggerSpan(t, count), 800, `${from}: Total spans 800ms with ${count} targets`);
    h.eq(Math.min(...ranks.map(r => stagger.staggerDelay(t, r, Math.max(...ranks)))) , 0, `${from}/${count}: first item starts at zero`);
  }
}
for (const count of [0, 1]) h.eq(stagger.staggerSpan(track({ totalMs: 800 }), count), 0, `${count} targets have no stagger tail`);
for (const spec of ["linear", "smooth", "enter", "exit", "settle", "bouncy", "steps(8)"]) {
  const curve = parseCurve(spec)!;
  const t = track({ totalMs: 800, curve });
  const delays = Array.from({ length: 61 }, (_, i) => stagger.staggerDelay(t, i, 60));
  h.eq(delays[0], 0, `${spec}: first delay is zero`);
  h.eq(delays[60], 800, `${spec}: last delay is the span`);
  h.ok(delays.every(d => d >= 0 && d <= 800), `${spec}: distribution stays within span`);
  if (spec !== "bouncy") h.ok(delays.every((d, i) => !i || d >= delays[i - 1]), `${spec}: monotone distribution`);
  const ease = resolveCurve(typeof curve === "string" ? { easing: curve } : { curve });
  h.ok(delays.every((d, i) => Math.abs(d - 800 * ease.clamped(i / 60)) < 1e-9), `${spec}: delays follow the clamped curve`);
}
const each = track({ perMs: 37 });
h.eq(Array.from({ length: 9 }, (_, i) => stagger.staggerDelay(each, i, 8)), Array.from({ length: 9 }, (_, i) => i * 37), "legacy Each arithmetic is byte-identical");
const shuffled = stagger.staggerRanks(60, "random", undefined, 42);
h.eq([...shuffled].sort((a,b) => a-b), Array.from({ length: 60 }, (_,i) => i), "random ranks are a permutation");
h.eq(shuffled, stagger.staggerRanks(60, "random", undefined, 42), "same seed replays identically");
h.ok(JSON.stringify(shuffled) !== JSON.stringify(stagger.staggerRanks(60, "random", undefined, 43)), "different seeds change order");
h.ok(typeof stagger.reshuffleSeed === "function" && core.reshuffleSeed === stagger.reshuffleSeed, "reshuffle uses the exported shared helper");
if (stagger.reshuffleSeed) for (const count of [2, 7, 60]) for (const seed of [0, 1, 42, 0xffffffff]) {
  const t = track({ from: "random", seed });
  const next = stagger.reshuffleSeed(t, count);
  h.ok(JSON.stringify(stagger.staggerRanks(count, "random", undefined, seed)) !== JSON.stringify(stagger.staggerRanks(count, "random", undefined, next)), `${count}/${seed}: reshuffle always changes the permutation`);
}
h.ok(!!stagger.staggerSeed && stagger.staggerSeed(track({ from: "random" })) === stagger.staggerSeed(JSON.parse(JSON.stringify(track({ from: "random" })))), "saved track identity preserves default seed");
h.ok(!!stagger.staggerSeed && stagger.staggerSeed(track({ from: "random" })) !== stagger.staggerSeed({ ...track({ from: "random" }), id: "other" }), "different track identities choose different default seeds");
h.ok(core.staggerDelay === stagger.staggerDelay && core.staggerRanks === stagger.staggerRanks && core.staggerSpan === stagger.staggerSpan, "headless exports the exact shared stagger core");

// Actual semantic nodes, real player spec delays, and seeked compiler/player frames.
const { document } = parseHTML("<html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;
const stage = { width: 800, height: 600 };
const parts = Array.from({ length: 7 }, (_, i) => `p${i}`);
const xs = [4, 1, 6, 0, 2, 5, 3];
const manifest = { schemaVersion: "0.2.0", parts: { id: "root", role: "figure", children: parts.map(id => ({ id, role: "point" })) },
  series: [{ id: "s", points: parts.map((svgId, i) => ({ svgId, x: xs[i], y: i })) }] } as FluxPlotManifest;
const root = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">${parts.map((id,i) => `<g id="${id}" data-x="${xs[i]}"><circle cx="${xs[i]*20}" cy="50" r="3"/></g>`).join("")}</svg>`, "image/svg+xml").documentElement as unknown as SVGSVGElement;
const opts = { theme: FLUX_DARK, plotManifest: () => manifest, plotRoot: () => root, reducedMotion: true };
const wrap = document.createElement("div") as unknown as HTMLElement;
for (let i = 0; i < parts.length; i++) {
  const node = document.createElement("div"); node.id = `plot__${parts[i]}`;
  node.setAttribute("data-x", String(xs[i])); wrap.appendChild(node as unknown as Node);
}
const rendered = { elements: new Map([["plot", wrap]]) };
const camera = document.createElement("div") as unknown as HTMLElement;
for (const from of ["start", "end", "center", "edges", "random"] as const) {
  for (const seed of [undefined, 5, 19]) {
    const t: Track = { ...track({ totalMs: 800, curve: "enter", from, by: "x", ...(seed === undefined ? {} : { seed }) }),
      parts, start: 30, duration: 200, easing: "linear" };
    const slide: Slide = { id: "s", elements: [{ type: "plot", id: "plot", assetId: "asset", x: 0, y: 0, width: 400, height: 300, rotation: 0 }],
      beats: [{ id: "base", tracks: [] }, { id: "wave", tracks: [t] }] };
    const compiled = compileSlide(slide, stage, opts), ct = compiled.cues[1].tracks[0];
    const specs = computeSlideAnims(slide, rendered, camera, stage, opts);
    h.eq(specs.length, parts.length, `${from}/${seed}: every semantic target binds`);
    h.eq(specs.map(s => s.delay), ct.ranks.map(r => 30 + stagger.staggerDelay(t, r, Math.max(...ct.ranks))), `${from}/${seed}: compiler and player use every same delay`);
    h.eq(compiled.cues[1].duration, 1030, `${from}/${seed}: cue includes total span`);
    const deck = createDeck({ withTitleSlide: false, stage }); deck.defaults.transition = "none"; deck.slides = [slide];
    const host = document.createElement("div") as unknown as HTMLElement;
    const player = createPlayer(host, deck, opts);
    let parity = true;
    for (const time of [0, 75, 230, 515, 829, 930, 1030, 400, 0]) {
      player.seek(0, 1, time);
      const frame = compiled.sample(1, time);
      for (const part of parts) {
        const actual = Number(host.querySelector(`[id="plot__${part}"]`)!.getAttribute("style")?.match(/opacity:\s*([^;]+)/)?.[1] ?? 1);
        if (Math.abs(actual - frame.partStates.plot[part].opacity) > 1e-9) parity = false;
      }
    }
    h.ok(parity, `${from}/${seed}: real player forward/reverse seeks agree with compiler`);
    player.destroy();
  }
}
await h.done();
