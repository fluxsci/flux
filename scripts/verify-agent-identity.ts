#!/usr/bin/env -S npx tsx
// 2026-09-27 — who is calling Flux (plan §5.3, §6.4): the env/clientInfo matrix
// behind journal identity, `flux log` bylines, presence names and claims.
// Pure: no filesystem, no network.
//   Run: node scripts/run-verifies.mjs --tier pure --only agent-identity
import { harness } from "./lib/harness.mjs";
import { detectAgentIdentity, describeIdentity } from "../flux-core/agentIdentity";

const h = harness("verify-agent-identity");

h.section("Claude Code (env reaches its shells AND its MCP servers)");
const cli = detectAgentIdentity({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "c4c8", AI_AGENT: "claude-code_2-1-283_agent" });
h.eq([cli.product, cli.surface, cli.client, cli.sessionId, cli.vendor], ["Claude Code", "CLI", "claude-code", "c4c8", "anthropic"], "the CLI");
h.eq(detectAgentIdentity({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }).surface, "VS Code", "the VS Code extension");
h.eq(detectAgentIdentity({ CLAUDE_CODE_SESSION_ID: "session-only", CODEX_THREAD_ID: "outer-codex" }).sessionId, "session-only", "visible Claude session id takes precedence even without entrypoint markers");
h.eq(detectAgentIdentity({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }).surface, "desktop app", "the desktop app");
h.eq(detectAgentIdentity({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).surface, "headless", "claude -p");
h.eq(detectAgentIdentity({ CLAUDE_CODE_ENTRYPOINT: "something-new" }).surface, "something-new", "an unknown entrypoint is kept raw");
h.eq(detectAgentIdentity({ AI_AGENT: "claude-code_2-1-283_harness" }).product, "Claude Code", "AI_AGENT alone identifies Claude Code (MCP server env)");
h.eq(detectAgentIdentity({ CLAUDECODE: "1" }, { name: "claude-code" }).surface, null, "no entrypoint and no surface in clientInfo → surface unknown");

h.section("Codex (env reaches shells only; MCP servers see clientInfo)");
const cx = detectAgentIdentity({ CODEX_THREAD_ID: "t-9", CODEX_CI: "1" });
h.eq([cx.product, cx.client, cx.sessionId], ["Codex", "codex", "t-9"], "a Codex shell");
h.eq(detectAgentIdentity({}, { name: "codex-mcp-client", version: "0.157.1" }).product, "Codex", "clientInfo alone identifies Codex");
h.eq(detectAgentIdentity({}, { name: "codex_vscode" }).surface, "VS Code", "the Codex VS Code client");
h.eq(detectAgentIdentity({ FLUX_CLIENT: "codex" }, { name: "codex-mcp-client" }).client, "codex", "config env and clientInfo agree");

h.section("others and fallbacks");
h.eq(detectAgentIdentity({ GEMINI_CLI: "1" }).product, "Gemini CLI", "Gemini CLI");
h.eq(detectAgentIdentity({ AI_AGENT: "cursor@1.2" }).product, "Cursor", "the Vercel AI_AGENT convention");
h.eq(detectAgentIdentity({}, { name: "Some Host" }).client, "some-host", "an unknown MCP client gets a slugged id");
h.eq(detectAgentIdentity({ FLUX_CLIENT: "agent" }).client, "agent", "FLUX_CLIENT is the last resort");
h.eq(detectAgentIdentity({}, undefined, "mcp").client, "mcp", "…then the caller's fallback");
h.eq(describeIdentity(cli), "Claude Code · CLI", "byline half");
h.eq(describeIdentity(detectAgentIdentity({})), "unknown agent · unknown surface", "an unknown caller says so plainly");

await h.done();
