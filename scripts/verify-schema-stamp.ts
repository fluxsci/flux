#!/usr/bin/env -S npx tsx
// WP 3.0 (manim study, FINAL_PLAN ruling X3): content-derived schema stamps. A deck is written as 0.7.0 only while it holds a feature an
// older build would break on, a canvas as 0.3.0 likewise (0.2.0 for a 3D model, 0.1.0 legacy); everything else keeps its bytes. The read
// guards understand 0.7.0 / 0.3.0 and refuse anything newer.
//   npx tsx scripts/verify-schema-stamp.ts
import { promises as fs, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";
import { DECK_SCHEMA_VERSION, DECK_BASE_SCHEMA_VERSION, type Deck } from "../src/lib/slide/types";
import { DECK_FEATURES, CANVAS_FEATURES, deckSchemaFor, canvasSchemaFor, compareSchema, supportsDeckSchema, DECK_EDITABLE, type SchemaFeature } from "../src/lib/slide/schemaStamp";
import { CANVAS_SCHEMA_VERSION, CANVAS_MODEL3D_SCHEMA_VERSION, LEGACY_FIG_SCHEMA_VERSION, isNewerSchema } from "../src/lib/project/types";
import { createDeck, migrateDeck, addSlideText } from "../src/lib/slide/ops";
import { validateDeckFile } from "../src/lib/project/validate";
import { scaffold } from "../flux-core/index";
import { saveDeck, loadDeck } from "../flux-core/slides";
import type { Element } from "../src/lib/types";

const h = harness("verify-schema-stamp");
const require = createRequire(import.meta.url);
const twin = require("../electron/deckSchemaSupport.cjs") as { DECK_EDITABLE: RegExp; supportsDeckSchema(v: unknown): boolean };

h.section("constants and the pure stamp");
h.ok(DECK_SCHEMA_VERSION === "0.7.0" && DECK_BASE_SCHEMA_VERSION === "0.6.0", "decks: read 0.7.0, write 0.6.0 unless a feature says otherwise");
h.ok(CANVAS_SCHEMA_VERSION === "0.3.0" && CANVAS_MODEL3D_SCHEMA_VERSION === "0.2.0" && LEGACY_FIG_SCHEMA_VERSION === "0.1.0", "canvases: read 0.3.0, write 0.2.0 for a 3D model, 0.1.0 otherwise");
h.ok(compareSchema("0.7.0", "0.6.0") > 0 && compareSchema("0.6.0", "0.6.0") === 0 && compareSchema("0.10.0", "0.9.0") > 0, "versions compare numerically (0.10 > 0.9)");
const deck = createDeck({ id: "d", title: "plain" });
h.ok(deck.schemaVersion === DECK_BASE_SCHEMA_VERSION && deckSchemaFor(deck) === DECK_BASE_SCHEMA_VERSION, "createDeck writes the base format, and a featureless deck stamps it");
const marker: SchemaFeature<Deck> = { name: "test-marker", version: "0.7.0", has: (d) => d.title.includes("[marker]") };
h.ok(deckSchemaFor({ ...deck, title: "has [marker]" }, [marker]) === "0.7.0" && deckSchemaFor(deck, [marker]) === "0.6.0", "a registered feature raises the stamp; without it the base stays");
h.ok(deckSchemaFor({ ...deck, title: "has [marker]" }, [{ ...marker, version: "0.5.0" }]) === "0.6.0", "a feature never LOWERS the stamp below the base");
for (const v of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"]) h.ok(migrateDeck({ ...structuredClone(deck), schemaVersion: v }).schemaVersion === DECK_BASE_SCHEMA_VERSION, `migrateDeck stamps ${v} up to the base format`);
h.ok(migrateDeck({ ...structuredClone(deck), schemaVersion: "0.7.0" }).schemaVersion === "0.7.0", "migrateDeck leaves a 0.7.0 deck alone (its migration-source regex is unchanged)");
h.ok(DECK_FEATURES.every((f) => compareSchema(f.version, DECK_SCHEMA_VERSION) <= 0) && CANVAS_FEATURES.every((f) => compareSchema(f.version, CANVAS_SCHEMA_VERSION) <= 0), "no registered feature stamps above what this build reads");
const els = (types: string[]) => types.map((type, i) => ({ id: `e${i}`, type }) as unknown as Element);
h.ok(canvasSchemaFor(els(["rect", "text"])) === "0.1.0" && canvasSchemaFor(els(["rect", "model3d"])) === "0.2.0" && canvasSchemaFor([]) === "0.1.0", "canvases stamp by content: legacy 0.1.0, a 3D model 0.2.0");

h.section("accept checks: one regex, its CommonJS twin");
h.ok(String(DECK_EDITABLE) === String(twin.DECK_EDITABLE), "electron/deckSchemaSupport.cjs is the same regex as schemaStamp.ts DECK_EDITABLE");
for (const [v, want] of [["0.2.0", true], ["0.6.0", true], ["0.7.0", true], ["0.7.3", true], ["0.8.0", false], ["0.1.0", false], ["1.7.0", false], [7, false]] as const)
  h.ok(supportsDeckSchema(v) === want && twin.supportsDeckSchema(v) === want, `editable ${JSON.stringify(v)}: ${want}`);

h.section("the write point and the read guards, on disk");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-schema-stamp-"));
try {
  await scaffold(root, { title: "stamp" });
  const d = createDeck({ id: "plain", title: "Plain" });
  addSlideText(d, d.slides[0].id, { text: "hi", x: 10, y: 10 });
  await saveDeck(root, d);
  const file = path.join(root, "slides", "plain", "deck.json"), first = await fs.readFile(file, "utf8");
  h.ok(JSON.parse(first).schemaVersion === "0.6.0", "a featureless deck is written as 0.6.0");
  await saveDeck(root, await loadDeck(root, "plain"));
  h.ok(await fs.readFile(file, "utf8") === first, "...and a load + save round trip is byte-identical (commitDeckGeneration)");
  // a feature registered in the live table reaches the one write point, and removing the content lowers the stamp again
  DECK_FEATURES.push(marker);
  try {
    const m = await loadDeck(root, "plain"); m.title = "Plain [marker]";
    await saveDeck(root, m);
    h.ok(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion === "0.7.0", "a deck holding a registered feature is written as 0.7.0");
    const reread = await loadDeck(root, "plain");
    h.ok(reread.schemaVersion === "0.7.0" && validateDeckFile(reread).length === 0, "a 0.7.0 deck passes the read guard and the bundled validator (flux-core loadDeck)");
    reread.title = "Plain";
    await saveDeck(root, reread);
    h.ok(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion === "0.6.0", "removing the feature lowers the stamp again (an exact derivation, not a ratchet)");
  } finally { DECK_FEATURES.splice(DECK_FEATURES.indexOf(marker), 1); }
  // a deck newer than this build is refused, bytes untouched
  const raw = JSON.parse(first); raw.schemaVersion = "0.8.0"; await fs.writeFile(file, JSON.stringify(raw));
  const newer = await fs.readFile(file, "utf8");
  let refused = false; try { await loadDeck(root, "plain"); } catch { refused = true; }
  h.ok(refused && await fs.readFile(file, "utf8") === newer && isNewerSchema("0.8.0", DECK_SCHEMA_VERSION), "a 0.8.0 deck is refused and never rewritten");
} finally { await fs.rm(root, { recursive: true, force: true }); }

h.section("source: every version regex is one of the sanctioned ones");
// The deck version regexes the codebase may hold: the editable check (one regex + its CJS twin), the JSON schema pattern (a string), and
// migrateDeck's migration SOURCE (0.2-0.5 upgrade by a stamp). Anything else re-introduces a per-site copy that drifts.
const SANCTIONED = new Map([
  ["src/lib/slide/schemaStamp.ts", 1], ["electron/deckSchemaSupport.cjs", 1], ["src/lib/slide/ops.ts", 1],
]);
const scan = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  if (statSync(p).isDirectory()) return n === "node_modules" || n.startsWith(".") ? [] : scan(p);
  return /\.(ts|js|cjs|mjs|svelte)$/.test(n) && !n.endsWith(".gen.js") ? [p] : [];
});
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const hits = new Map<string, number>();
for (const f of ["src", "flux-core", "electron"].flatMap((d) => scan(path.join(repo, d)))) {
  const n = (readFileSync(f, "utf8").match(/\/\^0\\\.\[\d+\]\\\.\//g) ?? []).length;
  if (n) hits.set(path.relative(repo, f), n);
}
h.ok([...hits].every(([f, n]) => SANCTIONED.get(f) === n) && [...SANCTIONED].every(([f]) => hits.has(f)), `the only deck version regex literals are the sanctioned ones (${[...hits].map(([f, n]) => `${f}×${n}`).join(", ")})`);
h.ok(/pattern: "\^0\\\\\.\[234567\]\\\\\."/.test(readFileSync(path.join(repo, "src/lib/project/schemas.ts"), "utf8")), "the deck JSON schema's schemaVersion pattern accepts 0.2-0.7");

await h.done();
