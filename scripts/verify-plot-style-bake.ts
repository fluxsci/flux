#!/usr/bin/env -S npx tsx
// Plot <style> baking — the 2026-09-16 mount-storm fix.
//
// A mounted plot's <style> is a live stylesheet in the editor document; every
// insertion re-invalidates rule sets for the whole document (10–50 ms per plot
// mount) and the rules stay in the cascade forever. bakePlotStyles turns each
// bakeable rule into presentation attributes on the elements it matches and
// drops the sheet, preserving the cascade exactly. This gates the pure half on
// linkedom; verify-vanilla-inline.mjs §2b asserts the live editor cascade.
//   node --import tsx scripts/verify-plot-style-bake.ts
import { parseHTML, DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { parsePlotSvg, bakePlotStyles, prefixIds, hoistPlotClips, applyOverrides } = await import("../src/lib/plot/parse");

const h = harness("verify-plot-style-bake");
const MPL = "*{stroke-linejoin: round; stroke-linecap: butt}";
const wrap = (inner: string, style = MPL) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="60" viewBox="0 0 100 60"><defs><style type="text/css">${style}</style></defs>${inner}</svg>`;

h.section("bakePlotStyles — the cascade is preserved for the supported stroke defaults (linkedom DOM)");
{
  const root = parsePlotSvg(
    wrap(
      `<g id="fig"><path id="p1" d="M0 0L1 1"/><path id="p2" d="M0 0L1 1" stroke-linecap="round"/><path id="p3" d="M0 0L1 1" style="stroke-linecap:round"/><g id="g1" style="stroke-linecap: square"><path id="p4" d="M0 0"/></g></g>`,
    ),
  )!;
  h.ok(!!root, "fixture parses");
  const res = bakePlotStyles(root as unknown as Element);
  h.eq(res.baked, 1, "one rule baked");
  h.eq(res.kept, 0, "no residual sheet");
  h.eq(root.querySelectorAll("style").length, 0, "the <style> element is gone");
  const attr = (id: string, a: string) => root.querySelector(`#${id}`)!.getAttribute(a);
  h.eq(attr("p1", "stroke-linecap"), "butt", "a plain element takes the rule as an attribute");
  h.eq(attr("p1", "stroke-linejoin"), "round", "…both declarations");
  h.eq(attr("p2", "stroke-linecap"), "butt", "a rule beats a presentation attribute — the existing attribute is overwritten");
  h.eq(attr("p3", "stroke-linecap"), "butt", "the rule supplies the attribute fallback; inline CSS still wins");
  h.eq(attr("p3", "stroke-linejoin"), "round", "…but the inline-less property of the same element is still baked");
  h.eq(attr("p4", "stroke-linecap"), "butt", "a descendant of an inline-styled group takes the rule directly (the rule matched it, not the group's inline)");
  h.eq(root.getAttribute("stroke-linecap"), "butt", "the root matches `*` too");
}
h.section("nonuniform CSS remains intact (no partial cascade rewrite)");
for (const css of [
  ".b{fill:red} .a .b{fill:green} #q{fill:blue} *{fill:black}",
  ".k:hover{fill:red} .k{fill:green}",
  "path{fill:red} [fill=red]{stroke:blue}",
  "path:not(.x){fill:blue} .a.b.c{fill:red}",
  "@media (min-width:1px){path{fill:red}} path{fill:green}",
  "path{stroke:blue!important} path{stroke:red}",
  "*{stroke-linecap:butt;--custom:red}",
  "*{stroke-linecap:invalid}",
  "*{stroke-linecap:butt} [unsupported|selector]{fill:blue}",
]) {
  const root = parsePlotSvg(wrap('<path id="q" class="a b c" d="M0 0L10 10"/>', css))!;
  const before = root.outerHTML;
  const res = bakePlotStyles(root as unknown as Element);
  h.eq(root.outerHTML, before, `unsupported CSS is byte-preserved: ${css}`);
  h.eq(res.baked, 0, "no selector/cascade is partially baked");
}
for (const attrs of ['media="print"', 'type="text/other"', 'title="alternate"']) {
  const root = parsePlotSvg(wrap('<path d="M0 0L10 10"/>').replace('type="text/css"', attrs))!;
  const before = root.outerHTML;
  h.eq(bakePlotStyles(root as unknown as Element).baked, 0, `conditional/non-CSS sheet retained: ${attrs}`);
  h.eq(root.outerHTML, before, 'stylesheet conditions are untouched');
}
{
  const root = parsePlotSvg(wrap('<path id="p" d="M0 0"/>') + '')!;
  const st = root.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'style');
  st.textContent = '*{stroke-linecap:square}';
  root.appendChild(st);
  bakePlotStyles(root as unknown as Element);
  h.eq(root.querySelector('#p')!.getAttribute('stroke-linecap'), 'square', 'later uniform sheet wins');
}
h.section("hoistPlotClips — same-clip sibling runs become one clipped group");
{
  const root = parsePlotSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>
     <g id="axes"><path id="a" clip-path="url(#c)" d="M0 0"/><path id="b" clip-path="url(#c)" d="M1 1"/><g id="t" transform="translate(1 1)" clip-path="url(#c)"><use href="#x"/></g><path id="d" clip-path="url(#c)" d="M2 2"/><path id="e" clip-path="url(#c)" d="M3 3"/><path id="f" clip-path="url(#d2)" d="M4 4"/><path id="lone" d="M5 5"/></g></svg>`,
  )!;
  const res = hoistPlotClips(root as unknown as Element);
  h.eq(res.groups, 2, "two runs (a,b) and (d,e) → two clipped groups");
  h.eq(res.hoisted, 4, "four elements hoisted");
  const a = root.querySelector("#a")!;
  h.eq(a.parentElement!.localName, "g", "a hoisted element sits inside a new <g>");
  h.eq(a.parentElement!.getAttribute("clip-path"), "url(#c)", "…which carries the clip");
  h.eq(a.getAttribute("clip-path"), null, "…and the child lost its own clip attribute");
  h.eq(a.parentElement, root.querySelector("#b")!.parentElement, "consecutive same-clip siblings share ONE group");
  h.ok(a.parentElement !== root.querySelector("#d")!.parentElement, "a run broken by a transformed sibling starts a new group");
  const t = root.querySelector("#t")!;
  h.eq(t.getAttribute("clip-path"), "url(#c)", "a child with its own transform keeps its own clip (different user space)");
  h.eq(t.parentElement!.id, "axes", "…and is not wrapped");
  h.eq(root.querySelector("#f")!.getAttribute("clip-path"), "url(#d2)", "a lone clipped element (run of 1) is untouched");
  h.eq(Array.from(root.querySelector("#axes")!.children).map((c) => c.id || c.localName).join(","), "g,t,g,f,lone", "sibling order is preserved");
  h.eq(root.querySelectorAll("clipPath [clip-path], defs [clip-path]").length, 0, "nothing inside <defs>/<clipPath> is rewritten");
}
h.section("clip units, structure and semantic motion");
for (const body of [
  '<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath></defs><path clip-path="url(#c)"/><path clip-path="url(#c)"/>',
  '<defs><clipPath id="c"><rect width="5" height="5"/></clipPath><g><path clip-path="url(#c)"/><path clip-path="url(#c)"/></g></defs>',
  '<defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><text clip-path="url(#c)">a</text><text clip-path="url(#c)">b</text>',
  '<style>svg > path{fill:red}</style><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><path clip-path="url(#c)"/><path clip-path="url(#c)"/>',
  '<defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><path clip-path="url(#c)"><animateTransform attributeName="transform" type="translate" values="0;10" dur="1s"/></path><path clip-path="url(#c)"/>',
]) {
  const root = parsePlotSvg(wrap(body, ''))!;
  const before = root.outerHTML;
  h.eq(hoistPlotClips(root as unknown as Element).hoisted, 0, 'unsafe clip run is left intact');
  h.eq(root.outerHTML, before, 'no geometry or selector semantics changed');
}
{
  const root = parsePlotSvg(wrap('<defs><clipPath id="c"><rect width="40" height="40"/></clipPath></defs><path id="a" d="M0 0h80v40z" clip-path="url(#c)"/><path id="b" d="M0 40h80v40z" clip-path="url(#c)"/>', ''))!;
  hoistPlotClips(root as unknown as Element);
  prefixIds(root as unknown as Element, 'plot');
  applyOverrides(root as unknown as Element, {a:{dx:20}}, 'plot');
  const a = root.querySelector('#plot__a')!, b = root.querySelector('#plot__b')!;
  h.eq(a.getAttribute('clip-path'), 'url(#plot__c)', 'a translated part regains its own prefixed clip');
  h.eq(b.getAttribute('clip-path'), 'url(#plot__c)', 'its sibling retains the original clip');
  h.eq(a.parentElement!.getAttribute('clip-path'), null, 'no fixed parent clip truncates the moving part');
}
h.section("prepared render cache follows semantic source changes");
{
  const {buildPlotMarkup} = await import('../src/lib/plot/inlineMarkup');
  const svg = wrap('<path id="a" d="M0 0h20v20z"/><path id="b" d="M30 0h20v20z"/>', '');
  const frame = {id:'cached',x:0,y:0,width:100,height:60};
  const manifest = (members: string[]) => ({parts:{id:'root',role:'group',children:[{id:'group',role:'group',members}]}}) as any;
  const first = buildPlotMarkup(svg, frame, {group:{hidden:true}}, manifest(['a']))!;
  const second = buildPlotMarkup(svg, frame, {group:{hidden:true}}, manifest(['b']))!;
  h.ok(first !== second, 'same SVG with changed sidecar has a distinct render');
  h.ok(/display\s*:\s*none/.test(parsePlotSvg(second)!.querySelector('#cached__b')!.getAttribute('style') ?? ''), 'new manifest targets the correct part');
  h.ok(!/display/.test(parsePlotSvg(second)!.querySelector('#cached__a')!.getAttribute('style') ?? ''), 'previous manifest does not leak into the next render');
}
h.done();
