#!/usr/bin/env -S npx tsx
// EXPORT PARITY (slides overhaul WS1) — the export must gather the SAME inputs
// the editor loads, or the exported .html silently diverges from preview:
//  1. sibling-manifest fallback: a plot with only svgPath (no manifestPath, no
//     project.json plots index) still gets its .fluxplot.json sibling.
//  2. bare-assetId morph targets resolve via the plots/<id>.svg convention.
//  3. gaps that WOULD diverge are reported as warnings, not swallowed:
//     part-tracks on a manifest-less plot, missing plot svg, missing media.
//  4. sidecar staleness: a tampered sources hash makes loadExportAssets skip the
//     sidecar and recompute fresh (warning logged).
// Run: npx tsx scripts/verify-slide-export-parity.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as core from "../flux-core/index";
import * as slides from "../flux-core/slides";
import * as slideOps from "../src/lib/slide/ops";
import type { Track } from "../src/lib/slide/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
// The REAL pre-regen fluxplot files (snapshotted from fluxv1) — group parts,
// ticks-as-<use>, the lot. Parity must hold on real generator output.
const FIX = path.join(here, "fixtures", "pre-regen");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-export-parity-"));
try {
  await core.scaffold(root, { title: "Export Parity Test" });

  // Lay plots out by convention only: plots/<assetId>.svg + sibling manifest.
  // No project.json plots index, no manifestPath on the element.
  const plotsDir = path.join(root, "plots", "example_plots");
  await fs.mkdir(plotsDir, { recursive: true });
  for (const name of ["06_scatter_regression", "08_ecdf"]) {
    await fs.copyFile(path.join(FIX, `${name}.svg`), path.join(plotsDir, `${name}.svg`));
    await fs.copyFile(path.join(FIX, `${name}.fluxplot.json`), path.join(plotsDir, `${name}.fluxplot.json`));
  }

  const deck = slideOps.createDeck({ id: "parity", title: "Parity" });
  const sid = slideOps.addSlide(deck, { name: "Scatter" }).id;
  const plotId = slideOps.addElement(deck, sid, {
    type: "plot", id: "el-plot", x: 100, y: 100, width: 800, height: 500, rotation: 0,
    assetId: "example_plots/06_scatter_regression",
    source: { svgPath: "plots/example_plots/06_scatter_regression.svg" }, // svgPath ONLY
  } as never);
  assert(plotId, "plot element added with svgPath only (no manifestPath)");
  const beat = slideOps.addBeat(deck, sid, { label: "build" })!;
  slideOps.setAnimation(deck, sid, beat.id, {
    id: "t1", target: "el-plot", part: "axis.x.ticks", preset: "drawOn", duration: 400,
  } as Track);
  // a morph track to a plot that is NOT on any slide — bare assetId reference
  slideOps.setAnimation(deck, sid, beat.id, {
    id: "t2", target: "el-plot", preset: "morph", duration: 1200,
    to: { assetId: "example_plots/08_ecdf" },
  } as Track);
  await slides.saveDeck(root, deck);

  // --- 1+2: gather resolves manifest via sibling + morph target via convention
  const { payload, warnings } = await slides.gatherDeckPayload(root, "parity");
  const scatter = payload.plots["example_plots/06_scatter_regression"];
  assert(!!scatter?.svg, "plot svg gathered");
  const parts = (scatter.manifest as unknown as { parts?: unknown }).parts;
  assert(!!parts, "manifest gathered via the .fluxplot.json SIBLING (no index, no manifestPath)");
  const ecdf = payload.plots["example_plots/08_ecdf"];
  assert(!!ecdf?.svg, "bare-assetId morph target gathered via plots/<id>.svg convention");
  assert(!!(ecdf.manifest as unknown as { parts?: unknown }).parts, "morph target manifest gathered via sibling");
  assert(warnings.length === 0, `complete deck gathers with zero warnings (got: ${warnings.join("; ")})`);

  // --- 3: divergence gaps produce warnings
  await fs.rm(path.join(plotsDir, "06_scatter_regression.fluxplot.json"));
  const g2 = await slides.gatherDeckPayload(root, "parity");
  assert(
    g2.warnings.some((w) => w.includes("no parts tree")),
    "part-track on a manifest-less plot → parity warning",
  );
  // restore, then break the morph target's svg
  await fs.copyFile(path.join(FIX, "06_scatter_regression.fluxplot.json"), path.join(plotsDir, "06_scatter_regression.fluxplot.json"));
  await fs.rm(path.join(plotsDir, "08_ecdf.svg"));
  const g3 = await slides.gatherDeckPayload(root, "parity");
  assert(
    g3.warnings.some((w) => w.includes("08_ecdf") && w.includes("not found")),
    "missing morph target svg → warning",
  );
  await fs.copyFile(path.join(FIX, "08_ecdf.svg"), path.join(plotsDir, "08_ecdf.svg"));

  // exportDeck surfaces gather warnings alongside size warnings
  await fs.rm(path.join(plotsDir, "06_scatter_regression.fluxplot.json"));
  const res = await slides.exportDeck(root, "parity");
  assert(res.warnings.some((w) => w.includes("no parts tree")), "exportDeck surfaces gather warnings");

  // --- 4: sidecar staleness guard — tamper the hash, expect skip + fresh compute.
  // loadExportAssets caches per process, so drive it in a SUBPROCESS with the
  // tampered sidecar preferred (repo dist/ candidate).
  const sidecarPath = path.join(repoRoot, "dist", "slide-export-assets.json");
  const sidecarRaw = await fs.readFile(sidecarPath, "utf8");
  const sidecar = JSON.parse(sidecarRaw) as { sourcesHash?: string; sources?: string[] };
  assert(!!sidecar.sources?.length && !!sidecar.sourcesHash, "sidecar carries sources + hash (regen via scripts/gen-export-assets.ts)");
  try {
    await fs.writeFile(sidecarPath, JSON.stringify({ ...sidecar, sourcesHash: "0".repeat(64) }));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const probe = `
      import { exportDeckHtml } from ${JSON.stringify(path.join(repoRoot, "src/lib/slide/export/exportDeck.ts"))};
      import * as slides from ${JSON.stringify(path.join(repoRoot, "flux-core/slides.ts"))};
      const { payload } = await slides.gatherDeckPayload(${JSON.stringify(root)}, "parity");
      const r = await exportDeckHtml(payload);
      console.log("BYTES:" + r.bytes);
    `;
    const probePath = path.join(root, "probe.mts");
    await fs.writeFile(probePath, probe);
    const { stdout, stderr } = await run("npx", ["tsx", probePath], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    assert(/stale .*slide-export-assets\.json/.test(stderr), "tampered sidecar hash → stale warning logged");
    assert(/BYTES:\d+/.test(stdout), "export still succeeds via fresh compute");
  } finally {
    await fs.writeFile(sidecarPath, sidecarRaw);
  }

  console.log("\nSLIDE EXPORT PARITY (WS1) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
