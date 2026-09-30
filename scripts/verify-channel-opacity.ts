// Per-channel alpha (owner inbox 2026-09-30: "fill and stroke should have
// independently adjustable opacity"). fillOpacity / strokeOpacity are optional
// 0–1 element props, independent of `opacity` (which multiplies both); opaque is
// their ABSENCE so files and SVG written before them are byte-identical. Pins:
// the shared op (clamp, delete-at-1, per-type guard), the export serializer
// (the canvas uses the same channelOpacity helper), arrowheads following the
// stroke, the slide tween, the load gate, and the REAL `flux set-style` CLI.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { harness } from "./lib/harness.mjs";
import * as ops from "../src/lib/ops";
import * as slideOps from "../src/lib/slide/ops";
import { elementToSvg } from "../src/lib/export";
import { channelOpacity } from "../src/lib/geometry";
import { lerpElement } from "../src/lib/slide/tween";
import { validateModel } from "../src/lib/project/validate";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import type { Element, Project } from "../src/lib/types";

const h = harness("verify-channel-opacity");
const rect = (): Element => ({ type: "rect", id: "r", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#ff0000", stroke: "#000000", strokeWidth: 2, cornerRadius: 0 });
const line = (): Element => ({ type: "line", id: "l", x: 0, y: 0, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 20, y2: 0, stroke: "#000000", strokeWidth: 2, arrowStart: false, arrowEnd: true });
const text = (): Element => ({ type: "text", id: "t", x: 0, y: 0, width: 10, height: 10, rotation: 0, text: "a", fontFamily: "Arial", fontSize: 12, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000000", sizing: "auto" } as Element);
const project = (elements: Element[]): Project => ({ version: 1, name: "t", canvases: [{ id: "c", name: "C" }], figures: [{ id: "f", name: "F", canvasId: "c", x: 0, y: 0, width: 100, height: 100, elements } as Project["figures"][number]], assets: [], palette: [] });
const svg = (e: Element) => elementToSvg(e, () => "");

// --- the op ---------------------------------------------------------------------------
const p = project([rect(), line(), text()]);
const [r, l, t] = p.figures[0].elements as [Element & { fillOpacity?: number; strokeOpacity?: number }, Element & { strokeOpacity?: number; fillOpacity?: number }, Element];
const untouched = svg(rect());
ops.setElementStyle(p, ["r", "l", "t"], { fillOpacity: 0.4, strokeOpacity: 0.7 });
h.eq([r.fillOpacity, r.strokeOpacity], [0.4, 0.7], "a rect takes both channels independently");
h.eq([l.fillOpacity, l.strokeOpacity], [undefined, 0.7], "a line takes only the stroke channel");
h.ok(!("fillOpacity" in t) && !("strokeOpacity" in t), "a text is untouched by channel alphas");
h.eq(r.opacity, undefined, "channel alphas never write the element opacity");
ops.setElementStyle(p, ["r"], { fillOpacity: 7, strokeOpacity: -1 });
h.eq([r.fillOpacity, r.strokeOpacity], [undefined, 0], "values clamp to 0–1 and opaque (1) is the property's absence");

// --- serialization (both engines use elementToSvg; the canvas uses channelOpacity) ---
h.eq(svg(rect()), untouched, "an element without channel alphas serializes byte-identically");
h.ok(!/opacity/.test(untouched), "…with no opacity attribute at all");
const half = { ...rect(), fillOpacity: 0.5, strokeOpacity: 0.25 } as Element;
h.ok(/fill-opacity="0.5"/.test(svg(half)) && /stroke-opacity="0.25"/.test(svg(half)), "a rect exports fill-opacity and stroke-opacity");
const arrowed = svg({ ...line(), strokeOpacity: 0.3 } as Element);
h.ok(/<line[^>]*stroke-opacity="0.3"/.test(arrowed) && /<polygon[^>]*fill-opacity="0.3"/.test(arrowed), "an arrowhead follows the stroke's alpha");
h.ok(!/fill-opacity/.test(arrowed.replace(/<polygon[^>]*>/g, "")), "a line's body carries no fill alpha");
h.eq([channelOpacity(undefined), channelOpacity(1), channelOpacity(0.2)], [undefined, undefined, 0.2], "channelOpacity omits opaque");

// --- slide tween: absent = opaque on every channel ------------------------------------
const mid = lerpElement(rect(), { ...rect(), fillOpacity: 0 } as Element, 0.5) as Element & { fillOpacity?: number };
h.eq(mid.fillOpacity, 0.5, "a Change from opaque to transparent fill tweens through 0.5");

// --- load gate -------------------------------------------------------------------------
h.eq(validateModel(project([half])).length, 0, "the load gate accepts channel alphas");
h.ok(validateModel(project([{ ...rect(), fillOpacity: 2 } as Element])).length > 0, "…and refuses one above 1");

// --- the REAL CLI ----------------------------------------------------------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-channel-opacity-"));
try {
  const tree = buildScaffoldTree({ title: "Channel alpha" }, slideOps.createDeck());
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, contents] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), contents); }
  const core = await import("../flux-core/model");
  await core.mutateFigModel(root, "seed", (m) => {
    const fig = m.project.figures[0] ?? ops.createFigure(m.project, { canvasId: m.project.canvases[0].id, name: "F", width: 100, height: 100 });
    fig.elements.push(rect());
  });
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", ...args, "--root", root], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1" }, timeout: 30000 });
  const res = run("set-style", "r", "--fill-opacity", "0.35", "--stroke-opacity", "0.6");
  h.eq(res.status, 0, `flux set-style --fill-opacity/--stroke-opacity: ${res.stderr}`);
  const saved = (await core.loadFigModel(root)).project.figures.flatMap((f) => f.elements).find((e) => e.id === "r") as Element & { fillOpacity?: number; strokeOpacity?: number };
  h.eq([saved?.fillOpacity, saved?.strokeOpacity, saved?.opacity], [0.35, 0.6, undefined], "the CLI writes both channels through the shared op");
  const bad = run("set-style", "r", "--fill-opacity", "1.5");
  h.ok(bad.status !== 0, "the CLI refuses an alpha above 1");
} finally { await fs.rm(root, { recursive: true, force: true }); }
await h.done();
