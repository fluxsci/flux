// Pure gate for the project watcher's route table (electron/projectWatchRules.js): every path
// the watcher's classifier routes to a subsystem lies inside a folder it actually watches, and
// every document Paper discovers — with its comment sidecars — is one of those paths.
//
// Why: until 2026-11-19 main.cjs kept two hand-written lists. `subsystemFor` routed paper/ to
// "manuscript" (since b6a741b8) but the watch list named only manuscript/, so in a new-layout
// project an agent's set-manuscript / reply / resolve never reached the open app — and the next
// GUI comment save erased the agent's reply. Both lists now derive from one table; this gate
// proves the table covers what Paper discovers (via the shipped discoverDocuments, not a copy)
// and pins, by source shape, that main.cjs builds its watch list and classifier from it.
//
// Run: node scripts/run-verifies.mjs --tier pure --only verify-project-watch-rules.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { harness } from "./lib/harness.mjs";
import {
  FIXED_WATCH_ROUTES, projectWatchRoutes, routeProjectRel, watchTargetRels, isWatchableDocumentRoot,
} from "../electron/projectWatchRules.js";
import { discoverDocuments, type DocumentIO } from "../src/lib/project/documentFiles";
import { commentsSidecarRels } from "../src/lib/project/docOrder";
import type { ProjectManifest } from "../src/lib/project/types";

const h = harness("verify-project-watch-rules");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

type Route = { rel: string; subsystem: string; file?: true };
/** Is `rel` a path the watcher would see: one of its targets, or inside a folder target? */
const watched = (routes: Route[], rel: string) =>
  watchTargetRels(routes).some((t: string) => rel === t || rel.startsWith(t + "/"));

const manifest = (extra: Partial<ProjectManifest>): ProjectManifest =>
  ({ title: "Watch", manuscript: { path: "" }, ...extra }) as unknown as ProjectManifest;
// Fixture projects, each with the documents its layout puts on disk.
const fixtures: { name: string; m: ProjectManifest; files: string[]; expectRoot?: string }[] = [
  { name: "new layout (documentRoot paper)", m: manifest({ documentRoot: "paper", manuscript: { path: "paper/notes.qmd" } }),
    files: ["paper/notes.qmd", "paper/methods/stats.qmd", "Context/ProjectContext.qmd"], expectRoot: "paper" },
  { name: "legacy manuscript/ main", m: manifest({ manuscript: { path: "manuscript/main.qmd" } }),
    files: ["manuscript/main.qmd", "manuscript/supplement.qmd", "paper/later.qmd"], expectRoot: "manuscript" },
  { name: "custom documentRoot", m: manifest({ documentRoot: "writing/drafts", manuscript: { path: "writing/drafts/a.qmd" } }),
    files: ["writing/drafts/a.qmd", "writing/drafts/part/b.qmd", "paper/c.qmd"], expectRoot: "writing/drafts" },
  { name: "legacy config folder", m: manifest({ manuscript: { path: "text/main.qmd", config: "text/_quarto.yml" } as ProjectManifest["manuscript"] }),
    files: ["text/main.qmd", "text/other.qmd"], expectRoot: "text" },
];

function memoryIO(files: string[]): DocumentIO {
  const dirs = new Set<string>();
  for (const f of files) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
  const entries = async (rel: string) => {
    const prefix = rel ? rel + "/" : "";
    const names = new Map<string, boolean>();
    for (const p of [...files, ...dirs]) if (p.startsWith(prefix) && p !== rel) {
      const name = p.slice(prefix.length).split("/")[0];
      names.set(name, dirs.has(prefix + name));
    }
    return [...names].map(([name, dir]) => ({ name, dir }));
  };
  const no = async () => { throw new Error("read-only"); };
  return { exists: async rel => files.includes(rel) || dirs.has(rel), read: async () => "", entries, write: no, create: no, mkdir: no, remove: no };
}

h.section("every routed path is watched (route table)");
for (const m of [null, ...fixtures.map(f => f.m)]) {
  const routes = projectWatchRoutes(m) as Route[];
  const label = m ? JSON.stringify(m.documentRoot ?? m.manuscript.path) : "unreadable project.json";
  for (const r of routes) {
    const probes = r.file ? [r.rel] : [`${r.rel}/x.qmd`, `${r.rel}/deep/er/x.comments.json`];
    for (const rel of probes) h.ok(routeProjectRel(routes, rel) === r.subsystem && watched(routes, rel), `${label}: ${rel} → ${r.subsystem}, and watched`);
  }
  h.ok(routes.some(r => r.rel === "paper" && r.subsystem === "manuscript"), `${label}: paper/ is watched as manuscript`);
  h.ok(routes.some(r => r.rel === "manuscript" && r.subsystem === "manuscript"), `${label}: legacy manuscript/ is watched as manuscript`);
  for (const rel of ["notes.qmd", "exports/paper.pdf", ".meta/journal.ndjson", "paperwork/x.qmd", "fig", "paper"])
    h.eq(routeProjectRel(routes, rel), null, `${label}: ${JSON.stringify(rel)} routes nowhere`);
}

h.section("the fixed subsystems keep their old routes");
{
  const routes = projectWatchRoutes(null) as Route[];
  const table: [string, string][] = [
    ["plots/a.svg", "plots"], ["fig/canvases/c.json", "fig"], ["references/library.bib", "references"],
    ["slides/talk/deck.json", "slides"], ["Context/RULES.md", "context"], [".meta/live/sessions/s.json", "presence"],
    [".meta/feedback.ndjson", "feedback"], ["paper/notes.qmd", "manuscript"], ["paper/notes.comments.json", "manuscript"],
    ["manuscript/main.qmd", "manuscript"], ["manuscript/comments.json", "manuscript"],
  ];
  for (const [rel, subsystem] of table) h.eq(routeProjectRel(routes, rel), subsystem, `${rel} → ${subsystem}`);
  h.eq(FIXED_WATCH_ROUTES.filter((r: Route) => r.file).map((r: Route) => r.rel), [".meta/feedback.ndjson"], "only the feedback ledger is a single-file route");
}

h.section("every document Paper discovers is watched, with its comment sidecars");
for (const f of fixtures) {
  const routes = projectWatchRoutes(f.m) as Route[];
  const { docs } = await discoverDocuments(f.m, memoryIO(f.files));
  h.ok(docs.length >= f.files.length - 1, `${f.name}: discovery found its documents (${docs.map(d => d.path).join(", ")})`);
  if (f.expectRoot) h.ok(routes.some(r => r.rel === f.expectRoot), `${f.name}: the project's own document folder ${f.expectRoot}/ is a watch target`);
  for (const d of docs) for (const rel of [d.path, ...commentsSidecarRels(f.m, d.path)]) {
    const subsystem = routeProjectRel(routes, rel);
    h.ok(watched(routes, rel) && (subsystem === "manuscript" || subsystem === "context"), `${f.name}: ${rel} is watched and routed (${subsystem})`);
  }
}

h.section("a document root never widens the watch to the project or outside it");
for (const bad of ["", ".", "..", "../elsewhere", "/abs", "a/../../b", ".hidden", "a//b", "C:\\docs", "a\\b"])
  h.ok(!isWatchableDocumentRoot(bad), `refused as a watch folder: ${JSON.stringify(bad)}`);
for (const m of [manifest({ manuscript: { path: "main.qmd" } }), manifest({ documentRoot: "../escape", manuscript: { path: "" } }), manifest({ documentRoot: "", manuscript: { path: "" } })]) {
  const targets = watchTargetRels(projectWatchRoutes(m));
  h.ok(targets.every((t: string) => isWatchableDocumentRoot(t) || FIXED_WATCH_ROUTES.some((r: Route) => r.rel === t)), `${JSON.stringify(m.documentRoot ?? m.manuscript.path)}: targets stay inside named folders (${targets.join(", ")})`);
}

h.section("main.cjs builds the watcher from the table (source shape)");
{
  const main = readFileSync(join(repo, "electron/main.cjs"), "utf8");
  const watchSetup = main.slice(main.indexOf('ipcMain.handle("watch:setRoot"'), main.indexOf("// Recipe WORKSPACE TRUST"));
  h.ok(watchSetup.length > 0 && /watchRules\.projectWatchRoutes\(manifest\)/.test(watchSetup), "the routes come from project.json through projectWatchRoutes");
  h.ok(/watchRules\.watchTargetRels\(routes\)/.test(watchSetup), "the watch targets are exactly the routes");
  h.ok(/subsystemFor\(projectRoot, abs, routes\)/.test(watchSetup), "the classifier is given the same routes");
  h.ok(!/\[\s*"plots",\s*"fig"/.test(main), "no hand-written folder list remains");
  const classifier = main.slice(main.indexOf("function subsystemFor("), main.indexOf("const captureFamily"));
  h.ok(/watchRules\.routeProjectRel\(routes, rel\)/.test(classifier), "subsystemFor routes through routeProjectRel");
  h.ok(!/rel\.startsWith\("(paper|manuscript|fig|references|slides|Context)\/"\)/.test(classifier), "subsystemFor has no private folder prefixes");
  const discovery = readFileSync(join(repo, "src/lib/project/documentFiles.ts"), "utf8");
  h.ok(/from '\.\.\/\.\.\/\.\.\/electron\/documentRoots\.js'/.test(discovery) && !/'paper', 'manuscript'/.test(discovery), "document discovery reads its folders from the same documentRoots module");
}

await h.done();
