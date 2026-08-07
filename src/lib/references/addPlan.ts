// The single source of truth for "add these BibTeX entries to a library.bib" — the
// dedupe + rekey decision that BOTH engines (GUI fluxlibBridge, Node flux-core/fluxlib)
// used to carry as byte-identical copies. Extracting it here means an import PREVIEW
// (planAdds without writing) is provably the same decision as the outcome (planAdds
// then append plan.appendText), so 2.4's "N new · M merged · K renamed" report can
// never drift from what actually lands.
//
// Pure: no I/O, no locks. Callers own reading library.bib under the "library" lock and
// writing `currentBibText + sep + plan.appendText` back atomically.
import type { RefEntry } from "./types";
import { splitBibEntries, lightEntry, bibtexKey, rekeyBibtex, stampDateAdded } from "./bibtex";
import { makeCitekey, dupeSignature } from "./citekey";

export type AddAction = "new" | "merged";

export interface PlannedAdd {
  action: AddAction;
  key: string; // final citekey (existing key when merged; assigned/kept when new)
  entry: RefEntry; // lightEntry carrying the final key (+ rekeyed `raw` when new)
  originalKey: string | null; // the incoming block's own citekey, before any rekey
  renamed: boolean; // new AND the assigned key differs from originalKey (collision-avoided)
  mergedInto: string | null; // merged → the existing key it collapsed onto
  reason: "doi" | "signature" | null; // why it merged
  hasDoi: boolean;
}

export interface AddPlan {
  planned: PlannedAdd[]; // one node per incoming entry, in order
  // AddResult parity (so both engines return the same shape they always did):
  added: RefEntry[]; // action==="new" (with rekeyed raw)
  deduped: RefEntry[]; // action==="merged" (existing key)
  keys: string[]; // final key for EVERY incoming entry, in order
  appendText: string; // the raw blocks to append to library.bib ("" when nothing new)
  counts: { total: number; new: number; merged: number; renamed: number; withDoi: number };
}

/**
 * Plan the addition of `incomingBibText` to a library whose current contents are
 * `currentBibText`. `source` mirrors the existing contract: "bibtex" keeps a well-formed
 * incoming citekey when it's free; "doi" (single fetched entry) always mints a fresh one.
 *
 * Dedup order matches the shipped logic exactly: DOI first, then a normalized
 * title+year+author signature (so a paper added without a DOI and re-added with one — or
 * vice-versa — collapses to a single citekey), including WITHIN the incoming batch.
 *
 * Every NEW entry is stamped with a `dateadded` field (one shared timestamp per plan —
 * a bulk import is one moment of arrival). Merged entries keep their existing stamp.
 * `addedAt` exists for deterministic tests; callers normally omit it.
 */
export function planAdds(
  currentBibText: string,
  incomingBibText: string,
  source: "doi" | "bibtex" = "bibtex",
  addedAt?: string,
): AddPlan {
  const stamp = addedAt ?? new Date().toISOString();
  const taken = new Set<string>();
  const doiToKey = new Map<string, string>();
  const sigToKey = new Map<string, string>();
  for (const r of splitBibEntries(currentBibText)) {
    const k = bibtexKey(r);
    if (k) taken.add(k);
    const e = lightEntry(r);
    if (e.doi) doiToKey.set(e.doi.toLowerCase(), k || e.key);
    const sig = dupeSignature(e);
    if (sig && !sigToKey.has(sig)) sigToKey.set(sig, k || e.key);
  }

  const planned: PlannedAdd[] = [];
  const added: RefEntry[] = [];
  const deduped: RefEntry[] = [];
  const keys: string[] = [];
  const appendBuf: string[] = [];

  for (const raw of splitBibEntries(incomingBibText)) {
    const e = lightEntry(raw);
    const doi = e.doi?.toLowerCase();
    const orig = bibtexKey(raw);

    if (doi && doiToKey.has(doi)) {
      const k = doiToKey.get(doi) as string;
      const entry: RefEntry = { ...e, key: k };
      deduped.push(entry);
      keys.push(k);
      planned.push({ action: "merged", key: k, entry, originalKey: orig, renamed: false, mergedInto: k, reason: "doi", hasDoi: true });
      continue;
    }
    const sig = dupeSignature(e);
    if (sig && sigToKey.has(sig)) {
      const k = sigToKey.get(sig) as string;
      if (doi) doiToKey.set(doi, k);
      const entry: RefEntry = { ...e, key: k };
      deduped.push(entry);
      keys.push(k);
      planned.push({ action: "merged", key: k, entry, originalKey: orig, renamed: false, mergedInto: k, reason: "signature", hasDoi: !!doi });
      continue;
    }

    const key = source === "bibtex" && orig && !taken.has(orig) ? orig : makeCitekey(e, taken);
    const outRaw = stampDateAdded(rekeyBibtex(raw, key), stamp);
    taken.add(key);
    if (doi) doiToKey.set(doi, key);
    if (sig && !sigToKey.has(sig)) sigToKey.set(sig, key);
    // dateAdded mirrors what the raw actually carries (a field-less `@misc{key}` can't take the stamp).
    const entry: RefEntry = { ...e, key, raw: outRaw, dateAdded: /\bdateadded\s*=/i.test(outRaw) ? stamp : undefined };
    added.push(entry);
    keys.push(key);
    appendBuf.push(outRaw);
    planned.push({ action: "new", key, entry, originalKey: orig, renamed: !!orig && orig !== key, mergedInto: null, reason: null, hasDoi: !!doi });
  }

  const counts = {
    total: planned.length,
    new: added.length,
    merged: deduped.length,
    renamed: planned.filter((p) => p.renamed).length,
    withDoi: planned.filter((p) => p.hasDoi).length,
  };
  return { planned, added, deduped, keys, appendText: appendBuf.join("\n\n"), counts };
}

/** Join a plan's append text onto existing library.bib content (the write both engines do). */
export function appendedBib(currentBibText: string, plan: AddPlan): string {
  if (!plan.appendText) return currentBibText;
  const sep = currentBibText && !currentBibText.endsWith("\n") ? "\n" : "";
  return currentBibText + sep + plan.appendText + "\n";
}
