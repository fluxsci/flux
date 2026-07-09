#!/usr/bin/env -S npx tsx
// figure-v1 Phase 2 — part properties foundation (plot/partStyle.ts + the
// extended buildPartIndex).
//
// Under test:
//  - partKind inference matrix: manifest roles, groupRole mapping for groups,
//    an authored data-kind attribute (authoritative), and the DOM-tag fallback;
//  - buildPartIndex now indexes the ENTIRE parts tree (containers, groups, and
//    member leaves) so ticklabel / axis-title ids resolve to real roles+labels
//    (they used to fall back to role:"part"), with richer series entries winning;
//  - readPartStyle precedence: override → drawable inline style / presentation
//    attrs → pristine plotDom cache (headless — no live DOM, no computed style);
//  - partBreadcrumb root→node labels; resolvePartId preferring covered ids;
//  - isScaffoldPart (the canvas part-move fall-through contract).
//
//  Run: npx tsx scripts/figenh-14-partfields.ts
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { buildPartIndex, prefixIds } = await import("../src/lib/plot/parse");
const { cachePlot } = await import("../src/lib/plot/store");
const {
  partKind,
  partKindFromRole,
  readPartStyle,
  partBreadcrumb,
  partDisplayLabel,
  isScaffoldPart,
  resolvePartId,
} = await import("../src/lib/plot/partStyle");
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { SemanticPlotElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

// ---------------------------------------------------------------------------
// Fixture: matplotlib-shaped — g-wrapped text with inline styles, a title with
// PRESENTATION attributes, fill:none gridlines, a background patch (no manifest
// coverage), and unknown-role nodes for the tag fallback + data-kind override.
// ---------------------------------------------------------------------------
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360pt" height="216pt" viewBox="0 0 360 216">
 <g id="figure">
  <g id="patch_1"><path d="M 0 216 L 360 216 L 360 0 L 0 0 z" style="fill: #fffcf0"/></g>
  <g id="plot-area">
   <g id="axis.x">
    <g id="axis.x.gridline.1"><path d="M 10 0 L 10 100" style="fill: none; stroke: #dad8ce; stroke-width: 0.8"/></g>
    <g id="axis.x.ticklabel.1">
     <text style="font-size: 5px; font-family: 'Lato'; text-anchor: middle; fill: #100f0f" x="10" y="110">0</text>
    </g>
    <g id="axis.x.title"><text font-size="11" fill="#333333" x="180" y="130">time (h)</text></g>
   </g>
   <g id="ctl"><path id="ctl.line" d="M 0 0 L 100 50" style="fill: none; stroke: #cc0000; stroke-width: 1.5"/></g>
   <g id="misc.box"><rect x="1" y="1" width="4" height="4" style="fill: #123456"/></g>
   <g id="misc.trace"><path d="M 0 0 L 9 9" style="fill: none; stroke: #00aa00"/></g>
   <g id="misc.note" data-kind="line"><text x="5" y="5" style="fill: #100f0f">hint</text></g>
  </g>
 </g>
</svg>`;

const MANIFEST = {
  spec: "fluxplot/manifest",
  schemaVersion: "0.2.0",
  plotType: "line",
  svg: "t.svg",
  size: { width: 360, height: 216, unit: "pt" },
  axes: [],
  series: [{ id: "ctl", role: "series", kind: "line", svg: { line: "ctl.line" } }],
  parts: {
    id: "figure",
    role: "figure",
    children: [
      {
        id: "plot-area",
        role: "plot-area",
        children: [
          {
            id: "axis.x",
            role: "axis",
            axis: "x",
            children: [
              { id: "axis.x.gridlines", role: "group", groupRole: "gridline", members: ["axis.x.gridline.1"] },
              { id: "axis.x.tick-labels", role: "group", groupRole: "tick-label", members: ["axis.x.ticklabel.1"] },
              { id: "axis.x.title" },
            ],
          },
          { id: "ctl", role: "series", children: [{ ref: "ctl.line", role: "line" }] },
          { id: "misc.box" },
          { id: "misc.trace" },
          { id: "misc.note" },
        ],
      },
    ],
  },
} as unknown as FluxPlotManifest;

const ASSET = "asset-pf";
const ok = cachePlot(ASSET, SVG, MANIFEST);
assert(ok, "cachePlot parsed + cached the fixture (preparePlot seam)");
// The manifest cachePlot stored may be orphan-augmented; use it like the app does.
const { plotManifests } = await import("../src/lib/plot/store");
const { get } = await import("svelte/store");
const M = get(plotManifests)[ASSET] as FluxPlotManifest;

// ---------------------------------------------------------------------------
// 1. extended buildPartIndex — whole tree + members + richer entries win
// ---------------------------------------------------------------------------
console.log("buildPartIndex (extended):");
const idx = buildPartIndex(M);
assert(idx["axis.x.ticklabel.1"]?.role === "tick-label", "member leaf ticklabel indexed with role tick-label (was role:'part' fallback)");
assert(idx["axis.x.ticklabel.1"]?.label === "Tick label 1", `member label humanized ("${idx["axis.x.ticklabel.1"]?.label}")`);
assert(idx["axis.x.title"]?.role === "axis-title", "axis title node indexed (role inferred from id)");
assert(idx["axis.x.tick-labels"]?.role === "tick-label", "group node indexed under its groupRole");
assert(idx["axis.x"]?.role === "axis" && idx["figure"]?.role === "figure", "containers indexed");
assert(idx["ctl.line"]?.role === "line" && idx["ctl.line"]?.series === "ctl", "series entry overwrites tree entry (richer wins: has series id)");
assert(!idx["patch_1"], "background patch stays un-indexed (not manifest content)");

// ---------------------------------------------------------------------------
// 2. partKind matrix
// ---------------------------------------------------------------------------
console.log("partKind:");
const root = (await import("../src/lib/plot/store")).plotDom.get(ASSET) as unknown as Element;
const nodeOf = (id: string) => root.querySelector(`[id="${id}"]`);

assert(partKind(M, "axis.x.ticklabel.1", nodeOf("axis.x.ticklabel.1")) === "text", "role: tick-label → text");
assert(partKind(M, "axis.x.title") === "text", "role: axis-title (inferred from id, no DOM needed) → text");
assert(partKind(M, "axis.x.gridline.1") === "line", "role: gridline member → line");
assert(partKind(M, "axis.x.gridlines") === "line", "groupRole: gridlines group → line");
assert(partKind(M, "axis.x.tick-labels") === "text", "groupRole: tick-labels group → text");
assert(partKind(M, "ctl") === "container", "role: series → container");
assert(partKind(M, "figure") === "container", "role: figure → container");
assert(partKind(M, "misc.box", nodeOf("misc.box")) === "shape", "unknown role, first drawable <rect> → shape");
assert(partKind(M, "misc.trace", nodeOf("misc.trace")) === "line", "unknown role, <path fill:none> → line");
assert(partKind(M, "misc.note", nodeOf("misc.note")) === "line", "data-kind attribute is AUTHORITATIVE (text node authored as line)");
assert(partKind(M, "misc.note") === "shape", "…without the DOM node the unknown role falls back to shape");
assert(partKindFromRole("tick-label") === "text" && partKindFromRole("spine") === "line" && partKindFromRole("legend") === "container" && partKindFromRole("point") === "shape", "partKindFromRole reproduces the X-Ray precedence");

// ---------------------------------------------------------------------------
// 3. readPartStyle — precedence + pristine-DOM (headless) fallback
// ---------------------------------------------------------------------------
console.log("readPartStyle:");
const mkEl = (overrides?: SemanticPlotElement["overrides"]): SemanticPlotElement =>
  ({
    type: "plot",
    id: "el1",
    x: 0,
    y: 0,
    width: 480,
    height: 288,
    rotation: 0,
    assetId: ASSET,
    overrides,
  }) as SemanticPlotElement;

// no live DOM in this process (document body empty) → the pristine plotDom cache serves reads
const plain = mkEl();
const tl = readPartStyle(plain, "axis.x.ticklabel.1", M);
assert(tl.fontSize === 5, `ticklabel fontSize from the drawable's inline style (${tl.fontSize})`);
assert(tl.fontFamily === "Lato", `fontFamily unquoted (${tl.fontFamily})`);
assert(tl.fill === "#100f0f", "fill from inline style");
assert(tl.fontWeight === 400 && tl.fontStyle === "normal" && tl.textDecoration === "none", "font weight/style/decoration defaults");
assert(tl.hidden === false && tl.dx === 0 && tl.dy === 0 && tl.opacity === 1, "wrapper-level defaults (hidden/dx/dy/opacity)");

const title = readPartStyle(plain, "axis.x.title", M);
assert(title.fontSize === 11 && title.fill === "#333333", "presentation ATTRIBUTES read when no inline style (axis title)");

const grid = readPartStyle(plain, "axis.x.gridline.1", M);
assert(grid.stroke === "#dad8ce" && grid.strokeWidth === 0.8, "line kind reads stroke/strokeWidth from the drawable");
assert(!("fontSize" in grid), "line kind omits text keys (only meaningful keys returned)");

const cont = readPartStyle(plain, "ctl", M);
assert(!("fill" in cont) && !("stroke" in cont) && "opacity" in cont && "hidden" in cont, "container kind returns only visible/opacity/dx/dy");

const ov = mkEl({
  "axis.x.ticklabel.1": { fontSize: 9, fill: "#cc0000", dx: 3, dy: -2, hidden: true, opacity: 0.4 },
});
const tlo = readPartStyle(ov, "axis.x.ticklabel.1", M);
assert(tlo.fontSize === 9 && tlo.fill === "#cc0000", "overrides beat the DOM values");
assert(tlo.dx === 3 && tlo.dy === -2 && tlo.hidden === true && tlo.opacity === 0.4, "dx/dy/hidden/opacity read from the override");

// ---------------------------------------------------------------------------
// 4. partBreadcrumb + partDisplayLabel
// ---------------------------------------------------------------------------
console.log("breadcrumb:");
const crumb = partBreadcrumb(M, "axis.x.ticklabel.1");
assert(
  JSON.stringify(crumb) === JSON.stringify(["Figure", "Plot area", "X axis", "Tick labels", "Tick label 1"]),
  `member breadcrumb root→leaf (${crumb.join(" › ")})`,
);
const crumb2 = partBreadcrumb(M, "ctl.line");
assert(JSON.stringify(crumb2) === JSON.stringify(["Figure", "Plot area", "Series: ctl", "Line"]), `node breadcrumb (${crumb2.join(" › ")})`);
assert(partBreadcrumb(M, "nope.42").length === 0, "unknown id → empty breadcrumb (caller falls back)");
assert(partBreadcrumb(undefined, "x").length === 0, "no manifest → empty breadcrumb");
assert(partDisplayLabel(M, "axis.x.ticklabel.1") === "Tick label 1", "display label from the extended index");
assert(partDisplayLabel(M, "unknown_9") === "unknown_9", "display label falls back to the raw id");

// ---------------------------------------------------------------------------
// 5. isScaffoldPart + resolvePartId (the canvas part-move contract)
// ---------------------------------------------------------------------------
console.log("scaffold + click resolution:");
assert(isScaffoldPart(M, "figure") && isScaffoldPart(M, "plot-area") && isScaffoldPart(M, "axis.x"), "figure/plot-area/axis are scaffold");
assert(isScaffoldPart(M, "patch_1"), "un-manifested background patch is scaffold (whole-plot drag)");
assert(!isScaffoldPart(M, "axis.x.ticklabel.1") && !isScaffoldPart(M, "ctl.line"), "real parts are NOT scaffold (movable)");
assert(isScaffoldPart(undefined, "anything"), "no manifest → everything scaffold");

// click resolution on a mounted-style (prefixed) clone: the stamped inner
// <text id="nNN"> must resolve to its covered ticklabel ancestor.
const clone = root.cloneNode(true) as Element;
prefixIds(clone, "el1");
const innerText = clone.querySelector(`[id="el1__axis.x.ticklabel.1"] text`);
assert(innerText && innerText.getAttribute("id")?.startsWith("el1__n"), "fixture sanity: inner <text> carries a stamped id");
assert(resolvePartId(M, innerText, "el1") === "axis.x.ticklabel.1", "resolvePartId prefers the covered ancestor over the stamped leaf");
const patchPath = clone.querySelector(`[id="el1__patch_1"] path`);
const resolvedBg = resolvePartId(M, patchPath, "el1");
assert(resolvedBg === "figure", `background click resolves up to the covered "figure" container (${resolvedBg}) → scaffold`);
const bare = resolvePartId(undefined, innerText, "el1");
assert(typeof bare === "string" && bare.startsWith("n"), "without a manifest the nearest raw id still resolves (legacy behavior)");

console.log(fails === 0 ? "\nfigenh-14-partfields: ALL OK" : `\nfigenh-14-partfields: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
