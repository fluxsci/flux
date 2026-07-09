#!/usr/bin/env -S npx tsx
// figure-v1 P5 (pure) — crop agent parity: the same ops.setCrop core behind
//   • the live bridge's `set_crop` verb (explicit id, selection default,
//     null reset, undoable via the store, error paths),
//   • flux-core's setCrop (disk round-trip through mutateFigModel), and
//   • flux-core renderFigureSvg's <image> crop rendering (nested-svg viewport
//     via the new assetSize callback — the headless twin of Element.svelte).
//
//  Run: npx tsx scripts/figenh-crop-parity.ts
import { get } from "svelte/store";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { ImageElement, Project, SemanticPlotElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (a: number | undefined, b: number, tol = 1e-6) => typeof a === "number" && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1) bridge `set_crop` on a live headless store
// ---------------------------------------------------------------------------
const plot: SemanticPlotElement = {
  type: "plot", id: "p1", x: 40, y: 40, width: 672, height: 480, rotation: 0, assetId: "a1",
};
const proj: Project = {
  version: 2, name: "t", canvases: [{ id: "c1", name: "C" }],
  figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 2000, height: 2000, background: "#fff", elements: [plot] }],
  assets: [{ id: "a1", name: "a", kind: "svg", path: "assets/a1.svg", naturalWidth: 672, naturalHeight: 480 }],
  palette: [],
};
store.loadProject(proj, null);
store.activeFigureId.set("f1");
const el = () => get(store.project).figures[0].elements.find((e) => e.id === "p1") as SemanticPlotElement;

{
  const r = (await dispatchCommand({ type: "set_crop", id: "p1", crop: { x: 100, y: 60, width: 300, height: 200 } })) as { id: string };
  assert(r.id === "p1", "set_crop returns the target id");
  const e = el();
  assert(near(e.crop?.x, 100) && near(e.crop?.width, 300), "set_crop wrote the window");
  assert(near(e.x, 140) && near(e.y, 100) && near(e.width, 300) && near(e.height, 200), "set_crop moved the box to frame the window (content pinned)");

  store.undo();
  assert(el().crop === undefined && near(el().x, 40), "set_crop is ONE undoable edit (Ctrl+Z reverts window + box)");
  store.redo();
  assert(near(el().crop?.x, 100), "…and redo restores it");

  // selection-defaulted targeting + null reset
  store.selection.set(new Set(["p1"]));
  await dispatchCommand({ type: "set_crop", crop: null });
  const r2 = el();
  assert(r2.crop === undefined && near(r2.x, 40) && near(r2.width, 672), "set_crop {crop:null} defaults to the selection and resets to the full box");

  let threw = "";
  try {
    await dispatchCommand({ type: "set_crop", id: "p1", crop: { x: 1, y: 2 } });
  } catch (err) {
    threw = String(err);
  }
  assert(/numeric/.test(threw), "malformed crop object throws (needs numeric x/y/width/height)");
  threw = "";
  try {
    await dispatchCommand({ type: "set_crop", id: "nope", crop: null });
  } catch (err) {
    threw = String(err);
  }
  assert(/not found/.test(threw), "unknown id throws");
}

// ---------------------------------------------------------------------------
// 2) flux-core setCrop: disk round-trip + renderFigureSvg <image> crop wrapper
// ---------------------------------------------------------------------------
const core = await import("../flux-core/index");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p5-crop-"));
try {
  await core.scaffold(TMP, { title: "P5 crop parity" });
  const idx = JSON.parse(await fs.readFile(path.join(TMP, "fig/index.json"), "utf8"));
  idx.canvases = [{ id: "canvas-1", name: "Canvas 1", order: 1 }];
  idx.figures = [{ id: "fig-1", name: "Fig", label: "fig-1", order: 1, kind: "main", canvas: "canvas-1", caption: "" }];
  // PNG with a pHYs dpi: display size = 1000×96/300 = 320 × 500×96/300 = 160
  idx.assets = [{ id: "a-png", kind: "png", path: "assets/a-png.png", name: "a", naturalWidth: 1000, naturalHeight: 500, dpi: 300 }];
  await fs.writeFile(path.join(TMP, "fig/index.json"), JSON.stringify(idx, null, 2));
  await fs.mkdir(path.join(TMP, "fig/canvases"), { recursive: true });
  await fs.mkdir(path.join(TMP, "fig/assets"), { recursive: true });
  // minimal valid-enough PNG bytes (renderFigureSvg only base64-inlines them)
  await fs.writeFile(
    path.join(TMP, "fig/assets/a-png.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  await fs.writeFile(
    path.join(TMP, "fig/canvases/canvas-1.json"),
    JSON.stringify({
      schemaVersion: "0.1.0", id: "canvas-1", name: "Canvas 1",
      figures: [{
        id: "fig-1", name: "Fig", canvasId: "canvas-1", x: 0, y: 0, width: 800, height: 600, background: "#fff",
        elements: [{ type: "image", id: "img1", x: 0, y: 0, width: 320, height: 160, rotation: 0, assetId: "a-png" }],
      }],
    }, null, 2),
  );

  await core.setCrop(TMP, "img1", { x: 20, y: 10, width: 100, height: 50 });
  const m1 = await core.loadFigModel(TMP);
  const img1 = m1.project.figures[0].elements[0] as ImageElement;
  assert(near(img1.crop?.x, 20) && near(img1.crop?.width, 100), "flux-core setCrop persists the window to disk");
  assert(near(img1.x, 20) && near(img1.y, 10) && near(img1.width, 100) && near(img1.height, 50), "flux-core setCrop moved the box (content pinned; dpi-derived display units)");

  const svg = await core.renderFigureSvg(TMP, "fig-1");
  assert(/<svg x="20" y="10" width="100" height="50" viewBox="20 10 100 50" preserveAspectRatio="none" overflow="hidden">/.test(svg), "renderFigureSvg wraps the cropped <image> in a nested-svg viewport (viewBox = window)");
  assert(/<image x="0" y="0" width="320" height="160" preserveAspectRatio="none" href="data:image\/png;base64/.test(svg), "…with the image at full DISPLAY size inside (natural×96/dpi)");

  await core.setCrop(TMP, "img1", null);
  const m2 = await core.loadFigModel(TMP);
  const img2 = m2.project.figures[0].elements[0] as ImageElement;
  assert(img2.crop === undefined && near(img2.x, 0) && near(img2.width, 320), "flux-core setCrop(null) resets to the full display-size box");
  const svg2 = await core.renderFigureSvg(TMP, "fig-1");
  assert(!/viewBox="20 10 100 50"/.test(svg2) && /<image x="0" y="0" width="320" height="160"/.test(svg2), "…and the render drops the wrapper (plain <image> again)");

  let threw = "";
  try {
    await core.setCrop(TMP, "missing", null);
  } catch (err) {
    threw = String(err);
  }
  assert(/not found/.test(threw), "flux-core setCrop throws for an unknown element");
} finally {
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nFIGENH-CROP-PARITY ALL PASS" : `\nFIGENH-CROP-PARITY ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
