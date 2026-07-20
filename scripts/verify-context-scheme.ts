#!/usr/bin/env -S npx tsx
// The Context scheme's machine layer (principal-agent, pure tier).
//   npx tsx scripts/verify-context-scheme.ts
// Covers: fluxContextDocs.gen.cjs drift (regenerating from resources/ must be
// byte-identical — the validators.gen discipline), stock-doc content pins,
// agentsConfig seed/read/resolve (placeholder substitution, flag-dropping,
// prompt fallback, cwd rule), and the contextTemplates entries both engines
// scaffold from. (ensureFluxConfig's end-to-end sims live in verify-fluxconfig.)
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
    "PRINCIPAL.md",
    "WORKERS.md",
    "FLUX-CLI.md",
    "PROJECT-GUIDE.md",
    "AGENTS-CONFIG.md",
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
  ok(/Boot sequence/.test(files["PRINCIPAL.md"]) && /notebook law/i.test(files["PRINCIPAL.md"]), "PRINCIPAL.md carries boot sequence + notebook law");
  ok(/Delegation discipline/.test(files["PRINCIPAL.md"]) && /Promotion discipline/.test(files["PRINCIPAL.md"]), "PRINCIPAL.md carries delegation + promotion doctrine");
  ok(/report/i.test(files["WORKERS.md"]) && /brief is your contract/i.test(files["WORKERS.md"]), "WORKERS.md carries the brief contract + report shape");
  ok(files["FLUX-CLI.md"].includes("{{FLUX_CLI}}") && files["FLUX-CLI.md"].includes("{{FLUX_MCP}}"), "FLUX-CLI.md keeps its install-time placeholders in the SOURCE");
  ok(/UserContext/.test(files["README.md"]) && /ownership/i.test(files["README.md"]), "README.md maps the two Context folders + ownership");
  ok(/compose-figure/.test(files["PROJECT-GUIDE.md"]) && /Live bridge/.test(files["PROJECT-GUIDE.md"]), "PROJECT-GUIDE.md carries the verb surface (the retired AGENTS.md content)");
  ok(typeof docs.FLUX_CONTEXT_HASH === "string" && docs.FLUX_CONTEXT_HASH.length === 16, "content hash present");
}

// --- 3. agentsConfig: seed / read / resolve ---------------------------------
const acMod = (await import("../electron/agentsConfig.cjs")) as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ac = (acMod.resolveAgentSpec ? acMod : acMod.default) as any;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ctxscheme-"));
try {
  const cfg = path.join(scratch, "FluxConfig");
  fs.mkdirSync(cfg, { recursive: true });
  ok(ac.seedAgentsConfigSync(cfg) === true, "agents.json seeded on first run");
  ok(ac.seedAgentsConfigSync(cfg) === false, "seed is once-only (user-owned afterwards)");
  const roster = ac.readAgentsConfigSync(cfg);
  ok(!roster.legacy && roster.families.codex && roster.families.claude, "seeded roster is the family-template schema");
  ok(roster.defaults.worker.model === ac.DECIDES && roster.defaults.principal.effort === "xhigh", "defaults: principal fixed, worker principal-decides");

  // family templates: {model}/{effort} substitute as SUBSTRINGS; a decides/default
  // value drops the arg WITH its flag; the boot prompt/env still flow through.
  const projectF = path.join(scratch, "ws", "paper");
  fs.mkdirSync(projectF, { recursive: true });
  const famSpec = ac.resolveFamilyLaunch(roster, "exec", { family: "codex", model: "gpt-5.6-luna", effort: "medium" }, {
    prompt: "brief text",
    projectRoot: projectF,
    mcpSpec: null,
    client: "worker",
  });
  ok(famSpec.command === "codex" && famSpec.args.includes("gpt-5.6-luna"), "family template substitutes {model}");
  ok(famSpec.args.includes("model_reasoning_effort=medium"), "family template substitutes {effort} inside a composite arg");
  const noEffort = ac.resolveFamilyLaunch(roster, "exec", { family: "codex", model: "gpt-5.6-sol", effort: "default" }, {
    prompt: "x",
    projectRoot: projectF,
    mcpSpec: null,
    client: "worker",
  });
  ok(!noEffort.args.some((a: string) => a.includes("model_reasoning_effort")) && !noEffort.args.includes("-c") === false, "effort=default drops the effort arg + its flag");
  ok(noEffort.args.filter((a: string) => a === "-c").length === 3, "only the effort -c pair dropped (approval trio intact)");
  let famErr = "";
  try {
    ac.resolveFamilyLaunch(roster, "exec", { family: "gemini", model: "x", effort: "y" }, { prompt: "x", projectRoot: projectF, client: "worker" });
  } catch (e) {
    famErr = String(e);
  }
  ok(/no agent family "gemini"/.test(famErr) && /codex/.test(famErr), "unknown family errors with the available list");

  // standing selection: defaults, then last-used wins
  const sel0 = ac.standingSelectionSync(cfg, roster);
  ok(sel0.principal.model === "gpt-5.6-sol" && sel0.worker.model === ac.DECIDES, "standing selection = defaults before any pick");
  ac.writeLastUsedSync(cfg, { principal: { family: "codex", model: "gpt-5.6-terra", effort: "high" }, worker: { family: "codex", model: "gpt-5.6-luna", effort: "low" } });
  const sel1 = ac.standingSelectionSync(cfg, roster);
  ok(sel1.principal.model === "gpt-5.6-terra" && sel1.worker.effort === "low", "last-used picker choice overrides defaults");

  // worker policy env + menu notes
  const pol = ac.parseWorkerPolicy(ac.workerPolicyEnv({ family: "codex", model: ac.DECIDES, effort: ac.DECIDES }));
  ok(pol.family === "codex" && pol.model === ac.DECIDES, "worker policy round-trips through the env");
  const menuDecide = ac.workerMenuNote(roster, { family: "codex", model: ac.DECIDES, effort: ac.DECIDES }, "flux");
  ok(/--model <m> --effort <e>/.test(menuDecide) && /gpt-5.6-terra/.test(menuDecide) && /Match effort to difficulty/.test(menuDecide), "decide-mode menu lists models/efforts + guidance");
  const menuFixed = ac.workerMenuNote(roster, { family: "codex", model: "gpt-5.6-sol", effort: "medium" }, "flux");
  ok(/worker fixed: codex\/gpt-5.6-sol\/medium/.test(menuFixed), "fixed-mode note names the pinned worker");

  // legacy rosters still resolve (fixed principal/workers commands)
  const legacyCfg = path.join(scratch, "LegacyConfig");
  fs.mkdirSync(legacyCfg, { recursive: true });
  fs.writeFileSync(path.join(legacyCfg, "agents.json"), JSON.stringify({ principal: { command: ["mytool", "{prompt}"] }, workers: { analysis: { command: ["mytool", "-p", "{prompt}"] } } }));
  const legacy = ac.readAgentsConfigSync(legacyCfg);
  ok(legacy.legacy === true && legacy.principalPass.command[0] === "mytool", "legacy fixed-command roster detected (pass falls back to principal)");

  // resolve: placeholder substitution + mcp wiring
  const project = path.join(scratch, "ws", "paper");
  fs.mkdirSync(project, { recursive: true });
  const spec = ac.resolveAgentSpec(
    { command: ["claude", "--mcp-config", "{mcpJson}", "{prompt}"] },
    { prompt: "hello", projectRoot: project, mcpSpec: { command: "node", args: ["/x/flux-mcp.mjs", project] }, client: "principal" },
  );
  ok(spec.command === "claude" && spec.args[spec.args.length - 1] === "hello", "{prompt} substitutes in place");
  ok(JSON.parse(spec.args[1]).mcpServers.flux.command === "node", "{mcpJson} embeds the MCP server spec");
  ok(spec.env.FLUX_PROJECT === project && spec.env.FLUX_CLIENT === "principal", "identity env always set");

  // resolve: unavailable placeholder drops its flag too
  const noMcp = ac.resolveAgentSpec(
    { command: ["claude", "--mcp-config", "{mcpJson}", "{prompt}"] },
    { prompt: "hi", projectRoot: project, mcpSpec: null, client: "principal" },
  );
  ok(!noMcp.args.includes("--mcp-config"), "missing mcpSpec drops --mcp-config AND its value");

  // resolve: no prompt slot → appended as final arg
  const appended = ac.resolveAgentSpec({ command: ["codex", "exec"] }, { prompt: "task", projectRoot: project, client: "worker" });
  ok(appended.args[appended.args.length - 1] === "task", "prompt appends when no placeholder");

  // cwd rule: plain parent → project; workspace-marked parent → parent
  ok(ac.resolveAgentSpec({ command: ["x"] }, { projectRoot: project, client: "worker" }).cwd === project, "cwd defaults to project (no workspace markers)");
  fs.writeFileSync(path.join(scratch, "ws", "AGENTS.md"), "# workspace\n");
  ok(ac.resolveAgentSpec({ command: ["x"] }, { projectRoot: project, client: "worker" }).cwd === path.join(scratch, "ws"), "cwd = parent when it looks like an analysis workspace");
  ok(ac.resolveAgentSpec({ command: ["x"], cwd: "project" }, { projectRoot: project, client: "worker" }).cwd === project, "explicit cwd override wins");

  // corrupt roster falls back with warning (to the DEFAULT family schema)
  fs.writeFileSync(path.join(cfg, "agents.json"), "{not json");
  const bad = ac.readAgentsConfigSync(cfg);
  ok(bad.warning !== null && !bad.legacy && bad.families.codex, "corrupt agents.json → default families + warning, never a throw");

  // boot/pass prompts point at the doctrine, with the machine CLI baked in
  // (the "flux: command not found" first-instruction detour, 2026-07-19).
  const boot = ac.principalBootPrompt(project, 'node "/x/dist/flux-cli.mjs"');
  ok(/PRINCIPAL\.md/.test(boot) && /node "\/x\/dist\/flux-cli\.mjs" config/.test(boot), "boot prompt bakes the resolved CLI into its config instruction");
  ok(/flux config/.test(ac.principalBootPrompt(project)), "boot prompt falls back to bare `flux` without a resolver");
  ok(/resolve each with a note/.test(ac.passPrompt(project)) && /node "\/x\/dist\/flux-cli\.mjs"/.test(ac.passPrompt(project, 'node "/x/dist/flux-cli.mjs"')), "pass prompt demands per-item resolution + bakes the CLI");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// --- 4. project templates (both engines scaffold from these) ----------------
const tpl = await import("../src/lib/project/contextTemplates");
{
  const entries = tpl.contextScaffoldEntries("My Study");
  ok(entries.dirs.includes("Context/Transcripts") && entries.dirs.includes("Context/Dispatches"), "entries: archive dirs present");
  const mission = entries.files.find(([r]) => r === "Context/Project/MISSION.qmd")?.[1] ?? "";
  ok(/^---\ntitle: "Mission — My Study"/.test(mission), "mission template carries front-matter title (paper-doc discovery)");
  ok(tpl.isRetiredAgentsGuide("# X — agent guide\n\nblah The file *is* the API blah"), "retired-guide detector: positive");
  ok(!tpl.isRetiredAgentsGuide("# my own notes\nThe file *is* the API"), "retired-guide detector: user-authored spared");
}

await h.done();
