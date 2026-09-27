// The one automatic answer for a sync conflict on a .bib library: union the ENTRIES.
//
// Syncthing keeps the losing side of a simultaneous edit as `library.sync-conflict-…bib`.
// A .bib file is a ledger of entries keyed by citekey (and, for dedupe, by DOI / title
// signature), so "both sides" has a well-defined merge: every entry the copy has that the
// canonical file lacks is appended, through the SAME planner every other add goes through
// (DOI + signature dedupe, citekey collisions re-minted). Canonical entries are never
// modified or removed — if both machines edited the same entry, this side's revision
// stands and the archived copy still holds the other one. Pure: no I/O.
import { planAdds, appendedBib } from "./addPlan";
import { splitBibEntries, bibtexKey } from "./bibtex";
import { CONFLICT_RE } from "../project/conflictRules";

export interface BibMergePlan {
  /** The merged library text (canonical + the copy's missing entries). */
  text: string;
  /** Citekeys appended from the copy, in the copy's order. */
  added: string[];
  /** Entries of the copy already present here (by DOI, signature or key). */
  alreadyPresent: number;
  /** True when the copy contributed nothing — discarding it loses no entry. */
  nothingToMerge: boolean;
}

/** Plan the union of `mine` (canonical library.bib) and `theirs` (the conflict copy). */
export function planBibConflictMerge(mine: string, theirs: string, addedAt?: string): BibMergePlan {
  // Two copies of ONE library: the citekey is the join key across machines, so an entry
  // whose citekey already exists here IS the same record (makeCitekey suffixes a title hash,
  // so two machines minting the same key for different papers does not happen). Without
  // this, a title-only record (no DOI, no author → no dedupe signature) came back under a
  // fresh key as a duplicate. The planner then handles the rest: DOI / signature dedupe
  // for entries the other machine keyed differently, and keepDateAdded keeps the day the
  // entry actually arrived.
  const identity = (k: string) => k.normalize("NFC").toLowerCase();
  const have = new Set(splitBibEntries(mine).map((r) => bibtexKey(r)).filter((k): k is string => !!k).map(identity));
  const blocks = splitBibEntries(theirs);
  const fresh = blocks.filter((r) => { const k = bibtexKey(r); return !k || !have.has(identity(k)); });
  const sameKey = blocks.length - fresh.length;
  const plan = planAdds(mine, fresh.join("\n"), "bibtex", addedAt, { keepDateAdded: true });
  return {
    text: appendedBib(mine, plan),
    added: plan.added.map((e) => e.key),
    alreadyPresent: plan.deduped.length + sameKey,
    nothingToMerge: !plan.appendText,
  };
}

/** Where a resolved library conflict copy is kept: never deleted, renamed so the scan stops
 *  reporting it. `library.sync-conflict-20260925-204624-GGKHM53.bib` →
 *  `library.other-machine-20260925-204624-GGKHM53.bib` (the stamp + device survive). */
export function archivedConflictName(copyName: string): string {
  const m = CONFLICT_RE.exec(copyName);
  if (!m) return copyName;
  return copyName.replace(CONFLICT_RE, `.other-machine-${m[1]}-${m[2]}-${m[3]}`);
}

/** The archive folder under a FluxLib root (derived, tooling-internal). */
export const LIBRARY_CONFLICT_ARCHIVE = ".fluxlib/sync-conflicts";
