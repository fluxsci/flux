#!/usr/bin/env -S npx tsx
// slide-migration §7.1 — the 0.2.0 deck load gate:
//   • a good slides-are-figures deck validates (pre-generated Ajv, CSP-safe)
//   • malformed decks are REJECTED (missing stage, bad element, wrong version)
//   • an OLD-format (0.1.x) deck fails validation — the sanctioned clean break
//     (owner decision, plan §0.2.1): the GUI read seam QUARANTINES it
//     (.corrupt-<ts> copy) and skips, never half-loads — re-homing
//     verify-deck-migrate.ts's "old decks don't crash the app" concern
//   • a NEWER deck is refused by the forward-version guard BEFORE validation
//   • dangling beat targets are WARNINGS (validate_deck), never rejections
//   npx tsx scripts/verify-deck-schema.ts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateDeckFile } from "../src/lib/project/validate";
import { isNewerSchema } from "../src/lib/project/types";
import { DECK_SCHEMA_VERSION } from "../src/lib/slide/types";
import * as slideOps from "../src/lib/slide/ops";
import { validateDeck as validateDeckVerb, saveDeck } from "../flux-core/slides";
import { scaffold } from "../flux-core/index";

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// --- a good deck (built through the one blank-deck source) validates -----------
const good = slideOps.createDeck({ id: "g", title: "Good" });
slideOps.addSlideText(good, good.slides[0].id, { text: "hi", x: 10, y: 10 });
assert(DECK_SCHEMA_VERSION === "0.2.0", "the slides-are-figures format is 0.2.0 (0.x minor = the breaking slot)");
assert(validateDeckFile(good).length === 0, "a createDeck() deck validates against the bundled schema");

// --- malformed decks are rejected -----------------------------------------------
{
  const noStage = structuredClone(good) as unknown as Record<string, unknown>;
  delete noStage.stage;
  assert(validateDeckFile(noStage).length > 0, "missing stage → rejected");
}
{
  const badEl = structuredClone(good);
  (badEl.slides[0].elements as unknown[]).push({ id: "z", type: "blob", x: 0 });
  assert(validateDeckFile(badEl).length > 0, "an element outside the figure union (type 'blob') → rejected");
}
{
  const nanGeom = structuredClone(good);
  (nanGeom.slides[0].elements[0] as unknown as { x: unknown }).x = null; // JSON.stringify(NaN)
  assert(validateDeckFile(nanGeom).length > 0, "null-corrupted geometry (the NaN persistence bug) → rejected");
}

// --- the CLEAN BREAK: a 0.1.x deck fails validation -------------------------------
const oldDeck = {
  schemaVersion: "0.1.0",
  id: "old",
  title: "Old",
  stage: { width: 1280, height: 720 },
  theme: "flux-dark",
  assets: [],
  slides: [
    {
      id: "s1",
      elements: [{ type: "textBox", id: "tb", x: 0, y: 0, width: 100, height: 40, rotation: 0, blocks: [{ id: "b", text: "hi" }] }],
      beats: [{ id: "b0", tracks: [] }],
    },
  ],
};
assert(validateDeckFile(oldDeck).length > 0, "a 0.1.x deck (textBox elements) FAILS validation — no migration, no compat shim (owner decision)");
assert(!isNewerSchema(oldDeck.schemaVersion, DECK_SCHEMA_VERSION), "…and it is NOT 'newer' — it takes the quarantine path, not the refuse path");

// --- forward-version guard runs BEFORE validation ---------------------------------
assert(isNewerSchema("0.3.0", DECK_SCHEMA_VERSION), "a 0.3.x deck is NEWER (refuse + toast; never rewritten, never quarantined)");
assert(!isNewerSchema("0.2.9", DECK_SCHEMA_VERSION), "0.2.x patch versions are OUR line (loadable)");

// --- validate_deck: dangling targets are warnings, not errors ---------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-deckschema-"));
try {
  await scaffold(root, { title: "schema" });
  const d = slideOps.createDeck({ id: "dangle", title: "Dangle" });
  const sid = d.slides[0].id;
  const el = slideOps.addSlideText(d, sid, { text: "x", x: 0, y: 0 })!;
  const beat = slideOps.addBeat(d, sid, { label: "b" })!;
  slideOps.setAnimation(d, sid, beat.id, { target: el, preset: "fade" });
  slideOps.setAnimation(d, sid, beat.id, { target: "deleted-el", preset: "fade" });
  await saveDeck(root, d);
  const v = await validateDeckVerb(root, "dangle");
  assert(v.ok, "a deck with a dangling beat target still VALIDATES (ok)");
  assert(v.warnings.some((w) => w.includes("deleted-el")), "…but validate_deck reports the dangling target as a warning");
  assert(slideOps.danglingTrackTargets(d).length === 1, "danglingTrackTargets finds exactly the one dangler");

  // and saving never silently strips it
  const reread = JSON.parse(await fs.readFile(path.join(root, "slides", "dangle", "deck.json"), "utf8"));
  assert(JSON.stringify(reread).includes("deleted-el"), "the save does NOT auto-prune dangling targets (undo may restore the element)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("\nDECK SCHEMA (0.2.0 load gate + clean break + dangling-target posture): PASS");
