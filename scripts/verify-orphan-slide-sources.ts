// Actual Figure deletion, retained asset ownership, and offline export. All IO
// stays inside one disposable project; the same fixture drives the GUI gate.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deleteFigure, syncFigureAssets } from "../flux-core/figures";
import { gatherDeckPayload } from "../flux-core/slides";
import { loadFigModel } from "../flux-core/model";
import { figureSourceOwners } from "../src/lib/project/figureSourceOwners";
import { planSourceUpdates } from "../src/lib/plot/sourceSync";
import { orphanSvg, orphanManifest, writeOrphanSourcesFixture } from "./lib/orphanSourcesFixture";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-orphan-sources-"));
const read = (rel: string) => fs.readFile(`${root}/${rel}`, "utf8");
const write = async (rel: string, text: string) => { const file = `${root}/${rel}`; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const io = { readText: (p: string) => fs.readFile(p, "utf8"), exists: async (p: string) => fs.access(p).then(() => true, () => false),
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })) };
let checks = 0;
const eq = (a: unknown, b: unknown, label: string) => { assert.deepEqual(a, b, label); checks++; console.log("  ok:", label); };
try {
  const { deck, ids } = await writeOrphanSourcesFixture({ write, read: (rel) => read(rel).catch(() => null) });
  await deleteFigure(root, "orphan-origin");
  const removed = (await loadFigModel(root)).project;
  eq(removed.figures.length, 0, "actual Figure deletion removes the final originating placement");
  eq(removed.assets.map((a) => a.id).sort(), [...ids].sort(), "deletion retains assets for placed and animation-only deck dependencies");
  for (const id of ids) { await write(`plots/${id}.svg`, orphanSvg(2, 400)); await write(`plots/${id}.fluxplot.json`, orphanManifest(2)); }
  const refreshed = await syncFigureAssets(root);
  eq(refreshed.refreshed.map((a) => a.assetId).sort(), ["orphan-live", "orphan-target"], "remaining deck source owners update their accepted fig bundles");
  const exported = await gatherDeckPayload(root, deck.id);
  eq(exported.warnings, [], "complete deck-owned sources export without gaps");
  eq(ids.map((id) => exported.payload.plots?.[id].svg.match(/data-version="(\d+)"/)?.[1]), ["2", "1", "2"], "placed and morph-only links refresh while the frozen copy retains v1");
  eq(exported.payload.deck.slides[0].elements.map((e) => e.width), [200, 100], "closed deck preserves physical scale and frozen placement size");
  eq(exported.payload.deck.slides[0].beats, deck.slides[0].beats, "source ownership does not rewrite authored animation endpoints");
  eq(exported.payload.deck.stage, deck.stage, "source ownership does not enlarge the fixed deck stage");
  const accepted = (await loadFigModel(root)).project;
  eq(accepted.figures.length, 0, "planning-only deck owners never become persisted Figure compositions");
  eq(accepted.assets.find((a) => a.id === "orphan-live")?.naturalWidth, 400, "accepted intrinsic metadata updates in the retained fig registry");
  eq(JSON.parse(await read("fig/assets/orphan-target.fluxplot.json")).version, 2, "animation-only semantic metadata persists with its SVG");
  await fs.rm(`${root}/plots/orphan-live.svg`);
  const missing = await gatherDeckPayload(root, deck.id);
  eq(missing.payload.plots?.["orphan-live"].svg.includes('data-version="2"'), true, "missing orphan source keeps its last accepted bundle");
  eq(missing.warnings.some((w) => w.includes("orphan-live") && w.includes("missing")), true, "missing orphan source is visible in export diagnostics");
  await write("plots/orphan-live.svg", orphanSvg(2, 400));
  const other = structuredClone(exported.payload.deck); other.id = "other-talk";
  const live = other.slides[0].elements.find((e) => e.id === "orphan-live")!;
  if (live.type === "plot") live.source = { svgPath: "plots/other.svg", frozen: true };
  await write("plots/other.svg", orphanSvg(3, 800));
  // Deliberately unregistered: disk discovery must include a saved deck that
  // still holds a dependency even if project.json missed its registration.
  await write("slides/other-talk/deck.json", JSON.stringify(other));
  const conflicted = await gatherDeckPayload(root, deck.id);
  eq(conflicted.payload.plots?.["orphan-live"].svg.includes('data-version="2"'), true, "conflicting frozen/live paths cannot overwrite the accepted bundle");
  eq(conflicted.warnings.some((w) => w.includes("conflicting source links")), true, "conflicting saved-deck links are diagnosed during export");
  const owners = await figureSourceOwners(root, accepted, io);
  await write("slides/other-talk/deck.json", JSON.stringify({ ...other, title: "Changed during source IO" }));
  await assert.rejects(() => owners.assertUnchanged(), /dependent deck changed/); checks++;
  // A real Figure remains authoritative while it exists, even if a copied
  // deck has a different link. Deck-local ID collisions are excluded too.
  const owning = structuredClone(accepted);
  owning.figures = [{ id: "owner", name: "Owner", canvasId: "c", x: 0, y: 0, width: 10, height: 10, background: "#fff", elements: [deck.slides[0].elements[0]] }];
  const ownedView = await figureSourceOwners(root, owning, io);
  eq(ownedView.deckAssetIds.has("orphan-live"), false, "existing Figure placement keeps source ownership over deck copies");
  const reversed = { ...owners.project, figures: [...owners.project.figures].reverse() };
  const reversedPlan = await planSourceUpdates(root, reversed, io);
  eq(reversedPlan.statuses.find((s) => s.assetId === "orphan-live")?.status, "error", "conflicting frozen/live links are diagnosed regardless of iteration order");
  console.log(`ORPHAN SLIDE SOURCES: PASS (${checks} assertions)`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
