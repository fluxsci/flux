import { assertBibValid } from "./bibScanner";
import { planAdds } from "./addPlan";
export interface BibRemoval { before: string; after: string; keys: string[] }
/** Restore removed records in their original relative order, preserving later
 * edits. Exact inverse when unchanged; identity conflicts require user review. */
export function restoreBibRemoval(current: string, receipt: BibRemoval): string {
  const before = assertBibValid(receipt.before).records.filter(r => r.kind === "entry");
  const wanted = new Set(receipt.keys);
  const removed = before.filter(r => wanted.has(r.key!));
  const raw = removed.map(r => receipt.before.slice(r.start,r.end)).join("\n\n");
  planAdds(current, raw, "bibtex", undefined, {restore:true}); // reject intervening key conflicts
  if (current === receipt.after) return receipt.before;
  let out = current;
  for (const record of removed) {
    const live = assertBibValid(out).records.filter(r => r.kind === "entry");
    const following = before.slice(before.indexOf(record)+1).map(r=>r.key);
    const anchor = following.map(key=>live.find(r=>r.key === key)).find(Boolean);
    const text = receipt.before.slice(record.start,record.end);
    if (anchor) out = out.slice(0,anchor.start) + text + "\n\n" + out.slice(anchor.start);
    else {
      const preceding = before.slice(0,before.indexOf(record)).reverse().map(r=>r.key);
      const previous = preceding.map(key=>live.find(r=>r.key === key)).find(Boolean);
      if (previous) out = out.slice(0,previous.end) + "\n\n" + text + out.slice(previous.end);
      else out += (out.endsWith("\n") ? "\n" : "\n\n") + text + "\n";
    }
  }
  return out;
}
