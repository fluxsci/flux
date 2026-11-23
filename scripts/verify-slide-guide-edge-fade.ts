// A tick label leaves the picture with its tick, whatever effect it entered with.
//
// An axis-view Change carries the generated ticks, labels and gridlines along the axis and fades each one out over a short band beyond the
// axis' end (projectDom: the guide pass `writeGuide` for an elastic plot, the hand-off pool `writeFlight` for a stretched one). The fade is
// written on the guide's own `opacity`. The player's look law writes the same property, after the content, for every node an effect owns:
// a tick label that FADED IN at an earlier step rests at the effect's `opacity: 1` in every later frame. The owner's deck (2026-11-22): the
// x tick labels of an EEG plot fade in, the next step zooms the x axis; the labels "0", "5" and "10" rode the data out of the axis at full
// strength, across the plots to the left of it, while their tick marks (drawn on, no opacity of the effect's own) faded as designed.
//
// The law pinned here, in the exported player: at every moment of a view Change a tick label is drawn exactly where a tick mark is drawn,
// with the same weight, and never beyond the fade band of its axis. Three slides: an elastic plot, a stretched plot (the pool), and an
// elastic plot whose labels are still fading in while the view moves (there a label weighs at most what its mark does; played live too,
// where the fade is a native effect, which would paint over the factor).
//
// NOT pinned (guide §10): the nice ticks a closed view RESTS on take their opacity from the label as it was before the view first moved.
// Labels that were still to fade in then (the third slide) leave the closed view without tick labels.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Track } from "../src/lib/slide/types";
import type { SemanticPlotElement } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-guide-edge-fade");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-guide-edge-fade-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  // an elastic line plot: x from -0.5 to 10.5, ticks at 0, 2, ... 10 (locator auto)
  const plots = { line: {
    svg: await fs.readFile(new URL("./fixtures/relayout/line/base.svg", import.meta.url), "utf8"),
    manifest: JSON.parse(await fs.readFile(new URL("./fixtures/relayout/line/base.fluxplot.json", import.meta.url), "utf8")),
  } };
  const deck = createDeck({ withTitleSlide: false }); deck.stage = { width: 960, height: 540 }; deck.defaults.transition = "none"; deck.background = "#ffffff";
  const FLY = 1000, VIEW = { x: { domain: [4.2, 6.9] } };
  /** Step 1: the x tick labels fade in. Step 2: the x axis closes in. Step 3: it opens again. `together` plays the fade in step 2 instead. */
  function slide(id: string, extra: Partial<SemanticPlotElement> = {}, together = false) {
    const s = addSlide(deck, { id, layout: "blank" });
    addElement(deck, s.id, { id, type: "plot", assetId: "line", x: 330, y: 120, width: 420, height: 260, rotation: 0, ...extra } as SemanticPlotElement);
    const enter: Track = { id: `${id}-labels`, target: id, part: "axis.x.tick-labels", preset: "fade", duration: together ? FLY : 300 } as Track;
    if (!together) addBeat(deck, s.id, { id: `${id}-enter` })!.tracks.push(enter);
    const zoom = addBeat(deck, s.id, { id: `${id}-zoom` })!;
    setTransform(deck, s.id, zoom.id, id, { state: { view: VIEW }, duration: FLY, easing: "smooth" });
    if (together) zoom.tracks.push(enter);
    const back = addBeat(deck, s.id, { id: `${id}-back` })!;
    setTransform(deck, s.id, back.id, id, { state: { view: null }, duration: FLY, easing: "smooth" });
    const issues = compileSlide(s, deck.stage, { plotManifest: () => plots.line.manifest as never }).issues;
    h.ok(!issues.length, `${id}: compiles without issues${issues.length ? ` (${issues.map(i => i.reason).join("; ")})` : ""}`);
    return { id, zoom: together ? 1 : 2, back: together ? 2 : 3 };
  }
  const cases = [
    { ...slide("elastic"), what: "an elastic plot (the guide pass)" },
    { ...slide("stretched", { layoutMode: "stretch" }), what: "a stretched plot (the hand-off pool)" },
    { ...slide("together", {}, true), what: "labels still fading in while the view moves" },
  ];

  const file = path.join(tmp, "edge-fade.html"); await fs.writeFile(file, (await exportDeckHtml({ deck, plots } as never)).html);
  const launched = await launch({ width: 1280, height: 720 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");

  interface Guide { x: number; weight: number; text: string }
  interface Frame { left: number; right: number; labels: Guide[]; marks: Guide[] }
  /** The x tick labels and tick marks DRAWN at (slide, step, ms): generated nodes and the projection's clones alike, with the weight
   *  (opacity through every ancestor) each is drawn at; `left`/`right` is the axis itself (its bottom spine). */
  const frameAt = (slideIndex: number, id: string, beat: number, ms: number) => page.evaluate(`(async () => {
    window.fluxDeck.seek(${slideIndex}, ${beat}, ${ms}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const weight = n => { let o = 1; for (let q = n; q && q.nodeType === 1; q = q.parentElement) { const c = getComputedStyle(q); if (c.display === "none" || c.visibility === "hidden") return 0; o *= Number(c.opacity); } return o; };
    const drawn = kind => [...document.querySelectorAll('[id^="${id}__axis.x.' + kind + '."]')].map(n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, weight: weight(n), text: n.textContent.trim(), box: r.width + r.height }; }).filter(g => g.weight > 0.02 && g.box > 0);
    const spine = document.getElementById("${id}__axis.x.spine.bottom").getBoundingClientRect();
    return { left: spine.left, right: spine.right, labels: drawn("ticklabel"), marks: drawn("tick") };
  })()`) as Promise<Frame>;
  const names = (f: Frame) => f.labels.map(g => g.text).join(" ");
  /** The drawn labels that break the law: no drawn tick mark under it, or another weight than the mark's (`entering`: the label's own effect
   *  is still fading it in, so it may weigh less than its mark, never more). */
  const strays = (f: Frame, entering: boolean) => f.labels.filter(g => {
    const mark = f.marks.find(m => Math.abs(m.x - g.x) <= 1.5);
    return !mark || (entering ? g.weight > mark.weight + 0.05 : Math.abs(mark.weight - g.weight) > 0.05);
  });

  for (const c of cases) {
    const at = deck.slides.findIndex(s => s.id === c.id);
    const rest = await frameAt(at, c.id, c.zoom, 0);
    if (c.id !== "together") h.eq(names(rest), "0 2 4 6 8 10", `${c.id}: before the view moves the six generated labels are drawn`);
    const band = (rest.right - rest.left) * 0.04 + 1.5;     // the fade band (4 % of the axis) and a pixel of text metrics
    let left = 0;
    for (const [beat, dir] of [[c.zoom, "in"], [c.back, "out"]] as const) for (const ms of [120, 250, 400, 550, 700, 850, 950]) {
      const f = await frameAt(at, c.id, beat, ms), where = `${c.id}, ${dir} at ${ms} ms`;
      const far = f.labels.filter(g => g.x < f.left - band || g.x > f.right + band);
      h.ok(!far.length, `${where}: no tick label is drawn beyond its axis${far.length ? ` ("${far.map(g => g.text).join('", "')}" at ${far.map(g => Math.round(g.x)).join(", ")} px; the axis spans ${Math.round(f.left)} to ${Math.round(f.right)})` : ""}`);
      const stray = strays(f, c.id === "together");
      h.ok(!stray.length, `${where}: each tick label is drawn as its tick mark is${stray.length ? ` (not "${stray.map(g => `${g.text}" at weight ${g.weight.toFixed(2)}`).join(', "')})` : ""}`);
      if (f.labels.length < 6) left++;
    }
    h.ok(left >= 8, `${c.id}: the view really carries ticks out of the axis (${left} of 14 sampled frames draw fewer than six labels): ${c.what}`);
    // the two rests: the nice ticks of the closed view, then the generated six again
    const closed = await frameAt(at, c.id, c.zoom, FLY), open = await frameAt(at, c.id, c.back, FLY);
    if (c.id !== "together") h.ok(closed.labels.length >= 3 && closed.labels.every(g => g.x >= closed.left - 1.5 && g.x <= closed.right + 1.5 && g.weight > 0.98), `${c.id}: the closed view rests on its own ticks, inside the axis (${names(closed)})`);
    h.eq(names(open), "0 2 4 6 8 10", `${c.id}: the reopened axis rests on the six generated labels`);
    h.ok(open.labels.every(g => g.weight > 0.98), `${c.id}: every label of the reopened axis is at full weight`);
  }
  // Played live, an effect in progress is a native animation (player `applyAt`, native): the same law in every frame the browser paints.
  {
    const c = cases[2], at = deck.slides.findIndex(s => s.id === c.id);
    const rest = await frameAt(at, c.id, 0, 0), band = (rest.right - rest.left) * 0.04 + 1.5;
    const live = await page.evaluate(`(async () => {
      const weight = n => { let o = 1; for (let q = n; q && q.nodeType === 1; q = q.parentElement) { const s = getComputedStyle(q); if (s.display === "none" || s.visibility === "hidden") return 0; o *= Number(s.opacity); } return o; };
      const drawn = kind => [...document.querySelectorAll('[id^="${c.id}__axis.x.' + kind + '."]')].map(n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, weight: weight(n), text: n.textContent.trim(), box: r.width + r.height }; }).filter(g => g.weight > 0.02 && g.box > 0);
      window.fluxDeck.goTo(${at}, 0); window.fluxDeck.next();
      const out = { frames: 0, moving: 0, far: [], heavy: [] }, t0 = performance.now();
      while (performance.now() - t0 < ${FLY + 250}) {
        await new Promise(r => requestAnimationFrame(r));
        const spine = document.getElementById("${c.id}__axis.x.spine.bottom").getBoundingClientRect(), labels = drawn("ticklabel"), marks = drawn("tick");
        out.frames++; if (marks.length && marks.length < 6) out.moving++;
        for (const g of labels) {
          const mark = marks.find(m => Math.abs(m.x - g.x) <= 1.5);
          if (g.x < spine.left - ${band} || g.x > spine.right + ${band}) out.far.push(g.text + " at " + Math.round(g.x));
          else if (!mark || g.weight > mark.weight + 0.05) out.heavy.push(g.text + " at weight " + g.weight.toFixed(2) + (mark ? " over a mark at " + mark.weight.toFixed(2) : " with no mark"));
        }
      }
      return out;
    })()`) as { frames: number; moving: number; far: string[]; heavy: string[] };
    h.ok(live.frames >= 10 && live.moving >= 3, `together, played live: the flight was watched (${live.frames} frames, ${live.moving} of them with ticks out of the axis)`);
    h.ok(!live.far.length, `together, played live: no tick label is drawn beyond its axis${live.far.length ? ` (${[...new Set(live.far)].slice(0, 6).join("; ")})` : ""}`);
    h.ok(!live.heavy.length, `together, played live: no tick label outweighs its tick mark${live.heavy.length ? ` (${[...new Set(live.heavy)].slice(0, 6).join("; ")})` : ""}`);
  }
  h.ok(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
h.done();
