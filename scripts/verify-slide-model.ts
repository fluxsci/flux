#!/usr/bin/env -S npx tsx
// P0 — the deck model + persistence + schema. A deck round-trips through the
// pure ops core and flux-core save/load with full fidelity, the deck schema
// ships into .meta/schema/, a valid deck passes, and a malformed deck is caught.
// Run: npx tsx scripts/verify-slide-model.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as slideOps from "../src/lib/slide/ops";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-model-"));
try {
  await core.scaffold(root, { title: "Slide Model Test" });

  // The deck schema shipped, and the scaffold seeded a starter deck.
  const schemas = await fs.readdir(path.join(root, ".meta", "schema"));
  assert(schemas.includes("deck.schema.json"), "deck.schema.json shipped to .meta/schema/");
  const decks0 = await core.listDecks(root);
  assert(decks0.length === 1 && decks0[0].slides === 1, `scaffold seeded one starter deck w/ 1 slide`);

  // The whole project (incl. the seeded deck) validates clean.
  let pv = await core.validate(root);
  assert(pv.ok, `scaffold validates clean incl. deck (${pv.checked} checked)`);
  let dv = await core.validateDeck(root);
  assert(dv.ok && dv.checked === 1, `validate-deck passes the starter deck`);

  // Build a rich deck via the PURE ops, save, reload → assert byte-identical.
  const deck = slideOps.createDeck({ id: "defense", title: "Thesis Defense" });
  const s1 = slideOps.addSlide(deck, { name: "Results", layout: "content-figure" });
  const tb = slideOps.addSlideText(deck, s1.id, { text: "Mycelial growth doubles under stress\n• …but only above 24 °C", x: 80, y: 80, fontSize: 24 })!;
  const beat = slideOps.addBeat(deck, s1.id, { label: "reveal bullets", advance: "click" })!;
  slideOps.setAnimation(deck, s1.id, beat.id, {
    target: tb,
    preset: "fadeRise",
    start: 0,
    duration: 320,
  });
  assert(deck.slides.length === 2, "deck has 2 slides (title + results)");

  await core.saveDeck(root, deck);
  const reloaded = await core.loadDeck(root, "defense");
  assert(JSON.stringify(reloaded.slides) === JSON.stringify(deck.slides), "deck slides round-trip byte-identical");
  assert(reloaded.title === "Thesis Defense", "deck title preserved");
  const rb = reloaded.slides[1].beats.find((b) => b.label === "reveal bullets");
  assert(!!rb && rb.tracks[0].preset === "fadeRise" && rb.tracks[0].duration === 320, "animation track round-trips");

  // The new deck registered in project.json.slides[].
  const decks1 = await core.listDecks(root);
  assert(decks1.some((d) => d.id === "defense" && d.slides === 2), "new deck registered in manifest");

  // Single-file validation via schemaForFile (slides/<id>/deck.json → "deck").
  pv = await core.validate(root, "slides/defense/deck.json");
  assert(pv.ok && pv.checked === 1, "single-file deck validate ok");

  // Corrupt a deck: drop a slide's required `beats` → must be caught.
  const dpath = path.join(root, "slides", "defense", "deck.json");
  const bad = JSON.parse(await fs.readFile(dpath, "utf8"));
  delete bad.slides[0].beats;
  await fs.writeFile(dpath, JSON.stringify(bad, null, 2));
  dv = await core.validateDeck(root, "defense");
  assert(!dv.ok && dv.errors.some((e) => /beats/.test(e)), `malformed deck caught (${dv.errors[0] ?? ""})`);

  console.log("\nALL SLIDE-MODEL (P0) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
