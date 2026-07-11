#!/usr/bin/env -S npx tsx
// WS-6.3 (fortify plan) — the verb-registry parity gate:
//   (a) the REAL MCP server's tools/list === the committed golden snapshot
//       (a rename/removal on either surface fails here first);
//   (b) `flux help` === the committed golden text;
//   (c) registered verbs produce the SAME core strings on both surfaces
//       (CLI decorates with "✓ "), and shared failures map per the taxonomy
//       (CLI exit codes incl. 75 for locks; MCP isError);
//   (d) surface inventory — every registry verb appears in the CLI help AND
//       the MCP tool list, and every `flux <verb>` the agent skill doc
//       (skills/flux/references/cli.md) names exists on the CLI surface.
// Regenerate goldens deliberately:  REGEN_GOLDEN=1 npx tsx scripts/verify-registry-parity.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN_DIR = path.join(REPO, "scripts", "fixtures");
const TOOLS_GOLDEN = path.join(GOLDEN_DIR, "mcp-tools.golden.json");
const HELP_GOLDEN = path.join(GOLDEN_DIR, "cli-help.golden.txt");
const REGEN = !!process.env.REGEN_GOLDEN;

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const { VERBS, registeredCliVerbs } = await import("../flux-core/registry");
const core = await import("../flux-core/index");

const TMP = path.join(REPO, "scratch-regparity");
await fs.rm(TMP, { recursive: true, force: true });
await core.scaffold(TMP, { title: "RegParity" });

// --- CLI runner ------------------------------------------------------------------
function runCli(args: string[], env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  return new Promise((res) => {
    const c = spawn("npx", ["tsx", "flux-cli.ts", ...args], {
      cwd: REPO,
      env: { ...process.env, FLUX_NO_MIGRATE: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.once("close", (code) => res({ out, err, code: code ?? -1 }));
  });
}

// --- MCP client -------------------------------------------------------------------
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "flux-mcp.ts", TMP],
  cwd: REPO,
  env: { ...(process.env as Record<string, string>), FLUX_NO_MIGRATE: "1" },
});
const client = new Client({ name: "regparity", version: "1.0.0" });
await client.connect(transport);

try {
  // ---- (a) tools/list golden -----------------------------------------------------
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  if (REGEN) {
    await fs.writeFile(TOOLS_GOLDEN, JSON.stringify(tools, null, 2) + "\n");
    ok(`REGENERATED ${path.basename(TOOLS_GOLDEN)} (${tools.length} tools)`);
  } else {
    const golden = JSON.parse(await fs.readFile(TOOLS_GOLDEN, "utf8")) as string[];
    const missing = golden.filter((t) => !tools.includes(t));
    const extra = tools.filter((t) => !golden.includes(t));
    assert(
      !missing.length && !extra.length,
      `tools/list matches the golden snapshot (${tools.length} tools)` +
        (missing.length ? ` — MISSING: ${missing.join(", ")}` : "") +
        (extra.length ? ` — EXTRA: ${extra.join(", ")}` : ""),
    );
  }

  // ---- (b) flux help golden --------------------------------------------------------
  const help = await runCli(["help"]);
  const helpText = help.out + help.err;
  if (REGEN) {
    await fs.writeFile(HELP_GOLDEN, helpText);
    ok(`REGENERATED ${path.basename(HELP_GOLDEN)} (${helpText.split("\n").length} lines)`);
  } else {
    const golden = await fs.readFile(HELP_GOLDEN, "utf8");
    assert(helpText === golden, "flux help matches the golden text");
  }

  // ---- (c) representative parity: success strings + error taxonomy ------------------
  {
    const cli = await runCli(["reindex", TMP]);
    const mcp = await client.callTool({ name: "reindex", arguments: {} });
    const mcpText = (mcp.content as { text?: string }[])[0]?.text ?? "";
    assert(cli.code === 0 && cli.err.trim() === `✓ ${mcpText}`, `reindex: CLI "✓ " + MCP core string ("${mcpText}")`);
  }
  {
    const cli = await runCli(["list", TMP]);
    const mcp = await client.callTool({ name: "list_project", arguments: {} });
    const mcpText = (mcp.content as { text?: string }[])[0]?.text ?? "";
    assert(cli.out.trim() === mcpText.trim(), "list_project: identical JSON payload on both surfaces");
  }
  {
    const cli = await runCli(["config", TMP]);
    const mcp = await client.callTool({ name: "config_paths", arguments: {} });
    const mcpText = (mcp.content as { text?: string }[])[0]?.text ?? "";
    const stable = (s: string) => JSON.stringify({ ...(JSON.parse(s) as Record<string, unknown>), build: "-" });
    assert(stable(cli.out) === stable(mcpText), "config_paths: identical payload (build stamp normalized)");
  }
  {
    // END-TO-END lock taxonomy (live since batch A registered the mutateFigModel
    // verbs): a held human lock defers a registry mutate verb on BOTH surfaces —
    // CLI exit 75 (EX_TEMPFAIL, script-retryable), MCP isError. The lock check
    // fires before model load, so the figure id never resolves.
    const lockPath = path.join(TMP, ".meta", "locks", "project.json");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ client: "human", pid: 999999, ts: new Date().toISOString() }));
    try {
      const cli = await runCli(["set-figure-layout", "anyfig", "--width", "100", "--root", TMP]);
      assert(
        cli.code === 75 && /locked/i.test(cli.err),
        `locked project → registry CLI verb exits 75 (got ${cli.code}: ${cli.err.trim().split("\n")[0]})`,
      );
      const mcp = await client.callTool({ name: "set_figure_layout", arguments: { figureId: "anyfig", width: 100 } });
      const mcpText = (mcp.content as { text?: string }[])[0]?.text ?? "";
      assert(mcp.isError === true && /locked/i.test(mcpText), "locked project → registry MCP twin isError with the lock message");
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }
  {
    // Error taxonomy unit level: the registry's surface mapping is the contract
    // 6.1 fixed by hand for compile/rerun.
    const { errorToCli, errorToMcp } = await import("../flux-core/registry");
    const { LockedError, ExternalToolError, NotFoundError } = await import("../flux-core/errors");
    const locked = errorToCli(new LockedError("deferred: project is locked (a human edit is in progress)"));
    assert(locked.exit === 75, "LockedError → CLI exit 75 (EX_TEMPFAIL, script-retryable)");
    const tool = errorToCli(new ExternalToolError("quarto exited 3", 3, "log tail"));
    assert(tool.exit === 3 && /log tail/.test(tool.err ?? ""), "ExternalToolError → its exit code + log on stderr");
    const nf = errorToCli(new NotFoundError("no figure \"ghost\""));
    assert(nf.exit === 1, "NotFoundError → CLI exit 1");
    const mcp = errorToMcp(new LockedError("deferred: project is locked"));
    assert(mcp.isError === true && /locked/.test(mcp.content[0]?.text ?? ""), "every taxonomy error → MCP isError with the message");
    // classifyError maps the WELL-KNOWN legacy strings until core sites convert.
    const { classifyError } = await import("../flux-core/errors");
    assert(classifyError(new Error("deferred: project is locked — a human edit is in progress")).code === "locked",
      "legacy lock string classifies as locked");
    assert(classifyError(new Error('no figure "x"')).code === "not-found", "legacy not-found string classifies");
  }

  // ---- (d) surface inventory ----------------------------------------------------------
  {
    const toolSet = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const v of VERBS) {
      if (!toolSet.has(v.name)) fail(`registry verb "${v.name}" missing from the MCP tool list`);
      if (!helpText.includes(v.cli)) fail(`registry verb "${v.cli}" missing from flux help`);
    }
    ok(`all ${VERBS.length} registry verbs present on both surfaces (help + tools/list)`);

    // Agent skill doc: every `flux <verb>` it names must exist on the CLI surface
    // (registry now, or a legacy switch case still to migrate).
    const doc = await fs.readFile(path.join(REPO, "skills", "flux", "references", "cli.md"), "utf8");
    const named = new Set<string>();
    for (const m of doc.matchAll(/(?:^|[`\s])flux\s+([a-z][a-z0-9-]+)/g)) named.add(m[1]);
    const cliSurface = new Set([...registeredCliVerbs()]);
    const legacy = await fs.readFile(path.join(REPO, "flux-cli.ts"), "utf8");
    for (const m of legacy.matchAll(/case "([a-z0-9-]+)":/g)) cliSurface.add(m[1]);
    const ghosts = [...named].filter((v) => !cliSurface.has(v) && !["help", "version"].includes(v));
    assert(!ghosts.length, `every skill-doc verb exists on the CLI surface${ghosts.length ? ` — GHOSTS: ${ghosts.join(", ")}` : ` (${named.size} checked)`}`);
  }
} finally {
  await client.close().catch(() => {});
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(failures ? `\nREGISTRY PARITY: FAIL (${failures})` : "\nREGISTRY PARITY: PASS");
process.exit(failures ? 1 : 0);
