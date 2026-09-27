// D3: the Reader's public CLI/MCP vocabulary is Highlights; storage stays compatible.
// Run through scripts/run-verifies.mjs --tier pure --only reader-highlights.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readerContextPath } from "../src/lib/references/items";
import { harness } from "./lib/harness.mjs";
import { TestProcessScope } from "./lib/testProcess.mjs";
import { isolatedEnv, discardTemporaryRoot } from "./lib/verifyRuntime.mjs";
import { tsxCli } from "./lib/tsxRun.mjs";

const h = harness("verify-reader-highlights");
const repo = path.resolve(import.meta.dirname, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-highlights-"));
const env = isolatedEnv(path.join(temp, "runtime"));
const scope = new TestProcessScope();
const clients: Client[] = [];
const textOf = (r: any): string => r.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
async function mcp(toolset: "core" | "full") {
  const client = new Client({ name: "verify-highlights", version: "1" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [tsxCli(), path.join(repo, "flux-mcp.ts")],
    cwd: temp, env: { ...env, FLUX_MCP_TOOLSET: toolset }, stderr: "pipe",
  }));
  return client;
}
async function cli(...args: string[]) {
  const child = scope.spawn(path.join(repo, "flux-cli.ts"), args, { cwd: temp, env, nodeArgs: [tsxCli()] });
  await child.closed;
  return child;
}

try {
  const full = await mcp("full"), core = await mcp("core");
  const call = (name: string, args: Record<string, unknown> = {}) => full.callTool({ name, arguments: args });
  const meta = (verb: string, args: Record<string, unknown> = {}) => core.callTool({ name: "flux_verb", arguments: { verb, args } });
  const fullTools = (await full.listTools()).tools, coreTools = (await core.listTools()).tools;
  for (const name of ["add_highlight", "list_highlights", "search_highlights", "get_reading_context"]) {
    const tool = fullTools.find(t => t.name === name);
    h.ok(!!tool && !tool.inputSchema.properties?.project, `${name}: full tool keeps machine scope`);
    h.ok(!coreTools.some(t => t.name === name), `${name}: remains outside the compact core tool list`);
    const discovered = JSON.parse(textOf(await core.callTool({ name: "flux_verbs", arguments: { query: name } })));
    h.eq(discovered[0]?.name, name, `${name}: discoverable through flux_verbs`);
  }
  for (const name of ["add_annotation", "list_annotations", "search_annotations"]) {
    h.ok(!fullTools.some(t => t.name === name), `${name}: retired from tools/list`);
    h.ok((await call(name)).isError && (await meta(name)).isError, `${name}: rejected by direct and meta dispatch`);
  }
  h.eq(textOf(await call("list_highlights", { key: "empty" })), "No highlights on empty.", "list empty state uses highlights");
  h.eq(textOf(await call("search_highlights", { query: "absent" })), 'No highlights match "absent".', "search empty state uses highlights");
  h.eq(textOf(await call("get_reading_context")), "No paper is open in FluxReader right now.", "missing reading context stays a clean empty state");

  const lib = JSON.parse(textOf(await call("config_paths"))).fluxLibPath as string;
  const key = "highlightFixture";
  const item = path.join(lib, "items", key), file = path.join(item, "annotations.json");
  await fs.mkdir(item, { recursive: true });
  const stored = { version: 1, annotations: [{ id: "existing", createdAt: "2026-01-01T00:00:00Z", page: 1, color: "yellow",
    anchor: { quote: "Existing passage", prefix: "before ", suffix: " after" }, note: "Preserve this note", tags: ["saved"] }], future: "preserve" };
  await fs.writeFile(file, JSON.stringify(stored));
  const added = await cli("add-highlight", "--key", key, "--quote", "CLI passage", "--page", "2", "--color", "blue", "--note", "CLI note");
  h.ok(added.code === 0 && /highlighted/.test(added.stderr), `CLI add-highlight works without a project: ${added.stderr.trim()}`);
  const fromMcp = await meta("add_highlight", { key, quote: "MCP passage", page: 3, color: "pink", note: "MCP note", tags: ["agent"] });
  h.ok(!fromMcp.isError && /added highlight/.test(textOf(fromMcp)), "core meta dispatch adds a highlight without a project");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  h.eq(saved.annotations[0], stored.annotations[0], "existing highlight identity, anchor and note survive both writes");
  h.ok(saved.version === 1 && saved.future === "preserve" && saved.annotations.length === 3 && !Object.hasOwn(saved, "highlights"), "annotations.json keeps its schema and unknown fields");
  h.ok(!await fs.stat(path.join(item, "highlights.json")).catch(() => null), "no renamed storage file is created");

  const listed = await cli("highlights", "--key", key);
  h.ok(listed.code === 0 && /3 highlight\(s\)/.test(listed.stderr), "CLI list reports highlight count");
  h.eq(JSON.parse(listed.stdout), saved.annotations, "CLI list reads the unchanged storage records");
  const all = await cli("highlights");
  h.eq(JSON.parse(all.stdout).map((a: any) => a.key), [key, key, key], "CLI library-wide list includes all saved highlights");
  const searched = await cli("highlights", "search", "MCP note", "--key", key);
  h.eq(JSON.parse(searched.stdout).map((a: any) => a.note), ["MCP note"], "CLI search matches the saved note");
  for (const [name, args] of [["list_highlights", { key }], ["search_highlights", { query: "MCP note", key }]] as const) {
    const direct = await call(name, args);
    h.ok(!direct.isError && textOf(direct).includes("MCP passage"), `${name}: reads the saved highlight`);
    h.eq(await meta(name, args), direct, `${name}: core meta dispatch equals the full tool`);
  }
  const markdown = await cli("highlights", "--key", key, "--md");
  h.ok(markdown.code === 0 && markdown.stdout.includes("3 highlights across 3 pages"), "CLI Markdown digest keeps its contents");
  h.eq(textOf(await call("list_highlights", { key, markdown: true })), markdown.stdout, "MCP Markdown digest equals CLI output");
  const help = await cli("help");
  h.ok(/highlights \[search/.test(help.stdout) && /add-highlight/.test(help.stdout) && !/^\s+(?:annotations|add-annotation)\b/m.test(help.stdout), "CLI help advertises only the new Reader names");
  for (const name of ["annotations", "add-annotation"]) h.ok((await cli(name, "--key", key)).code !== 0, `${name}: retired CLI verb fails`);

  const contextFile = readerContextPath(lib);
  const reading = { citekey: key, title: "Reader fixture", page: 2, selection: "Selected passage", updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), annotations: [{ page: 2, color: "blue", quote: "CLI passage", note: "CLI note" }] };
  const contextBytes = JSON.stringify(reading);
  await fs.writeFile(contextFile, contextBytes);
  const contextResult = await call("get_reading_context"), context = JSON.parse(textOf(contextResult));
  h.eq(context.highlights, reading.annotations, "reading context maps the stored annotations to highlights");
  h.ok(!Object.hasOwn(context, "annotations") && context.citekey === key && context.page === 2 && context.selection === reading.selection, "reading context drops only the old output field");
  h.eq(await meta("get_reading_context"), contextResult, "core meta dispatch returns the same reading context");
  h.eq(await fs.readFile(contextFile, "utf8"), contextBytes, "reading context mapping leaves saved bytes unchanged");
  const { annotations: _annotations, ...withoutHighlights } = reading;
  await fs.writeFile(contextFile, JSON.stringify(withoutHighlights));
  h.eq(JSON.parse(textOf(await call("get_reading_context"))).highlights, [], "older context without highlights returns an empty list");
} finally {
  for (const client of clients) await client.close();
  await scope.dispose();
  discardTemporaryRoot(env.TMPDIR);
  await fs.rm(temp, { recursive: true, force: true });
}
await h.done();
