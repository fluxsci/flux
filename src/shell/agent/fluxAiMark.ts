// The Flux AI mark: a small living network. Eleven nodes of the Flux bloom (the logo's own golden-
// angle spiral, spread thin) joined by a few connections, with colour moving through it: soft
// fronts that drift across neighbouring nodes, and now and then a burst that starts at one node
// and spreads along its connections. It sits top-left of every agent surface (Ask, Annotate,
// Inbox) and turns slowly, always.
//
// Owner, 2026-11-18: "if the flux logo were sparser, looked more like a neural network (some
// connections, etc.), and felt more 'alive' in terms of changing colors that influence each
// other … still circular and dynamic … with spontaneous activity."
//
// HOW IT IS DRAWN, and why: the network is not drawn at all. Its shape (nodes and edges) is a
// MASK on one box (`.fam-net`); inside that box are plain coloured layers: the resting colours
// (`.fam-base`), two soft fronts that orbit at different speeds (`.fam-flow`), and two bursts
// that grow from a node and fade (`.fam-spark`). Every moving part animates only `transform`
// or `opacity` on an HTML element, which the compositor runs by itself: no script, no style
// work and no painting per frame. (An SVG whose circles change colour would repaint on the main
// thread at every frame, for as long as an agent surface is open; a continuous main-thread
// frame loop is also what adds input latency to the editor beside it.) The periods are chosen
// not to line up, so the activity never visibly repeats.
//
// One description of it here, because Ask's synchronous bootstrap builds its header by hand
// before any component has loaded and the lazy surface that adopts it must draw the same thing
// (FluxAiMark.svelte renders these parts; `fluxAiMarkElement` builds the same DOM without a
// component). The look and the motion are global CSS (app.css, .flux-ai-mark) for the same reason.
//
// TONE is what the colour says:
//   ready  the bloom's own colours: nothing is running
//   live   blue, and quicker: an agent is working, or will pick this up as you send it
//   wait   the annotation gold: something is waiting for you
//   done   green: finished
//   error  red

export type FluxAiTone = "ready" | "live" | "wait" | "done" | "error";

/** The network, in a 32-unit box centred on (16, 16): the bloom's first eleven points, spread.
 *  A golden-angle spiral fills its disc evenly, so the mark stays round however few points it has. */
const GOLDEN = 137.508, SPREAD = 3.85, COUNT = 11;
export const FLUX_AI_NODES: { x: number; y: number; r: number }[] = Array.from({ length: COUNT }, (_, k) => {
  const i = k + 1, a = (i * GOLDEN * Math.PI) / 180, d = SPREAD * Math.sqrt(i);
  return { x: +(16 + d * Math.cos(a)).toFixed(2), y: +(16 + d * Math.sin(a)).toFixed(2), r: +(2.45 - 0.085 * i).toFixed(2) };
});
/** Its connections, along the spiral's own grain. In a golden-angle spiral a point's nearest
 *  neighbours are the points five and three steps on: every five-step link, plus the three-step
 *  links of the inner four. That is one connected web in which the rim's points hang off the
 *  middle like dendrites: sparse, round, and not a grid. Indices into FLUX_AI_NODES. */
export const FLUX_AI_EDGES: [number, number][] = [
  ...Array.from({ length: COUNT - 5 }, (_, i): [number, number] => [i, i + 5]),
  ...Array.from({ length: 4 }, (_, i): [number, number] => [i, i + 3]),
];
/** The network's shape as a CSS mask image: what lets colour move THROUGH it. */
export const FLUX_AI_MASK = (() => {
  const lines = FLUX_AI_EDGES.map(([a, b]) => `<path d='M${FLUX_AI_NODES[a].x} ${FLUX_AI_NODES[a].y}L${FLUX_AI_NODES[b].x} ${FLUX_AI_NODES[b].y}'/>`).join("");
  const dots = FLUX_AI_NODES.map((n) => `<circle cx='${n.x}' cy='${n.y}' r='${n.r}'/>`).join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><g fill='none' stroke='#000' stroke-width='1.15' stroke-linecap='round' opacity='.7'>${lines}</g>${dots}</svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
})();
/** The coloured layers inside the mask, in paint order (class names; app.css styles them). */
export const FLUX_AI_LAYERS = ["fam-base", "fam-flow f1", "fam-flow f2", "fam-spark s1", "fam-spark s2"] as const;
/** Where the two bursts start: a hub near the centre and a node on the rim (% of the box). */
export const FLUX_AI_SPARKS = [FLUX_AI_NODES[0], FLUX_AI_NODES[6]].map((n) => ({ left: `${((n.x / 32) * 100).toFixed(1)}%`, top: `${((n.y / 32) * 100).toFixed(1)}%` }));

/** The mark as plain DOM, for code that runs before any component is available. `still` draws
 *  it at rest (a button's icon): the network in its colours, nothing moving. */
export function fluxAiMarkElement(doc: Document, size = 18, tone: FluxAiTone = "ready", still = false): HTMLSpanElement {
  const mark = doc.createElement("span");
  mark.className = still ? "flux-ai-mark still" : "flux-ai-mark";
  mark.dataset.tone = tone;
  mark.setAttribute("aria-hidden", "true");
  mark.style.setProperty("--fam-size", `${size}px`);
  mark.style.setProperty("--fam-mask", FLUX_AI_MASK);
  const net = doc.createElement("span");
  net.className = "fam-net";
  let spark = 0;
  for (const name of FLUX_AI_LAYERS) {
    const layer = doc.createElement("i");
    layer.className = name;
    if (name.startsWith("fam-spark")) { const at = FLUX_AI_SPARKS[spark++]; layer.style.left = at.left; layer.style.top = at.top; }
    net.append(layer);
  }
  mark.append(net);
  return mark;
}
