// R3 — FluxReader "Ask Claude" context handoff. Two parts:
//  1. LIVE: launch the flux MCP server exactly the way agent:mcpSpec tells `claude` to
//     (repo tsx bin + flux-mcp.ts) and drive a real stdio JSON-RPC handshake through
//     tools/call get_reading_context — proving the spawned session can see the reader.
//  2. SOURCE: assert the wiring (main handler, preload, AgentDrawer --mcp-config +
//     initial prompt + ask() queue, ReaderMode popover/✦ routing) — the pty/claude UI
//     itself can't run in the headless harness.
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
    const child = spawn(cmd, cmdArgs, { cwd: fakeProject, stdio: ["pipe", "pipe", "pipe"] });
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
          assert(/citekey|No reader context/i.test(text), `[${label}] context mentions a citekey (or a clean empty state): ${text.slice(0, 80)}…`);
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
console.log("\nR3 — main/preload/bridge wiring (source):");
const main = read("electron/main.cjs");
assert(/ipcMain\.handle\("agent:mcpSpec"/.test(main), "main exposes agent:mcpSpec");
assert(/node_modules", "\.bin", "tsx"/.test(main) && /flux-mcp\.ts/.test(main), "dev spec = repo tsx bin + flux-mcp.ts (absolute — claude spawns from its own cwd)");
assert(/app\.asar\.unpacked", "dist", "flux-mcp\.mjs"/.test(main) && /ELECTRON_RUN_AS_NODE/.test(main), "packaged spec = unpacked bundle on Electron-as-Node");
assert(/^\s*- dist\/flux-mcp\.mjs/m.test(read("electron-builder.yml")), "electron-builder.yml asar-unpacks dist/flux-mcp.mjs (the packaged spawn path)");
const preload = read("electron/preload.cjs");
assert(/agentMcpSpec: \(\) => ipcRenderer\.invoke\("agent:mcpSpec"\)/.test(preload), "preload exposes fig.agentMcpSpec");
assert(/agentMcpSpec\?\(\): Promise/.test(read("src/lib/project/types.ts")), "FileBridge types agentMcpSpec");

console.log("\nR3 — AgentDrawer (source):");
const ad = read("src/shell/modes/reader/AgentDrawer.svelte");
assert(/--mcp-config/.test(ad) && /mcpServers: \{ flux: server \}/.test(ad), "spawns claude with --mcp-config registering the flux server");
assert(/--allowedTools", "mcp__flux"/.test(ad), "pre-allows the flux MCP tools (no permission prompt for context reads)");
assert(/get_reading_context/.test(ad), "initial prompt tells the session to read the live reading context");
assert(/reader-context\.json/.test(ad), "no-MCP fallback points at ~/FluxLib/.fluxlib/reader-context.json directly");
assert(/paper\?\.title/.test(ad) && /paper\?\.citekey/.test(ad), "initial prompt names the open paper (title + citekey)");
assert(/export function ask\(/.test(ad) && /pendingAsks/.test(ad), "exposes ask() with a queue for pre-boot questions");

console.log("\nR3 — ReaderMode/PdfView routing (source):");
const rm = read("src/shell/modes/reader/ReaderMode.svelte");
assert(/async function askAgent\(/.test(rm) && /agentDrawer\?\.ask\(/.test(rm), "askAgent opens the drawer and prefills the question");
// The popover annotation may be passed as `popAnn!` or a pinned `{@const ann}` — either
// wires the highlight into askClaudeAbout; assert the routing, not the variable name.
assert(/onAsk=\{\(\) => askClaudeAbout\(\w+!?\)\}/.test(rm), "popover Ask Claude routes the highlight into the session");
assert(/onAskSelection=\{\(text, page\)/.test(rm), "selection ✦ routes the passage into the session");
assert(/paper=\{\$readerKey \? \{ citekey: \$readerKey, title: entry\?\.title \} : null\}/.test(rm), "drawer receives the open paper");
const pv = read("src/shell/modes/reader/PdfView.svelte");
assert(/onAskSelection\?: \(text: string, page: number\)/.test(pv) && /class="mask"/.test(pv), "selection menu carries the ✦ ask button");

if (failures) {
  console.error(`\nR3 AGENT-HANDOFF VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nR3 AGENT-HANDOFF VERIFY: PASS");
