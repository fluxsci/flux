#!/usr/bin/env -S npx tsx
// WS-5.2 (fortify plan) — forward-version guards: files stamped with a NEWER
// breaking format (0.x → minor is the breaking slot) must REFUSE to load, and
// the on-disk bytes must be byte-identical afterwards (the no-rewrite
// assertion is the point: the old behavior migrated newer files DOWN and the
// next save rewrote them lossily). Patch bumps still load.
//   npx tsx scripts/verify-fwdguard.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isNewerSchema } from "../src/lib/project/types";
import { scaffold, loadFigModel } from "../flux-core/index";
import { loadDeck, saveDeck } from "../flux-core/slides";
import type { Deck } from "../src/lib/slide/types";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- the shared comparator ---------------------------------------------------
assert(isNewerSchema("0.2.0", "0.1.0"), "0.2.0 is newer than 0.1.0 (minor = breaking)");
assert(!isNewerSchema("0.1.7", "0.1.0"), "0.1.7 is NOT newer (patch loads fine)");
assert(!isNewerSchema("0.1.0", "0.1.0"), "same version is not newer");
assert(isNewerSchema("1.0.0", "0.9.0"), "major bump is newer");
assert(!isNewerSchema(undefined, "0.1.0"), "missing version = legacy, not newer");
assert(!isNewerSchema("garbage", "0.1.0"), "garbled version = legacy, not newer");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-fwdguard-"));
try {
  await scaffold(root, { title: "fwd" });

  // ---- fig index bumped minor → loadFigModel refuses, bytes unchanged --------
  const idxPath = path.join(root, "fig", "index.json");
  const idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
  idx.schemaVersion = "0.2.0";
  const idxBytes = JSON.stringify(idx, null, 2) + "\n";
  await fs.writeFile(idxPath, idxBytes);
  let threw = "";
  try {
    await loadFigModel(root);
  } catch (e) {
    threw = String(e);
  }
  assert(/newer Flux/i.test(threw), `newer fig/index refuses with the Update-Flux copy (${threw.slice(0, 70)})`);
  assert((await fs.readFile(idxPath, "utf8")) === idxBytes, "fig/index.json bytes UNCHANGED after the refusal");
  idx.schemaVersion = "0.1.0";
  await fs.writeFile(idxPath, JSON.stringify(idx, null, 2) + "\n");

  // ---- canvas file bumped minor → refused, bytes unchanged --------------------
  const cvDir = path.join(root, "fig", "canvases");
  await fs.mkdir(cvDir, { recursive: true });
  // register a canvas in the index so readCanvasFiles visits the file
  const idx2 = JSON.parse(await fs.readFile(idxPath, "utf8"));
  idx2.canvases = [{ id: "canvas-1", name: "Canvas 1", order: 1 }];
  await fs.writeFile(idxPath, JSON.stringify(idx2, null, 2) + "\n");
  const cvPath = path.join(cvDir, "canvas-1.json");
  const cvBytes = JSON.stringify({ schemaVersion: "0.5.0", id: "canvas-1", figures: [] }, null, 2) + "\n";
  await fs.writeFile(cvPath, cvBytes);
  threw = "";
  try {
    await loadFigModel(root);
  } catch (e) {
    threw = String(e);
  }
  assert(/newer Flux/i.test(threw), "newer canvas file refuses");
  assert((await fs.readFile(cvPath, "utf8")) === cvBytes, "canvas bytes UNCHANGED after the refusal");
  await fs.writeFile(cvPath, JSON.stringify({ schemaVersion: "0.1.0", id: "canvas-1", figures: [] }, null, 2) + "\n");

  // ---- patch-bumped canvas still loads ----------------------------------------
  await fs.writeFile(cvPath, JSON.stringify({ schemaVersion: "0.1.9", id: "canvas-1", figures: [] }, null, 2) + "\n");
  const m = await loadFigModel(root);
  assert(m.project.canvases.length === 1, "PATCH-bumped canvas loads fine");

  // ---- deck bumped minor → loadDeck refuses, bytes unchanged -------------------
  const deck = {
    schemaVersion: "0.1.0",
    id: "fwd",
    title: "Fwd",
    theme: "flexoki",
    stage: { width: 1280, height: 720 },
    slides: [],
  } as unknown as Deck;
  await saveDeck(root, deck);
  const deckPath = path.join(root, "slides", "fwd", "deck.json");
  const newer = JSON.parse(await fs.readFile(deckPath, "utf8"));
  newer.schemaVersion = "0.9.0";
  const deckBytes = JSON.stringify(newer, null, 2) + "\n";
  await fs.writeFile(deckPath, deckBytes);
  threw = "";
  try {
    await loadDeck(root, "fwd");
  } catch (e) {
    threw = String(e);
  }
  assert(/newer Flux/i.test(threw), "newer deck refuses");
  assert((await fs.readFile(deckPath, "utf8")) === deckBytes, "deck bytes UNCHANGED after the refusal");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nFWDGUARD: FAIL (${failures})` : "\nFWDGUARD: PASS");
process.exit(failures ? 1 : 0);
