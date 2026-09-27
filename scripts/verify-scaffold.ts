// V1-readiness 0.6 gate — the consolidated scaffolder (AGT-15). `flux new` and the
// GUI's New-project now write the SAME tree from one source (src/lib/project/
// scaffoldTree.ts). This scaffolds via flux-core into a temp dir and asserts the
// canonical shape the two engines used to disagree on. Run: npx tsx scripts/verify-scaffold.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flux-scaf-cfg-")); // isolate prefs
const core = await import("../flux-core/index");
const { buildScaffoldTree } = await import("../src/lib/project/scaffoldTree");
const { createDeck } = await import("../src/lib/slide/ops");

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flux-scaf-"));
await core.scaffold(root, { title: "Consolidation Test", author: "A. Author" });

const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const has = (rel: string) => fs.existsSync(path.join(root, rel));

// --- manifest: the canonical (formerly GUI-only) shape --------------------------------
const m = JSON.parse(read("project.json"));
ok(m.manuscript.config === "paper/_quarto.yml", "manifest points at paper/_quarto.yml (CLI used to claim a _quarto.yml it never wrote)");
ok(has("paper/_quarto.yml"), "…and the _quarto.yml actually exists");
ok(m.manuscript.format === "quarto", `manuscript.format = quarto (was "pdf" from the CLI)`);
ok(m.references.csljson === "references/library.csl.json" && "defaultStyle" in m.references, "references block carries csljson/defaultStyle");
ok(m.capabilities?.figures === "0.1", "capabilities populated (CLI wrote {})");
ok(m.authors?.[0]?.name === "A. Author", "author threaded");

// --- tree completeness ------------------------------------------------------------------
for (const rel of ["README.md", ".gitignore", "AGENTS.md", "CLAUDE.md", "references/library.bib", ".meta/journal.ndjson", "paper/notes.qmd"])
  ok(has(rel), `${rel} written`);
const figIndex = JSON.parse(read("fig/index.json"));
ok(figIndex.figures?.length === 1 && figIndex.figures[0].name === "Figure 1", "fig index seeds Figure 1 (CLI wrote an empty index)");
ok(has("fig/canvases/canvas-1.json"), "seeded canvas file exists");
ok(read("references/library.bib").startsWith("%"), "project bib carries the cited-subset header");
const deckRel = m.slides?.[0]?.path ?? "";
ok(!!deckRel && has(deckRel), `starter deck registered + written (${deckRel})`);
const schemas = fs.readdirSync(path.join(root, ".meta", "schema"));
ok(schemas.length >= 7, `.meta/schema/ ships the contract (${schemas.length} files; GUI projects used to get an empty dir)`);

// --- AGENTS.md is the Context stub; the verb guide lives in FluxContext ------------------
// (Per-project baked guides went stale on
// every release — PROJECT-AND-FIGURES.md in the machine FluxContext re-syncs with the
// app. The stock docs themselves are pinned by verify-context-scheme.ts.)
const agents = read("AGENTS.md");
ok(agents.includes("# This is a Flux project") && agents.includes("flux-connect"), "AGENTS.md points to flux-connect");
ok(agents.includes("do not connect unasked"), "stub connects only on request");
ok(read("CLAUDE.md") === "@AGENTS.md\n", "CLAUDE.md imports the shared pointer");
ok(!/compose-figure/.test(agents), "the verb guide no longer bakes into projects (lives in FluxContext)");

// --- the project Context layer ------------------------------------------------------------
ok(has("Context/ProjectContext.qmd"), "ProjectContext document scaffolded");
ok(has("Context/NOTEBOOK.md") && read("Context/NOTEBOOK.md").includes("## Log"), "Context notebook scaffolded (Log only)");
ok(has("Context/RULES.md"), "Context project rules scaffolded");

ok(JSON.stringify(fs.readdirSync(path.join(root, "Context")).sort()) === JSON.stringify(["NOTEBOOK.md", "ProjectContext.qmd", "RULES.md"]), "Context tree has only the standard documents");
ok(read(".gitignore").includes(".meta/archive/") && read(".gitignore").includes(".meta/feedback/"), "archives and annotation images are ignored");

// --- validate: the scaffolded tree passes its own shipped schemas ------------------------
const v = await core.validate(root);
ok(v.ok, `flux validate passes on a fresh scaffold (${v.checked} files checked)`, v.errors.join(" | "));

// --- GUI parity: the shared builder produces the same file SET the engine wrote ----------
const tree = buildScaffoldTree({ title: "Consolidation Test", author: "A. Author" }, createDeck({ title: "Consolidation Test" }));
const wroteSet = new Set(tree.files.map(([rel]) => rel.replace(/slides\/[^/]+\//, "slides/<deck>/")));
const diskSet = new Set(
  ["project.json", "AGENTS.md", "CLAUDE.md", "README.md", ".gitignore", "paper/notes.qmd", "paper/_quarto.yml", "references/library.bib", "fig/index.json", "fig/canvases/canvas-1.json", deckRel.replace(/slides\/[^/]+\//, "slides/<deck>/"), ".meta/journal.ndjson", "Context/ProjectContext.qmd", "Context/NOTEBOOK.md", "Context/RULES.md", ...schemas.map((s) => `.meta/schema/${s}`)],
);
ok([...wroteSet].every((f) => diskSet.has(f)) && wroteSet.size === diskSet.size, `one tree, both engines (${wroteSet.size} files)`);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
