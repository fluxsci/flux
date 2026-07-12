// WS-2 Fix 1 (fortify plan): change-gating for the block-widget StateFields.
//
// embeds/tables/math rebuilt their decorations with a FULL O(doc-lines) walk on
// every docChanged — even a prose keystroke thousands of lines from any
// construct. touchesMe() is the conservative gate: a field rebuilds only when
// a change could plausibly create/destroy/alter ITS constructs; otherwise the
// existing decorations are mapped through the change (RangeSet.map keeps the
// widgets glued to their lines).
//
// Decorations stay a pure function of the document by construction: the
// predicate reads ONLY tr.changes + the documents — never the selection.
//
// Conservative contract (over-triggering is safe; under-triggering shows as a
// widget failing to appear/disappear — scripts/verify-paper-changegate.ts is
// the case battery):
//   (a) any change that inserts or removes a NEWLINE rebuilds (line structure
//       changed — covers multi-line cuts crossing a construct);
//   (b) any change whose touched lines (the FULL old lines it removed from OR
//       the FULL new lines it inserted into — single-char keystrokes never
//       contain a multi-char token, the line does) contain a trigger token
//       rebuilds;
//   (c) any change within `guardLines` of an existing decoration rebuilds
//       (edits inside/near a live construct — tables use 2: the optional
//       `: Caption {#tbl-…}` line may sit one BLANK line below the block).

import type { Transaction } from "@codemirror/state";
import type { RangeSet, RangeValue } from "@codemirror/state";

export interface GateSpec {
  /** Substrings that mark a line as construct-relevant (checked against the
   *  full old + new touched lines, not just the typed text). */
  tokens: readonly string[];
  /** Rebuild when a change lands within this many lines of an existing
   *  decoration (default 1). */
  guardLines?: number;
}

/** True iff `tr` could affect the constructs described by `spec`. */
export function touchesMe(tr: Transaction, value: RangeSet<RangeValue>, spec: GateSpec): boolean {
  const guard = spec.guardLines ?? 1;
  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  let hit = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (hit) return;
    // (a) newline inserted or removed → line structure changed.
    if (inserted.toString().includes("\n")) {
      hit = true;
      return;
    }
    const oldFromLine = oldDoc.lineAt(fromA);
    const oldToLine = oldDoc.lineAt(toA);
    if (oldFromLine.number !== oldToLine.number) {
      hit = true;
      return;
    }
    // (b) trigger tokens on the touched lines (old or new).
    const oldText = oldDoc.sliceString(oldFromLine.from, oldToLine.to);
    const newFromLine = newDoc.lineAt(fromB);
    const newToLine = newDoc.lineAt(toB);
    const newText = newDoc.sliceString(newFromLine.from, newToLine.to);
    for (const t of spec.tokens) {
      if (oldText.includes(t) || newText.includes(t)) {
        hit = true;
        return;
      }
    }
    // (c) proximity to an existing decoration (old-doc coordinates — `value`
    // has not been mapped yet).
    const gFrom = oldDoc.line(Math.max(1, oldFromLine.number - guard)).from;
    const gTo = oldDoc.line(Math.min(oldDoc.lines, oldToLine.number + guard)).to;
    value.between(gFrom, gTo, () => {
      hit = true;
      return false;
    });
  });
  return hit;
}

// Per-field build()/scan() counters — the structural perf gates assert a prose
// keystroke triggers ZERO of these (scripts/verify-paper-changegate.ts pure;
// scripts/verify-scale-paper.mjs live via window.__flux.paperPerf).
export const paperPerf = { embeds: 0, tables: 0, math: 0, citeScans: 0 };
