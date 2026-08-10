// F1 flux-core + CLI: scaffold a real on-disk project, write a figure, then drive
// it through the core verbs (reindex, list, render-figure, caption, set-caption,
// add-reference, add-panel) — proving "the file is the API" from Node. Also runs
// the actual CLI binary once for terminal authenticity.
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");
const TMP = path.join(REPO, "scratch-fluxproj");

// --- hermetic env: HOME + XDG into a scratch dir BEFORE flux-core loads -------------------
// add-reference writes to the MACHINE-GLOBAL FluxLib as well as the project, and a temp
// project root sandboxes only the project half. Without this, every run of the pure tier
// filed the "A study" fixture into the developer's real ~/FluxConfig/FluxLib/library.bib
// (13 of them accumulated before it was caught). Same idiom as verify-zotero-sync.ts.
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f1-core-"));
const HOME = path.join(SCRATCH, "home");
await fs.mkdir(path.join(HOME, ".config"), { recursive: true });
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
process.env.FLUX_NO_MIGRATE = "1";
const LIB = path.join(SCRATCH, "lib");

// Dynamic — must not bind any module-scope path before the env above is in place.
const core = await import("../flux-core/index");

await fs.rm(TMP, { recursive: true, force: true });
await core.scaffold(TMP, { title: "Test Paper", author: "Me" });

const figIndex = {
  schemaVersion: "0.1.0",
  canvases: [{ id: "canvas-1", name: "Canvas 1", order: 1 }],
  figures: [
    { id: "growth", name: "Growth curves", label: "fig-growth", order: 1, kind: "main", canvas: "canvas-1", caption: "" },
  ],
  assets: [],
  palette: [],
  colorGroups: [],
};
const txt = (id: string, t: string, x: number) => ({
  type: "text", id, name: `panel ${t}`, x, y: 6, width: 16, height: 22, rotation: 0,
  text: t, fontFamily: "Arial", fontSize: 18, fontWeight: 700, fontStyle: "normal", align: "left", color: "#111", panelLabel: true,
});
const rect = (id: string, x: number, fill: string) => ({
  type: "rect", id, x, y: 32, width: 260, height: 240, rotation: 0, fill, stroke: "#222222", strokeWidth: 1, cornerRadius: 4,
});
const canvas = {
  schemaVersion: "0.1.0", id: "canvas-1", name: "Canvas 1",
  figures: [
    {
      id: "growth", name: "Growth curves", canvasId: "canvas-1", x: 0, y: 0, width: 600, height: 300, background: "#ffffff",
      elements: [rect("r1", 20, "#d95f02"), txt("la", "a", 20), rect("r2", 320, "#1b9e77"), txt("lb", "b", 320)],
      captions: { __figure__: "Growth over time.", la: "Control vs treatment.", lb: "Dose response." },
    },
  ],
};
await fs.writeFile(path.join(TMP, "fig/index.json"), JSON.stringify(figIndex, null, 2));
await fs.mkdir(path.join(TMP, "fig/canvases"), { recursive: true });
await fs.writeFile(path.join(TMP, "fig/canvases/canvas-1.json"), JSON.stringify(canvas, null, 2));

const results: Record<string, unknown> = {};

const ri = await core.reindex(TMP);
const manifest = JSON.parse(await fs.readFile(path.join(TMP, "project.json"), "utf8"));
results.reindex = {
  figures: ri.figures,
  manifestGrowth: manifest.figures.some((f: any) => f.id === "growth" && f.caption === "fig/captions/growth.md"),
};

const list = await core.listProject(TMP);
results.list = { title: list.title, docs: list.documents, panels: list.figures[0]?.panels };

const svg = await core.renderFigureSvg(TMP, "growth");
results.render = { isSvg: svg.includes("<svg"), hasOrange: svg.includes("#d95f02"), hasGreen: svg.includes("#1b9e77"), len: svg.length };

results.caption = await core.captionFor(TMP, "growth");

await core.setCaption(TMP, "growth", "Edited caption. (a) x. (b) y.");
results.setCaption = (await fs.readFile(path.join(TMP, "fig/captions/growth.md"), "utf8")).trim();

await core.addReference(TMP, "@article{smith2020, title={A study}, year={2020}}", { libPath: LIB });
results.bib = (await fs.readFile(path.join(TMP, "references/library.bib"), "utf8")).includes("smith2020");
// Both halves of add-reference must land in the sandbox: the project's cited subset (above)
// and the library itself. The second check is the leak gate — if libPath ever stops reaching
// addToFluxLib, the entry falls back to the MACHINE-GLOBAL library instead. `scaffold` legitimately
// machine-inits an empty <FluxConfig>/FluxLib skeleton, so the contract is "no ENTRY lands there",
// not "the folder never appears".
const globalBib = path.join(HOME, "FluxConfig", "FluxLib", "library.bib");
results.libContained = {
  // Tolerant read: when libPath is ignored the temp lib is never created at all, and a raw
  // ENOENT here would mask the real diagnosis below.
  inTempLib: fsSync.existsSync(path.join(LIB, "library.bib"))
    ? fsSync.readFileSync(path.join(LIB, "library.bib"), "utf8").includes("smith2020")
    : false,
  globalLibEntries: fsSync.existsSync(globalBib)
    ? (fsSync.readFileSync(globalBib, "utf8").match(/^@/gm) ?? []).length
    : 0,
};

await fs.writeFile(
  path.join(TMP, "panel.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>',
);
const ap = await core.addPanel(TMP, "growth", path.join(TMP, "panel.svg"), { x: 600, y: 32, width: 200, height: 200 });
const canvasAfter = JSON.parse(await fs.readFile(path.join(TMP, "fig/canvases/canvas-1.json"), "utf8"));
const idxAfter = JSON.parse(await fs.readFile(path.join(TMP, "fig/index.json"), "utf8"));
results.addPanel = {
  // figure-v1 P4: EVERY imported .svg is a semantic `plot` element (a vanilla
  // file gets a DERIVED manifest at render/cache time — never an opaque image).
  elementAdded: canvasAfter.figures[0].elements.some((e: any) => e.id === ap.elementId && e.type === "plot" && e.source?.svgPath),
  assetRegistered: idxAfter.assets.some((a: any) => a.id === ap.assetId),
};

// path-safety (M9): escaping the root must throw.
try {
  core.safeJoin(TMP, "../../etc/passwd");
  results.pathSafety = "DID NOT THROW";
} catch {
  results.pathSafety = "blocked";
}

// terminal authenticity: run the real CLI once.
const { stdout } = await pexec("npx", ["tsx", "flux-cli.ts", "list", TMP], { cwd: REPO, env: { ...process.env, FLUX_NO_MIGRATE: "1" } });
results.cli = { listHasGrowth: stdout.includes("fig-growth"), title: JSON.parse(stdout).title };

await fs.rm(TMP, { recursive: true, force: true });

// This script reports by exit code, so the containment result has to THROW to have teeth —
// printing `false` would leave the leak green. Global-leak first: it is the precise diagnosis
// when libPath is ignored (the temp lib is simply never created in that case).
const contained = results.libContained as { inTempLib: boolean; globalLibEntries: number };
if (contained.globalLibEntries !== 0) {
  throw new Error(
    `FAIL: ${contained.globalLibEntries} entr${contained.globalLibEntries === 1 ? "y" : "ies"} landed in the ` +
      `MACHINE-GLOBAL FluxLib (${path.join(HOME, "FluxConfig", "FluxLib", "library.bib")}) — a write escaped ` +
      "its libPath. On a real HOME this files test fixtures into the user's own reference library.",
  );
}
if (!contained.inTempLib) {
  throw new Error(`FAIL: add-reference wrote the entry to neither the sandboxed FluxLib (${LIB}) nor the global one.`);
}
await fs.rm(SCRATCH, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
