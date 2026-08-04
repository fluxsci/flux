// R3 — FluxReader "Ask AI" context handoff (terminal-first rework, 2026-07-20:
// the bespoke AgentDrawer is retired — the reader mounts the SHARED terminal
// session and PREFILLS questions; agents get reader state via the flux MCP's
// get_reading_context). Two parts:
// presence: main-process / build-config source shapes — not headless-drivable (WS-7.5).
//  1. LIVE: launch the flux MCP server both ways a principal launch resolves it
//     (repo tsx + flux-mcp.ts; the packaged bundle) and drive a real stdio
//     JSON-RPC handshake through tools/call get_reading_context.
//  2. SOURCE: assert the wiring (agent.cjs mcpSpecFor + roster {mcpJson} embed,
//     ReaderMode terminal pane + prefill routing, PdfView ✦ menu).
//   Run: npx tsx scripts/verify-r3-agent.ts
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
const tsxBin = join(root, "node_modules", ".bin", "tsx");
const entry = join(root, "flux-mcp.ts");
assert(existsSync(tsxBin) && existsSync(entry), "dev MCP command exists (node_modules/.bin/tsx + flux-mcp.ts)");
await mcpHandshake(tsxBin, [entry, fakeProject], "dev");

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

console.log("\nR3 — reader terminal + prefill routing (source):");
const rm = read("src/shell/modes/reader/ReaderMode.svelte");
assert(/import TerminalPane from "\.\.\/\.\.\/terminal\/TerminalPane\.svelte"/.test(rm), "reader mounts the SHARED terminal pane (one session with the paper margin)");
assert(/async function askAgent\(/.test(rm) && /terminalPrefill\(/.test(rm), "askAgent opens the pane and PREFILLS the question (never submits)");
const rd = read("src/shell/modes/reader/ReaderDoc.svelte");
assert(/onAsk=\{\(\) => askClaudeAbout\(\w+!?\)\}/.test(rd), "popover Ask routes the highlight into the terminal");
assert(/onAskSelection=\{\(text, page\)/.test(rd), "selection ✦ routes the passage into the terminal");
const ts = read("src/shell/terminal/terminalSession.ts");
assert(/export function prefill\(/.test(ts) && /t \+ " "/.test(ts), "terminalSession.prefill writes WITHOUT a newline (prefill, not submit)");
assert(/reader-context\.json/.test(read("src/lib/references/items.ts")), "reader still publishes reader-context.json (any session can get_reading_context)");
const pv = read("src/shell/modes/reader/PdfView.svelte");
assert(/onAskSelection\?: \(text: string, page: number\)/.test(pv) && /class="mask"/.test(pv), "selection menu carries the ✦ ask button");

if (failures) {
  console.error(`\nR3 AGENT-HANDOFF VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nR3 AGENT-HANDOFF VERIFY: PASS");
