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
  ok(/feedback/.test(files["WORKFLOW.md"]) && /resolve-feedback/.test(files["WORKFLOW.md"]), "WORKFLOW's review loop covers the feedback ledger");
  ok(/\{\{FLUX_MCP_PATH\}\}/.test(files["TEMPLATES.md"]), "TEMPLATES keeps the MCP path placeholder in the SOURCE");
  ok(/aligned by filename|SAME item filenames/.test(files["LIGHTTABLE.md"]) && /\{\{LIGHTTABLE_DIR\}\}/.test(files["LIGHTTABLE.md"]), "LIGHTTABLE carries the alignment convention + dir placeholder");
  ok(/uv init/.test(files["PYTHON-CONVENTIONS.md"]) && /uv add --editable ~\/fluxplot/.test(files["PYTHON-CONVENTIONS.md"]) && /uv init --lib/.test(files["PYTHON-CONVENTIONS.md"]), "PYTHON-CONVENTIONS carries the uv doctrine (project + fluxplot dep + library form)");
  ok(/\{\{FLUX_REPO\}\}\/docs\/installation\.qmd/.test(files["PYTHON-CONVENTIONS.md"]), "PYTHON-CONVENTIONS points troubleshooting at the installation doc");
  const machineSpecific = Object.entries(files).filter(([, body]) => /driessen2|\/home\/[a-z]/.test(body));
  ok(machineSpecific.length === 0, `stock docs carry no machine-specific paths (${machineSpecific.map(([n]) => n).join(", ") || "clean"})`);
  ok(files["FLUX-CLI.md"].includes("{{FLUX_CLI}}") && files["FLUX-CLI.md"].includes("{{FLUX_MCP}}"), "FLUX-CLI.md keeps its install-time placeholders in the SOURCE");
  ok(/UserContext/.test(files["README.md"]) && /ownership/i.test(files["README.md"]), "README.md maps the two Context folders + ownership");
  ok(/compose-figure/.test(files["PROJECT-GUIDE.md"]) && /Live bridge/.test(files["PROJECT-GUIDE.md"]), "PROJECT-GUIDE.md carries the verb surface (the retired AGENTS.md content)");
  ok(typeof docs.FLUX_CONTEXT_HASH === "string" && docs.FLUX_CONTEXT_HASH.length === 16, "content hash present");
}

// --- 4. project templates (both engines scaffold from these) ----------------
const tpl = await import("../src/lib/project/contextTemplates");
{
  const entries = tpl.contextScaffoldEntries("My Study");
  const mission = entries.files.find(([r]) => r === "Context/Project/MISSION.qmd")?.[1] ?? "";
  ok(/^---\ntitle: "Mission — My Study"/.test(mission), "mission template carries front-matter title (paper-doc discovery)");
  ok(tpl.isRetiredAgentsGuide("# X — agent guide\n\nblah The file *is* the API blah"), "retired-guide detector: positive");
  ok(!tpl.isRetiredAgentsGuide("# my own notes\nThe file *is* the API"), "retired-guide detector: user-authored spared");
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
