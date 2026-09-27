// Staying current (plan §8.8): the stat-only no-change check within budget,
// every change kind summarised, cursor semantics (an agent's own writes are
// never reported back to it; each external change is reported once; read_delta
// details and advances), the notice only for connected sessions, and the CLI
// session path the Claude Code prompt hook uses. Hermetic scratch machine.
//   node scripts/run-verifies.mjs --tier pure --only verify-connect-delta
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";
import { tsxCli } from "./lib/tsxRun.mjs";

const h = harness("verify-connect-delta");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "verify-connect-delta-")));
const env = isolatedEnv(path.join(scratch, "machine"));
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX", "FLUX_PROJECT", "FLUX_CLIENT", "FLUX_CONNECT_CACHE", "FLUX_CONNECT_FALLBACK", "FLUX_HOOK_SESSION"]) delete env[k];
for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
Object.assign(process.env, env);

const core = await import("../flux-core/index");
const conn = await import("../flux-core/connect/index");
const refresh = await import("../flux-core/connect/refresh");
const { createConnectSession } = await import("../flux-core/connect/mcp");
const { hookFastPath } = await import("../flux-core/connect/hookFast");
const { hookDelta } = await import("../flux-core/connect/cli");
const { readCursor } = await import("../flux-core/connect/cache");
const { detectAgentIdentity } = await import("../flux-core/agentIdentity");
const { makeNote, serializeEvent } = await import("../src/lib/project/annotations");

const identity = detectAgentIdentity({});
const root = path.join(scratch, "proj");
await core.scaffold(root, { title: "Delta" });
await fs.writeFile(path.join(root, "paper", "draft.qmd"), "---\ntitle: Draft\n---\n\n# Draft\n\nLine one.\nLine two.\n");
await fs.mkdir(path.join(root, "plots"), { recursive: true });
await fs.writeFile(path.join(root, "plots", "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect width="100" height="80" fill="#205ea6"/></svg>');
const fig = (await core.composeFigure(root, [path.join(root, "plots", "a.svg")], { id: "fa" })).figureId;
const ledger = path.join(root, ".meta", "feedback.ndjson");
const text = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const tool = (label: string) => async () => ({ content: [{ type: "text" as const, text: label }] });

try {
  h.section("the no-change check is stat-only and fast");
  {
    const big = path.join(scratch, "big");
    await core.scaffold(big, { title: "Big" });
    for (let i = 0; i < 480; i++) await fs.writeFile(path.join(big, "paper", `doc-${String(i).padStart(3, "0")}.qmd`), `# Doc ${i}\n\nText.\n`);
    const r = await conn.connect({ target: big, identity, noRender: true });
    const paths = r.cursor!.snapshot.paths;
    h.ok(paths.length >= 480, `the watch list covers every document (${paths.length} paths)`);
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      const s = await refresh.takeSnapshot(paths);
      refresh.sameSnapshot(s, r.cursor!.snapshot);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    h.ok(median <= 30, `no-change check median ${median.toFixed(1)} ms ≤ 30 ms on a 500-file project`);
    h.ok(refresh.sameSnapshot(await refresh.takeSnapshot(paths), r.cursor!.snapshot), "an untouched project reads as unchanged");
  }

  h.section("each change kind is summarised");
  {
    const r = await conn.connect({ target: root, identity, noRender: true });
    const cursor = r.cursor!;
    await fs.appendFile(path.join(root, "Context", "ProjectContext.qmd"), "\nWe study synapses.\n");
    await fs.appendFile(path.join(root, "Context", "RULES.md"), "- Use SI units.\n");
    await core.writeLog(root, { text: "Result one", title: "First result", identity });
    await fs.writeFile(path.join(root, "paper", "draft.qmd"), "---\ntitle: Draft\n---\n\n# Draft\n\nLine one, edited.\nLine two.\nLine three.\n");
    await fs.writeFile(path.join(root, "paper", "new.qmd"), "# New\n");
    await core.setCaption(root, fig, "A new caption.");
    await fs.appendFile(ledger, serializeEvent(makeNote("Please fix the axis", { surface: "figure" }, "app", { session: { id: "s-me", name: "heron" } })));
    await core.createDeck(root, { id: "deck1", title: "Deck" });
    const now = await refresh.takeSnapshot([...new Set([...cursor.snapshot.paths, path.join(root, "slides", "deck1", "deck.json")])]);
    const delta = await refresh.computeDelta(conn.deltaInputs(root, cursor, refresh.changedPaths(cursor.snapshot, now), "s-me"));
    const kinds = delta.changes.map((c) => c.kind).sort();
    const summary = refresh.renderDeltaLine(delta, cursor.since);
    h.ok(summary.startsWith("↻ Since you last looked (") && summary.endsWith("— details: read_delta"), "the notice line has its shape");
    const all = delta.changes.map((c) => c.summary).join(" · ");
    h.ok(all.includes("ProjectContext edited") && all.includes("Rules edited"), "ProjectContext and Rules edits");
    h.ok(all.includes("1 new Log entry"), "a new Log entry");
    h.ok(/paper\/draft\.qmd \+2\/−1/.test(all) && all.includes("new document paper/new.qmd"), "an edited document with line counts (+2/−1), and a new one");
    h.ok(all.includes("1 figure changed"), "a figure change");
    h.ok(summary.startsWith(`↻ Since you last looked (${refresh.ageOf(cursor.since)}): 1 new annotation — 1 for you (`), "a new annotation routed to this session leads the line");
    h.ok(/\+\d more — details/.test(summary) && delta.changes.length > 6, "a long list is capped with a count");
    h.ok(kinds.includes("deck"), "a deck change");
    const details = refresh.renderDeltaDetails(delta, "Delta", cursor.since);
    h.ok(details.includes("+ We study synapses.") && details.includes("Result one") && details.includes("+ Line three.") && details.includes("**routed to you**"), "details carry the changed lines, the entry in full and the routing");
  }

  h.section("MCP session: cursor semantics");
  {
    const s = createConnectSession({ identity: () => ({ ...identity, sessionId: "s-me" }) });
    h.eq(text(await s.wrap("list_project", tool("before"))), "before", "not connected: no notice");
    const r = await conn.connect({ target: root, identity, noRender: true });
    s.hooks.connected({ root: r.root, title: r.title, packId: r.packId, cursor: r.cursor, live: false });
    h.eq(text(await s.wrap("list_project", tool("quiet"))), "quiet", "connected, nothing changed: no notice");
    // The agent's own write, made inside a tool call, is absorbed.
    const own = await s.wrap("write_log", async () => {
      await core.writeLog(root, { text: "Mine", title: "My own entry", identity });
      return { content: [{ type: "text", text: "logged" }] };
    });
    h.eq(text(own), "logged", "the call that wrote carries no notice about itself");
    h.eq(text(await s.wrap("list_project", tool("next"))), "next", "the agent's own write is never reported back to it");
    // Someone else edits between calls.
    await fs.appendFile(path.join(root, "paper", "draft.qmd"), "Someone else's line.\n");
    const withNotice = text(await s.wrap("list_project", tool("after")));
    h.ok(withNotice.startsWith("after\n↻ Since you last looked") && withNotice.includes("paper/draft.qmd +1/−0") && !withNotice.includes("My own entry") && !withNotice.includes("Log"), "an external edit is reported on the next tool result, without the agent's own entry");
    h.eq(text(await s.wrap("list_project", tool("again"))), "again", "each external change is reported once");
    h.eq(text(await s.wrap("read_pack", tool("quiet tool"))), "quiet tool", "the reading tools never carry the notice");
    const rd = s.tools().find((t) => t.name === "read_delta")!;
    const det = text(await rd.fn({}));
    h.ok(det.includes('# Changes in "Delta" since you last looked') && det.includes("+ Someone else's line."), "read_delta returns the details");
    h.ok(text(await rd.fn({})).includes("Nothing changed since you last looked."), "read_delta advances the cursor");
    await core.setCaption(root, fig, "Another caption.");
    const figDelta = await rd.fn({});
    h.ok(text(figDelta).includes("### Figures") && figDelta.content.some((c) => c.type === "image"), "read_delta re-renders the canvas of a changed figure");
  }

  h.section("CLI session: the prompt hook");
  {
    const key = "0f1e2d3c-4b5a-6978-8a9b-cadbecfd0e1f";
    const stdin = JSON.stringify({ session_id: key, cwd: root, hook_event_name: "UserPromptSubmit" });
    h.eq(await hookFastPath(JSON.stringify({ session_id: "not-connected-session-id" })), "quiet", "a session that never connected: quiet");
    h.eq(await hookFastPath("not json"), "quiet", "garbage on stdin: quiet");
    const r = await conn.connect({ target: root, identity: { ...identity, sessionId: key }, sessionKey: key, noRender: true });
    h.ok(!!(await readCursor(key)) && (await readCursor(key))!.packId === r.packId, "a CLI connect with a vendor session id writes the session cursor");
    h.eq(await hookFastPath(stdin), "quiet", "connected, nothing changed: quiet");
    // The agent's own CLI write (same vendor session id) is absorbed by the CLI itself.
    const cli = spawnSync(process.execPath, [tsxCli(), path.join(repo, "flux-cli.ts"), "log", "Own CLI entry", "--title", "CLI own", "--root", root], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: key } });
    h.eq(cli.status, 0, "the agent's own `flux log` succeeds");
    h.eq(await hookFastPath(stdin), "quiet", "…and is folded into its cursor: the hook stays quiet");
    await fs.appendFile(path.join(root, "Context", "RULES.md"), "- Another rule.\n");
    const fast = await hookFastPath(stdin);
    h.ok(fast !== "quiet" && fast.key === key, "an external change: the fast path hands over");
    process.env.FLUX_HOOK_SESSION = key;
    try {
      const line = await hookDelta();
      h.ok(line.startsWith("↻ Flux (Delta) · Since you last looked (") && line.includes("Rules edited") && !line.includes("CLI own") && line.endsWith("`flux connect --refresh`"), `the hook prints one line about the change: ${line}`);
      h.eq(await hookDelta(), "", "…once");
    } finally {
      delete process.env.FLUX_HOOK_SESSION;
    }
    h.eq(await hookFastPath(stdin), "quiet", "the reported change no longer triggers the hook");
    const rf = await conn.connect({ target: root, identity: { ...identity, sessionId: key }, sessionKey: key, refresh: true, noRender: true });
    h.ok(rf.refresh && rf.refresh.details.includes("Rules edited") && !rf.refresh.details.includes("CLI own"), "--refresh details start from the session's cursor");
  }
} finally {
  await h.done(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
}
