// flux-connect over a real MCP server process (plan §8.10, §8.14): connect
// returns the brief plus structuredContent whose paths exist, binds the
// project, read_pack / get_pack_image read the pack without file access, an
// external change rides the next tool result exactly once, read_delta details
// it, and a later global connect leaves the project binding alone.
//   node scripts/run-verifies.mjs --tier pure --only verify-connect-mcp
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { harness } from "./lib/harness.mjs";
import { installTestLauncher, rawMcp, scratchProject } from "./lib/mcpFixture";

const h = harness("verify-connect-mcp");
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "connect-mcp-")));
const launcher = await installTestLauncher(path.resolve(import.meta.dirname, ".."), path.join(temp, "bin"));
const root = await scratchProject(path.join(temp, "Proj"), "MCP Connect");
const env = { ...process.env, FLUX_MCP_TOOLSET: "core" };
for (const k of ["FLUX_PROJECT", "FLUX_CLIENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX", "FLUX_CONNECT_CACHE", "FLUX_CONNECT_FALLBACK"]) delete env[k];
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];

try {
  const c = await rawMcp(launcher, temp, [], env);
  clients.push(c);
  await c.initialize("claude-code");
  const names = (await c.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
  h.ok(["connect", "read_pack", "get_pack_image", "read_delta"].every((n) => names.includes(n)), "the core toolset has connect and the pack tools");

  h.section("connect");
  const r = await c.call("connect", { target: root, noRender: false });
  const brief = textOf(r);
  const sc = r.structuredContent as { packId: string; briefPath: string; bundlePath: string; images: { path: string }[]; root: string };
  h.ok(!r.isError && brief.startsWith(`# FLUX-CONNECT BRIEF · project "MCP Connect" · pack ${sc.packId}`), "connect returns the brief as text");
  h.ok(sc.root === root && fsSync.existsSync(sc.briefPath) && fsSync.existsSync(sc.bundlePath) && sc.images.every((i) => fsSync.existsSync(i.path)), "structuredContent paths exist");
  h.ok(brief.includes("You: Claude Code"), "the brief names the handshake product");
  h.eq(JSON.parse(textOf(await c.call("list_project"))).title, "MCP Connect", "connect binds the project for later tools");

  h.section("reading the pack over MCP");
  h.eq(textOf(await c.call("read_pack", { packId: sc.packId, section: "brief" })), brief, "read_pack brief");
  const f = textOf(await c.call("read_pack", { packId: sc.packId, section: "F" }));
  h.ok(f.startsWith("## §F · Log"), "read_pack one section");
  const img = await c.call("get_pack_image", { packId: sc.packId, index: 0 });
  const im = img.content.find((x: { type: string }) => x.type === "image") as { data: string; mimeType: string } | undefined;
  h.ok(!!im && im.mimeType === "image/png" && Buffer.from(im.data, "base64").subarray(1, 4).toString() === "PNG", "get_pack_image returns image content");
  h.ok((await c.call("read_pack", { packId: "zzzzzzzzzz" })).isError, "an unknown pack is refused");

  h.section("staying current");
  h.ok(!textOf(await c.call("list_project")).includes("↻"), "no notice while nothing changed");
  await c.call("write_log", { text: "My own entry", title: "Own", agent: "Test model" });
  h.ok(!textOf(await c.call("list_project")).includes("↻"), "the session's own write is not reported back");
  await fs.appendFile(path.join(root, "Context", "RULES.md"), "- A rule the user added.\n");
  const noticed = textOf(await c.call("list_project"));
  h.ok(/↻ Since you last looked \([^)]*\): Rules edited — details: read_delta$/m.test(noticed), "an external change rides the next tool result");
  h.ok(!textOf(await c.call("list_documents")).includes("↻"), "…exactly once");
  const d = textOf(await c.call("read_delta"));
  h.ok(d.includes("### Rules edited") && d.includes("+ - A rule the user added.") && !d.includes("Own"), "read_delta details the external change only");
  const viaMeta = await c.call("flux_verb", { verb: "list_project" });
  h.ok(!viaMeta.isError && !textOf(viaMeta).includes("↻"), "flux_verb results follow the same rule");

  h.section("global keeps the binding");
  const g = await c.call("connect", { target: "global", noRender: true });
  h.ok(textOf(g).includes("✓ flux-connected · global · pack") && textOf(g).includes("MCP Connect"), "global connect lists the known project");
  h.eq(JSON.parse(textOf(await c.call("list_project"))).title, "MCP Connect", "the project binding survives a global connect");
} finally {
  for (const c of clients) await c.close();
  await fs.rm(temp, { recursive: true, force: true });
}
await h.done();
