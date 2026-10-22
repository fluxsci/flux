// Plots rail focus + dissections arrangement (pure).
//   * src/lib/plotsRail/focusPlot.ts — the ONE selection→plot ladder (drilled part → owner;
//     single selection; several → the last plot-like one), where a plot's companions live
//     (external/library → none; sourceless → asset name; a placed DISSECTION FILE → its owner
//     plot, that file selected), and the store (sticky on deselect, pinned ignores changes,
//     last writer wins between canvas and gallery);
//   * src/lib/dissect/state.ts keeps no private copy of the ladder (the `d` hotkey uses it);
//   * src/lib/plotsRail/dissectionsModel.ts — summary first (`_stats` first), loose files as
//     "Overview", image groups, other files last;
//   * src/lib/plotsRail/tableCard.ts — card parsing, transposed one-row wide tables, heights.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-plots-rail-focus
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "svelte/store";
import { harness } from "./lib/harness.mjs";
import { resolvePlotElement, focusTargetFor, focusPlot, offerFocus, setPinned, resetFocus } from "../src/lib/plotsRail/focusPlot";
import { arrangeDissections } from "../src/lib/plotsRail/dissectionsModel";
import { tablePreview, tableCardHeight } from "../src/lib/plotsRail/tableCard";

const h = harness("verify-plots-rail-focus");
const repo = join(import.meta.dirname, "..");
const ROOT = "/p/proj";

const plot = (id: string, svgPath?: string, extra: Record<string, unknown> = {}) => ({ id, type: "plot", assetId: `a_${id}`, ...(svgPath ? { source: { svgPath, ...extra } } : {}) });
const text = (id: string) => ({ id, type: "text" });
const proj = { figures: [{ id: "f1", elements: [plot("p1", "plots/growth.svg"), plot("p2", "plots/sub/b.svg"), text("t1"), plot("p3", "plots/c.svg")] }] } as never;

h.section("the selection → plot ladder");
{
  h.eq(resolvePlotElement(proj, new Set(["p2"]), null)?.id, "p2", "a single selected plot");
  h.eq(resolvePlotElement(proj, new Set(["t1"]), null)?.id, "t1", "a single selected element of any kind (the caller checks for an asset)");
  h.eq(resolvePlotElement(proj, new Set(["t1"]), { elementId: "p3", partId: "x" } as never)?.id, "p3", "a drilled part resolves to its owning plot");
  h.eq(resolvePlotElement(proj, new Set(["p1", "t1", "p3"]), null)?.id, "p3", "several selected → the most recently added plot-like element");
  h.eq(resolvePlotElement(proj, new Set(["p3", "t1"]), null)?.id, "p3", "…skipping non-plot elements");
  h.eq(resolvePlotElement(proj, new Set(), null), null, "nothing selected → null");
}

h.section("where a plot's companions live");
{
  const none = async () => false;
  const t1 = await focusTargetFor(plot("x", "plots/sub/b.svg"), ROOT, "", none);
  h.eq(`${t1.kind}:${t1.key}:${t1.abs}`, `plot:sub/b:${ROOT}/plots/sub/b.svg`, "a project plot → its key and absolute file");
  const abs = await focusTargetFor(plot("x", `${ROOT}/plots/growth.svg`), ROOT, "", none);
  h.eq(abs.key, "growth", "an absolute source inside the project resolves the same way");
  const lib = await focusTargetFor(plot("x", "/home/u/FluxConfig/plot_library/figs/q.svg", { external: true }), ROOT, "", none);
  h.eq(`${lib.kind}:${lib.key}`, "external:", "a global-library plot (external source) has no dissections — not a basename key");
  const outside = await focusTargetFor(plot("x", "/elsewhere/q.svg"), ROOT, "", none);
  h.eq(outside.kind, "external", "an absolute source outside the project is external too");
  const pasted = await focusTargetFor({ id: "i", type: "image", assetId: "a" } as never, ROOT, "pasted-2026.png", none);
  h.eq(`${pasted.kind}:${pasted.key}`, "sourceless:pasted-2026", "a sourceless image keeps the documented asset-name fallback, labelled as such");
  // A placed dissection FILE: key/group/file when the owner plot exists…
  const exists = async (p: string) => p === `${ROOT}/plots/growth.svg`;
  const own = await focusTargetFor(plot("x", "plots/_dissections/growth/by_subject/s07.svg"), ROOT, "", exists);
  h.eq(`${own.kind}:${own.key}:${own.file?.group}/${own.file?.name}`, "plot:growth:by_subject/s07.svg", "a placed per-subject panel focuses its OWNER plot with that file selected");
  const loose = await focusTargetFor(plot("x", "plots/_dissections/growth/overview.svg"), ROOT, "", exists);
  h.eq(`${loose.key}:${loose.file?.group}/${loose.file?.name}`, "growth:/overview.svg", "a loose dissection file → the owner, default group");
  const nested = await focusTargetFor(plot("x", "plots/_dissections/sub/b/s1.svg"), ROOT, "", async (p) => p === `${ROOT}/plots/sub/b.svg`);
  h.eq(`${nested.key}:${nested.file?.group}`, "sub/b:", "a nested owner key with a loose file is read loose-first");
  const orphan = await focusTargetFor(plot("x", "plots/_dissections/gone/x.svg"), ROOT, "", none);
  h.eq(orphan.kind, "none", "a dissection file without an owner plot has no dissections of its own");
}

h.section("the focus store");
{
  resetFocus();
  const A = { key: "a", kind: "plot" as const, name: "a" }, B = { key: "b", kind: "plot" as const, name: "b" };
  offerFocus(A, "gallery");
  h.eq(get(focusPlot).target?.key, "a", "a gallery click sets the focus");
  offerFocus(B, "canvas");
  h.ok(get(focusPlot).target?.key === "b" && get(focusPlot).live, "a canvas selection takes it (last writer wins) and is live");
  const n = get(focusPlot).n;
  offerFocus(null, "canvas");
  h.ok(get(focusPlot).target?.key === "b" && !get(focusPlot).live, "deselecting keeps the plot (sticky), no longer live");
  offerFocus(B, "canvas");
  h.ok(get(focusPlot).live, "re-selecting the same plot on the canvas re-claims it");
  offerFocus(B, "canvas");
  h.eq(get(focusPlot).n, n + 1, "the same plot from the same source is not a change");
  offerFocus(A, "gallery");
  offerFocus(B, "canvas");
  h.eq(get(focusPlot).source, "canvas", "a canvas press after a gallery click takes the focus back");
  setPinned(true);
  offerFocus(A, "gallery");
  h.eq(get(focusPlot).target?.key, "b", "pinned: focus changes are ignored");
  setPinned(false);
  offerFocus(A, "gallery");
  h.eq(get(focusPlot).target?.key, "a", "unpinned: it follows again");
}

h.section("the `d` hotkey uses the one ladder");
{
  const state = readFileSync(join(repo, "src", "lib", "dissect", "state.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
  h.ok(/resolvePlotElement/.test(state) && /focusTargetFor/.test(state), "dissect/state.ts imports the rail's ladder");
  h.ok(!/ps\.elementId|sel\.size === 1/.test(state), "…and keeps no private copy of it");
}

h.section("the Dissections pane's arrangement");
{
  const f = (name: string, kind: "image" | "table" | "other") => ({ name, abs: `/d/${name}`, kind });
  const listing = { root: "/d", total: 9, groups: [
    { name: "", files: [f("overview.svg", "image"), f("readme.md", "other")] },
    { name: "by_subject", files: [f("s01.svg", "image"), f("s02.svg", "image"), f("subj.csv", "table")] },
    { name: "_stats", files: [f("anova.csv", "table"), f("posthoc.tsv", "table")] },
    { name: "alt", files: [f("alt.svg", "image")] },
  ] };
  const secs = arrangeDissections(listing as never);
  h.eq(secs.map((s) => s.title).join(" | "), "Summary | Overview | alt | by_subject | Other files", "summary first, the loose files as Overview, image groups alphabetically, other files last");
  h.eq(secs[0].files.map((x) => `${x.group}/${x.name}`).join(","), "_stats/anova.csv,_stats/posthoc.tsv,by_subject/subj.csv", "_stats tables lead the summary");
  h.eq(arrangeDissections(null).length, 0, "no listing → no sections");
}

h.section("table cards");
{
  const p = tablePreview("term,estimate,p\nintake,0.42,0.003\nexercise,-0.11,0.2\n", "anova.csv", false);
  h.ok(!p.transposed && p.cols === 3 && p.rows.length === 2 && p.complete, "a small table: header + rows, complete");
  const wide = tablePreview("test,statistic,df,p,effect,ci_low,ci_high\nwelch,3.21,14.2,0.006,0.81,0.2,1.4\n", "s.csv", false);
  h.ok(wide.transposed, "one row, more than five columns → transposed into key/value lines");
  const long = tablePreview(Array.from({ length: 40 }, (_, i) => `${i},${i * 2}`).join("\n"), "l.csv", true);
  h.ok(long.rows.length === 6 && !long.complete, "a long or truncated file shows six rows and says ≥N (incomplete)");
  h.ok(tableCardHeight(wide) > tableCardHeight(p) && tableCardHeight(null) > 0, "card heights follow their lines");
}

await h.done();
