#!/usr/bin/env -S npx tsx
// P6 — the AGENT-facing export (§8.2). Scaffold a project, author a deck through
// the pure ops, drop a deck-local image asset, and run flux-core's headless
// exportDeck end-to-end: gatherDeckPayload reads the media off disk, the .html
// lands in exports/, and it's self-contained. The path a CLI/MCP agent uses.
// Run: npx tsx scripts/verify-slide-export-core.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as slides from "../flux-core/slides";
import * as slideOps from "../src/lib/slide/ops";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-export-core-"));
try {
  await core.scaffold(root, { title: "Export Core Test" });

  // author a deck through the pure ops, then save it on disk
  const deck = slideOps.createDeck({ id: "talk", title: "Defense Talk" });
  const s1 = slideOps.addSlide(deck, { name: "Results", layout: "content-figure" }).id;
  slideOps.addTextBox(deck, s1, { text: "Key result", x: 100, y: 120, width: 800, height: 100, fontSize: 48 });
  slideOps.addMath(deck, s1, { tex: "e^{i\\pi}+1=0", x: 100, y: 300, width: 400, height: 100 });
  // a deck-local image asset (written to slides/talk/assets/)
  const onePx = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await fs.mkdir(path.join(root, "slides", "talk", "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "slides", "talk", "assets", "shot.png"), onePx);
  deck.assets.push({ id: "shot", kind: "png", path: "assets/shot.png" });
  slideOps.addImageToSlide(deck, s1, { assetId: "shot", x: 950, y: 120, width: 200, height: 150 });
  await slides.saveDeck(root, deck);

  // gather → assert the image was read off disk into a data URI
  const { payload, warnings: gatherWarnings } = await slides.gatherDeckPayload(root, "talk");
  assert(gatherWarnings.length === 0, `no gather warnings for a complete deck (got: ${gatherWarnings.join("; ")})`);
  assert(payload.deck.id === "talk" && payload.deck.slides.length === 2, "payload carries the loaded deck");
  assert((payload.assets?.shot ?? "").startsWith("data:image/png;base64,"), "deck image asset gathered as a data URI off disk");

  // export → the self-contained file lands in exports/
  const res = await slides.exportDeck(root, "talk");
  assert(res.path.endsWith(path.join("exports", "talk.html")), "exports to exports/talk.html by default");
  const html = await fs.readFile(res.path, "utf8");
  assert(html.startsWith("<!doctype html>") && html.includes("FluxSlideRuntime.boot("), "emitted a bootable self-contained document");
  assert(html.includes("data:image/png;base64,iVBOR"), "the image data URI is inlined in the export");
  assert(html.includes("data:font/woff2;base64,") && !html.includes("url(fonts/"), "fonts inlined, no external font refs");
  assert(res.bytes > 80_000 && res.warnings.length === 0, `headless export is self-contained (${(res.bytes / 1024).toFixed(0)} KB)`);

  // the export was journaled (provenance, like every flux-core mutation)
  const jnl = await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8").catch(() => "");
  assert(/"action":"export_deck"/.test(jnl), "export_deck journaled");

  console.log("\nALL SLIDE-EXPORT-CORE (P6) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
