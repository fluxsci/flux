// R3 — FluxReader context handoff to external agents. The live MCP handshakes
// cover source and bundled entry points; source checks pin the Reader selection
// seam and the D13 terminal removal.
// Run through scripts/run-verifies.mjs --tier pure --only r3-agent.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { tsxCli as resolveTsxCli } from "./lib/tsxRun.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else {
    console.log("  ok:", msg);
  }
}
const read = (p: string) => readFileSync(join(root, p), "utf8");

// --- 1. live MCP handshake (both commands agent:mcpSpec can return) -----------------
// Dev: repo tsx bin + flux-mcp.ts. Packaged: the esbuild bundle dist/flux-mcp.mjs
// (spawned via ELECTRON_RUN_AS_NODE from app.asar.unpacked — here plain `node` is
// the equivalent runtime). Both must complete the same stdio JSON-RPC handshake.
const fakeProject = join(tmpdir(), "flux-r3-verify-project");
mkdirSync(fakeProject, { recursive: true });

function mcpHandshake(cmd: string, cmdArgs: string[], label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: fakeProject,
      stdio: ["pipe", "pipe", "pipe"],
      // never run the FluxConfig migration against the real HOME from a test
      env: { ...process.env, FLUX_NO_MIGRATE: "1" },
    });
    const timeout = setTimeout(() => {
      assert(false, `[${label}] MCP server answered within 25s (timed out)`);
      child.kill();
      resolve();
    }, 25000);
    let buf = "";
    let sentCall = false;
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { serverInfo?: { name?: string }; content?: { text?: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && !sentCall) {
          sentCall = true;
          assert(msg.result?.serverInfo?.name === "flux", `[${label}] initialize handshake → serverInfo.name === 'flux'`);
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "get_reading_context", arguments: {} },
            }) + "\n",
          );
        } else if (msg.id === 2) {
          const text = msg.result?.content?.[0]?.text ?? "";
          assert(text.length > 0, `[${label}] tools/call get_reading_context returns content`);
          // Clean empty states: no context file at all ("No reader context") OR a
          // context whose citekey is empty (the reader was closed — flux-mcp
          // answers "No paper is open in FluxReader right now."). This test reads
          // the REAL machine-global FluxLib, so both empties are legitimate.
          assert(
            /citekey|No reader context|No paper is open/i.test(text),
            `[${label}] context mentions a citekey (or a clean empty state): ${text.slice(0, 80)}…`,
          );
          clearTimeout(timeout);
          child.kill();
          resolve();
        }
      }
    });
    child.on("error", (e) => {
      assert(false, `[${label}] MCP server spawn failed: ${e.message}`);
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-r3", version: "0" } },
      }) + "\n",
    );
  });
}

console.log("R3 — live flux MCP server, dev command (get_reading_context):");
// Spawn tsx the way mcpSpecForCli does: this node + the installed CLI. The
// .bin shim is an sh script on Windows and its .cmd twin cannot be spawned
// without a shell on current Node, so neither is a portable command.
const tsxCli = resolveTsxCli();
const entry = join(root, "flux-mcp.ts");
assert(existsSync(tsxCli) && existsSync(entry), "dev MCP command exists (the installed tsx CLI + flux-mcp.ts)");
await mcpHandshake(process.execPath, [tsxCli, entry, fakeProject], "dev");

// Packaged twin: if the CLI bundle was built, the MCP bundle MUST exist beside it
// (a built-but-drifted dist/ is exactly the state that shipped a broken Ask Claude).
const cliBundle = join(root, "dist", "flux-cli.mjs");
const mcpBundle = join(root, "dist", "flux-mcp.mjs");
if (existsSync(cliBundle)) {
  console.log("\nR3 — live flux MCP server, packaged bundle (dist/flux-mcp.mjs):");
  assert(existsSync(mcpBundle), "dist/flux-mcp.mjs built alongside dist/flux-cli.mjs (build-cli.mjs emits both)");
  if (existsSync(mcpBundle)) await mcpHandshake(process.execPath, [mcpBundle, fakeProject], "bundle");
} else {
  console.log("\nR3 — dist/flux-cli.mjs absent (no build yet) — skipping bundle handshake");
}

// --- 2. source wiring -----------------------------------------------------------------
console.log("\nR3 — main-process MCP resolution (source):");
const agentCjs = read("electron/ipc/agent.cjs");
assert(/function mcpSpecFor\(/.test(agentCjs), "agent family resolves the MCP spec (mcpSpecFor)");
assert(/node_modules",\s*"\.bin",/.test(agentCjs) && /"tsx\.cmd" : "tsx"/.test(agentCjs) && /flux-mcp\.ts/.test(agentCjs), "dev spec = repo tsx bin + flux-mcp.ts (absolute; tsx.cmd twin on win32 — the agent spawns from its own cwd)");
assert(/app\.asar\.unpacked", "dist", "flux-mcp\.mjs"/.test(agentCjs) && /ELECTRON_RUN_AS_NODE/.test(agentCjs), "packaged spec = unpacked bundle on Electron-as-Node");
assert(/mcpSpec: mcp\.ok \? \{ command: mcp\.command/.test(agentCjs), "principalSpec embeds the MCP spec ({mcpJson} roster placeholder)");
assert(/^\s*- dist\/flux-mcp\.mjs/m.test(read("electron-builder.yml")), "electron-builder.yml asar-unpacks dist/flux-mcp.mjs (the packaged spawn path)");
assert(!/agent:mcpSpec/.test(read("electron/ipc/contract.cjs")), "the retired agent:mcpSpec channel is gone from the contract");

// D13 retires the in-app shell and its passage prefill. Reader context remains
// available to external agents; Phase 4 will use the selection/annotation anchors.
console.log("\nR3 — reader context without an in-app terminal (source):");
const rm = read("src/shell/modes/reader/ReaderMode.svelte");
const rd = read("src/shell/modes/reader/ReaderDoc.svelte");
const pv = read("src/shell/modes/reader/PdfView.svelte");
const hp = read("src/shell/modes/reader/HighlightPopover.svelte");
assert(!/TerminalPane|terminalPrefill|askAgent|agentPane/.test(rm + rd), "Reader has no terminal mount or prefill route");
assert(!/onAskSelection|onAsk|✦/.test(pv + hp), "Reader passage actions stay hidden until Annotate is implemented");
assert(/onSelect=\{handleSelect\}/.test(rd) && /onSelect\?\.\(anchor\.quote, page\)/.test(pv), "selection still publishes the exact passage and page");
assert(/reader-context\.json/.test(read("src/lib/references/items.ts")), "reader still publishes reader-context.json (any session can get_reading_context)");
for (const file of ["src/shell/terminal/terminalSession.ts", "src/shell/terminal/TerminalPane.svelte", "src/shell/modes/paper/margin/views/TerminalView.svelte", "electron/ipc/terminal.cjs"]) {
  assert(!existsSync(join(root, file)), `retired terminal file is absent: ${file}`);
}
assert(!/pty:/.test(read("electron/ipc/contract.cjs") + read("electron/preload.cjs")), "the PTY IPC surface is absent");
assert(!/TermBridge/.test(read("src/lib/project/types.ts")), "FileBridge has no terminal API");
assert(!/nodePty|terminalFamily|reapPtys/.test(read("electron/main.cjs")), "Electron no longer loads or registers the terminal backend");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
for (const name of ["@lydell/node-pty", "@xterm/xterm", "@xterm/addon-fit"]) {
  assert(!pkg.dependencies?.[name] && !lock.packages?.[`node_modules/${name}`], `${name} is absent from runtime dependencies and lockfile`);
}
assert(!/@lydell|node-pty/.test(read("electron-builder.yml")), "packaging has no PTY native-module entries or architecture caveats");

if (failures) {
  console.error(`\nR3 AGENT-HANDOFF VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nR3 AGENT-HANDOFF VERIFY: PASS");
