#!/usr/bin/env -S npx tsx
// WS6 — provenance journal + advisory locks. flux-core writes append journal
// lines (ts + client + action); an agent/CLI file-write DEFERS (throws) while a
// human holds the project lock instead of clobbering it; stale locks auto-expire;
// withLock releases. Run: npx tsx scripts/verify-an-journal-locks.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as locks from "../flux-core/locks";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const REPO = path.resolve(import.meta.dirname, "..");
const fixture = path.join(REPO, "fixtures", "plots", "growth.svg");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-journal-"));
const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);
const readJournal = async () => {
  const txt = await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8").catch(() => "");
  return txt.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

try {
  core.setClient("cli");
  await core.scaffold(root, { title: "Journal & Locks" });

  // 1. flux-core writes append journal lines carrying client + a precise action.
  await core.createFigure(root, { id: "f1", name: "One" });
  await core.composeFigure(root, [fixture], { id: "growth", name: "Growth", rows: 1 });
  await core.setManuscript(root, "# Title\n\nBody.\n");
  let log = await readJournal();
  assert(log.some((e) => e.action === "create_figure" && e.client === "cli"), "createFigure journaled (client=cli)");
  assert(log.some((e) => e.action === "compose_figure"), "composeFigure journaled");
  assert(log.some((e) => e.action === "set_manuscript"), "setManuscript journaled");
  assert(log.every((e) => e.ts && e.client), "every journal line carries ts + client");

  // 2. an agent/CLI write DEFERS while a human holds the project lock (no clobber).
  await locks.acquireLock(root, "project", "human");
  let deferred = false;
  try {
    await core.createFigure(root, { id: "f2", name: "Two" });
  } catch (e) {
    deferred = /deferred/i.test(String((e as Error).message));
  }
  assert(deferred, "flux-core write deferred while human holds the project lock");
  const beforeRelease = (await readJournal()).filter((e) => e.action === "create_figure").length;
  assert(beforeRelease === 1, "the deferred write did NOT clobber (still one create_figure)");

  // …and proceeds once the human releases.
  await locks.releaseLock(root, "project", "human");
  await core.createFigure(root, { id: "f2", name: "Two" });
  log = await readJournal();
  assert(log.filter((e) => e.action === "create_figure").length === 2, "write succeeds after lock release");

  // 3. lock semantics: fresh-by-other detected, same-client allowed, stale ignored.
  await locks.acquireLock(root, "p2", "human");
  assert((await locks.heldByOther(root, "p2", "cli")) !== null, "fresh lock by another client is detected");
  assert((await locks.heldByOther(root, "p2", "human")) === null, "the lock's own client is not blocked");

  const stale = path.join(root, ".meta", "locks", "stale.json");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, JSON.stringify({ client: "human", pid: 1, ts: "2000-01-01T00:00:00.000Z" }));
  assert((await locks.heldByOther(root, "stale", "cli")) === null, "a stale lock is ignored (TTL expiry)");

  // 4. withLock runs the body and always releases.
  let ran = false;
  await locks.withLock(root, "wl", "cli", async () => {
    ran = true;
    assert(await exists(path.join(root, ".meta", "locks", "wl.json")), "lock is held inside withLock");
  });
  assert(ran, "withLock ran the body");
  assert(!(await exists(path.join(root, ".meta", "locks", "wl.json"))), "withLock released the lock afterward");

  console.log("\nALL JOURNAL+LOCKS (WS6) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
