// Machine project history: shared CJS API, isolated machine state, real IO.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";
import { TestProcessScope } from "./lib/testProcess.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const require = createRequire(import.meta.url);
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const h = harness("verify-projects-registry"), scope = new TestProcessScope();
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flux-project-history-")));
const env = isolatedEnv(path.join(scratch, "machine"));
Object.assign(process.env, env);
// Import after the scratch HOME/XDG assignments, just like a standalone CLI.
const registry = await import("../electron/projectsRegistry.cjs");
const { userDataDir } = require("../electron/fluxPaths.cjs");
const file = path.join(userDataDir(), "projects.json");
const disk = async () => JSON.parse(await fs.readFile(file, "utf8"));
const root = async (name: string) => {
  const dir = path.join(scratch, name); await fs.mkdir(dir, { recursive: true }); return fs.realpath(dir);
};
const originalOpen = fs.open, originalRename = fs.rename, originalStat = fs.stat;

try {
  h.eq(await registry.listKnownProjects(), [], "missing registry is an empty history");
  h.ok(file.startsWith(scratch + path.sep) && !file.includes("FluxConfig"), "registry uses isolated machine userData");
  const a = await root("project A"), b = await root("project B");
  await registry.recordProjectOpened(path.join(a, "."), "First title");
  const opened = (await registry.listKnownProjects())[0];
  h.eq(opened.root, a, "record canonicalizes the root");
  h.ok(!!opened.lastOpened && !opened.lastConnected, "open stamps only lastOpened");
  await registry.recordProjectConnected(a, "Updated title");
  const connected = (await registry.listKnownProjects())[0];
  h.eq(connected.lastOpened, opened.lastOpened, "connect preserves the open timestamp");
  h.ok(!!connected.lastConnected, "connect stamps lastConnected");
  h.eq(connected.title, "Updated title", "repeat record updates the title without duplication");
  await registry.recordProjectOpened(a, "");
  h.eq((await registry.listKnownProjects())[0].lastConnected, connected.lastConnected, "open preserves the connection timestamp");
  h.eq((await disk()).projects.length, 1, "repeat records deduplicate");
  h.eq((await disk()).v, 1, "disk schema is version 1");
  await registry.recordProjectConnected(b, "Second");
  h.eq((await registry.listKnownProjects()).map(p => p.root), [b, a], "most recent project is first");
  await assert.rejects(registry.recordProjectOpened("", "bad"));
  await assert.rejects(registry.recordProjectOpened(path.join(scratch, "absent"), "bad"));
  await assert.rejects(registry.recordProjectOpened(file, "bad"));
  h.eq((await disk()).projects.length, 2, "invalid, absent and non-directory roots never enter history");

  h.section("lazy pruning and corrupt-file tolerance");
  await fs.rm(b, { recursive: true });
  h.eq((await disk()).projects.length, 2, "missing root remains until a read");
  h.eq((await registry.listKnownProjects()).map(p => p.root), [a], "read prunes a missing root");
  h.eq((await disk()).projects.length, 1, "prune is persisted");
  fs.stat = (async (target: string, ...args: any[]) => {
    if (target === a) throw Object.assign(new Error("temporary permission failure"), { code: "EACCES" });
    return (originalStat as any)(target, ...args);
  }) as typeof fs.stat;
  try { await assert.rejects(registry.listKnownProjects(), /permission failure/); }
  finally { fs.stat = originalStat; }
  h.eq((await disk()).projects.length, 1, "permission failure never prunes a project");
  for (const corrupt of ["{broken", "null", '{"v":1,"projects":null}', '{"v":0,"projects":[]}']) {
    await fs.writeFile(file, corrupt);
    h.eq(await registry.listKnownProjects(), [], `tolerates invalid history: ${corrupt}`);
  }
  await fs.writeFile(file, "{broken");
  await registry.recordProjectConnected(a, "Recovered");
  h.eq((await disk()).projects[0].title, "Recovered", "record repairs corrupt history");
  await fs.writeFile(file, JSON.stringify({ v: 1, projects: [null, {}, { root: "relative", title: "bad" },
    { root: a, title: "Valid", lastOpened: "not a timestamp" }, { root: a, title: "Duplicate" }] }));
  h.eq(await registry.listKnownProjects(), [{ root: a, title: "Valid" }], "malformed entries/timestamps and duplicate roots are ignored");

  h.section("cap and both recency fields");
  await fs.rm(file);
  const roots: string[] = [];
  for (let i = 0; i < 105; i++) {
    roots.push(await root(`cap-${i}`));
    await (i % 2 ? registry.recordProjectConnected : registry.recordProjectOpened)(roots[i], `Project ${i}`);
  }
  const capped = await registry.listKnownProjects();
  h.eq(capped.length, 100, "record/list cap history at 100");
  h.eq(capped.map(p => p.root), roots.slice(5).reverse(), "cap retains the 100 newest opens/connections in order");
  h.eq((await disk()).projects.length, 100, "cap applies to saved bytes");
  await registry.recordProjectOpened(roots[5], "Reopened");
  h.eq((await registry.listKnownProjects())[0].root, roots[5], "reopening an older entry promotes it");
  await registry.recordProjectConnected(roots[6], "Reconnected");
  h.eq((await registry.listKnownProjects())[0].root, roots[6], "reconnecting an older entry promotes it");

  h.section("atomic publication and failure cleanup");
  const before = await fs.readFile(file, "utf8");
  let synced = false, directorySynced = false, intercepted = false;
  fs.open = (async (target: string, ...args: any[]) => {
    const handle = await (originalOpen as any)(target, ...args);
    if (String(target).startsWith(file + ".tmp-") || target === path.dirname(file)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); if (target === path.dirname(file)) directorySynced = true; else synced = true; };
    }
    return handle;
  }) as typeof fs.open;
  fs.rename = (async (from: string, to: string) => {
    if (to === file) {
      intercepted = true;
      h.eq(await fs.readFile(file, "utf8"), before, "readers see exact old bytes until publication");
      h.ok(synced, "temporary file is synced before rename");
      h.eq(JSON.parse(await fs.readFile(from, "utf8")).projects[0].title, "Atomic", "temporary file holds complete next registry");
    }
    return originalRename(from, to);
  }) as typeof fs.rename;
  try { await registry.recordProjectOpened(a, "Atomic"); }
  finally { fs.open = originalOpen; fs.rename = originalRename; }
  h.ok(intercepted, "writer actually publishes by rename");
  h.ok(process.platform === "win32" || directorySynced, "publication syncs the directory where supported");
  const committed = await fs.readFile(file, "utf8");
  for (const stage of ["sync", "rename"]) {
    fs.open = (async (target: string, ...args: any[]) => {
      const handle = await (originalOpen as any)(target, ...args);
      if (stage === "sync" && String(target).startsWith(file + ".tmp-")) handle.sync = async () => { throw new Error("injected sync failure"); };
      return handle;
    }) as typeof fs.open;
    fs.rename = (async (from: string, to: string) => {
      if (stage === "rename" && to === file) throw new Error("injected rename failure");
      return originalRename(from, to);
    }) as typeof fs.rename;
    try { await assert.rejects(registry.recordProjectConnected(a, "Lost"), /injected/); }
    finally { fs.open = originalOpen; fs.rename = originalRename; }
    h.eq(await fs.readFile(file, "utf8"), committed, `${stage} failure preserves prior bytes`);
    h.ok(!(await fs.readdir(path.dirname(file))).some(f => f.startsWith("projects.json.tmp-")), `${stage} failure cleans temporary files`);
  }

  h.section("concurrent app and CLI writers");
  await fs.rm(file);
  await Promise.all([registry.recordProjectOpened(a, "Parallel"), registry.recordProjectConnected(a, "Parallel")]);
  const both = (await registry.listKnownProjects())[0];
  h.ok(!!both.lastOpened && !!both.lastConnected, "same-process concurrent calls preserve both stamps");
  const worker = path.join(scratch, "writer.cjs");
  await fs.writeFile(worker, `const registry = require(${JSON.stringify(require.resolve("../electron/projectsRegistry.cjs"))});
process.stdin.resume(); process.stdin.on('end', () => process.exit(1));
process.stdin.once('data', async () => {
  try { for (const root of process.argv.slice(3)) await registry[process.argv[2]](root, 'Concurrent'); process.exit(0); }
  catch (e) { console.error(e); process.exit(1); }
}); console.log('ready');\n`);
  const workers = ["recordProjectOpened", "recordProjectConnected"].map(method => scope.spawn(worker, [method, ...roots.slice(0, 12)], { nodeArgs: [], env, readyLine: "ready", deadlineMs: 30000 }));
  await Promise.all(workers.map(w => w.ready));
  for (const w of workers) w.child.stdin.write("go\n");
  for (const w of workers) h.eq((await scope.waitExit(w)).code, 0, `concurrent process completes: ${w.stderr}`);
  const shared = await registry.listKnownProjects();
  h.eq(shared.length, 13, "cross-process updates never drop another project's entry");
  h.ok(shared.every(p => p.lastOpened && p.lastConnected), "cross-process updates to the same roots preserve both stamps");
} catch (error) { h.fail(String(error)); }
finally {
  fs.open = originalOpen; fs.rename = originalRename; fs.stat = originalStat;
  await scope.dispose();
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.rm(env.TMPDIR!, { recursive: true, force: true });
}
await h.done();
