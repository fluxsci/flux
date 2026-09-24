#!/usr/bin/env -S npx tsx
// Regression: "Couldn't open that deck — its file may be missing or corrupt."
// after an agent rewrote a deck while it was open. The agent's CLI burst made
// SlideMode reload the deck while a source refresh published resolved assets
// through `mutateDisplay`, a display-only store change. loadDeckInto treated
// that bump as a user edit landing mid-load, abandoned a perfectly valid file,
// and SlideMode reported the null as corruption.
//
// Contract:
//   1. a display-only change mid-load does NOT abort the load;
//   2. a real document edit mid-load DOES supersede it (never clobber an edit),
//      and says so through onSuperseded, which is not a file failure;
//   3. a genuinely missing deck returns null WITHOUT onSuperseded;
//   4. SlideMode stays silent on a superseded load and retries the external
//      reload, keeping the "missing or corrupt" toast for real failures.
//   npx tsx scripts/verify-slide-reload-supersede.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-reload-supersede");
const { document } = parseHTML("<!doctype html><html><body></body></html>");
const ROOT = await fs.mkdtemp(`${os.tmpdir()}/flux-reload-supersede-`);
// Fires once, right after the deck file is read: the moment inside
// loadDeckInto where the watcher's source refresh landed in the field.
let midLoad: (() => void) | null = null;
const fig = {
  async remove(p: string) { await fs.rm(p, { force: true }); },
  async exists(p: string) { try { await fs.access(p); return true; } catch { return false; } },
  async readText(p: string) {
    const text = await fs.readFile(p, "utf8");
    if (midLoad && p.endsWith("deck.json")) { const hook = midLoad; midLoad = null; hook(); }
    return text;
  },
  async writeText(p: string, t: string) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, t); },
  async mkdir(p: string) { await fs.mkdir(p, { recursive: true }); },
  async readdir(p: string) { const es = await fs.readdir(p, { withFileTypes: true }); return es.map((e) => ({ name: e.name, dir: e.isDirectory() })); },
  async readFile(p: string) { const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
};
(globalThis as { window?: unknown }).window = { fig };
(globalThis as { document?: unknown }).document = document;

try {
  const bridge = await import("../src/lib/project/slideBridge");
  const { deckOverlay } = await import("../src/lib/slide/store");
  const { setStoreTenant } = await import("../src/lib/tenancy");
  const store = await import("../src/lib/store");
  const { get } = await import("svelte/store");
  setStoreTenant("slide");
  store.embeddedProjectRoot.set(ROOT);
  await fs.writeFile(`${ROOT}/project.json`, JSON.stringify({ schemaVersion: "0.1.0", id: "reload-test", title: "T", manuscript: { path: "paper/notes.qmd", config: "paper/_quarto.yml", format: "quarto" }, references: { library: "references/library.bib" }, figures: [], slides: [] }, null, 2));
  const A = await bridge.createDeckInProject(ROOT, { title: "Alpha" });
  const B = await bridge.createDeckInProject(ROOT, { title: "Agent deck" });

  // 1. display-only change mid-load
  let superseded = false;
  const nBefore = store.editGen.n, editsBefore = store.editGen.edits;
  midLoad = () => store.mutateDisplay(() => {});
  const loaded = await bridge.loadDeckInto(ROOT, A.id, { onSuperseded: () => { superseded = true; } });
  h.ok(store.editGen.n > nBefore && store.editGen.edits === editsBefore, "a display refresh advances the store counter but not the edit counter");
  h.ok(!!loaded && !superseded && get(deckOverlay)?.id === A.id, "a display-only refresh landing mid-load does not abort a valid deck's load");

  // 2. a real edit mid-load supersedes the load (the edit is never clobbered)
  superseded = false;
  midLoad = () => store.mutate(() => {});
  const overtaken = await bridge.loadDeckInto(ROOT, B.id, { onSuperseded: () => { superseded = true; } });
  h.ok(overtaken === null && superseded, "a document edit mid-load supersedes it and reports onSuperseded, not a file failure");
  h.ok(get(deckOverlay)?.id === A.id, "the superseded load leaves the live deck untouched");

  // ... and once the editor is quiet, the retried load lands the new deck.
  superseded = false;
  const retried = await bridge.loadDeckInto(ROOT, B.id, { onSuperseded: () => { superseded = true; } });
  h.ok(!!retried && !superseded && get(deckOverlay)?.id === B.id, "the retried reload lands the agent's deck");

  // 3. a genuinely missing deck file is a real failure
  await fs.rm(path.join(ROOT, "slides", A.id, "deck.json"));
  superseded = false;
  const missing = await bridge.loadDeckInto(ROOT, A.id, { onSuperseded: () => { superseded = true; } });
  h.ok(missing === null && !superseded, "a missing deck file returns null without claiming supersession");

  // 4. SlideMode wiring (the component needs a live shell; pin the source shape)
  const mode = await fs.readFile(path.join(import.meta.dirname, "../src/shell/modes/slide/SlideMode.svelte"), "utf8");
  const open = mode.slice(mode.indexOf("async function openDeck("), mode.indexOf("let deckBusy"));
  const quiet = open.indexOf("if (!loaded && superseded)"), toast = open.indexOf("missing or corrupt");
  h.ok(open.includes("onSuperseded:") && quiet > 0 && toast > quiet, "SlideMode returns quietly on a superseded load before the corruption toast");
  const revision = mode.slice(mode.indexOf("async function onDeckRevision("), mode.indexOf("async function reloadDeckTheirs("));
  h.ok(/for \(let attempt = 0; attempt < \d+; attempt\+\+\)/.test(revision) && revision.includes("lastOpenSuperseded") && revision.includes("get(figDirty)"), "an overtaken external reload is retried while the editor stays clean");
} catch (error) {
  console.error(error);
  h.fail(String((error as Error)?.message ?? error));
} finally {
  await fs.rm(ROOT, { recursive: true, force: true });
}
await h.done();
