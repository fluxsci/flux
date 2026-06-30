#!/usr/bin/env -S npx tsx
// Regression: multiple decks per project (D). createDeckInProject writes +
// registers each deck, listProjectDecks enumerates them with live slide counts,
// and switching decks after an edit+save preserves the edit — the save-before-
// switch contract SlideMode.switchDeck relies on. Self-contained temp project.
//   npx tsx scripts/verify-slide-decks.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const ROOT = await fs.mkdtemp(`${os.tmpdir()}/flux-decks-`);
// a node-fs FileBridge (write-capable) rooted on absolute paths
const fig = {
  async exists(p: string) { try { await fs.access(p); return true; } catch { return false; } },
  async readText(p: string) { return fs.readFile(p, "utf8"); },
  async writeText(p: string, t: string) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, t); },
  async mkdir(p: string) { await fs.mkdir(p, { recursive: true }); },
  async readdir(p: string) { const es = await fs.readdir(p, { withFileTypes: true }); return es.map((e) => ({ name: e.name, dir: e.isDirectory() })); },
  async readFile(p: string) { const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
};
(globalThis as { window?: unknown }).window = { fig };
(globalThis as { document?: unknown }).document = document;

const slideOps = await import("../src/lib/slide/ops");
const bridge = await import("../src/lib/project/slideBridge");
const { deck: deckStore, commitDeck } = await import("../src/lib/slide/store");
const { get } = await import("svelte/store");

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// seed a minimal project.json (listProjectDecks/registerDeck read+write it)
await fs.writeFile(`${ROOT}/project.json`, JSON.stringify({ schema: "flux-project", title: "T", slides: [] }, null, 2));

// 1. create two decks (each writes slides/<id>/deck.json + registers in manifest)
const A = await bridge.createDeckInProject(ROOT, { title: "Alpha" });
const B = await bridge.createDeckInProject(ROOT, { title: "Beta" });
assert(A.id !== B.id, "two new decks get distinct ids");
assert(get(deckStore)?.id === B.id, "the most recently created deck is the live one");

// 2. listProjectDecks enumerates both, with titles
let list = await bridge.listProjectDecks(ROOT);
assert(list.length === 2 && list.some((d) => d.title === "Alpha") && list.some((d) => d.title === "Beta"), "listProjectDecks returns both decks");

// 3. load A, edit it (add a uniquely-named slide), save to disk
await bridge.loadDeckInto(ROOT, A.id);
assert(get(deckStore)?.id === A.id, "loadDeckInto put deck A in the live store");
commitDeck((d) => slideOps.addSlide(d, { name: "EDIT_SLIDE", layout: "blank" }));
const aSlides = get(deckStore)!.slides.length;
await bridge.saveDeckFrom(ROOT);

// 4. switch to B — the save-before-switch contract means A is already flushed
await bridge.loadDeckInto(ROOT, B.id);
assert(get(deckStore)?.id === B.id, "switched the live store to deck B");
assert(!get(deckStore)!.slides.some((s) => s.name === "EDIT_SLIDE"), "deck B does NOT carry deck A's edit (decks are independent)");

// 5. re-read A from disk → the edit survived the switch
const aDisk = await bridge.readDeck(ROOT, A.id);
assert(aDisk?.slides.length === aSlides && aDisk.slides.some((s) => s.name === "EDIT_SLIDE"), "deck A's edit persisted across the deck switch");

// 6. listProjectDecks slide counts reflect the edit (live count, not stale)
list = await bridge.listProjectDecks(ROOT);
assert(list.find((d) => d.id === A.id)?.slides === aSlides, `listProjectDecks reflects A's new slide count (${aSlides})`);

await fs.rm(ROOT, { recursive: true, force: true });
console.log("\nSLIDE MULTI-DECK REGRESSION PASSED");
