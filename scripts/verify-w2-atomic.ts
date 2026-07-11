// W2 (V1 review): atomic writes + journal append — crash-safety verification.
// Run: npx tsx scripts/verify-w2-atomic.ts
//
// 1. Kill-mid-write: a child process atomicWrites a ~1.5MB JSON in a tight loop;
//    the parent SIGKILLs it at random offsets N times. The target must parse as
//    valid JSON after every kill (old or new content — never truncated).
// 2. Journal concurrency: two processes append 150 entries each to the same
//    .meta/journal.ndjson → exactly 300 well-formed lines (read-rewrite lost these).
// 3. Journal rotation: >5MB journal rotates to journal-<ts>.ndjson on next append.
// 4. Corrupt-cache quarantine: an unparseable enrich.json is quarantined as
//    .corrupt-<ts> and loadEnrich returns {} instead of wiping it on next write.
// 5. Dir-fsync presence (WS-5.3): atomicWrite fsyncs the FILE, but rename
//    durability needs the DIRECTORY entry synced too — fsyncDir must exist,
//    behave (real dir ok, missing dir best-effort silent), and be WIRED into
//    both save paths (flux-core saveFigModel + renderer figbridge/electron).
//
// Process containment (WS-0a): every child is owned by a TestProcessScope —
// fixture .mjs children launched directly via process.execPath (no npx wrapper),
// group-killed, awaited to `close`, ready-protocol instead of boot sleeps, and
// the temp dir is removed only after a post-teardown quiescence check. A parent
// assertion failure (or FLUX_W2_INDUCE_FAIL=1, the containment drill) still tears
// everything down via the finally block.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { atomicWrite, fsyncDir } from "../flux-core/fsx";
import { journal } from "../flux-core/index";
import { loadEnrich, ensureFluxLib } from "../flux-core/fluxlib";
import { TestProcessScope, assertFileQuiescent } from "./lib/testProcess.mjs";

let failures = 0;
const ok = (m: string) => console.log("✓ " + m);
const fail = (m: string) => {
  console.error("✗ " + m);
  failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w2-"));
const scope = new TestProcessScope();
const victim = path.join(work, "victim.json");

try {
  // -------------------------------------------------------------- 1. kill-mid-write
  {
    await atomicWrite(victim, JSON.stringify({ n: 0, rows: [] }));
    const KILLS = 8;
    let sawProgress = 0;
    for (let i = 0; i < KILLS; i++) {
      const writer = scope.spawn(path.join(fixturesDir, "w2-writer-child.mjs"), [victim], {
        readyLine: "writing-started",
        deadlineMs: 60_000,
        label: `writer#${i + 1}`,
      });
      await writer.ready; // the write loop is provably live from here
      if (process.env.FLUX_W2_INDUCE_FAIL) throw new Error("induced parent failure (containment drill)");
      await sleep(Math.random() * 120); // land the SIGKILL at a random point in a write
      await scope.reap(writer); // group SIGKILL + awaited close
      try {
        const parsed = JSON.parse(await fs.readFile(victim, "utf8"));
        if (parsed.n > 0) sawProgress++;
      } catch (e) {
        fail(`kill #${i + 1}: target is corrupt/truncated — ${(e as Error).message}`);
      }
    }
    if (sawProgress === KILLS) ok(`target parsed after ${KILLS}/${KILLS} SIGKILLs, child progress visible in all`);
    else fail(`progress visible in only ${sawProgress}/${KILLS} kills — ready protocol violated`);
    const leftovers = (await fs.readdir(work)).filter((n) => /\.tmp-\d+-\d+$/.test(n));
    ok(`${leftovers.length} orphan tmp file(s) left by kills (harmless dot-litter; target untouched)`);
  }

  // -------------------------------------------------------------- 2. journal concurrency
  {
    const root = path.join(work, "proj");
    await fs.mkdir(path.join(root, ".meta"), { recursive: true });
    const N = 150;
    const jfix = path.join(fixturesDir, "w2-journal-child.mjs");
    const A = scope.spawn(jfix, [root, "A", String(N)], { deadlineMs: 120_000, label: "journal-A" });
    const B = scope.spawn(jfix, [root, "B", String(N)], { deadlineMs: 120_000, label: "journal-B" });
    const [ra, rb] = await Promise.all([scope.waitExit(A), scope.waitExit(B)]);
    if (ra.code !== 0 || rb.code !== 0)
      fail(`journal writers exited ${ra.code}/${rb.code}\nA stderr: ${A.stderr}\nB stderr: ${B.stderr}`);
    const lines = (await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8")).trim().split("\n");
    const parsedOk = lines.every((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    if (lines.length === 2 * N && parsedOk) ok(`journal kept all ${2 * N} concurrent entries, every line parses`);
    else fail(`journal lost/garbled entries: ${lines.length}/${2 * N} lines, parseable=${parsedOk}`);
  }

  // -------------------------------------------------------------- 3. journal rotation
  {
    const root = path.join(work, "proj-rot");
    const jp = path.join(root, ".meta", "journal.ndjson");
    await fs.mkdir(path.dirname(jp), { recursive: true });
    await fs.writeFile(jp, ('{"pad":"' + "x".repeat(1024) + '"}\n').repeat(5200)); // >5MB
    await journal(root, { action: "post-rotate" });
    const metaFiles = await fs.readdir(path.join(root, ".meta"));
    const rotated = metaFiles.find((f) => /^journal-\d+\.ndjson$/.test(f));
    const fresh = (await fs.readFile(jp, "utf8")).trim().split("\n");
    if (rotated && fresh.length === 1 && JSON.parse(fresh[0]).action === "post-rotate")
      ok(`journal rotated to ${rotated}; fresh journal has exactly the new entry`);
    else fail(`rotation failed (rotated=${rotated}, fresh lines=${fresh.length})`);
  }

  // -------------------------------------------------------------- 4. corrupt quarantine
  {
    const lib = path.join(work, "FluxLibTest");
    await ensureFluxLib(lib);
    const ep = path.join(lib, ".fluxlib", "enrich.json");
    await fs.writeFile(ep, '{"truncated": ');
    const map = await loadEnrich(lib);
    const q = (await fs.readdir(path.join(lib, ".fluxlib"))).find((f) => /^enrich\.json\.corrupt-\d+$/.test(f));
    const gone = !(await fs.stat(ep).catch(() => null));
    if (Object.keys(map).length === 0 && q && gone) ok(`corrupt enrich.json quarantined as ${q}`);
    else fail(`quarantine failed (map=${Object.keys(map).length} keys, q=${q}, originalGone=${gone})`);
  }

  // -------------------------------------------------------------- 5. dir-fsync presence
  {
    await fsyncDir(work); // real directory: must not throw
    await fsyncDir(path.join(work, "no-such-dir")); // missing: best-effort silent
    ok("fsyncDir behaves (real dir ok, missing dir silent)");
    const repo = path.join(fixturesDir, "..", "..");
    const src = async (p: string) => await fs.readFile(path.join(repo, p), "utf8");
    const wired: [string, string, RegExp][] = [
      ["flux-core/index.ts", "canvas batch", /fsyncDir\(safeJoin\(root, "fig\/canvases"\)\)/],
      ["flux-core/index.ts", "index commit", /fsyncDir\(j\(root, "fig"\)\)/],
      ["src/lib/project/figbridge.ts", "renderer canvas batch", /fig\.fsyncDir\?\.\(/],
      ["electron/main.cjs", "IPC handler", /["']fs:fsyncDir["']/],
      ["electron/preload.cjs", "bridge exposure", /fsyncDir/],
    ];
    for (const [file, what, re] of wired) {
      if (re.test(await src(file))) ok(`dir-fsync wired: ${what} (${file})`);
      else fail(`dir-fsync NOT wired: ${what} (${file}) — pattern ${re} missing`);
    }
  }
} catch (e) {
  // A parent throw (incl. the FLUX_W2_INDUCE_FAIL drill) is a test failure, but
  // teardown below must still run to completion — containment is unconditional.
  fail(`unhandled parent error: ${(e as Error).stack ?? e}`);
} finally {
  // Containment teardown: kill every child group and AWAIT each close before
  // any temp-dir removal — runs on success, assertion failure, or throw alike.
  await scope.dispose();
}

// Post-teardown self-check: no survivor is still writing (lifecycle assertion,
// not process-table scraping). Only then is removing the tree race-free.
try {
  await assertFileQuiescent(victim, { settleMs: 250 });
  ok("post-teardown: victim quiescent — no surviving writer");
} catch (e) {
  fail(String(e));
}
try {
  await fs.rm(work, { recursive: true, force: true });
} catch (e) {
  fail(`teardown could not remove ${work}: ${String(e)}`);
}

console.log(failures ? "W2 VERIFY: FAIL" : "W2 VERIFY: PASS");
process.exit(failures ? 1 : 0);
