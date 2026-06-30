#!/usr/bin/env -S npx tsx
// P4 — the portable export (§7.4, headless half). Build a real multi-element
// deck (title, bullets, math, image, a plot + a morph build), export it to ONE
// self-contained .html, and assert it inlines everything (runtime IIFE, deck,
// fonts as data URIs, KaTeX) with NO external references. Writes the file so the
// puppeteer pass can open it offline. Run: npx tsx scripts/verify-slide-export.ts
import { writeFile } from "node:fs/promises";
import * as slideOps from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { ExportPayload } from "../src/lib/slide/export/runtime";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- a real deck via the pure ops -------------------------------------------
const deck = slideOps.createDeck({ id: "talk", title: "Mycelial Growth — Defense" });
const s0 = deck.slides[0].id;
slideOps.addTextBox(deck, s0, { text: "Mycelial growth under nutrient stress", x: 120, y: 250, width: 1040, height: 160, fontSize: 64, fontWeight: 700 });

const s1 = slideOps.addSlide(deck, { name: "Results", layout: "content-figure" }).id;
const body = slideOps.addTextBox(deck, s1, {
  x: 90, y: 150, width: 560, height: 360, fontSize: 34,
  blocks: [slideOps.makeBlock("Growth doubles under stress", { marker: "bullet" }), slideOps.makeBlock("…but only above 24 °C", { marker: "bullet", emphasis: "accent" })],
})!;
slideOps.addMath(deck, s1, { tex: "\\frac{dN}{dt}=rN\\left(1-\\frac{N}{K}\\right)", x: 90, y: 540, width: 560, height: 110, display: true });
slideOps.addImageToSlide(deck, s1, { assetId: "logo", x: 1100, y: 40, width: 120, height: 120 });
const plot = slideOps.addPlotToSlide(deck, s1, { assetId: "plotA", x: 700, y: 150, width: 480, height: 400 })!;
const k1 = slideOps.addBeat(deck, s1, { label: "reveal", advance: "click" })!;
slideOps.setAnimation(deck, s1, k1.id, { target: body, selector: { blocks: "all" }, preset: "stagger", duration: 320, stagger: { perMs: 110 } });
const k2 = slideOps.addBeat(deck, s1, { label: "morph", advance: "click" })!;
slideOps.setAnimation(deck, s1, k2.id, { target: plot, preset: "morph", to: { assetId: "plotB" }, duration: 1200, easing: "smooth" });
// anim export parity: a parts-tree-targeted draw-on + a spatial (by:x) stagger —
// the auto-animate output shapes — must round-trip into the exported deck JSON.
slideOps.setAnimation(deck, s1, k1.id, { target: plot, part: "axis.x", preset: "drawOn", start: 0, duration: 400 });
slideOps.setAnimation(deck, s1, k1.id, { target: plot, part: "fit.points", preset: "stagger", duration: 240, stagger: { perMs: 40, by: "x", from: "start" }, params: { child: "fade" } });

// --- payload: inline plots (A rising, B falling), a 1×1 image asset ----------
const mkManifest = (ys: number[]): FluxPlotManifest => ({
  spec: "fluxplot", schemaVersion: "1", plotType: "line", svg: "", size: { width: 480, height: 400, unit: "px" },
  axes: [{ x: { scale: "linear", domain: [0, 5], anchors: [{ data: 0, svg: 40 }, { data: 5, svg: 440 }] }, y: { scale: "linear", domain: [0, 10], anchors: [{ data: 0, svg: 380 }, { data: 10, svg: 20 }] } }],
  series: [{ id: "ctrl", svg: { line: "ctrl.line", points: "ctrl.pts" }, points: [1, 2, 3, 4].map((x, i) => ({ index: i, svgId: `ctrl.p${i}`, x, y: ys[i] })) }],
});
const px = (x: number, y: number) => [40 + 80 * x, 380 - 36 * y];
const ptsA = [1, 2, 3, 4].map((x, i) => px(x, [2, 4, 6, 8][i]));
const svgA = `<svg viewBox="0 0 480 400" xmlns="http://www.w3.org/2000/svg"><path id="ctrl.line" d="${ptsA.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ")}" fill="none" stroke="#4385be" stroke-width="3"/>${ptsA.map((p, i) => `<circle id="ctrl.p${i}" cx="${p[0]}" cy="${p[1]}" r="7" fill="#66a0c8"/>`).join("")}</svg>`;
const payload: ExportPayload = {
  deck,
  plots: { plotA: { svg: svgA, manifest: mkManifest([2, 4, 6, 8]) }, plotB: { svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", manifest: mkManifest([8, 6, 4, 2]) } },
  assets: { logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
};

const { html, bytes, warnings } = await exportDeckHtml(payload);

assert(html.startsWith("<!doctype html>"), "emits a complete HTML document");
assert(html.includes("FluxSlideRuntime") && html.includes("FluxSlideRuntime.boot("), "bundles the player runtime + boots it");
assert(html.includes("Mycelial Growth — Defense"), "deck title in <title>");
assert(html.includes('id="flux-payload"') && html.includes("\\u003csvg") || html.includes("ctrl.line"), "deck + plot payload inlined");
assert((html.match(/data:font\/woff2;base64,/g) ?? []).length >= 3, "Gelasio + KaTeX fonts inlined as woff2 data URIs");
assert(html.includes('font-family:"Gelasio"') && html.includes(".katex"), "Gelasio @font-face + KaTeX CSS present");
// self-containment: no external network references
assert(!html.includes("url(fonts/"), "no leftover external KaTeX font url(fonts/…) refs");
assert(!/<link\b/i.test(html) && !/<script[^>]*\bsrc=/i.test(html), "no external <link> or <script src>");
assert(!/src=["']https?:/i.test(html) && !/url\(\s*["']?https?:/i.test(html), "no http(s) asset references");
assert(bytes > 80_000, `bundle is substantial (${(bytes / 1024).toFixed(0)} KB incl. KaTeX + fonts)`);
assert(warnings.length === 0, "no size warnings for this deck");
// anim parity: the parts-tree targeting + spatial stagger survive into the bundle
assert(html.includes('"part":"axis.x"'), "part-targeted (axis.x) draw-on track round-trips into the exported deck JSON");
assert(/"by":"x"/.test(html), "spatial stagger (by:x) round-trips into the exported deck JSON");

const outPath = (process.env.FLUX_EXPORT_OUT || "/tmp/flux-export-talk") + ".html";
await writeFile(outPath, html);
console.log(`\n  wrote ${(bytes / 1024).toFixed(0)} KB → ${outPath}`);
console.log("\nALL SLIDE-EXPORT (P4) HEADLESS TESTS PASSED");
