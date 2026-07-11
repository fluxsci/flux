// Live citation numbering (numeric style). A StateField in scienceTables'
// shape: it re-scans the document and publishes the key→ordinal registry
// SYNCHRONOUSLY during the transaction, so the chip widgets built in the same
// update cycle read fresh numbers (StateFields update before ViewPlugins).
//
// Perf gate: prose typing costs nothing — a rescan happens only when the
// transaction carries refreshChips (bib load/change → resolvability changed),
// or the edit could plausibly alter citations: inserted/deleted text contains
// cite-ish characters, or a change overlaps a known citation token range
// (ranges are mapped through every transaction otherwise).

import { StateField, type EditorState, type Transaction } from "@codemirror/state";
import { bibEntry } from "../scholar/bib";
import { buildCitationOrdinals } from "../scholar/citeNumbering";
import { numberingFacet } from "../scholar/numberingFacet";
import { refreshChips } from "./chips";
import { paperPerf } from "./changeGate";

// @ [ ] ; are the chars that create/split/join groups. Backtick/tilde/$ flip
// code/math MASKING — but buildCitationOrdinals masks inline spans PER LINE
// and fence markers are line-start anchored, so (WS-2 Fix 3) a masking char
// triggers a rescan only when (a) a fence marker sits on a touched line — the
// multi-line masking flip — or (b) the touched line actually carries cite-ish
// text. A backtick/tilde typed in plain prose no longer rescans the doc.
// ($ was never a trigger before — a latent staleness gap, closed here; same
// for a newline splitting/joining a fence-marker line.) In-key edits are
// caught by the range-overlap check.
const CITEISH = /[@[\];]/;
const MASKISH = /[`~$]/;
const FENCE_MARK = /^\s*(```|~~~)/m;

type Ranges = { from: number; to: number }[];

function scan(state: EditorState): Ranges {
  paperPerf.citeScans++;
  const res = buildCitationOrdinals(state.doc.toString(), (k) => !!bibEntry(k));
  // WS-4.2: publish into THIS editor's numbering instance (facet), not a
  // module global — synchronously, before the chip plugin reads it.
  state.facet(numberingFacet).publishOrdinals(res.map);
  return res.ranges;
}

function needsRescan(tr: Transaction, ranges: Ranges): boolean {
  let hit = false;
  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (hit) return;
    const ins = inserted.toString();
    const rem = tr.startState.sliceDoc(fromA, toA);
    if (CITEISH.test(ins) || CITEISH.test(rem)) {
      hit = true;
      return;
    }
    if (MASKISH.test(ins) || MASKISH.test(rem) || ins.includes("\n") || rem.includes("\n")) {
      const oldText = oldDoc.sliceString(oldDoc.lineAt(fromA).from, oldDoc.lineAt(toA).to);
      const newText = newDoc.sliceString(newDoc.lineAt(fromB).from, newDoc.lineAt(toB).to);
      if (FENCE_MARK.test(oldText) || FENCE_MARK.test(newText)) {
        hit = true;
        return;
      }
      if ((MASKISH.test(ins) || MASKISH.test(rem)) && (CITEISH.test(oldText) || CITEISH.test(newText))) {
        hit = true;
        return;
      }
    }
    for (const r of ranges) {
      if (fromA <= r.to && toA >= r.from) {
        hit = true;
        break;
      }
    }
  });
  return hit;
}

export const citeNumberField = StateField.define<Ranges>({
  create: (state) => scan(state),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(refreshChips))) return scan(tr.state);
    if (!tr.docChanged) return value;
    if (needsRescan(tr, value)) return scan(tr.state);
    // The edit can't have changed any citation — just keep the ranges current.
    return value.map((r) => ({
      from: tr.changes.mapPos(r.from, 1),
      to: tr.changes.mapPos(r.to, -1),
    }));
  },
});


