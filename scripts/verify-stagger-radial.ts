#!/usr/bin/env -S npx tsx
// WP 4.3 (manim study, W7): the radial stagger order. `Stagger.by: "radial"` ranks a plot's parts by their distance from `origin` (data
// units; absent = the parts' centre), measured in the plot's PIXEL space through each series' view fits (a log axis and a squashed aspect
// measure as they look), by ONE function both engines call (staggerData.radialCoordinates; the player never reads DOM attributes for it).
// `from: "start"` ripples out, `"end"` collapses in. A deck holding it is written as 0.7.0 (an older build's validator rejects it).
// Run: npx tsx scripts/verify-stagger-radial.ts
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import { radialCoordinates } from "../src/lib/slide/staggerData";
import { staggerRanks, patchStagger } from "../src/lib/slide/stagger";
import { deckSchemaFor } from "../src/lib/slide/schemaStamp";
import { DECK_SCHEMA_VERSION, DECK_BASE_SCHEMA_VERSION } from "../src/lib/slide/types";
import { createDeck, addSlide, addPlotToSlide, addBeat, setAnimation } from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { validateDeckFile } from "../src/lib/project/validate";
import { launch } from "./lib/driver.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";

const h = harness("verify-stagger-radial");
const fixture = (name: string) => {
  const base = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "plots", `${name}_FLUXPLOT`);
  return { manifest: JSON.parse(readFileSync(`${base}.fluxplot.json`, "utf8")) as FluxPlotManifest, svg: readFileSync(`${base}.svg`, "utf8") };
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-radial-"));
try {
  h.section("the order (pure)");
  // a 3 x 3 grid on linear axes that map one data unit to the same number of pixels in x and y
  const grid = clone(fixture("mpl_scatter").manifest);
  const ax = grid.axes[0] as unknown as { x: Record<string, unknown>; y: Record<string, unknown> };
  ax.x = { ...ax.x, scale: "linear", domain: [0, 2], anchors: [{ data: 0, svg: 0 }, { data: 2, svg: 200 }] };
  ax.y = { ...ax.y, scale: "linear", domain: [0, 2], anchors: [{ data: 0, svg: 200 }, { data: 2, svg: 0 }] };
  const s0 = grid.series[0] as unknown as { points: { index: number; svgId: string; x: number; y: number }[] };
  s0.points = Array.from({ length: 9 }, (_, i) => ({ index: i, svgId: `g.point.${i}`, x: i % 3, y: Math.floor(i / 3) }));
  const ids = s0.points.map((p) => p.svgId);
  const d = radialCoordinates(grid, ids, { x: 1, y: 1 });
  h.ok(d[4] === 0 && [1, 3, 5, 7].every((i) => Math.abs((d[i] as number) - 100) < 1e-9) && [0, 2, 6, 8].every((i) => Math.abs((d[i] as number) - 100 * Math.SQRT2) < 1e-9), "a 3x3 grid about its centre: 0 / 100 px for the edge midpoints / 141 px for the corners (pixel space)");
  const ranks = staggerRanks(9, "start", d), ring = (i: number) => (i === 4 ? 0 : [1, 3, 5, 7].includes(i) ? 1 : 2);
  h.ok(ids.every((_, i) => ids.every((__, j) => ring(i) < ring(j) ? ranks[i] < ranks[j] : true)), "from start it ripples out: the centre, then the edge midpoints, then the corners");
  const inward = staggerRanks(9, "end", d);
  h.ok(inward[4] === 8 && [0, 2, 6, 8].every((i) => inward[i] < 4), "from end it collapses in: the corners first, the centre last");
  h.eq(radialCoordinates(grid, ids), d, "no origin = the centre of the parts");
  const off = radialCoordinates(grid, ids, { x: 0, y: 0 });
  h.ok(off[0] === 0 && (off[8] as number) > (off[4] as number), "an origin at a corner orders from that corner");
  h.eq(radialCoordinates(grid, [...ids, "nope"])[9], null, "a part the manifest does not place is null (it keeps its order after the ranked ones)");
  // a log x axis: decades are evenly spaced on screen, so 10 is midway between 1 and 100 (in data it would sit near 1)
  const logm = clone(fixture("mpl_scatter").manifest);
  const lx = logm.axes[0] as unknown as { x: Record<string, unknown> };
  lx.x = { ...lx.x, scale: "log", domain: [1, 100], anchors: [{ data: 1, svg: 0 }, { data: 100, svg: 200 }] };
  const ls = logm.series[0] as unknown as { points: { index: number; svgId: string; x: number; y: number }[] };
  ls.points = [1, 10, 100].map((x, index) => ({ index, svgId: `l.point.${index}`, x, y: (logm.axes[0] as unknown as { y: { domain: number[] } }).y.domain?.[0] ?? 0 }));
  const ld = radialCoordinates(logm, ls.points.map((p) => p.svgId), { x: 10, y: (logm.axes[0] as unknown as { y: { domain: number[] } }).y.domain?.[0] ?? 0 });
  h.ok(Math.abs((ld[0] as number) - (ld[2] as number)) < 1e-6 && ld[1] === 0, "a log axis: 1 and 100 are equally far from 10 (one decade each way), as they look");

  // bars sit at their middle ON THEIR OWN BASELINE (a stacked bar), heatmap cells are placed from their names (values stored or not)
  const bm = clone(fixture("mpl_bars_5").manifest), bs = bm.series[0] as unknown as { bar: { baseline: number[]; center: number[]; length: number[] }; svg: { bars: string[] } };
  bs.bar.baseline[2] = 20;   // stack bar 2 on top of something
  const mid2 = { x: bs.bar.center[2], y: bs.bar.baseline[2] + bs.bar.length[2] / 2 };
  const bd = radialCoordinates(bm, bs.svg.bars, mid2);
  h.ok(Math.abs(bd[2] as number) < 1e-9 && bd.every((v, i) => i === 2 || (v as number) > 1), "a stacked bar is placed at the middle of its own bar (baseline + half its length), not of a bar from zero");
  const heat = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "colorscale", "heatmap.fluxplot.json"), "utf8")) as FluxPlotManifest;
  const cells = (heat.series ?? []).flatMap((x) => (x.components ?? []).flatMap((c) => c.members ?? [])).filter((m) => /\.cell\.\d+\.\d+$/.test(m));
  const hd = radialCoordinates(heat, cells);
  h.ok(cells.length > 10 && hd.every((v) => typeof v === "number"), `a heatmap without stored values still places all its ${cells.length} cells (from their names)`);

  h.section("authoring and files");
  h.eq(patchStagger({ perMs: 40 }, { by: "radial", origin: { x: 1, y: 2 } }), { perMs: 40, by: "radial", origin: { x: 1, y: 2 } }, "patchStagger takes by radial with an origin");
  const refuse = (p: object) => { try { patchStagger({ perMs: 40 }, p as never); return false; } catch { return true; } };
  h.ok(refuse({ by: "radial", origin: { x: Infinity, y: 0 } }) && refuse({ by: "x", origin: { x: 1, y: 1 } }), "refused: a non-finite origin, an origin without by radial");
  h.eq(patchStagger({ perMs: 40, by: "radial", origin: { x: 1, y: 2 } }, { by: "x" }).origin, undefined, "leaving radial drops the origin (no trap)");
  const deck = createDeck({ id: "rd", title: "radial", withTitleSlide: false } as never); deck.defaults.transition = "none";
  const sc = fixture("mpl_scatter");
  deck.plots = { sc: { svg: sc.svg, manifest: sc.manifest } } as never;
  const slide = addSlide(deck, { id: "s", layout: "blank" } as never);
  const plotId = addPlotToSlide(deck, slide.id, { assetId: "sc", x: 20, y: 20, width: 600, height: 320 } as never) as unknown as string;
  const b = addBeat(deck, slide.id, { id: "b" } as never)!;
  h.eq(deckSchemaFor(deck), DECK_BASE_SCHEMA_VERSION, "without a radial order the deck stays the base format");
  setAnimation(deck, slide.id, b.id, { target: plotId, preset: "fade", start: 0, duration: 300, selector: { role: "point" }, stagger: { totalMs: 900, by: "radial", from: "start" } } as never);
  h.eq(deckSchemaFor(deck), DECK_SCHEMA_VERSION, "a radial order stamps the deck 0.7.0 (an older build's validator rejects it)");
  h.eq((validateDeckFile(JSON.parse(JSON.stringify(deck))) as unknown as unknown[]).length, 0, "...and it validates");

  h.section("both engines rank alike (the compiler and the exported player)");
  const manifestFor = () => sc.manifest;
  const c = compileSlide(deck.slides[0], deck.stage, { plotManifest: manifestFor } as never);
  const ct = c.cues[1].tracks[0], partIds = ct.parts;
  h.ok(partIds.length > 10 && new Set(ct.ranks).size === partIds.length, `the compiler ranks ${partIds.length} points`);
  const file = path.join(tmp, "radial.html"); await fs.writeFile(file, (await exportDeckHtml({ deck, plots: { sc: { svg: sc.svg, manifest: sc.manifest } } } as never)).html);
  const launched = await launch({ width: 960, height: 540 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  let compared = 0, agree = 0;
  for (const ms of [120, 300, 480, 660, 840]) {
    const want = c.sample(1, ms).partStates[plotId] ?? {};
    const dom = await page.evaluate(`(() => { window.fluxDeck.seek(0, 1, ${ms}); const out = {}; for (const id of ${JSON.stringify(partIds)}) { const n = document.querySelector('[id$="' + id + '"]'); if (n) out[id] = +getComputedStyle(n).opacity; } return out; })()`) as Record<string, number>;
    for (const id of partIds) { if (dom[id] === undefined) continue; compared++; if (Math.abs((want[id]?.opacity ?? 1) - dom[id]) < 0.02) agree++; }
  }
  h.ok(compared > 50 && agree === compared, `mid-stagger, every point's opacity in the player equals the compiler's sample (${agree}/${compared})`);
  h.eq(errors, [], "no page errors");
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
