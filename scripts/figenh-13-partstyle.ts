#!/usr/bin/env -S npx tsx
// figure-v1 Phase 1 — the override foundation.
//
// Root cause under test: semantic ids sit on <g> WRAPPERS while matplotlib puts
// explicit inline styles on the child drawables, so wrapper-level style writes
// were silently defeated for every paint/font property (only display:none and
// opacity worked). applyOverrides must now DRILL paint/font props to drawable
// descendants, keep hidden/opacity/dx/dy on the wrapper, and the cache pass
// must normalize shared <use>/defs markers so per-instance styling is possible.
//
//  Run: npx tsx scripts/figenh-13-partstyle.ts
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { preparePlot, applyOverrides, parsePlotSvg, drawablesUnder } = await import("../src/lib/plot/parse");
const { normalizeSvgForParts } = await import("../src/lib/plot/derive");
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const attr = (root: Element, id: string, name: string) =>
  root.querySelector(`[id="${id}"]`)?.getAttribute(name) ?? null;
const styleOf = (root: Element, id: string) => attr(root, id, "style") ?? "";

// ---------------------------------------------------------------------------
// Fixture: a matplotlib-shaped snippet — g-wrapped text with inline styles,
// gridline paths with fill:none, two ticks sharing ONE defs marker, a per-point
// <use> carrying a semantic id, and hostile content for the sanitizer.
// ---------------------------------------------------------------------------
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="360pt" height="216pt" viewBox="0 0 360 216">
 <script>alert(1)</script>
 <g id="figure">
  <foreignObject width="10" height="10"><div>x</div></foreignObject>
  <g id="plot-area">
   <g id="axis.x">
    <g id="axis.x.gridline.1"><path d="M 10 0 L 10 100" style="fill: none; stroke: #dad8ce; stroke-width: 0.8"/></g>
    <g id="axis.x.tick.1">
     <defs><path id="mDEF" d="M 0 0 L 0 4.5" style="stroke: #575653"/></defs>
     <g><use xlink:href="#mDEF" x="10" y="100" style="fill: #575653; stroke: #575653"/></g>
    </g>
    <g id="axis.x.tick.2"><g><use xlink:href="#mDEF" x="60" y="100" style="fill: #575653; stroke: #575653"/></g></g>
    <g id="axis.x.ticklabel.1" onclick="evil()">
     <text style="font-size: 5px; font-family: 'Arial'; text-anchor: middle; fill: #100f0f" x="10" y="110" transform="rotate(-0 10 110)">0</text>
    </g>
   </g>
   <g id="ctl"><path id="ctl.line" d="M 0 0 L 100 50" style="fill: none; stroke: #cc0000; stroke-width: 1.5"/></g>
   <use id="ctl.point.2" xlink:href="#mDEF" x="42" y="43" data-role="point" data-index="2"/>
   <a href="https://evil.example/x"><g id="orphan_1"><rect x="1" y="1" width="2" height="2"/></g></a>
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
  series: [],
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
              { id: "axis.x.ticks", role: "group", groupRole: "tick", members: ["axis.x.tick.1", "axis.x.tick.2"] },
              { id: "axis.x.tick-labels", role: "group", groupRole: "tick-label", members: ["axis.x.ticklabel.1"] },
            ],
          },
          { id: "ctl", role: "series", children: [{ ref: "ctl.line", role: "line" }] },
        ],
      },
    ],
  },
} as unknown as FluxPlotManifest;

// ---------------------------------------------------------------------------
// 1. normalize: sanitize + <use> inlining + determinism
// ---------------------------------------------------------------------------
console.log("normalize:");
const prep = preparePlot(SVG, MANIFEST);
assert(prep.root, "preparePlot parses the SVG");
const root = prep.root as unknown as Element;

assert(!root.querySelector("script"), "sanitize: <script> removed");
assert(!root.querySelector("foreignObject"), "sanitize: <foreignObject> removed");
assert(attr(root, "axis.x.ticklabel.1", "onclick") === null, "sanitize: on* handler attribute stripped");
assert(root.querySelector("a")?.getAttribute("href") === null, "sanitize: external href stripped");

assert(root.querySelectorAll("use").length === 0, "use-inline: every defs-referencing <use> replaced");
assert(!root.querySelector('[id="mDEF"]'), "use-inline: the now-unreferenced def was removed");
const tick1Path = root.querySelector('[id="axis.x.tick.1"] path');
const tick2Path = root.querySelector('[id="axis.x.tick.2"] path');
assert(tick1Path && tick2Path && tick1Path !== tick2Path, "use-inline: each tick owns its own cloned path");
assert((tick1Path?.getAttribute("transform") ?? "").includes("translate(10 100)"), "use-inline: tick 1 keeps its x/y placement");
assert((tick2Path?.getAttribute("transform") ?? "").includes("translate(60 100)"), "use-inline: tick 2 keeps its x/y placement");
const t1Style = tick1Path?.getAttribute("style") ?? "";
assert(/stroke:\s*#575653/.test(t1Style), "use-inline: def's own declared stroke wins");
assert(/fill:\s*#575653/.test(t1Style), "use-inline: use-level fill (undeclared on def) merged in");
const pt = root.querySelector('[id="ctl.point.2"]');
assert(pt && pt.tagName.toLowerCase() === "path", "use-inline: semantic per-point <use> became its own node keeping the id");
assert(pt?.getAttribute("data-index") === "2", "use-inline: data-* attributes carried onto the replacement");

// determinism / idempotence
const again = parsePlotSvg(SVG) as unknown as Element;
normalizeSvgForParts(again);
normalizeSvgForParts(again); // twice on the same tree
const onceMore = parsePlotSvg(SVG) as unknown as Element;
normalizeSvgForParts(onceMore);
assert(String(again) === String(onceMore), "normalize: deterministic + idempotent (double-run == single-run on fresh parse)");

// orphan defense still composes with normalization
const partsStr = JSON.stringify(prep.manifest?.parts ?? {});
assert(partsStr.includes("unclassified") && partsStr.includes("orphan_1"), "preparePlot: orphan defense picked up the un-manifested id");

// ---------------------------------------------------------------------------
// 2. applyOverrides: drill semantics
// ---------------------------------------------------------------------------
console.log("applyOverrides:");
const EID = "el9";
// prefix ids the way mountPlot does
const { prefixIds } = await import("../src/lib/plot/parse");
prefixIds(root, EID);
const P = (id: string) => `${EID}__${id}`;

applyOverrides(
  root,
  {
    "axis.x.ticklabel.1": { fill: "#cc0000", fontSize: 8, fontStyle: "italic", textDecoration: "underline" },
    "axis.x.ticks": { stroke: "#00aa00" },
    "axis.x.gridlines": { fill: "#123456", strokeWidth: 2 },
    ctl: { hidden: true, opacity: 0.5 },
    "ctl.line": { fill: "#0000ff", dx: 3, dy: -2 },
  },
  EID,
  prep.manifest,
);

// text drill: the <text> child carries the new declarations (beats its own inline style)
const labelText = root.querySelector(`[id="${P("axis.x.ticklabel.1")}"] text`) as Element;
const lt = labelText.getAttribute("style") ?? "";
assert(/fill:\s*#cc0000/.test(lt), "drill: fill landed ON THE <text> drawable, not the wrapper");
assert(/font-size:\s*8px/.test(lt), "drill: fontSize landed on the <text>");
assert(/font-style:\s*italic/.test(lt), "drill: fontStyle (new key) landed on the <text>");
assert(/text-decoration:\s*underline/.test(lt), "drill: textDecoration (new key) landed on the <text>");

// group fan-out + per-instance independence (the shared-def bug is dead)
const s1 = tick1Path?.getAttribute("style") ?? "";
const s2 = tick2Path?.getAttribute("style") ?? "";
assert(/stroke:\s*#00aa00/.test(s1) && /stroke:\s*#00aa00/.test(s2), "group key fans out to both inlined ticks");
applyOverrides(root, { "axis.x.tick.1": { stroke: "#ff00ff" } }, EID, prep.manifest);
assert(/stroke:\s*#ff00ff/.test(tick1Path?.getAttribute("style") ?? ""), "leaf key restyles tick 1 alone");
assert(/stroke:\s*#00aa00/.test(tick2Path?.getAttribute("style") ?? ""), "tick 2 unaffected by tick 1's leaf override");

// fill:none guard: group-level fill skips the fill:none gridline path...
const grid = root.querySelector(`[id="${P("axis.x.gridline.1")}"] path`) as Element;
const gs = grid.getAttribute("style") ?? "";
assert(!/fill:\s*#123456/.test(gs), "fill:none guard: group-level fill does NOT fill a fill:none path");
assert(/stroke-width:\s*2/.test(gs), "…but strokeWidth from the same group override applies");
// ...while a LEAF-level fill (explicit intent on exactly that node) does apply
const ctlLine = root.querySelector(`[id="${P("ctl.line")}"]`) as Element;
assert(/fill:\s*#0000ff/.test(ctlLine.getAttribute("style") ?? ""), "leaf-level fill overrides even a fill:none path (explicit intent)");

// wrapper-level props. NOTE the container key "ctl" resolves through the
// manifest to its leaf "ctl.line" (regeneration-safe fan-out, unchanged
// semantics) — so hidden/opacity land on the resolved target's node.
const ctlLineNode = root.querySelector(`[id="${P("ctl.line")}"]`) as Element;
const cw = ctlLineNode.getAttribute("style") ?? "";
assert(/display:\s*none/.test(cw), "hidden lands on the resolved target node (display:none)");
assert(/opacity:\s*0\.5/.test(cw), "opacity lands on the resolved target node (compositing, not inheritance)");

// dx/dy: transform prepended, original preserved
const tr = ctlLine.getAttribute("transform") ?? "";
assert(tr.startsWith("translate(3 -2)"), "dx/dy: translate prepended to the target's transform");
// the label's original rotate() must survive a dx/dy on IT
applyOverrides(root, { "axis.x.ticklabel.1": { dx: 1, dy: 1 } }, EID, prep.manifest);
const wrapTr = (root.querySelector(`[id="${P("axis.x.ticklabel.1")}"]`) as Element).getAttribute("transform") ?? "";
assert(wrapTr.startsWith("translate(1 1)"), "dx/dy: applies to the id-carrying wrapper");

// drawablesUnder: excludes defs content
const dgs = drawablesUnder(root.querySelector(`[id="${P("figure")}"]`) as Element);
assert(dgs.length > 0 && dgs.every((d) => !String(d.tagName).match(/^defs$/i)), "drawablesUnder finds drawables, none from <defs>");

console.log("\nfigenh-13-partstyle: ALL OK");
