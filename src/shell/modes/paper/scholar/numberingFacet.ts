// ---------------------------------------------------------------------------
// WS-4.2 (fortify plan): per-editor numbering state. The citation-ordinal,
// table-number and equation-number registries used to be MODULE GLOBALS —
// written synchronously by the citeNumbers/tables/math StateFields, read by
// chip widgets and margin views. One instance of this record now rides each
// editor's extension tree as a Facet value; PaperMode owns the instance and
// republishes to its margin surfaces through the stores in the owner handle.
//
// Ordinals publish synchronously before the chip plugin (numeric chips never
// render stale numbers), preserved structurally: the WRITER fields mutate the
// instance during their
// own StateField update, and citeNumberField still sits before scienceChips in
// buildExtensions — chips read fresh numbers in the same transaction.
// ---------------------------------------------------------------------------

import { Facet } from "@codemirror/state";
import { writable, type Writable } from "svelte/store";
import type { CitationStyle } from "./citeNumbering";

export interface PaperNumbering {
  /** Citation key → appearance ordinal (numeric style). */
  ordinals: Map<string, number>;
  style: CitationStyle;
  /** Labeled-table numbers by appearance ({#tbl-…}). */
  tbl: Map<string, number>;
  /** Labeled-table doc positions + captions (written with `tbl` in the same
   *  tables.ts build): hover cards, @tbl completion, and jump-to-table read
   *  these — a table lives in the DOCUMENT, so "activate" scrolls the editor
   *  there instead of opening Figure mode. */
  tblMeta: Map<string, { pos: number; caption: string | null }>;
  /** Labeled-equation numbers by appearance ({#eq-…}). */
  eq: Map<string, number>;
  /** Labeled-equation doc positions (math.ts build) — jump-to-equation. */
  eqPos: Map<string, number>;
  /** Equality-guarded Svelte republication for margin surfaces (badges, the
   *  group editor) — the writers call this; the OWNER (PaperMode) wires it. */
  publishOrdinals(next: Map<string, number>): void;
}

/** Owner handle: the per-editor instance + the reactive faces margin views
 *  consume (threaded through the margin host, NOT module imports). */
export interface PaperNumberingHandle {
  instance: PaperNumbering;
  ordinalsStore: Writable<Map<string, number>>;
  styleStore: Writable<CitationStyle>;
  setStyle(style: CitationStyle): void;
}

export function createPaperNumbering(): PaperNumberingHandle {
  const ordinalsStore = writable<Map<string, number>>(new Map());
  const styleStore = writable<CitationStyle>("author-year");
  const instance: PaperNumbering = {
    ordinals: new Map(),
    style: "author-year",
    tbl: new Map(),
    tblMeta: new Map(),
    eq: new Map(),
    eqPos: new Map(),
    publishOrdinals(next) {
      // Equality guard (the old setCitationOrdinals contract): chips read the
      // instance synchronously; Svelte subscribers only wake on real change.
      if (next.size === instance.ordinals.size) {
        let same = true;
        for (const [k, v] of next)
          if (instance.ordinals.get(k) !== v) {
            same = false;
            break;
          }
        if (same) return;
      }
      instance.ordinals = next;
      ordinalsStore.set(next);
    },
  };
  return {
    instance,
    ordinalsStore,
    styleStore,
    setStyle(style) {
      instance.style = style;
      styleStore.set(style);
    },
  };
}

/** Absent facet (hermetic tests composing single fields) → an inert instance. */
const FALLBACK: PaperNumbering = {
  ordinals: new Map(),
  style: "author-year",
  tbl: new Map(),
  tblMeta: new Map(),
  eq: new Map(),
  eqPos: new Map(),
  publishOrdinals(next) {
    FALLBACK.ordinals = next;
  },
};

export const numberingFacet = Facet.define<PaperNumbering, PaperNumbering>({
  combine: (values) => values[0] ?? FALLBACK,
});
