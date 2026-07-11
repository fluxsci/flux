#!/usr/bin/env -S npx tsx
// presence: main-process / build-config source shapes — not headless-drivable (WS-7.5).
// figure-v1 P0b — importer multi-select parity: the batch-import verb exists on
// every agent surface and produces the SAME model outcome as the GUI's Alt+I
// multi-insert (Ctrl+Enter → io.importPlotsFromPaths).
//
//   1. flux-core importPlots(root, figId, paths): semantic-vs-vanilla sidecar
//      resolution, TRUE physical size (pt → CSS px), GUI placement parity
//      (single centers; batch grid-packs via the SAME src/lib/layout functions
//      io.placeIncoming composes), persistence round-trip, sidecar copy.
//   2. CLI `import-plots <figId> <svg…> --root R`.
//   3. Live bridge `import_plots`: allow-listed + fails LOUDLY headless (io.ts
//      is a GUI-runtime module — browser Image/window.fig; the real browser io
//      path is exercised by verify-importer-multi.mjs) + source tripwire that
//      the case delegates to io.importPlotsFromPaths.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import { ALLOWED_COMMANDS, dispatchCommand } from "../src/lib/bridge/commands";
import { gridLayout, emptyRegion } from "../src/lib/layout";
import { elementBBox, unionRect } from "../src/lib/geometry";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (v: number, t: number, tol = 0.01) => Math.abs(v - t) <= tol;

const svgPt = (wpt: number, hpt: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${wpt}pt" height="${hpt}pt" viewBox="0 0 ${wpt} ${hpt}"><rect width="${wpt}" height="${hpt}" fill="#d95f02"/></svg>`;
const MANIFEST = { schemaVersion: "0.1.0", axes: [], series: [], guides: [], overlays: [] };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p0b-"));
try {
  await core.scaffold(root, { title: "P0b" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P", width: 680, height: 850 });

  // Plot files: t1 = semantic (manifest sidecar), t2/t3 = vanilla. 216pt → 288
  // CSS px, 144pt → 192 px (the browser's pt→px conversion, mirrored headless).
  const plots = path.join(root, "plots");
  await fs.writeFile(path.join(plots, "t1.svg"), svgPt(216, 216));
  await fs.writeFile(path.join(plots, "t1.fluxplot.json"), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(plots, "t2.svg"), svgPt(144, 216));
  await fs.writeFile(path.join(plots, "t3.svg"), svgPt(144, 144));

  // --- 1a. single import → semantic plot element, centered at physical size ----
  const one = await core.importPlots(root, figureId, [path.join(plots, "t1.svg")]);
  assert(one.panels.length === 1, "importPlots([t1]) → 1 panel");
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === figureId)!;
    const el = fig.elements.find((e) => e.id === one.panels[0].elementId) as
      | { type: string; x: number; y: number; width: number; height: number }
      | undefined;
    assert(el?.type === "plot", `t1 (manifest sidecar) imports as a SEMANTIC plot element (got ${el?.type})`);
    assert(!!el && near(el.width, 288) && near(el.height, 288), `t1 lands at TRUE physical size 288 px (got ${el?.width}×${el?.height})`);
    assert(!!el && near(el.x, (680 - 288) / 2) && near(el.y, (850 - 288) / 2), `single import centers in the frame (GUI placeIncoming parity) — got (${el?.x}, ${el?.y})`);
    const asset = project.assets.find((a) => a.id === one.panels[0].assetId);
    assert(asset?.kind === "svg" && near(asset.naturalWidth ?? 0, 288), `asset registered at CSS-px natural size (got ${asset?.naturalWidth})`);
    const sidecar = await fs
      .stat(path.join(root, `fig/assets/${one.panels[0].assetId}.fluxplot.json`))
      .then(() => true)
      .catch(() => false);
    assert(sidecar, "FluxPlot manifest copied as an asset-local sidecar (GUI reconnect contract)");
  }

  // --- 1b. batch import → inline plot elements, grid-packed like the GUI ------
  // (figure-v1 P4: EVERY svg is a semantic plot; vanilla files get a DERIVED
  // manifest at prepare time and carry source.svgPath but no manifestPath.)
  const two = await core.importPlots(root, figureId, [path.join(plots, "t2.svg"), path.join(plots, "t3.svg")]);
  assert(two.panels.length === 2, "importPlots([t2, t3]) → 2 panels");
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === figureId)!;
    const els = two.panels.map((p) => fig.elements.find((e) => e.id === p.elementId)!) as Array<{
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      source?: { svgPath?: string; manifestPath?: string };
    }>;
    assert(els.every((e) => e?.type === "plot"), `vanilla svgs import as inline plots (got ${els.map((e) => e?.type).join(",")})`);
    assert(
      els.every((e) => e?.source?.svgPath && !e?.source?.manifestPath),
      "vanilla plots carry svgPath provenance but NO manifestPath (the fluxplot discriminator)",
    );
    assert(near(els[0].width, 192) && near(els[0].height, 288) && near(els[1].width, 192), "batch keeps TRUE physical sizes (192×288, 192×192) — never fit-scaled");

    // Placement parity: recompute what the GUI's placeIncoming/autoArrange does
    // with the SAME pure functions (src/lib/layout + geometry) over the same
    // pre-batch occupancy (the t1 element), and require an exact match.
    const preBatch = fig.elements.filter((e) => !two.panels.some((p) => p.elementId === (e as { id: string }).id));
    const minDim = Math.min(fig.width, fig.height);
    const margin = minDim * 0.04;
    const gap = minDim * 0.02;
    const inner = { x: margin, y: margin, w: fig.width - 2 * margin, h: fig.height - 2 * margin };
    const region = emptyRegion(inner, unionRect(preBatch.map((e) => elementBBox(e as Parameters<typeof elementBBox>[0]))), minDim * 0.03);
    const sizes = [
      { w: 192, h: 288 },
      { w: 192, h: 192 },
    ];
    const meanAspect = sizes.reduce((a, s) => a + s.w / s.h, 0) / sizes.length;
    const expected = gridLayout(sizes, region, gap, meanAspect < 1 ? "rows" : "cols");
    assert(
      els.every((e, i) => near(e.x, expected[i].x) && near(e.y, expected[i].y)),
      `batch placement matches the GUI grid math exactly (got ${els.map((e) => `(${e.x.toFixed(1)},${e.y.toFixed(1)})`).join(" ")}, expected ${expected.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(" ")})`,
    );
    const overlap =
      Math.max(0, Math.min(els[0].x + els[0].width, els[1].x + els[1].width) - Math.max(els[0].x, els[1].x)) *
      Math.max(0, Math.min(els[0].y + els[0].height, els[1].y + els[1].height) - Math.max(els[0].y, els[1].y));
    assert(overlap === 0, "batch-placed plots do not overlap each other");
  }

  // --- 1c. pre-flight: one bad path → NOTHING written --------------------------
  {
    const before = (await core.loadFigModel(root)).project;
    const beforeCount = before.figures.find((f) => f.id === figureId)!.elements.length;
    let threw = "";
    try {
      await core.importPlots(root, figureId, [path.join(plots, "t2.svg"), path.join(plots, "missing.svg")]);
    } catch (e) {
      threw = (e as Error).message;
    }
    const after = (await core.loadFigModel(root)).project;
    const afterCount = after.figures.find((f) => f.id === figureId)!.elements.length;
    assert(/not readable/.test(threw), `bad path fails the whole batch up front (${threw || "no error"})`);
    assert(afterCount === beforeCount && after.assets.length === before.assets.length, "failed batch writes NO elements and NO assets (AGT-12)");
  }

  // --- 2. CLI import-plots -----------------------------------------------------
  try {
    await core.createFigure(root, { id: "figq", name: "Q", width: 680, height: 850 });
    const out = execFileSync(
      "npx",
      ["tsx", "flux-cli.ts", "import-plots", "figq", path.join(plots, "t2.svg"), path.join(plots, "t3.svg"), "--root", root],
      { cwd: path.resolve("."), stdio: "pipe" },
    ).toString();
    const panels = JSON.parse(out) as { assetId: string; elementId: string }[];
    const { project } = await core.loadFigModel(root);
    const figq = project.figures.find((f) => f.id === "figq")!;
    assert(panels.length === 2 && panels.every((p) => figq.elements.some((e) => e.id === p.elementId)), `CLI import-plots added both panels (${panels.map((p) => p.elementId).join(", ")})`);
  } catch (e) {
    assert(false, `CLI import-plots failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // --- 3. live bridge import_plots ----------------------------------------------
  assert((ALLOWED_COMMANDS as readonly string[]).includes("import_plots"), "import_plots is allow-listed on the live bridge");
  {
    let msg = "";
    try {
      await dispatchCommand({ type: "import_plots" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/paths\[\] required/.test(msg), `import_plots without paths fails loudly (${msg || "no error"})`);
    msg = "";
    try {
      await dispatchCommand({ type: "import_plots", paths: [path.join(plots, "t1.svg")] });
    } catch (e) {
      msg = (e as Error).message;
    }
    // Headless there is no window/file bridge: the verb must refuse loudly, not
    // no-op. (The real browser dispatch → io.importPlotsFromPaths path is the
    // ui gate verify-importer-multi.mjs.)
    assert(/GUI runtime import/.test(msg), `import_plots headless fails loudly, not silently (${msg || "no error"})`);
  }
  {
    // Source tripwire (verify-writer-latency style): the bridge case must stay a
    // thin delegation to the SAME io function the GUI importer calls.
    const src = await fs.readFile(path.resolve("src/lib/bridge/commands.ts"), "utf8");
    const m = /case "import_plots": \{([\s\S]*?)\n    \}/.exec(src);
    assert(!!m && /importPlotsFromPaths\(paths\)/.test(m[1]), "bridge import_plots delegates to io.importPlotsFromPaths (source tripwire)");
    const imp = await fs.readFile(path.resolve("src/lib/PlotImporter.svelte"), "utf8");
    assert(/importPlotsFromPaths\(picks\.map\(\(p\) => p\.abs\)\)/.test(imp), "GUI importer inserts via the SAME io.importPlotsFromPaths (source tripwire)");
  }

  console.log(fails === 0 ? "\nP0B IMPORTER PARITY ALL PASS" : `\nP0B IMPORTER PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
