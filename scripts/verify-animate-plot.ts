#!/usr/bin/env -S npx tsx
// animate-plot (headless auto-build) == the GUI path: same tracks for the same plot, with the pen measure computed by ONE
// function on a parse of the plot's own SVG. Pure tier (no browser): linkedom stands in for the GUI's DOMParser.
//   npx tsx scripts/verify-animate-plot.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import * as slideOps from "../src/lib/slide/ops";
import { applyAutoAnimation, AUTO_PACES } from "../src/lib/slide/autobuild";
import { plotPenLengths, partPenLengths } from "../src/lib/slide/partLength";
import { scaffold } from "../flux-core/index";
import { saveDeck, loadDeck, animatePlotVerb } from "../flux-core/slides";
import type { Beat } from "../src/lib/slide/types";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-animate-plot");
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "plots", n);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-animate-plot-"));
const strip = (beats: Beat[]) => JSON.stringify(beats.map(b => [b.label, b.advance ?? "", b.tracks.map((t, i) => [t.part, t.preset, t.duration, t.start ?? 0, t.anchor ? [t.anchor.edge, t.anchor.offsetMs, b.tracks.findIndex(x => x.id === t.anchor!.trackId)] : null, t.stagger ?? null, t.params ?? null])]));
try {
  await scaffold(root, { title: "animate-plot" });
  for (const name of ["mpl_scatter", "mpl_sine_waves", "mpl_bars"]) {
    const svg = await fs.readFile(fx(`${name}_FLUXPLOT.svg`), "utf8");
    const manifest = JSON.parse(await fs.readFile(fx(`${name}_FLUXPLOT.fluxplot.json`), "utf8"));
    await fs.mkdir(path.join(root, "plots"), { recursive: true });
    await fs.writeFile(path.join(root, "plots", `${name}.svg`), svg);
    await fs.writeFile(path.join(root, "plots", `${name}.fluxplot.json`), JSON.stringify(manifest));
    for (const pace of ["classic", "v2"] as const) {
      const make = () => { const d = slideOps.createDeck({ id: `d-${name}-${pace}`, title: name }); const s = slideOps.addSlide(d, { id: "s", layout: "blank" }); const p = slideOps.addPlotToSlide(d, s.id, { assetId: name, x: 20, y: 20, width: 520, height: 300 })!; return { d, s, p }; };
      // the GUI path: parse the SVG it already holds, measure with the shared function, call the shared build
      const gui = make();
      const lengths = plotPenLengths(parseHTML(svg).document, manifest, 520);
      applyAutoAnimation(gui.d, "s", gui.p, manifest, { pace: AUTO_PACES[pace], lengths });
      // the headless path: the verb reads the plot files itself
      const cli = make();
      await saveDeck(root, cli.d);
      const r = await animatePlotVerb(root, cli.d.id, "s", cli.p, { pace });
      const after = await loadDeck(root, cli.d.id);
      h.eq(strip(after.slides.find(s => s.id === "s")!.beats), strip(gui.d.slides.find(s => s.id === "s")!.beats), `${name}/${pace}: animate-plot tracks == the GUI auto-build tracks (lengths included)`);
      h.ok(r.beats >= 2 && r.beats <= 3, `${name}/${pace}: ${r.beats} click beats`);
    }
  }
  // the measure itself: positive for stroked spines/lines, absent for text
  const svg = await fs.readFile(fx("mpl_sine_waves_FLUXPLOT.svg"), "utf8");
  const manifest = JSON.parse(await fs.readFile(fx("mpl_sine_waves_FLUXPLOT.fluxplot.json"), "utf8"));
  const L = plotPenLengths(parseHTML(svg).document, manifest, 520);
  h.ok(Object.keys(L).some(k => /\.line$/.test(k) && L[k] > 100), "the pen measure finds the wave lines");
  h.eq(plotPenLengths(parseHTML(svg).document.querySelector("svg")!, manifest, 520), L, "the same measure from the cached <svg> element (the GUI's plotDom) as from a parsed document");
  h.ok(!Object.keys(L).some(k => /title|tick-label/.test(k)), "no length for text parts");
  h.eq(partPenLengths(parseHTML("<svg viewBox='0 0 10 10'><path id='a' d='M0 0 L3 4' stroke='#000' fill='none'/></svg>").document, ["a", "missing"], 2), { a: 10 }, "unit check: a 3-4-5 path at 2 stage px per unit is 10 px; an absent id is simply absent");
  { // review F3: the measure indexes ids once (O(nodes)), not one attribute query per id (O(parts x nodes))
    const N = 5000;
    const dense = parseHTML(`<svg viewBox='0 0 100 100'><g id='pts'>${Array.from({ length: N }, (_, i) => `<circle id='p${i}' cx='${i % 100}' cy='${(i / 100) | 0}' r='1' fill='#000'/>`).join("")}</g><path id='ln' d='M0 0 L3 4' stroke='#000' fill='none'/></svg>`).document.querySelector("svg")!; // the GUI hands the cached <svg> element (no getElementById)
    let queries = 0;
    const qs = dense.querySelector.bind(dense);
    dense.querySelector = ((sel: string) => { queries++; return qs(sel); }) as typeof dense.querySelector;
    const t0 = performance.now();
    const out = partPenLengths(dense, [...Array.from({ length: N }, (_, i) => `p${i}`), "pts", "ln"], 1);
    const dt = performance.now() - t0;
    h.eq(out, { ln: 5 }, "dense plot: only the stroked line has a pen length (filled points have none)");
    h.ok(queries === 0, `dense plot: ${queries} per-id attribute queries (the ids are indexed in one querySelectorAll pass)`);
    h.ok(dt < 1500, `dense plot (${N} leaf ids) measured in ${Math.round(dt)} ms (< 1500; per-id attribute queries were O(parts x nodes))`);
  }
  const bad = await animatePlotVerb(root, "d-mpl_bars-v2", "s", "nope").then(() => "ok", e => String(e.message));
  h.ok(/plot element not found/.test(bad), "a non-plot element is refused cleanly");
  const dflt = slideOps.createDeck({ id: "d-default", title: "d" }); slideOps.addSlide(dflt, { id: "s", layout: "blank" });
  const dp = slideOps.addPlotToSlide(dflt, "s", { assetId: "mpl_scatter", x: 20, y: 20, width: 520, height: 300 })!;
  await saveDeck(root, dflt);
  const badPace2 = await animatePlotVerb(root, "d-default", "s", dp, { pace: "motion" as never }).then(() => "ok", e => String(e.message));
  h.ok(/unknown pace: motion/.test(badPace2), "animate-plot refuses an unknown --pace value");
  await animatePlotVerb(root, "d-default", "s", dp);
  const noPace = await loadDeck(root, "d-default");
  const cls = slideOps.createDeck({ id: "d-cls", title: "d" }); slideOps.addSlide(cls, { id: "s", layout: "blank" });
  const cp = slideOps.addPlotToSlide(cls, "s", { assetId: "mpl_scatter", x: 20, y: 20, width: 520, height: 300 })!;
  applyAutoAnimation(cls, "s", cp, JSON.parse(await fs.readFile(fx("mpl_scatter_FLUXPLOT.fluxplot.json"), "utf8")), { pace: AUTO_PACES.classic });
  h.eq(strip(noPace.slides.find(s => s.id === "s")!.beats), strip(cls.slides.find(s => s.id === "s")!.beats), "animate-plot without --pace builds the default (classic) pace");
} finally { await fs.rm(root, { recursive: true, force: true }); }
await h.done();
