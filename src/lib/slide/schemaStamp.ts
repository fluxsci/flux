// ---------------------------------------------------------------------------
// Content-derived schema stamps (manim study WP 3.0, FINAL_PLAN ruling X3). An older Flux must refuse a file it would play WRONG, and
// nothing else: so a file's version is derived from what it holds, at the one write point of each format (decks: commitDeckGeneration;
// canvases: planFigSave), and removing the last such feature lowers the stamp again. Only features an older validator or player would
// break on are registered (attached connectors, a radial stagger order); additions that merely play degraded in an older build
// (pairLag, a text halo, Stagger.spacing) are not stamped (owner decision Q8). New preset names and params keys need no stamp at all.
// Each later WP registers its detector in the same commit as its field. Pure.
// ---------------------------------------------------------------------------
import type { Deck } from "./types";
import type { Element } from "../types";
import { DECK_BASE_SCHEMA_VERSION, DECK_SCHEMA_VERSION } from "./types";
import { CANVAS_MODEL3D_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION, LEGACY_FIG_SCHEMA_VERSION } from "../project/types";
import { hasAttach } from "./attach";

/** A file feature that needs a newer format: its name (for diagnostics and gates), the version a file holding it is written as, and its test. */
export interface SchemaFeature<T> { readonly name: string; readonly version: string; has(subject: T): boolean }

/** Deck features. Registered by: WP 3.2 (attached connectors), WP 4.3 (`Stagger.by: "radial"`). */
export const DECK_FEATURES: SchemaFeature<Deck>[] = [
  // an older build would play an attached connector at its stored Design geometry while its drivers move away from it
  { name: "attach", version: DECK_SCHEMA_VERSION, has: (deck) => deck.slides.some((s) => s.elements.some(hasAttach)) },
];
/** Canvas features, over the canvas's elements (every figure on it). Registered by: model3d (0.2.0, before the manim study), WP 3.2. */
export const CANVAS_FEATURES: SchemaFeature<readonly Element[]>[] = [
  { name: "model3d", version: CANVAS_MODEL3D_SCHEMA_VERSION, has: (els) => els.some((e) => e.type === "model3d") },
  // an older Figure editor would move a box and leave its attached connector behind (and drop the field on save)
  { name: "attach", version: CANVAS_SCHEMA_VERSION, has: (els) => els.some(hasAttach) },
];

/** Numeric x.y.z order (a missing or garbled part reads 0). */
export function compareSchema(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0), pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
const stamp = <T>(base: string, subject: T, features: readonly SchemaFeature<T>[]): string =>
  features.reduce((v, f) => (compareSchema(f.version, v) > 0 && f.has(subject) ? f.version : v), base);

/** The version a deck is written as: the base, raised by every registered feature it holds. Never above DECK_SCHEMA_VERSION. */
export function deckSchemaFor(deck: Deck, features: readonly SchemaFeature<Deck>[] = DECK_FEATURES): string {
  return stamp(DECK_BASE_SCHEMA_VERSION, deck, features);
}
/** The version a canvas is written as, from the elements of every figure on it. */
export function canvasSchemaFor(elements: readonly Element[], features: readonly SchemaFeature<readonly Element[]>[] = CANVAS_FEATURES): string {
  return stamp(LEGACY_FIG_SCHEMA_VERSION, elements, features);
}

/** Decks this build may EDIT in place (the deck JSON schema's `schemaVersion` pattern, the 3D import's destination checks): 0.2 through the
 *  newest read format. ONE regex; electron/deckSchemaSupport.cjs is its CommonJS twin (verify-schema-stamp pins them equal). The migration-
 *  source regex in ops.ts migrateDeck (0.2–0.5 upgrade by a stamp) is a different question and stays as it is. */
export const DECK_EDITABLE = /^0\.[234567]\./;
export const supportsDeckSchema = (v: unknown): boolean => typeof v === "string" && DECK_EDITABLE.test(v);
/** The newest read format, re-exported where the stamp lives. */
export { DECK_SCHEMA_VERSION };
