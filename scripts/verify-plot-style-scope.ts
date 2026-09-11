#!/usr/bin/env -S npx tsx
// Inline-plot <style> scoping — the 2026-09-11 flat-caps report.
//
// matplotlib (and therefore every fluxplot) SVG opens with
// `<style>*{stroke-linejoin: round; stroke-linecap: butt}</style>`. Once a plot
// is inlined, that stylesheet is document-global: it restyled every Flux
// <line>/<path>/<rect> on the canvas (round caps drew flat until zooming culled
// the plot out of the DOM), leaked across plots, into paper embeds, and into
// exported SVGs. prefixIds now scopes each rule to the placement's own root.
// This gates the pure half; verify-vanilla-inline.mjs §2b asserts the live
// cascade (getComputedStyle) in the editor.
//  Run: npx tsx scripts/verify-plot-style-scope.ts
import * as fs from "node:fs/promises";
import { parseHTML, DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { parsePlotSvg, prefixIds, scopeCss, scopePlotStyles, PLOT_SCOPE_ATTR } = await import("../src/lib/plot/parse");
const { buildPlotMarkup } = await import("../src/lib/plot/inlineMarkup");

const h = harness("verify-plot-style-scope");
const S = '[data-plot-scope="p1"]';
const MPL = "*{stroke-linejoin: round; stroke-linecap: butt}";

h.section("scopeCss — selector rewriting (pure string)");
h.eq(scopeCss(MPL, S), `${S} ${MPL}`, "the matplotlib preamble's universal rule is scoped");
h.eq(scopeCss(".a, g > .b{fill:red}", S), `${S} .a, ${S} g > .b{fill:red}`, "every selector of a comma list is scoped");
h.eq(scopeCss(":is(.a,.b){x:y}", S), `${S} :is(.a,.b){x:y}`, "a comma inside :is() stays one selector");
h.eq(scopeCss('[title="a,b"]{x:y}', S), `${S} [title="a,b"]{x:y}`, "a comma inside an attribute value stays one selector");
h.eq(scopeCss("@font-face{font-family:F;src:url(f.woff)}", S), "@font-face{font-family:F;src:url(f.woff)}", "@font-face passes through verbatim");
h.eq(scopeCss("@keyframes k{from{opacity:0}to{opacity:1}}", S), "@keyframes k{from{opacity:0}to{opacity:1}}", "@keyframes selectors are never prefixed");
h.eq(scopeCss("@import url(x.css); *{a:b}", S), `@import url(x.css); ${S} *{a:b}`, "a block-less @import statement passes through, the rule after it is scoped");
h.eq(scopeCss("@media print{*{fill:red} .k{a:b}}", S), `@media print{${S} *{fill:red} ${S} .k{a:b}}`, "rules nested in @media are scoped");
h.eq(scopeCss("/* c */ *{a:b}\n.d{e:f}", S), ` ${S} *{a:b}\n${S} .d{e:f}`, "comments are dropped; line structure survives");
h.eq(scopeCss("*{a:b", S), `${S} *{a:b}`, "an unterminated block is closed, not lost");
h.eq(scopeCss("   \n", S), "   \n", "whitespace-only css is returned unchanged");

h.section("prefixIds — the DOM pass (linkedom)");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="60" viewBox="0 0 100 60">
 <defs><style type="text/css">${MPL}</style>
  <linearGradient id="grad"><stop offset="0" stop-color="#000"/></linearGradient>
  <style>.area{fill:url(#grad)}</style></defs>
 <g id="figure_1"><path d="M0 0L10 10" class="area"/></g></svg>`;
{
  const root = parsePlotSvg(SVG)!;
  h.ok(!!root, "fixture parses");
  prefixIds(root as unknown as Element, "p1");
  h.eq(root.getAttribute(PLOT_SCOPE_ATTR), "p1", "the root is stamped as the scope");
  const styles = Array.from(root.querySelectorAll("style")).map((s) => s.textContent ?? "");
  h.eq(styles[0], `${S} ${MPL}`, "matplotlib preamble scoped in the DOM");
  h.eq(styles[1], `${S} .area{fill:url(#p1__grad)}`, "a class rule is scoped AND its url(#…) still points at the prefixed gradient (FIG-11 kept)");
  h.eq(root.querySelector("g")?.getAttribute("id"), "p1__figure_1", "id prefixing unchanged");
}
{
  const plain = parsePlotSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`)!;
  prefixIds(plain as unknown as Element, "p2");
  h.ok(!plain.hasAttribute(PLOT_SCOPE_ATTR), "a style-less plot gets no scope attribute (byte-identical output)");
}
{
  const root = parsePlotSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>*{a:b}</style></svg>`)!;
  scopePlotStyles(root as unknown as Element, 'a"b\\c');
  h.eq(root.querySelector("style")?.textContent, '[data-plot-scope="a\\"b\\\\c"] *{a:b}', "quotes and backslashes in the element id are CSS-escaped");
}

h.section("export twin — buildPlotMarkup over a REAL fluxplot fixture");
{
  const svg = await fs.readFile("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
  const manifest = JSON.parse(await fs.readFile("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
  h.ok(svg.includes(`<style type="text/css">${MPL}</style>`), "the fixture carries the matplotlib preamble (the leak's source)");
  const out = buildPlotMarkup(svg, { id: "el1", x: 0, y: 0, width: 504, height: 360 }, undefined, manifest) ?? "";
  h.ok(out.includes('data-plot-scope="el1"'), "exported plot markup stamps its scope");
  h.ok(out.includes(`[data-plot-scope="el1"] ${MPL}`), "exported preamble is scoped");
  const bare = (out.match(/\*\{/g) ?? []).length;
  const scoped = (out.match(/\[data-plot-scope="el1"\] \*\{/g) ?? []).length;
  h.ok(bare > 0 && bare === scoped, `no unscoped universal rule survives in the export (${scoped}/${bare} scoped)`);
}

await h.done();
