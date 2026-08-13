#!/usr/bin/env -S npx tsx
// Headless delete_figure must prune index assets that no remaining figure
// references (2026-08-13: four agent deletes left 14 fig/index.json entries
// pointing at files an agent had removed — ENOENT spam on every subsequent
// load of the project). Contract:
//   • an asset still referenced by ANY remaining figure survives a delete;
//   • an asset referenced by NO remaining figure leaves the index;
//   • asset FILES are never deleted (recompose reuse; the GUI keeps its own
//     entries for snapshot undo — the INDEX must simply never name an asset
//     nothing uses).
//   Run: npx tsx scripts/verify-delete-prune.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-delete-prune");

// hermetic env (verify-f1-core idiom) — before flux-core loads
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "flux-delprune-"));
const HOME = path.join(SCRATCH, "home");
await fs.mkdir(path.join(HOME, ".config"), { recursive: true });
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
process.env.FLUX_NO_MIGRATE = "1";
const core = await import("../flux-core/index");

const PLOT = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
  `<rect id="bar1" x="20" y="40" width="30" height="60" fill="${color}"/></svg>`;

const root = path.join(SCRATCH, "proj");
const readIndex = async () =>
  JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8")) as {
    assets: { id: string; path: string }[];
    figures: { id: string }[];
  };
const assetIds = async () => (await readIndex()).assets.map((a) => a.id).sort();
const filesOnDisk = async () =>
  (await fs.readdir(path.join(root, "fig", "assets"))).filter((f) => f.endsWith(".svg")).length;
const indexConsistent = async () => {
  const idx = await readIndex();
  for (const a of idx.assets) {
    try {
      await fs.access(path.join(root, "fig", a.path));
    } catch {
      return false;
    }
  }
  return true;
};

try {
  await core.scaffold(root, { title: "DeletePrune" });
  const baselineFigures = (await readIndex()).figures.length; // scaffold's starter figure(s)
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  await fs.writeFile(path.join(root, "plots", "p1.svg"), PLOT("#336699"));
  await fs.writeFile(path.join(root, "plots", "p2.svg"), PLOT("#993366"));
  const a = await core.composeFigure(root, [path.join(root, "plots", "p1.svg")], { id: "figa", captionStub: false });
  const b = await core.composeFigure(root, [path.join(root, "plots", "p2.svg")], { id: "figb", captionStub: false });
  const dup = await core.duplicateFigure(root, a.figureId); // shares figa's asset

  const before = await assetIds();
  h.ok(before.length === 2, `two composed assets in the index (got ${before.length})`);
  h.ok(await filesOnDisk() === 2, "two asset files on disk");

  h.section("delete with a surviving reference");
  await core.deleteFigure(root, a.figureId);
  h.ok((await assetIds()).length === 2, "asset shared with the duplicate figure survives the delete");
  h.ok(await indexConsistent(), "every index asset entry still has its file");

  h.section("delete the last reference");
  await core.deleteFigure(root, dup.figureId);
  const afterDup = await assetIds();
  h.ok(afterDup.length === 1, `unreferenced asset pruned from the index (got ${afterDup.length})`);
  h.ok(await filesOnDisk() === 2, "asset FILES are never deleted (recompose reuse)");
  h.ok(await indexConsistent(), "index stays consistent with disk");

  await core.deleteFigure(root, b.figureId);
  h.ok((await assetIds()).length === 0, "deleting the last plot-bearing figure empties the asset index");
  h.ok((await readIndex()).figures.length === baselineFigures, "only the scaffold starter figure(s) remain");
  h.ok(await filesOnDisk() === 2, "files still on disk after all deletes");
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true });
}
await h.done();
