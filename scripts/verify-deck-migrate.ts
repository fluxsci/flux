#!/usr/bin/env -S npx tsx
// WS-4.4 (fortify plan) — normalizeDeck is THE deck-load chokepoint: legacy
// `type:"svg"` elements become semantic plots, track ids backfill, and running
// it twice is a no-op (idempotent). Every seam (GUI slideBridge.readDeck,
// store.loadDeckModel, flux-core loadDeck) routes through it.
//   npx tsx scripts/verify-deck-migrate.ts

import { normalizeDeck } from "../src/lib/slide/ops";
import type { Deck } from "../src/lib/slide/types";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const legacy = {
  schemaVersion: "0.1.0",
  id: "deck1",
  title: "T",
  theme: "flexoki",
  stage: { width: 1280, height: 720 },
  assets: [{ id: "old-svg", kind: "svg", path: "assets/old-svg.svg" }],
  slides: [
    {
      id: "s1",
      elements: [
        { type: "svg", id: "e1", assetId: "old-svg", x: 0, y: 0, width: 100, height: 80, rotation: 0 },
        { type: "rect", id: "e2", x: 10, y: 10, width: 50, height: 40, rotation: 0, fill: "#000", stroke: "#000", strokeWidth: 1, cornerRadius: 0 },
      ],
      beats: [
        {
          id: "b1",
          tracks: [
            { target: "e1", preset: "fade-in", duration: 300, easing: "smooth" }, // NO id (pre-Track.id deck)
            { id: "trk_keep", target: "e2", preset: "fade-in", duration: 300, easing: "smooth" },
          ],
        },
      ],
    },
  ],
} as unknown as Deck;

const d = normalizeDeck(legacy);
assert(d === legacy, "normalizeDeck mutates in place and returns the deck");
const e1 = d.slides[0].elements[0] as { type: string; overrides?: unknown; source?: { svgPath: string } };
assert(e1.type === "plot", 'legacy type:"svg" element became a semantic plot');
assert(!!e1.overrides, "…with an overrides bag");
assert(e1.source?.svgPath === "slides/deck1/assets/old-svg.svg", `…and a deck-local source path (${e1.source?.svgPath})`);
const tracks = d.slides[0].beats[0].tracks;
assert(!!tracks[0].id && tracks[0].id.length > 0, "missing track id backfilled");
assert(tracks[1].id === "trk_keep", "existing track id untouched");

// idempotence: a second run changes NOTHING (byte-identical JSON)
const once = JSON.stringify(d);
normalizeDeck(d);
assert(JSON.stringify(d) === once, "normalizeDeck twice is a no-op (idempotent)");

// a modern deck passes through untouched
const modern = JSON.parse(once) as Deck;
const before = JSON.stringify(modern);
normalizeDeck(modern);
assert(JSON.stringify(modern) === before, "an already-current deck is untouched");

console.log(failures ? `\nDECK MIGRATE: FAIL (${failures})` : "\nDECK MIGRATE: PASS");
process.exit(failures ? 1 : 0);
