// W3 (V1 review): lock protocol v2 — concurrency verification.
// Run: npx tsx scripts/verify-w3-locks.ts
//
// 1. Concurrent FluxLib adds: two processes each append 4 distinct BibTeX entries
//    to the SAME library at once → all 8 present (the LR-1 lost-update scenario).
// 2. Concurrent fig verbs: two processes each create 3 figures in the same
//    project → all 6 present (mutateFigModel holds the lock across load→save).
// 3. Human-held lock defers an agent verb immediately with the clear message.
// 4. Agent-vs-agent contention retries briefly instead of erroring.
// 5. mergeEnrichDelta preserves entries written mid-hydrate by someone else.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { scaffold, createFigure, loadFigModel, setClient } from "../flux-core/index";
import { addToFluxLib, loadLibrary, mergeEnrichDelta, loadEnrich, writeEnrich, ensureFluxLib } from "../flux-core/fluxlib";
import { acquireLockAt, projectLockDir, withLockAt } from "../flux-core/locks";
import type { EnrichEntry } from "../src/lib/references/types";

let failures = 0;
const ok = (m: string) => console.log("✓ " + m);
const fail = (m: string) => {
  console.error("✗ " + m);
  failures++;
};
const work = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w3-"));
const coreUrl = pathToFileURL(path.resolve("flux-core/index.ts")).href;
const libUrl = pathToFileURL(path.resolve("flux-core/fluxlib.ts")).href;

function run(script: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((res) => {
    const c = spawn("npx", ["tsx", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: path.resolve("."),
    });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.once("exit", (code) => res({ code: code ?? -1, err }));
  });
}

// ---------------------------------------------------------------- 1. concurrent lib adds
{
  const lib = path.join(work, "lib1");
  await ensureFluxLib(lib);
  const src = `
    import { addToFluxLib } from ${JSON.stringify(libUrl)};
    import { setLockClient } from ${JSON.stringify(pathToFileURL(path.resolve("flux-core/locks.ts")).href)};
    const [lib, who] = process.argv.slice(2);
    setLockClient(who);
    for (let i = 0; i < 4; i++) {
      await addToFluxLib(
        \`@article{\${who}\${i}x, title={Paper \${who} \${i}}, author={Doe, J.}, year={202\${i}}, doi={10.1/\${who}.\${i}}}\`,
        { source: "bibtex", libPath: lib },
      );
    }
  `;
  const p = path.join(work, "w3-add.mts");
  await fs.writeFile(p, src);
  const [a, b] = await Promise.all([run(p, [lib, "agentA"]), run(p, [lib, "agentB"])]);
  if (a.code !== 0 || b.code !== 0) fail(`lib-add writers exited ${a.code}/${b.code}\n${a.err}\n${b.err}`);
  const entries = await loadLibrary(lib);
  if (entries.length === 8) ok("concurrent FluxLib adds: all 8 entries present (no lost update)");
  else fail(`concurrent FluxLib adds lost entries: ${entries.length}/8 — [${entries.map((e) => e.key)}]`);
}

// ---------------------------------------------------------------- 2. concurrent fig verbs
{
  const root = path.join(work, "proj");
  await scaffold(root, { title: "W3" });
  const baseline = (await loadFigModel(root)).project.figures.length;
  const src = `
    import { createFigure, setClient } from ${JSON.stringify(coreUrl)};
    const [root, who] = process.argv.slice(2);
    setClient(who);
    for (let i = 0; i < 3; i++) await createFigure(root, { name: who + "-" + i });
  `;
  const p = path.join(work, "w3-fig.mts");
  await fs.writeFile(p, src);
  const [a, b] = await Promise.all([run(p, [root, "agentA"]), run(p, [root, "agentB"])]);
  if (a.code !== 0 || b.code !== 0) fail(`fig writers exited ${a.code}/${b.code}\n${a.err}\n${b.err}`);
  const { project } = await loadFigModel(root);
  const made = project.figures.length - baseline;
  const uniq = new Set(project.figures.map((f) => f.id)).size === project.figures.length;
  if (made === 6 && uniq)
    ok("concurrent createFigure: all 6 new figures present, ids unique (lock spans load→save)");
  else fail(`concurrent createFigure lost figures: ${made}/6 new (unique=${uniq})`);
}

// ---------------------------------------------------------------- 3. human lock defers fast
{
  const root = path.join(work, "proj2");
  await scaffold(root, { title: "W3b" });
  await acquireLockAt(projectLockDir(root), "project", "human");
  setClient("cli");
  const t0 = Date.now();
  try {
    await createFigure(root, { name: "should-defer" });
    fail("verb ran despite a fresh human lock");
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = (e as Error).message;
    if (/deferred/.test(msg) && /human edit is in progress/.test(msg) && ms < 1000)
      ok(`human-held lock defers immediately (${ms}ms) with the clear message`);
    else fail(`unexpected deferral behavior: ${ms}ms, "${msg}"`);
  }
}

// ---------------------------------------------------------------- 4. agent contention retries
{
  const dir = path.join(work, "retry-locks");
  await acquireLockAt(dir, "thing", "agentA");
  setTimeout(async () => {
    const { releaseLockAt } = await import("../flux-core/locks");
    await releaseLockAt(dir, "thing", "agentA");
  }, 600);
  const t0 = Date.now();
  try {
    await withLockAt(dir, "thing", "agentB", async () => "ran", { retries: 8 });
    const ms = Date.now() - t0;
    if (ms >= 400) ok(`agent-vs-agent contention retried and succeeded after ${ms}ms`);
    else fail(`retry succeeded suspiciously fast (${ms}ms) — was the lock ever held?`);
  } catch (e) {
    fail(`retry path deferred instead of succeeding: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- 5b. external canvas edit survives the next verb (WS-5.4)
{
  // The headless engine has no baseline — its divergence safety is "every verb
  // loads FRESH from disk under the lock". Pin that: an external in-place edit
  // to a canvas file (index untouched) must survive the next verb's full rewrite.
  const root = path.join(work, "proj3");
  await scaffold(root, { title: "W3c" });
  setClient("cli");
  await createFigure(root, { name: "First" });
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const cvPath = path.join(root, "fig", "canvases", `${idx.canvases[0].id}.json`);
  const cf = JSON.parse(await fs.readFile(cvPath, "utf8"));
  cf.figures[0].x = 4321; // the "external" (human/other-agent) in-place edit
  await fs.writeFile(cvPath, JSON.stringify(cf, null, 2) + "\n");
  await createFigure(root, { name: "Second" }); // full load→save cycle
  const after = JSON.parse(await fs.readFile(cvPath, "utf8"));
  const survivor = after.figures.find((f: { x: number }) => f.x === 4321);
  if (survivor && after.figures.length === cf.figures.length + 1)
    ok("external canvas edit survived the next verb's rewrite (fresh load under the lock)");
  else fail(`external canvas edit clobbered: x=4321 ${survivor ? "present" : "GONE"}, figures=${after.figures.length}`);
}

// ---------------------------------------------------------------- 5. mergeEnrichDelta preserves concurrent writes
{
  const lib = path.join(work, "lib2");
  await ensureFluxLib(lib);
  const mk = (k: string): EnrichEntry =>
    ({ key: k, sources: ["openalex"], fetchedAt: new Date().toISOString() }) as unknown as EnrichEntry;
  // hydrate A takes its snapshot (empty), then B lands its own entry, then A merges its delta
  await writeEnrich({ fromB: mk("fromB") }, lib); // B's mid-hydrate write
  await mergeEnrichDelta({ fromA: mk("fromA") }, lib); // A merges only its delta
  const map = await loadEnrich(lib);
  if (map.fromA && map.fromB) ok("mergeEnrichDelta preserved the concurrently-written entry");
  else fail(`mergeEnrichDelta clobbered: keys=[${Object.keys(map)}]`);
}

await fs.rm(work, { recursive: true, force: true });
console.log(failures ? "W3 VERIFY: FAIL" : "W3 VERIFY: PASS");
process.exit(failures ? 1 : 0);
