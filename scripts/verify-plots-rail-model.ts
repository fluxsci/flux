// Plots rail gallery rules (pure) — src/lib/plotsRail/galleryModel.ts and the P3 seams:
//   * filters (Unused · Fluxplots · Has dissections): conjunctive, an unknown count never hides;
//   * the focus folder (subtree membership, climbing) and Similar names (the dialog's rule,
//     reference first, ranked);
//   * variant stacks: _v<n> / _<n> / _<letter> suffixes, the unsuffixed original joins, one
//     folder only, the newest on top, expanded stacks in place with a head;
//   * the journal width class and Peek's formatters;
//   * tablePreview's longer look (Peek's 20 rows) leaves the card's 6 alone;
//   * the slide layout store decodes the new left-rail view + width safely (behaviour; the IPC's
//     pre-warm path is gated in verify-plot-thumbs.ts, Slide's routing in -slide.mjs).
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-plots-rail-model
import { harness } from "./lib/harness.mjs";
import { applyFilters, anyFilter, inFolder, parentFolder, similarTo, variantKey, stackVariants, widthClass, relativeTime, formatBytes, type ModelItem } from "../src/lib/plotsRail/galleryModel";
import { formatSizePx, formatSizeMm, formatWidthMm } from "../src/lib/figure/physicalUnits";
import { tablePreview, CARD_ROWS } from "../src/lib/plotsRail/tableCard";

const h = harness("verify-plots-rail-model");

const it = (rel: string, mtimeMs = 0, semantic = false): ModelItem & { rel: string } => {
  const i = rel.lastIndexOf("/");
  return { rel, abs: `/p/plots/${rel}`, name: i >= 0 ? rel.slice(i + 1) : rel, dir: i >= 0 ? rel.slice(0, i) : "", mtimeMs, semantic };
};

h.section("filters");
{
  const items = [it("a.svg", 1, true), it("b.svg", 2), it("c.svg", 3, true), it("d.svg", 4)];
  const placed = (x: ModelItem) => (x.name === "a.svg" ? 2 : 0);
  const counts: Record<string, number | null> = { "a.svg": 3, "b.svg": 0, "c.svg": null, "d.svg": 5 };
  const dis = (x: ModelItem) => counts[x.name] ?? null;
  const names = (xs: ModelItem[]) => xs.map((x) => x.name).join(",");
  const none = { unused: false, fluxplot: false, dissected: false };
  h.ok(!anyFilter(none) && applyFilters(items, none, placed, dis) === items, "no filter: the same list (no copy)");
  h.eq(names(applyFilters(items, { ...none, unused: true }, placed, dis)), "b.svg,c.svg,d.svg", "Unused drops placed plots");
  h.eq(names(applyFilters(items, { ...none, fluxplot: true }, placed, dis)), "a.svg,c.svg", "Fluxplots keeps the editable ones");
  h.eq(names(applyFilters(items, { ...none, dissected: true }, placed, dis)), "a.svg,c.svg,d.svg", "Has dissections drops a known 0 and keeps an unknown count");
  h.eq(names(applyFilters(items, { unused: true, fluxplot: true, dissected: true }, placed, dis)), "c.svg", "filters combine (AND)");
}

h.section("focus folder and similar names");
{
  h.ok(inFolder("figs/latency", "figs") && inFolder("figs", "figs") && !inFolder("figs2", "figs") && inFolder("x", ""), "subtree membership (not a name prefix)");
  h.eq(parentFolder("figs/latency/raw"), "figs/latency", "one folder up");
  h.eq(parentFolder("figs"), "", "a top-level folder climbs to everything");
  const items = [it("a/latency_raincloud_v1.svg"), it("a/other.svg"), it("b/latency_raincloud_v2.svg"), it("a/latency_raincloud_s07.svg")];
  const sim = similarTo(items, items[0]).map((x) => x.rel);
  h.eq(sim[0], "a/latency_raincloud_v1.svg", "the reference comes first");
  h.ok(sim.includes("b/latency_raincloud_v2.svg") && sim.includes("a/latency_raincloud_s07.svg") && !sim.includes("a/other.svg"), `variants across folders, unrelated names dropped (${sim.join(" ")})`);
}

h.section("variant stacks");
{
  h.eq(variantKey("fig1_a.svg"), "fig1", "a panel letter");
  h.eq(variantKey("latency_v12.svg"), "latency", "a version");
  h.eq(variantKey("run-07.png"), "run", "a numbered run");
  h.eq(variantKey("latency_raincloud_v2.svg"), "latency_raincloud", "only the LAST suffix is the variant");
  h.eq(variantKey("growth.svg"), null, "no suffix, no key");
  h.eq(variantKey("fig_2d.svg"), null, "a word that merely ends in a digit-letter is not a variant");
  const items = [it("p/fig1_a.svg", 5), it("p/fig1_b.svg", 9), it("p/fig1_c.svg", 7), it("p/growth.svg", 1), it("p/latency.svg", 2), it("p/latency_v2.svg", 3), it("p/solo_a.svg", 4)];
  const out = stackVariants(items, new Set());
  const shape = out.map((e) => (e.kind === "stack" ? `[${e.top.name}×${e.members.length}]` : e.item.name)).join(" ");
  h.eq(shape, "[fig1_b.svg×3] growth.svg [latency_v2.svg×2] solo_a.svg", "stacks sit where their first member was, newest on top; the unsuffixed original joins; a lone variant stays a plot");
  const expanded = stackVariants(items, new Set(["p/fig1"]));
  const ex = expanded.map((e) => (e.kind === "stack" ? "S" : `${e.item.name}${e.head ? `^${e.head.count}` : ""}`)).join(" ");
  h.eq(ex, "fig1_a.svg^3 fig1_b.svg fig1_c.svg growth.svg S solo_a.svg", "an expanded stack lays out in place, its first member the head");
  const twoDirs = stackVariants([it("x/fig1_a.svg"), it("x/fig1_b.svg")], new Set());
  h.ok(twoDirs.length === 1 && twoDirs[0].kind === "stack" && twoDirs[0].key === "x/fig1", "the stack key carries the folder");
  const big = Array.from({ length: 20000 }, (_, i) => it(`d${i % 50}/plot${i}_v${i % 3}.svg`, i));
  const t0 = performance.now();
  stackVariants(big, new Set());
  const ms = performance.now() - t0;
  h.ok(ms < 60, `20,000 plots stack in ${ms.toFixed(1)} ms (< 60)`);
}

h.section("width class and formatters");
{
  h.eq(widthClass([89, 60])?.label, "1c", "89 mm is one column");
  h.eq(widthClass([120, 60])?.label, "1.5c", "120 mm is a column and a half");
  h.eq(widthClass([183, 90])?.label, "2c", "183 mm is the full page");
  h.eq(widthClass([240, 90])?.label, ">2c", "wider than a page");
  h.eq(widthClass(null), null, "no physical size, no badge");
  h.eq(formatSizeMm([88.9, 61.234], "in"), "3.50 × 2.41 in", "physical size in inches (matplotlib figsize) — the default unit");
  h.eq(formatSizeMm([89, 61.234], "mm"), "89.0 × 61.2 mm", "…or millimetres");
  h.eq(formatSizePx(96 * 6.4, 96 * 4.8, "in"), "6.40 × 4.80 in", "from CSS px at 96/in (matplotlib's default figsize)");
  h.eq(formatSizeMm(null, "in"), "", "no physical size, no text");
  h.ok(/^3\.50 in wide/.test(widthClass([88.9, 60])!.title) && /^88\.9 mm wide/.test(widthClass([88.9, 60], "mm")!.title), "the width badge's tooltip speaks the chosen unit");
  h.eq(formatWidthMm(183, "in"), "7.20 in", "a width alone");
  const now = Date.UTC(2026, 9, 22, 12);
  h.eq(relativeTime(now - 10_000, now), "just now", "seconds");
  h.eq(relativeTime(now - 12 * 60_000, now), "12 min ago", "minutes");
  h.eq(relativeTime(now - 3 * 3_600_000, now), "3 h ago", "hours");
  h.eq(relativeTime(now - 30 * 3_600_000, now), "yesterday", "yesterday");
  h.eq(formatBytes(1536), "2 KB", "kilobytes");
  h.eq(formatBytes(3.4 * 1024 * 1024), "3.4 MB", "megabytes");
}

h.section("table previews");
{
  const csv = "a,b\n" + Array.from({ length: 40 }, (_, i) => `${i},${i * 2}`).join("\n");
  h.eq(tablePreview(csv, "t.csv", false).rows.length, CARD_ROWS, "the card keeps its 6 rows");
  const peek = tablePreview(csv, "t.csv", false, 20);
  h.ok(peek.rows.length === 20 && peek.rowCount === 40, `Peek's look: 20 rows of 40 (${peek.rows.length}/${peek.rowCount})`);
}

h.section("the slide layout decodes the left rail's view and width");
{
  // slideLayoutStore reads localStorage at import: stub it with a hostile saved layout.
  const saved: Record<string, string> = { "flux.slide.layout": JSON.stringify({ filmstripW: 1400, leftView: "gallery", plotsRailW: 99999 }) };
  (globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => saved[k] ?? null, setItem: (k: string, v: string) => { saved[k] = v; }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as Storage;
  const { slideLayout } = await import("../src/shell/modes/slide/slideLayoutStore");
  const { get } = await import("svelte/store");
  const v = get(slideLayout);
  h.ok(v.leftView === "slides" && v.plotsRailW === 8000 && v.filmstripW === 1400, `an unknown view falls back to Slides; widths have no fixed cap (1400 survives), only a sanity bound on the stored value (${JSON.stringify(v)})`);
  const { leftRailMax, shownLeftRailW } = await import("../src/lib/figureLayoutStore");
  h.eq(leftRailMax(1500, 248), 1012, "the rail may grow until the canvas keeps 240 px beside the right rail");
  h.eq(shownLeftRailW(1400, 220, 1500, 248), 1012, "a stored width wider than the window shows clamped (and is kept)");
  h.eq(shownLeftRailW(1400, 220, 2600, 0), 1400, "…and comes back when the window is wide enough");
  h.eq(shownLeftRailW(500, 220, 300, 248), 220, "on a tiny window the minimum wins");
  slideLayout.set({ ...v, leftView: "plots", plotsRailW: 360 });
  h.ok(/"leftView":"plots"/.test(saved["flux.slide.layout"]) && /"plotsRailW":360/.test(saved["flux.slide.layout"]), "the view and its width persist");
}

await h.done();
