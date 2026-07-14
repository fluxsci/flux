#!/usr/bin/env -S npx tsx
// WS-4.4 (fortify plan) — a deck with a missing plot / missing morph target
// yields NON-EMPTY diagnostics and never throws (placeholders render). Tests
// the headless twin (flux-core gatherDeckPayload warnings — the same shape the
// GUI's loadDeckAssets diagnostics mirror), plus the morph resolution order:
// track-authored to.svgPath is preferred over the legacy plots/<id>.svg guess.
//   npx tsx scripts/verify-deck-diagnostics.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { gatherDeckPayload, saveDeck } from "../flux-core/slides";
import { scaffold } from "../flux-core/index";
import type { Deck } from "../src/lib/slide/types";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-deckdiag-"));
try {
  await scaffold(root, { title: "diag" });

  // A real plot the morph can point at through an EXPLICIT authored path.
  const realSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect id="a.r" width="10" height="10"/></svg>`;
  await fs.mkdir(path.join(root, "plots", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "plots", "nested", "real-target.svg"), realSvg);

  const deck = {
    schemaVersion: "0.2.0",
    id: "diag",
    title: "Diag",
    theme: "flux-dark",
    stage: { width: 640, height: 360 },
    assets: [{ id: "ghost-media", kind: "png", path: "assets/ghost.png" }], // missing on disk
    slides: [
      {
        id: "s1",
        elements: [
          {
            type: "plot",
            id: "p1",
            assetId: "missing-plot",
            x: 0,
            y: 0,
            width: 200,
            height: 150,
            rotation: 0,
            overrides: {},
            source: { svgPath: "plots/does-not-exist.svg" },
          },
        ],
        beats: [
          {
            id: "b1",
            tracks: [
              {
                id: "t-morph",
                target: "p1",
                preset: "morph",
                // authored EXPLICIT path (nested — the legacy guess would miss it)
                to: { assetId: "real-target", svgPath: "plots/nested/real-target.svg" },
                duration: 1200,
                easing: "smooth",
              },
              {
                id: "t-morph-2",
                target: "p1",
                preset: "morph",
                to: { assetId: "ghost-target" }, // no authored path, no file → warning
                duration: 1200,
                easing: "smooth",
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Deck;
  await saveDeck(root, deck);

  const { payload, warnings } = await gatherDeckPayload(root, "diag");
  assert(warnings.length >= 3, `diagnostics are NON-EMPTY (${warnings.length}): missing media + missing plot + ghost morph`);
  assert(
    warnings.some((w) => w.includes("ghost-media")),
    "missing media asset reported",
  );
  assert(
    warnings.some((w) => w.includes("missing-plot")),
    "missing plot reported",
  );
  assert(
    warnings.some((w) => w.includes("ghost-target")),
    "unresolvable morph target reported",
  );
  assert(!!payload.plots?.["real-target"], "authored to.svgPath resolved the nested morph target (no path guessing)");
  assert(payload.deck.slides.length === 1, "payload still built — no throw, placeholders render");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nDECK DIAGNOSTICS: FAIL (${failures})` : "\nDECK DIAGNOSTICS: PASS");
process.exit(failures ? 1 : 0);
