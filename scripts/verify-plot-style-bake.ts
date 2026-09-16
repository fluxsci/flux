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

const { parsePlotSvg, bakePlotStyles, splitPlotCss, prefixIds, hoistPlotClips } = await import("../src/lib/plot/parse");

const h = harness("verify-plot-style-bake");
const MPL = "*{stroke-linejoin: round; stroke-linecap: butt}";
const wrap = (inner: string, style = MPL) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="60" viewBox="0 0 100 60"><defs><style type="text/css">${style}</style></defs>${inner}</svg>`;

h.section("splitPlotCss — rules vs residual (pure string)");
{
  const r = splitPlotCss(MPL);
  h.eq(r.rules.length, 1, "the matplotlib preamble is one bakeable rule");
  h.eq(r.rules[0].selector, "*", "…with the universal selector");
  h.eq(r.rules[0].decls.map((d) => d.join("=")).join(";"), "stroke-linejoin=round;stroke-linecap=butt", "…and both declarations");
  h.eq(r.residual.trim(), "", "…and nothing left over");
}
{
  const r = splitPlotCss(".a:hover{fill:red} .b{fill:blue !important} @font-face{font-family:F;src:url(f)} .c{fill:green;mix-blend-mode:multiply}");
  h.eq(r.rules.map((x) => x.selector).join(","), ".c", "pseudo-class, !important and at-rules are not baked; the plain rule is");
  h.ok(/\.a:hover\{fill:red\}/.test(r.residual) && /!important/.test(r.residual) && /@font-face/.test(r.residual), "pseudo / !important / @font-face stay in the residual sheet");
  h.ok(/\.c\{mix-blend-mode:multiply\}/.test(r.residual), "a non-presentation property of a baked rule stays in the residual");
}
{
  const r = splitPlotCss("g > .x, #id .y{fill:red} .z{fill:blue}");
  h.eq(r.rules.length, 3, "a comma list yields one rule per selector");
  h.ok(r.rules[1].specificity > r.rules[0].specificity && r.rules[0].specificity > r.rules[2].specificity, "specificity orders id > class+type > class");
}

h.section("bakePlotStyles — the cascade is preserved exactly (linkedom DOM)");
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
  h.eq(attr("p3", "stroke-linecap"), null, "an inline style declaration beats the rule — left alone (no shadowing attribute)");
  h.eq(attr("p3", "stroke-linejoin"), "round", "…but the inline-less property of the same element is still baked");
  h.eq(attr("p4", "stroke-linecap"), "butt", "a descendant of an inline-styled group takes the rule directly (the rule matched it, not the group's inline)");
  h.eq(root.getAttribute("stroke-linecap"), "butt", "the root matches `*` too");
}
{
  const root = parsePlotSvg(wrap(`<g class="a"><path id="q" class="b" d="M0 0"/></g>`, ".b{fill:red} .a .b{fill:green} #q{fill:blue} *{fill:black}"))!;
  bakePlotStyles(root as unknown as Element);
  h.eq(root.querySelector("#q")!.getAttribute("fill"), "blue", "ascending specificity: the id rule wins over class, descendant and universal");
  h.eq(root.querySelector("g")!.getAttribute("fill"), "black", "the universal rule reaches the group");
}
{
  const root = parsePlotSvg(wrap(`<path id="r" d="M0 0"/>`, ".x{fill:red} .x{fill:blue}"))!;
  const dummy = root.querySelector("#r")!;
  dummy.setAttribute("class", "x");
  bakePlotStyles(root as unknown as Element);
  h.eq(dummy.getAttribute("fill"), "blue", "equal specificity: source order wins (later rule)");
}
{
  const root = parsePlotSvg(wrap(`<path id="s" class="k" d="M0 0"/>`, ".k:hover{fill:red} .k{fill:green}"))!;
  const res = bakePlotStyles(root as unknown as Element);
  h.eq(res.kept, 1, "a pseudo-class rule keeps a residual sheet");
  h.ok(root.querySelector("style")!.textContent!.includes(":hover") && !root.querySelector("style")!.textContent!.includes(".k{fill:green}"), "…holding only the unbakeable rule");
  h.eq(root.querySelector("#s")!.getAttribute("fill"), "green", "…while the plain rule was baked");
  prefixIds(root as unknown as Element, "el1");
  h.ok(root.querySelector("style")!.textContent!.startsWith('[data-plot-scope="el1"]'), "the residual sheet is still scoped by prefixIds afterwards");
}
{
  const root = parsePlotSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0"/></svg>`)!;
  const res = bakePlotStyles(root as unknown as Element);
  h.eq(res.baked + res.kept + res.attrs, 0, "a style-less plot is untouched");
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
h.done();
