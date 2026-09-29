#!/usr/bin/env -S npx tsx
// The Context layer: generated stock docs, placeholder discipline and the
// shared project templates. Machine-init simulations live in verify-fluxconfig.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tokensOf } from "../flux-core/connect/facts";

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
    "README.md", "FLUX.md", "CONNECT.md", "WORKFLOW.md", "CLI-REFERENCE.md",
    "PROJECT-AND-FIGURES.md", "PLOTS-AND-STYLE.md", "PYTHON-CONVENTIONS.md",
    "MANUSCRIPT.md", "REVIEW.md", "LIBRARY.md", "SLIDES.md", "LIGHTTABLE.md",
  ];
  h.eq(Object.keys(files).sort(), [...expect].sort(), "stock set is exactly the 13-document connect manual (D5)");
  const doc = (name: string) => files[name] ?? "";
  for (const name of expect) {
    ok(doc(name).split("\n")[0].includes("(stock — shipped with Flux, do not edit)"), `${name}: stock ownership header`);
    ok(doc("README.md").includes(`[${name}](${name})`), `README indexes ${name}`);
  }
  ok(/## .*Glossary/i.test(doc("FLUX.md")) && /## .*The tool map/i.test(doc("FLUX.md")), "FLUX.md has glossary and tool map headings");
  for (const pin of ["receipt", "watch", "Log", "only when asked"])
    ok(doc("CONNECT.md").includes(pin), `CONNECT.md carries ${pin}`);

  // Use the connect engine's token estimate, so prompt excerpts and the reading
  // plan share one budget. Require exactly one complete pair, never a first-match
  // success that silently ignores a duplicated or unclosed extraction block.
  for (const [name, marker, limit] of [
    ["FLUX.md", "ask-summary", 600],
    ["CONNECT.md", "ask-rules", 400],
    ["CONNECT.md", "task-rules", 400],
  ] as const) {
    const source = doc(name), start = `<!-- ${marker} -->`, end = `<!-- /${marker} -->`;
    const pieces = source.split(start), ends = source.split(end);
    const body = pieces.length === 2 && ends.length === 2 && pieces[1].includes(end)
      ? pieces[1].split(end)[0].trim() : "";
    ok(!!body, `${name}: exactly one nonempty, correctly ordered ${marker} block`);
    ok(tokensOf(body) <= limit, `${name}: ${marker} <= ${limit} tokens (${tokensOf(body)})`);
  }
  ok(/read-only/.test(doc("CONNECT.md")) && /Never push, publish or delete/.test(doc("CONNECT.md")), "compact Ask/task contracts retain their safety boundaries");
  const watch = doc("REVIEW.md").split("## Watch-mode protocol")[1]?.split("\n## ")[0] ?? "";
  for (const [step, pin] of [[1, "scope"], [2, "list_inbox"], [3, "wait_for_inbox"], [4, "claim_item"], [5, "stopped: true"]] as const) {
    const block = watch.split(`\n${step}. `)[1]?.split(/\n\d+\. /)[0] ?? "";
    ok(block.includes(pin), `REVIEW watch step ${step}: ${pin}`);
  }
  ok(watch.includes("needsInput:true") && watch.includes("revoked") && watch.includes("empty timeout"), "watch protocol covers questions, revocation and empty waits");
  ok(doc("REVIEW.md").includes('flux_verb {verb:"get_inbox_image"'), "REVIEW reaches snapshots omitted from the core toolset");
  ok(/add-figure/.test(doc("CLI-REFERENCE.md")) && !/add-math/.test(doc("CLI-REFERENCE.md")), "CLI-REFERENCE reflects the current slide surface (no retired verbs)");
  ok(["inbox", "claim", "reply", "resolve"].every(v => doc("WORKFLOW.md").includes(`"$F" ${v}`)), "WORKFLOW covers the complete inbox review loop");
  ok(doc("CLI-REFERENCE.md").includes('"{{FLUX_CLI}}" connect setup') && doc("CLI-REFERENCE.md").includes("{{FLUX_MCP}}"), "setup and MCP invocation use the canonical launcher placeholders");
  ok(!Object.values(files).some(body => body.includes("{{FLUX_MCP_PATH}}")), "retired MCP path placeholder is absent");
  ok(/aligned by filename|SAME item filenames/.test(doc("LIGHTTABLE.md")) && /\{\{LIGHTTABLE_DIR\}\}/.test(doc("LIGHTTABLE.md")), "LIGHTTABLE carries the alignment convention + dir placeholder");
  ok(/uv init/.test(doc("PYTHON-CONVENTIONS.md")) && /uv add --editable ~\/fluxplot/.test(doc("PYTHON-CONVENTIONS.md")) && /uv init --lib/.test(doc("PYTHON-CONVENTIONS.md")), "PYTHON-CONVENTIONS carries the uv doctrine (project + fluxplot dep + library form)");
  ok(/\{\{FLUX_REPO\}\}\/docs\/installation\.qmd/.test(doc("PYTHON-CONVENTIONS.md")), "PYTHON-CONVENTIONS points troubleshooting at the installation doc");
  const machineSpecific = Object.entries(files).filter(([, body]) => /driessen2|\/home\/[^\s/`]+/.test(body));
  ok(machineSpecific.length === 0, `stock docs carry no machine-specific paths (${machineSpecific.map(([n]) => n).join(", ") || "clean"})`);
  ok(doc("FLUX.md").includes('"{{FLUX_CLI}}"') && doc("FLUX.md").includes("{{FLUX_MCP}}"), "FLUX.md quotes its launcher placeholder and keeps MCP delegation");
  ok(!/(^|[^"'])\$F\s/m.test(doc("WORKFLOW.md")), "WORKFLOW quotes the launcher variable in every shell command");
  ok(/UserContext/.test(doc("README.md")) && /ownership/i.test(doc("README.md")), "README.md maps the Context folders + ownership");
  ok(/compose-figure/.test(doc("PROJECT-AND-FIGURES.md")) && /get_app_context/.test(doc("REVIEW.md")), "merged references preserve figure and live-bridge guidance");
  const retired = /(?:FLUX-CLI|PROJECT-GUIDE|TEMPLATES|MANUSCRIPT-AND-REVIEW)\.md/;
  ok(!Object.values(files).some(body => retired.test(body)), "stock references name no deleted or renamed manual");
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
