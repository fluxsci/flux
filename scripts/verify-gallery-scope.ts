// Plot gallery scope rules (pure): the Project | Global browse scopes and the
// Settings → Figure "plotSearchScope" preference, resolved by
// src/lib/plot/galleryScope.ts into the cached walks a search reads. Pins every
// preference option, the reserved-collection override, the folder filter, the
// mixed-scope labelling flag, and the settings decoder's enum + default.
//   Run: npx tsx scripts/verify-gallery-scope.ts
import assert from "node:assert/strict";
import {
  DEFAULT_PLOT_SEARCH_SCOPE,
  PLOT_SEARCH_SCOPES,
  gallerySearchPlan,
  inPlanFolder,
  isPlotSearchScope,
  sourceKey,
  type PlotSearchScope,
} from "../src/lib/plot/galleryScope";

let checks = 0;
const ok = (cond: unknown, msg: string) => { assert(cond, msg); checks++; };

const P = "/p/proj/plots", G = "/home/u/FluxConfig/plot_library";
const keys = (plan: ReturnType<typeof gallerySearchPlan>) => plan.sources.map(sourceKey).join(",");
const plan = (mode: PlotSearchScope, browse: "project" | "global", cwd: string, reserved = "") =>
  gallerySearchPlan({ mode, browse, reserved, cwd, browseRoot: browse === "global" ? G : P });

// ---- options + default -----------------------------------------------------------
ok(DEFAULT_PLOT_SEARCH_SCOPE === "current", "default = everything in the selected scope");
ok(PLOT_SEARCH_SCOPES[0].id === "current", "the default is the first menu option");
ok(new Set(PLOT_SEARCH_SCOPES.map((s) => s.id)).size === 5, "five distinct options");
for (const id of ["current", "folder", "project", "global", "all"]) ok(isPlotSearchScope(id), `option ${id} exists`);
ok(!isPlotSearchScope("library") && !isPlotSearchScope(3), "unknown values are rejected");
ok(keys(gallerySearchPlan({ mode: "bogus" as PlotSearchScope, browse: "global", reserved: "", cwd: G, browseRoot: G })) === "global:", "a corrupt mode falls back to the default");

// ---- current (default): follows the switch ----------------------------------------
ok(keys(plan("current", "project", P)) === "project:", "current + Project → the project tree");
ok(keys(plan("current", "global", `${G}/figs`)) === "global:", "current + Global → the whole global tree, even from a subfolder");
ok(!plan("current", "global", G).mixed && !plan("current", "global", G).folder, "current never labels or folder-filters");
ok(/global plot library/.test(plan("current", "global", G).placeholder), "placeholder names the global library");
ok(/project plots/.test(plan("current", "project", P).placeholder), "placeholder names project plots");

// ---- fixed scopes: independent of the switch -------------------------------------
ok(keys(plan("project", "global", G)) === "project:", "project-only while browsing Global still searches the project");
ok(plan("project", "global", G).mixed, "…and labels rows with their scope");
ok(!plan("project", "project", P).mixed, "project-only while browsing Project is not mixed");
ok(keys(plan("global", "project", `${P}/a`)) === "global:" && plan("global", "project", P).mixed, "global-only while browsing Project");
ok(/global plots only/i.test(plan("global", "project", P).placeholder), "the box says the search left the browsed scope");

// ---- everything ---------------------------------------------------------------------
const all = plan("all", "project", `${P}/x`);
ok(keys(all) === "project:,global:", "all → both whole trees");
ok(all.mixed && !all.folder, "all labels rows and never folder-filters");

// ---- current folder -----------------------------------------------------------------
const f = plan("folder", "global", `${G}/figs/2024`);
ok(keys(f) === "global:" && f.folder === `${G}/figs/2024`, "folder → the browsed tree, filtered to the current folder");
ok(/inside figs\/2024/.test(f.placeholder), "placeholder names the folder");
ok(inPlanFolder(f, `${G}/figs/2024/a.svg`) && inPlanFolder(f, `${G}/figs/2024/deep/b.svg`), "files in the folder and its subfolders pass");
ok(!inPlanFolder(f, `${G}/figs/other.svg`) && !inPlanFolder(f, `${G}/figs/2024x/c.svg`), "siblings and prefix-lookalikes do not");
ok(!plan("folder", "project", P).folder, "at the root, folder = the whole tree (no filter)");
ok(!plan("folder", "project", `${P}/`).folder, "a trailing slash on the root is still the root");
ok(inPlanFolder(plan("current", "project", P), "/anywhere/z.svg"), "no filter → everything passes");

// ---- the reserved-collection rule beats every preference -----------------------------
for (const mode of ["current", "project", "global", "all"] as PlotSearchScope[]) {
  const r = plan(mode, "project", `${P}/_lighttable`, "_lighttable");
  ok(keys(r) === "project:_lighttable" && !r.mixed, `${mode}: inside _lighttable the search stays in it`);
}
const deep = plan("folder", "global", `${G}/_lighttable/sweep`, "_lighttable");
ok(keys(deep) === "global:_lighttable" && deep.folder === `${G}/_lighttable/sweep`, "folder inside a collection narrows further");
ok(/inside _lighttable\/sweep/.test(deep.placeholder), "…and says so");
ok(plan("current", "project", `${P}/_lighttable`, "_lighttable").placeholder === "Search inside _lighttable/…", "collection placeholder unchanged from the reserved-folder contract");

// ---- settings decoder ---------------------------------------------------------------------
{
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; },
  };
  const { decodeSettings } = await import("../src/lib/settings");
  ok(decodeSettings({}).plotSearchScope === "current", "settings default plotSearchScope = current");
  ok(decodeSettings({ plotSearchScope: "all" }).plotSearchScope === "all", "settings keep a valid choice");
  ok(decodeSettings({ plotSearchScope: "library" }).plotSearchScope === "current", "settings drop an invalid choice");
}

console.log(`##VERIFY## ${JSON.stringify({ script: "verify-gallery-scope", ok: true, checks, failed: 0 })}`);
console.log(`GALLERY SCOPE VERIFY: PASS (${checks} checks)`);
