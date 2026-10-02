// Paper's slide-embed source chip — the pure half (the label catalog). The
// chip must resolve SYNCHRONOUSLY in CodeMirror's decoration pass, so
// slideChipCatalog keeps {deck → title, slides} filled from the embed
// repository's deck reads. Pinned here, hermetically, against the REAL
// repository over a scratch project:
//   - first sight is `pending` (fallback "Slide <short id>"), one deck read,
//     then "Deck title · Slide <1-based ordinal>"; the name rides the tooltip;
//   - lookups never re-read (no per-keystroke IO), whatever the count;
//   - unknown deck / slide no longer in the deck → unresolved (dimmed) label;
//   - a repository invalidation (deck write) re-reads and notifies ONCE, and
//     keeps answering with the old entry until the fresh read settles;
//   - an invalidation with no visible change does not notify;
//   - a read superseded by a later invalidation can never win;
//   - dispose unsubscribes.
// The CodeMirror/DOM half (fold, reveal, double-click, rename) is
// verify-slide-embed-chip.mjs.
import { harness } from "./lib/harness.mjs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inlineSlideFixture } from "./fixtures/inline-slide";
import { createSlideRepository } from "../src/lib/slide/embedRepository";
import { createSlideChipCatalog, slideChipLabel, type SlideCatalogDeck } from "../src/shell/modes/paper/science/slideChipCatalog";

const h = harness("verify-slide-embed-chip");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-chip-"));
const tick = () => new Promise((r) => setTimeout(r, 0));
let reads = 0;
const io = {
  readText: (p: string) => {
    if (p.endsWith("deck.json")) reads++;
    return fs.readFile(p, "utf8");
  },
  readFile: (p: string) => fs.readFile(p),
  exists: async (p: string) => fs.access(p).then(() => true, () => false),
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })),
};
const writeDeck = async (deck: ReturnType<typeof inlineSlideFixture>) => {
  await fs.mkdir(path.join(root, "slides", deck.id), { recursive: true });
  await fs.writeFile(path.join(root, "slides", deck.id, "deck.json"), JSON.stringify(deck));
};
try {
  const talk = inlineSlideFixture("talk");
  talk.title = "Deck 3";
  // Names deliberately drift from position (the owner's Deck 3 has its
  // "Title" slide second): the chip says the ORDINAL.
  talk.slides = [
    { ...structuredClone(talk.slides[1]), id: "intro", name: "Slide 2" },
    { ...structuredClone(talk.slides[0]), id: "results", name: "Title" },
    { ...structuredClone(talk.slides[1]), id: "third", name: "Slide 3" },
  ];
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify({ slides: [{ id: "talk", path: "slides/talk/deck.json", title: "Deck 3" }] }));
  await writeDeck(talk);
  const repo = createSlideRepository(root, io);
  let changes = 0;
  const catalog = createSlideChipCatalog(repo, () => changes++);

  const raw = '![](../slides/talk/renders/results-step-0.svg){#slide-a .flux-slide deck="talk" slide="results" width=50%}';
  const first = catalog.lookup({ deck: "talk", slide: "results" });
  h.eq(first.state, "pending", "first sight answers synchronously with pending");
  const pend = slideChipLabel({ deck: "talk", slide: "slide_murfegg25pk8_8" }, first, raw);
  h.ok(pend.text === "Slide murfeg" && pend.resolved && pend.pending, `pending label is the short-id fallback, not dimmed (${pend.text})`);
  await tick();
  await tick();
  h.eq(changes, 1, "the settled read notifies once");
  const resolved = slideChipLabel({ deck: "talk", slide: "results" }, catalog.lookup({ deck: "talk", slide: "results" }), raw);
  h.eq(resolved.text, "Deck 3 · Slide 2", "deck title + 1-based ordinal, mid-dot like the widget footer");
  h.ok(resolved.resolved && !resolved.pending, "resolved label is the accent chip");
  h.ok(resolved.tooltip.includes("Slide 2 of 3 — “Title”") && resolved.tooltip.includes(raw) && /double-click to open in Slide/.test(resolved.tooltip),
    "tooltip carries position-of-count, the slide's own name, the raw line and the gesture hint");
  const third = slideChipLabel({ deck: "talk", slide: "third" }, catalog.lookup({ deck: "talk", slide: "third" }), raw);
  h.ok(third.text === "Deck 3 · Slide 3" && !third.tooltip.includes("“Slide 3”"), "a default name equal to the ordinal is not repeated");

  const before = reads;
  for (let i = 0; i < 2000; i++) catalog.lookup({ deck: "talk", slide: i % 2 ? "results" : "intro" });
  await tick();
  h.eq(reads - before, 0, "2,000 lookups cost zero deck reads (no per-keystroke IO)");

  catalog.lookup({ deck: "gone", slide: "x" });
  await tick();
  await tick();
  const gone = slideChipLabel({ deck: "gone", slide: "x" }, catalog.lookup({ deck: "gone", slide: "x" }), raw);
  h.ok(!gone.resolved && gone.text === "Missing slide deck" && /no longer registered/.test(gone.tooltip), `unknown deck → unresolved chip with the reason (${gone.tooltip.split(":")[0]})`);
  const lost = slideChipLabel({ deck: "talk", slide: "nope" }, catalog.lookup({ deck: "talk", slide: "nope" }), raw);
  h.ok(!lost.resolved && lost.text === "Deck 3 · missing slide", "slide no longer in its deck → unresolved, deck title kept");
  const blank = catalog.lookup({ deck: "", slide: "" });
  h.eq(blank.state, "missing", "an embed with no IDs is unresolved without IO");

  // Rename the deck on disk + invalidate (what slideEmbedRevision does).
  changes = 0;
  talk.title = "Evidence deck";
  await writeDeck(talk);
  repo.invalidate();
  h.eq(slideChipLabel({ deck: "talk", slide: "results" }, catalog.lookup({ deck: "talk", slide: "results" }), raw).text, "Deck 3 · Slide 2",
    "while the fresh read is in flight the old entry still answers (no fallback flash)");
  await tick();
  await tick();
  h.ok(changes === 1, `one invalidation → one notification (${changes})`);
  h.eq(slideChipLabel({ deck: "talk", slide: "results" }, catalog.lookup({ deck: "talk", slide: "results" }), raw).text, "Evidence deck · Slide 2", "rename reaches the label");

  // Reorder: ordinal follows position.
  talk.slides = [talk.slides[1], talk.slides[0], talk.slides[2]];
  await writeDeck(talk);
  repo.invalidate();
  await tick();
  await tick();
  h.eq(slideChipLabel({ deck: "talk", slide: "results" }, catalog.lookup({ deck: "talk", slide: "results" }), raw).text, "Evidence deck · Slide 1", "reordering renumbers the chip");

  changes = 0;
  repo.invalidate();
  await tick();
  await tick();
  h.eq(changes, 0, "an invalidation with no visible change does not notify");

  // Superseded reads: a slow first read must not overwrite a newer one.
  let release: ((d: SlideCatalogDeck) => void) | undefined;
  const listeners = new Set<() => void>();
  let call = 0;
  const fake = {
    deck: (_id: string) => (++call === 1 ? new Promise<SlideCatalogDeck>((r) => { release = r; }) : Promise.resolve({ title: "Newer", slides: [{ id: "s" }] })),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const raced = createSlideChipCatalog(fake, () => {});
  raced.lookup({ deck: "d", slide: "s" });
  for (const fn of listeners) fn();
  await tick();
  release!({ title: "Stale", slides: [{ id: "s" }] });
  await tick();
  const r = raced.lookup({ deck: "d", slide: "s" });
  h.ok(r.state === "resolved" && r.deckTitle === "Newer", "a read superseded by an invalidation can never win");
  raced.dispose();
  h.eq(listeners.size, 0, "dispose unsubscribes from the repository");
  catalog.dispose();
  repo.dispose();
} catch (e) {
  h.fail(String(e instanceof Error ? e.stack : e));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
await h.done();
