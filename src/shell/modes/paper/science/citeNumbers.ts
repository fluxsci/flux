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
import {
  buildCitationOrdinals,
  setCitationOrdinals,
  getCitationStyle,
} from "../scholar/citeNumbering";
import { refreshChips } from "./chips";

// @ [ ] ; are the chars that create/split/join groups; backtick/tilde flip the
// code masking that decides whether a token counts at all. In-key edits are
// caught by the range-overlap check instead.
const CITEISH = /[@[\];`~]/;

type Ranges = { from: number; to: number }[];

function scan(state: EditorState): Ranges {
  const res = buildCitationOrdinals(state.doc.toString(), (k) => !!bibEntry(k));
  setCitationOrdinals(res.map);
  return res.ranges;
}

function needsRescan(tr: Transaction, ranges: Ranges): boolean {
  let hit = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (hit) return;
    if (CITEISH.test(inserted.toString())) hit = true;
    else if (CITEISH.test(tr.startState.sliceDoc(fromA, toA))) hit = true;
    else
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

export { getCitationStyle };
