#!/usr/bin/env -S npx tsx
// Regression: the renderer's slideBridge.exportDeck delegates to the host
// fig.exportDeck (main process) and surfaces the written path / error; and
// canExportDeck gates the Export button on that method existing (it's absent in
// the web/mem demo, present only in the desktop bridge). The Node engine itself
// is covered by verify-slide-export.ts; this covers the renderer↔host seam.
//   npx tsx scripts/verify-slide-export-bridge.ts
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { window?: unknown }).window = {}; // fileBridge() reads window.fig at call time

const { canExportDeck, exportDeck } = await import("../src/lib/project/slideBridge");
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const W = globalThis as { window: { fig?: unknown } };

// 1. no bridge method → cannot export (web/mem demo)
W.window.fig = undefined;
assert(canExportDeck() === false, "canExportDeck() false with no bridge at all");
W.window.fig = { writeText() {} };
assert(canExportDeck() === false, "canExportDeck() false when the bridge lacks exportDeck");
let threw = false;
try { await exportDeck("/r", "d1"); } catch { threw = true; }
assert(threw, "exportDeck throws when the host cannot export");

// 2. a host WITH exportDeck → delegates + returns the written path
let seen: { root: string; deckId: string } | null = null;
W.window.fig = { exportDeck: async (root: string, deckId: string) => { seen = { root, deckId }; return { ok: true, path: `${root}/exports/${deckId}.html` }; } };
assert(canExportDeck() === true, "canExportDeck() true when the bridge exposes exportDeck");
const p = await exportDeck("/proj", "deckX");
assert(seen!.root === "/proj" && seen!.deckId === "deckX", "exportDeck forwards root + deckId to the host");
assert(p === "/proj/exports/deckX.html", "exportDeck returns the host's written path");

// 3. host failure → surfaced as a thrown error message
W.window.fig = { exportDeck: async () => ({ ok: false, error: "esbuild boom" }) };
let msg = "";
try { await exportDeck("/r", "d"); } catch (e) { msg = (e as Error).message; }
assert(msg === "esbuild boom", "exportDeck surfaces the host error message");

console.log("\nSLIDE EXPORT BRIDGE REGRESSION PASSED");
