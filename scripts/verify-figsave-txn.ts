#!/usr/bin/env -S npx tsx
// WS-5.3 (fortify plan) — fig/ save durability + write-amplification:
//   · unchanged canvases KEEP their mtime (byte-identical rewrites skipped);
//   · the index is byte-identical + mtime-stable when nothing changed;
//   · index.json.bak holds the PREVIOUS commit point after a real change;
//   · kill-mid-save (real SIGKILL via the WS-0a harness): the index — written
//     LAST — never references a canvas file that doesn't exist.
//   npx tsx scripts/verify-figsave-txn.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { scaffold, loadFigModel, saveFigModel } from "../flux-core/index";
import { TestProcessScope } from "./lib/testProcess.mjs";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-figtxn-"));
const scope = new TestProcessScope();
try {
  await scaffold(root, { title: "txn" });

  // Seed: two canvases, one figure each.
  {
    const { project, index } = await loadFigModel(root);
    project.canvases.push({ id: "cA", name: "A" }, { id: "cB", name: "B" });
    project.figures.push(
      { id: "fA", canvasId: "cA", name: "FA", x: 0, y: 0, width: 100, height: 80, elements: [] },
      { id: "fB", canvasId: "cB", name: "FB", x: 0, y: 0, width: 100, height: 80, elements: [] },
    );
    await saveFigModel(root, project, index);
  }

  const cAPath = path.join(root, "fig", "canvases", "cA.json");
  const cBPath = path.join(root, "fig", "canvases", "cB.json");
  const idxPath = path.join(root, "fig", "index.json");

  // ---- no-op save: everything mtime-stable + byte-identical ------------------
  const statA1 = await fs.stat(cAPath);
  const statB1 = await fs.stat(cBPath);
  const idx1 = await fs.readFile(idxPath, "utf8");
  const statI1 = await fs.stat(idxPath);
  await sleep(30);
  {
    const { project, index } = await loadFigModel(root);
    await saveFigModel(root, project, index);
  }
  const statA2 = await fs.stat(cAPath);
  const statB2 = await fs.stat(cBPath);
  assert(statA1.mtimeMs === statA2.mtimeMs && statB1.mtimeMs === statB2.mtimeMs, "no-op save keeps canvas mtimes (skip-unchanged)");
  assert((await fs.readFile(idxPath, "utf8")) === idx1, "no-op save leaves index byte-identical");
  assert((await fs.stat(idxPath)).mtimeMs === statI1.mtimeMs, "no-op save keeps the index mtime (skip-unchanged)");

  // ---- geometry-only change: touched canvas rewrites, index untouched ---------
  await sleep(30);
  {
    const { project, index } = await loadFigModel(root);
    const fA = project.figures.find((f) => f.id === "fA")!;
    fA.x = 42;
    await saveFigModel(root, project, index);
  }
  const statA3 = await fs.stat(cAPath);
  const statB3 = await fs.stat(cBPath);
  assert(statA3.mtimeMs !== statA2.mtimeMs, "the CHANGED canvas rewrote");
  assert(statB3.mtimeMs === statB2.mtimeMs, "the untouched sibling canvas kept its mtime");
  assert((await fs.readFile(idxPath, "utf8")) === idx1, "geometry-only edit does NOT churn the index");

  // ---- index-affecting change (rename): .bak holds the previous commit point --
  await sleep(30);
  {
    const { project, index } = await loadFigModel(root);
    project.figures.find((f) => f.id === "fA")!.name = "FA renamed";
    await saveFigModel(root, project, index);
  }
  assert((await fs.readFile(idxPath, "utf8")) !== idx1, "rename rewrote the index");
  assert(
    (await fs.readFile(idxPath + ".bak", "utf8")) === idx1,
    "index.json.bak holds the PREVIOUS commit point",
  );

  // ---- kill-mid-save: index (written LAST) never references a missing canvas --
  const KILLS = 6;
  for (let i = 0; i < KILLS; i++) {
    const child = scope.spawn(path.join(fixturesDir, "figsave-child.mjs"), [root], {
      readyLine: "saving-started",
      deadlineMs: 60_000,
      label: `figsave#${i + 1}`,
    });
    await child.ready;
    await sleep(Math.random() * 150);
    await scope.reap(child);
    // stale locks from the killed child must not wedge the next iteration
    await fs.rm(path.join(root, ".meta", "locks"), { recursive: true, force: true }).catch(() => {});
    let idx: { canvases?: { id: string }[]; figures?: { canvas: string }[] } | null = null;
    try {
      idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
    } catch (e) {
      fail(`kill #${i + 1}: index unparseable — ${String(e)}`);
      continue;
    }
    for (const c of idx?.canvases ?? []) {
      const p = path.join(root, "fig", "canvases", `${c.id}.json`);
      if (!(await fs.stat(p).catch(() => null))) fail(`kill #${i + 1}: index references missing canvas ${c.id}`);
    }
    for (const f of idx?.figures ?? []) {
      const p = path.join(root, "fig", "canvases", `${f.canvas}.json`);
      if (!(await fs.stat(p).catch(() => null))) fail(`kill #${i + 1}: figure entry references missing canvas ${f.canvas}`);
    }
  }
  if (failures === 0) ok(`${KILLS}/${KILLS} kills: index never referenced a missing canvas (index-written-LAST holds)`);
} finally {
  await scope.dispose();
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nFIGSAVE TXN: FAIL (${failures})` : "\nFIGSAVE TXN: PASS");
process.exit(failures ? 1 : 0);
