// Exercise the real stdio MCP writer with scratch HOME/project state.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { harness } from "./lib/harness.mjs";
import { scratchProject } from "./lib/mcpFixture";
import { repo, rawMcp, installTestLauncher, cleanEnv, until, textOf } from "./lib/inboxFixture";
import { readPresence, readAnnotationState, appendAnnotationEvent } from "../flux-core/annotations";
import { presenceWord, presenceFileRel, isPresenceStale } from "../src/lib/project/presence";
import { makeReleaseSession } from "../src/lib/project/annotations";
const h = harness("verify-presence"), temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "inbox-presence-")));
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];
try {
  const root = await scratchProject(path.join(temp, "A"), "Presence A"), other = await scratchProject(path.join(temp, "B"), "Presence B");
  const launcher = await installTestLauncher(repo, path.join(temp, "bin"));
  const id = "presence-gate", name = presenceWord(id);
  const env = cleanEnv({ CODEX_THREAD_ID: id });
  const a = await rawMcp(launcher, root, [], env); clients.push(a); await a.initialize("codex", "9.1");
  await a.call("list_project");
  h.eq(await readPresence(root), [], "cwd auto-bind never writes presence");
  const receipt = await a.call("connect", { live: true });
  const first = (await readPresence(root))[0];
  h.ok(first && first.name === name, "explicit connect creates the named session atomically");
  h.ok(textOf(receipt).includes(`You are ${name}`), "connect receipt carries the session name");
  h.eq([first.id, first.product, first.clientVersion, first.live, first.watching], [id, "Codex", "9.1", true, false], "presence contains identity, live flag and passive watch state");
  h.ok(!("cwd" in first), "MCP presence never mistakes server cwd for caller cwd");
  const beat = await until(async () => { const s = (await readPresence(root))[0]; return s?.heartbeatAt !== first.heartbeatAt ? s : null; }, "15 s heartbeat", 20000);
  h.ok(Date.parse(beat.heartbeatAt) - Date.parse(first.heartbeatAt) >= 14000, "writer heartbeats at the 15 s interval");
  const wait = a.call("wait_for_inbox", { timeoutMs: 2500 });
  await until(async () => (await readPresence(root))[0]?.watching, "pending wait marks watching");
  h.ok((await readPresence(root))[0].watching, "pending wait sets watching");
  await wait;
  h.ok((await readPresence(root))[0].watching, "watching survives return for the two-minute grace period");
  const stoppedWait = a.call("wait_for_inbox", { timeoutMs: 5000 });
  await appendAnnotationEvent(root, makeReleaseSession({ id, name }, "human"));
  const stopped = JSON.parse(textOf(await stoppedWait));
  h.eq(stopped.stopped, true, "release-session stops a real MCP pending wait");
  let collision = "";
  for (let n = 0; ; n++) if (presenceWord(`collision-${n}`) === name) { collision = `collision-${n}`; break; }
  const b = await rawMcp(launcher, temp, [], cleanEnv({ CODEX_THREAD_ID: collision })); clients.push(b); await b.initialize("codex");
  await b.call("connect", { target: root });
  h.eq((await readPresence(root)).find(s => s.id === collision)?.name, `${name}-2`, "a live name collision receives -2");
  await b.call("connect", { target: other });
  h.ok(!(await readPresence(root)).some(s => s.id === collision) && (await readPresence(other)).some(s => s.id === collision), "rebind removes old presence and publishes the new file");
  await Promise.all([b.call("connect", { target: root }), b.call("connect", { target: other })]);
  h.eq([...(await readPresence(root)), ...(await readPresence(other))].filter(s => s.id === collision).length, 1, "overlapping connects retain exactly one owned presence writer");
  await b.call("connect", { target: other });
  await b.call("connect", { target: "global" });
  h.ok((await readPresence(other)).some(s => s.id === collision), "global connect preserves existing binding and presence");
  b.entry.child.stdin.end(); await b.entry.closed;
  h.eq(await readPresence(other), [], "stdin close removes the owned presence file");
  const c = await rawMcp(launcher, temp, [], cleanEnv({ CODEX_THREAD_ID: "graceful" })); clients.push(c); await c.initialize("codex"); await c.call("connect", { target: other });
  c.entry.child.kill("SIGTERM"); await c.entry.closed;
  if (process.platform !== "win32") h.eq(await readPresence(other), [], "SIGTERM removes presence before exit");
  else h.ok((await readAnnotationState(other)).presence.size === 0, "Windows termination leaves no live presence");
  // Kill the server itself: run from source, the launcher's child is tsx, which runs the
  // server as ITS child — killing tsx orphans a server that then exits cleanly.
  process.kill(first.pid, "SIGKILL"); await a.entry.closed;
  const abandoned = (await readPresence(root)).find(s => s.id === id)!;
  h.ok(!!abandoned, "abrupt kill leaves the last atomic heartbeat readable");
  h.ok(!(await readAnnotationState(root)).presence.has(id), "same-host reader marks the killed pid stale immediately");
  h.ok(isPresenceStale(abandoned, Date.parse(abandoned.heartbeatAt) + 61000), "remote reader expires that heartbeat after 60 s");
  h.eq((await fs.readdir(path.join(root, ".meta/live/sessions"))).filter(n => n.startsWith(".")), [], "presence leaves no partial temporary file");
} finally { for (const c of clients) await c.close(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
