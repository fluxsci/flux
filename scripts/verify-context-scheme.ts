#!/usr/bin/env -S npx tsx
// The Context layer: generated stock docs, placeholder discipline and the
// shared project templates. Machine-init simulations live in verify-fluxconfig.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-context-scheme");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const genPath = path.join(repoRoot, "electron", "fluxContextDocs.gen.cjs");

// --- 1. generated module is in sync with resources/flux-context ------------
{
  const before = fs.readFileSync(genPath, "utf8");
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "gen-flux-context.mjs")], { stdio: "pipe" });
  const after = fs.readFileSync(genPath, "utf8");
  if (!ok(before === after, "fluxContextDocs.gen.cjs is in sync with resources/flux-context (run scripts/gen-flux-context.mjs)")) {
    fs.writeFileSync(genPath, before); // never leave the tree dirty on failure
  }
}

// --- 2. stock docs: content pins + placeholder discipline -------------------
const docsMod = (await import("../electron/fluxContextDocs.gen.cjs")) as Record<string, unknown>;
const docs = (docsMod.FLUX_CONTEXT_FILES ? docsMod : docsMod.default) as {
  FLUX_CONTEXT_FILES: Record<string, string>;
  FLUX_CONTEXT_HASH: string;
};
{
  const files = docs.FLUX_CONTEXT_FILES as Record<string, string>;
  const expect = [
    "README.md",
    "FLUX-CLI.md",
    "PROJECT-GUIDE.md",
    // the skill-content migration (2026-07-19): the working references are stock too
    "WORKFLOW.md",
    "CLI-REFERENCE.md",
    "PLOTS-AND-STYLE.md",
    "PROJECT-AND-FIGURES.md",
    "MANUSCRIPT-AND-REVIEW.md",
    "SLIDES.md",
    "TEMPLATES.md",
    "LIGHTTABLE.md",
    "PYTHON-CONVENTIONS.md",
  ];
  ok(expect.every((n) => n in files) && Object.keys(files).length === expect.length, `stock set complete (${expect.length} docs)`);
  ok(/add-figure/.test(files["CLI-REFERENCE.md"]) && !/add-math/.test(files["CLI-REFERENCE.md"]), "CLI-REFERENCE reflects the post-migration slide surface (no retired verbs)");
  ok(/inbox/.test(files["WORKFLOW.md"]) && /\bresolve\b/.test(files["WORKFLOW.md"]), "WORKFLOW's review loop covers the unified inbox");
  ok(files["TEMPLATES.md"].includes('command = "{{FLUX_CLI}}"') && files["TEMPLATES.md"].includes('args = ["mcp",') && !Object.values(files).some(body => body.includes("{{FLUX_MCP_PATH}}")), "manual MCP snippets use the canonical launcher; retired MCP path placeholder is absent");
  ok(/aligned by filename|SAME item filenames/.test(files["LIGHTTABLE.md"]) && /\{\{LIGHTTABLE_DIR\}\}/.test(files["LIGHTTABLE.md"]), "LIGHTTABLE carries the alignment convention + dir placeholder");
  ok(/uv init/.test(files["PYTHON-CONVENTIONS.md"]) && /uv add --editable ~\/fluxplot/.test(files["PYTHON-CONVENTIONS.md"]) && /uv init --lib/.test(files["PYTHON-CONVENTIONS.md"]), "PYTHON-CONVENTIONS carries the uv doctrine (project + fluxplot dep + library form)");
  ok(/\{\{FLUX_REPO\}\}\/docs\/installation\.qmd/.test(files["PYTHON-CONVENTIONS.md"]), "PYTHON-CONVENTIONS points troubleshooting at the installation doc");
  const machineSpecific = Object.entries(files).filter(([, body]) => /driessen2|\/home\/[a-z]/.test(body));
  ok(machineSpecific.length === 0, `stock docs carry no machine-specific paths (${machineSpecific.map(([n]) => n).join(", ") || "clean"})`);
  ok(files["FLUX-CLI.md"].includes('"{{FLUX_CLI}}"') && files["FLUX-CLI.md"].includes("{{FLUX_MCP}}"), "FLUX-CLI.md quotes its launcher placeholder and keeps MCP delegation");
  ok(!/(^|[^"'])\$F\s/m.test(files["WORKFLOW.md"]), "WORKFLOW quotes the launcher variable in every shell command");
  ok(/UserContext/.test(files["README.md"]) && /ownership/i.test(files["README.md"]), "README.md maps the two Context folders + ownership");
  ok(/compose-figure/.test(files["PROJECT-GUIDE.md"]) && /Live bridge/.test(files["PROJECT-GUIDE.md"]), "PROJECT-GUIDE.md carries the verb surface (the retired AGENTS.md content)");
  ok(typeof docs.FLUX_CONTEXT_HASH === "string" && docs.FLUX_CONTEXT_HASH.length === 16, "content hash present");
}

// --- 4. project templates (both engines scaffold from these) ----------------
const tpl = await import("../src/lib/project/contextTemplates");
{
  const entries = tpl.contextScaffoldEntries("My Study");
  const projectContext = entries.files.find(([r]) => r === "Context/ProjectContext.qmd")?.[1] ?? "";
  ok(/^---\ntitle: "Project context — My Study"/.test(projectContext), "project context template carries front-matter title (paper-doc discovery)");
  h.eq(entries.dirs, ["Context"], "Context has no scaffolded subfolders");
  h.eq(entries.files.map(([rel]) => rel), [...tpl.CONTEXT_DOC_RELS], "the three stock documents are in display order");
  ok(projectContext.includes("file AND every file it links") && projectContext.includes("## Background"), "ProjectContext is the must-read hub");
  const instruction = '*(Append-only, newest last: `### YYYY-MM-DD HH:MM — title`, For each entry, note which agent you are and where you are working from (cli/vsCode/desktop app/etc.). Use as much detail as is appropriate for the entry you are making, which could be anything from a very concise sentence or two to a highly-detailed multi-paragraph or multi-page entry)*';
  ok(tpl.notebookTemplate().includes(instruction), "notebook instruction is the owner's verbatim text");
  h.eq(tpl.notebookTemplate().match(/^## .+$/gm), ["## Log"], "new notebook has only the Log section");
  h.eq(tpl.claudeStubTemplate(), "@AGENTS.md\n", "CLAUDE.md is exactly the AGENTS.md import");
  ok(tpl.agentsStubTemplate().includes("do not connect unasked") && !/`flux[ `]/.test(tpl.agentsStubTemplate()), "agent pointer is passive and never invokes bare flux");
  ok(tpl.isRetiredAgentsGuide("# X — agent guide\n\nblah The file *is* the API blah"), "retired-guide detector: positive");
  ok(!tpl.isRetiredAgentsGuide("# my own notes\nThe file *is* the API"), "retired-guide detector: user-authored spared");
}

// --- heal parity: both engines add missing files and preserve authored bytes ---
{
  const core = await import("../flux-core/context");
  const { ensureProjectContext: guiHeal } = await import("../src/lib/project/contextHeal");
  const { buildScaffoldTree } = await import("../src/lib/project/scaffoldTree");
  const { createDeck } = await import("../src/lib/slide/ops");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "context-heal-"));
  const manifest = buildScaffoldTree({title: "Heal Test"}, createDeck({title: "Talk"})).manifest;
  const priorWindow = (globalThis as any).window;
  (globalThis as any).window = { fig: {
    exists: async (p: string) => fs.existsSync(p),
    mkdir: async (p: string) => { fs.mkdirSync(p, {recursive: true}); },
    readText: async (p: string) => fs.readFileSync(p, "utf8"),
    writeText: async (p: string, text: string, opts?: {createOnly?: boolean}) => { fs.writeFileSync(p, text, {flag: opts?.createOnly ? "wx" : "w"}); },
  } };
  try {
    for (const [name, heal] of [
      ["Node", (root: string) => core.ensureProjectContext(root)],
      ["GUI", (root: string) => guiHeal({root, manifest})],
    ] as const) {
      const root = path.join(scratch, name);
      fs.mkdirSync(root);
      h.eq(await heal(root), {created: [], skipped: "not-a-project"}, `${name}: requires project.json`);
      h.eq(fs.readdirSync(root), [], `${name}: non-project stays empty`);
      fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(manifest));
      const healed = await heal(root);
      const stock = [...tpl.contextScaffoldEntries(manifest.title).files, ["AGENTS.md", tpl.agentsStubTemplate()], ["CLAUDE.md", tpl.claudeStubTemplate()]];
      for (const [rel, body] of stock) h.eq(fs.readFileSync(path.join(root, rel), "utf8"), body, `${name}: ${rel} matches shared template`);
      ok(healed.created.includes("CLAUDE.md") && !healed.skipped, `${name}: reports created pointers`);
      h.eq((await heal(root)).created, [], `${name}: second heal is a no-op`);
      for (const [rel] of stock) fs.writeFileSync(path.join(root, rel), `User's ${rel}\n`);
      fs.unlinkSync(path.join(root, tpl.CONTEXT_PATHS.projectContext));
      h.eq((await heal(root)).created, [tpl.CONTEXT_PATHS.projectContext], `${name}: heals a single missing document`);
      for (const [rel] of stock.filter(([rel]) => rel !== tpl.CONTEXT_PATHS.projectContext))
        h.eq(fs.readFileSync(path.join(root, rel), "utf8"), `User's ${rel}\n`, `${name}: preserves edited ${rel}`);
      fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test — agent guide\nThe file *is* the API\n");
      await heal(root);
      h.eq(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), tpl.agentsStubTemplate(), `${name}: replaces the retired generated verb guide`);
      h.eq(fs.readdirSync(path.join(root, "Context")).sort(), ["NOTEBOOK.md", "ProjectContext.qmd", "RULES.md"], `${name}: only the three standard documents are created`);
    }
  } finally {
    if (priorWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = priorWindow;
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

// --- 5. FluxContext re-sync when the checkout MOVED ------------------------
// The stamped cli bakes this install's absolute paths into the synced docs. If
// those paths vanish, the checkout moved and every substitution on disk is
// dangling — re-sync. If they merely DIFFER (dev checkout vs packaged app, which
// resolve different {{FLUX_CLI}} strings), leave them: rewriting on every engine
// switch would churn the folder. "Gone", not "different", is the trigger.
{
  const fp = (await import("../electron/fluxPaths.cjs")) as Record<string, unknown>;
  const dangling = fp.stampedCliDanglingSync as (cli?: string) => boolean;
  const scratch5 = fs.mkdtempSync(path.join(os.tmpdir(), "flux-stamp-"));
  try {
    const live = path.join(scratch5, "flux-cli.mjs");
    fs.writeFileSync(live, "//");
    const gone = path.join(scratch5, "moved-away", "flux-cli.mjs");

    ok(dangling(`node "${live}"`) === false, "stamped cli whose path still exists: not dangling");
    ok(dangling(`node "${gone}"`) === true, "stamped cli whose path is gone: dangling → re-sync");
    ok(
      dangling(`ELECTRON_RUN_AS_NODE=1 "${live}" "${gone}"`) === true,
      "packaged-style command: ANY missing path counts as dangling",
    );
    ok(dangling("flux") === false, "bare `flux` fallback carries no paths: never dangling");
    ok(dangling(undefined) === false, "absent stamp field: not dangling");

    // The churn guard — the reason this is existence-based and not equality-based.
    const packaged = path.join(scratch5, "Flux.app-stand-in");
    fs.writeFileSync(packaged, "//");
    ok(
      dangling(`node "${live}"`) === false && dangling(`ELECTRON_RUN_AS_NODE=1 "${packaged}" "${live}"`) === false,
      "dev and packaged commands differ but both exist — neither triggers a re-sync",
    );
  } finally {
    fs.rmSync(scratch5, { recursive: true, force: true });
  }
}

await h.done();
