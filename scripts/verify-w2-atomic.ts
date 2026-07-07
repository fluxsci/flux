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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { atomicWrite } from "../flux-core/fsx";
import { journal } from "../flux-core/index";
import { loadEnrich, ensureFluxLib } from "../flux-core/fluxlib";

let failures = 0;
const ok = (m: string) => console.log("✓ " + m);
const fail = (m: string) => {
  console.error("✗ " + m);
  failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const work = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w2-"));

// ---------------------------------------------------------------- 1. kill-mid-write
{
  const target = path.join(work, "victim.json");
  await atomicWrite(target, JSON.stringify({ n: 0, rows: [] }));

  const childSrc = `
    import { atomicWrite } from ${JSON.stringify(pathToFileURL(path.resolve("flux-core/fsx.ts")).href)};
    const target = process.argv[2];
    const rows = Array.from({ length: 12000 }, (_, i) => ({ i, s: "x".repeat(100) }));
    let n = 0;
    for (;;) await atomicWrite(target, JSON.stringify({ n: ++n, rows }));
  `;
  const childPath = path.join(work, "w2-child.mts");
  await fs.writeFile(childPath, childSrc);
  const childLog = path.join(work, "w2-child.log");

  const KILLS = 8;
  let sawProgress = 0;
  for (let i = 0; i < KILLS; i++) {
    const log = await fs.open(childLog, "a");
    const child = spawn("npx", ["tsx", childPath, target], {
      stdio: ["ignore", "ignore", log.fd],
      cwd: path.resolve("."),
    });
    const exited = new Promise((r) => child.once("exit", r));
    await sleep(1400 + Math.random() * 400); // let tsx boot, then catch it mid-flight
    child.kill("SIGKILL");
    await exited;
    await log.close();
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"));
      if (parsed.n > 0) sawProgress++;
    } catch (e) {
      fail(`kill #${i + 1}: target is corrupt/truncated — ${(e as Error).message}`);
    }
  }
  if (sawProgress === 0)
    console.error("child stderr:\n" + (await fs.readFile(childLog, "utf8").catch(() => "(none)")));
  if (failures === 0) ok(`target parsed after ${KILLS}/${KILLS} SIGKILLs (progress seen in ${sawProgress})`);
  if (sawProgress === 0)
    fail("child never completed a write — the kill window missed the write loop entirely (test inconclusive)");
  const leftovers = (await fs.readdir(work)).filter((n) => /\.tmp-\d+-\d+$/.test(n));
  ok(`${leftovers.length} orphan tmp file(s) left by kills (harmless dot-litter; target untouched)`);
}

// ---------------------------------------------------------------- 2. journal concurrency
{
  const root = path.join(work, "proj");
  await fs.mkdir(path.join(root, ".meta"), { recursive: true });
  const N = 150;
  const jsrc = `
    import { journal } from ${JSON.stringify(pathToFileURL(path.resolve("flux-core/index.ts")).href)};
    const [root, who] = process.argv.slice(2);
    for (let i = 0; i < ${N}; i++) await journal(root, { action: "test", target: who + ":" + i });
  `;
  const jpath = path.join(work, "w2-journal.mts");
  await fs.writeFile(jpath, jsrc);
  const run = (who: string) =>
    new Promise<number>((res) => {
      const c = spawn("npx", ["tsx", jpath, root, who], {
        stdio: ["ignore", "ignore", "inherit"],
        cwd: path.resolve("."),
      });
      c.once("exit", (code) => res(code ?? -1));
    });
  const [a, b] = await Promise.all([run("A"), run("B")]);
  if (a !== 0 || b !== 0) fail(`journal writers exited ${a}/${b}`);
  const lines = (await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8"))
    .trim()
    .split("\n");
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

// ---------------------------------------------------------------- 3. journal rotation
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

// ---------------------------------------------------------------- 4. corrupt quarantine
{
  const lib = path.join(work, "FluxLibTest");
  await ensureFluxLib(lib);
  const ep = path.join(lib, ".fluxlib", "enrich.json");
  await fs.writeFile(ep, '{"truncated": ');
  const map = await loadEnrich(lib);
  const q = (await fs.readdir(path.join(lib, ".fluxlib"))).find((f) =>
    /^enrich\.json\.corrupt-\d+$/.test(f),
  );
  const gone = !(await fs.stat(ep).catch(() => null));
  if (Object.keys(map).length === 0 && q && gone) ok(`corrupt enrich.json quarantined as ${q}`);
  else fail(`quarantine failed (map=${Object.keys(map).length} keys, q=${q}, originalGone=${gone})`);
}

// Teardown with retries: the kill-mid-write children can land a final write while
// rm walks the tree (ENOTEMPTY race). Teardown litter must never fail the suite.
for (let i = 0; ; i++) {
  try {
    await fs.rm(work, { recursive: true, force: true });
    break;
  } catch (e) {
    if (i >= 4) {
      console.warn(`teardown: leaving temp dir behind (${work}): ${String(e)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
console.log(failures ? "W2 VERIFY: FAIL" : "W2 VERIFY: PASS");
process.exit(failures ? 1 : 0);
