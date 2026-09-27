// ---------------------------------------------------------------------------
// Sync conflicts — detection state + the three resolutions.
//
// A sync tool (Syncthing, per notes/SYNC_OPTIONS.md) never destroys the losing side of a
// simultaneous edit: it renames it to `<base>.sync-conflict-<date>-<time>-<device>.<ext>`
// and moves on. That is the right thing to do and the wrong thing to leave alone — the
// copy is a second version of your work that drifts further from both sides every day,
// and it is invisible unless something goes looking.
//
// So Flux surfaces them deliberately (the watcher routes them to their own subsystem
// instead of into the document list) and keeps a banner up until every one is resolved.
// "Resolved" is usually one click: most conflicts are byte-identical because both
// machines saved the same text, and the scan says so up front.
//
// Resolution never invents a merge for content it cannot reason about. Three actions:
//   keepMine    the copy is discarded; the file you have wins
//   keepTheirs  the copy replaces the file, then is discarded
//   merge       append-only NDJSON ledgers ONLY — union the lines (order is not meaning)
// Every one ends with the conflict copy gone, because a resolution that leaves the file
// behind is not a resolution.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import { fileBridge, joinPath } from "./types";
import { isMergeableConflict, mergeNdjson, type SyncConflict } from "./conflictRules";
import { planBibConflictMerge } from "../references/bibConflict";
import { pushToast } from "../toast";

// The machine-global reference library (FluxLib) can sync between machines too, and its
// library.bib is the file most likely to conflict — both machines add papers. From the
// 2026-09-21 fortification to 09-26 every library write REFUSED while a conflict copy sat
// beside library.bib (canonical.ts assertNoCanonicalConflict) and nothing showed it: the
// only symptom was the assign inbox reporting "network unavailable" for a day. Now the
// library.bib copy merges itself (union of entries, copy archived under
// .fluxlib/sync-conflicts/ — never deleted) at startup, on Library open and before any
// library write; other library files (organize.json) reach the same banner as project
// conflicts. The scan covers FluxLib's top level whether or not a project is open.

/** Unresolved conflict copies in the open project and the reference library. Empty is the normal state. */
export const conflicts = writable<SyncConflict[]>([]);
/** True while the resolver panel is open. */
export const conflictsOpen = writable(false);
/** Bumped whenever a scan lands, so views can react without diffing the list. */
export const conflictsScanned = writable(0);

let scanning = false;

/** The reference library's conflict copies: its top level only (library.bib, fluxlib.json)
 *  plus one level (.fluxlib/organize.json) — never the ~2,000 items/ dirs. A copy of
 *  library.bib is resolved on the spot — entry union, copy archived, one toast saying what
 *  came in (owner 2026-09-26: the library must work seamlessly on this machine; a banner
 *  asking to confirm a lossless merge is friction, and a refused write is a broken importer).
 *  Anything else (organize.json) still goes to the banner. */
async function scanLibraryConflicts(): Promise<SyncConflict[]> {
  const fb = fileBridge();
  if (!fb?.conflictsScan) return [];
  const { resolveFluxLibPath, mergeLibraryConflictCopies } = await import("../references/fluxlibBridge");
  const lib = await resolveFluxLibPath();
  if (!lib) return [];
  try {
    for (const m of await mergeLibraryConflictCopies(lib)) {
      const n = m.added.length;
      pushToast(n ? "success" : "info", n ? `Merged ${n} reference${n === 1 ? "" : "s"} from a synced copy of your library` : "Cleared a synced copy of your library", {
        detail: `${m.copy}: ${n} added, ${m.alreadyPresent} already here — nothing lost. The copy is archived at ${m.archivedTo}.`,
        ttl: 8000,
      });
    }
  } catch (e) {
    pushToast("error", "Could not merge a synced copy of your library", { detail: String((e as Error)?.message ?? e) });
  }
  return ((await fb.conflictsScan(lib, { maxDepth: 1 })) ?? []).map((c) => ({ ...c, libraryRoot: lib }));
}

/** Re-scan the open project (when there is one) and the reference library. Safe to call
 *  often — overlapping calls collapse. */
export async function refreshConflicts(root: string | null): Promise<SyncConflict[]> {
  const fb = fileBridge();
  if (!fb?.conflictsScan) {
    conflicts.set([]);
    return [];
  }
  if (scanning) return get(conflicts);
  scanning = true;
  try {
    const [project, library] = await Promise.all([root ? fb.conflictsScan(root) : Promise.resolve([]), scanLibraryConflicts()]);
    const found = [...(project ?? []), ...library];
    conflicts.set(found);
    conflictsScanned.update((n) => n + 1);
    return found;
  } catch {
    return get(conflicts); // a failed scan must never clear a standing warning
  } finally {
    scanning = false;
  }
}

/** True when an unresolved conflict copy sits beside the reference library's library.bib —
 *  every library write refuses until it is resolved (the assign scan reports this by name). */
export function hasLibraryBibConflict(): boolean {
  return get(conflicts).some((c) => !!c.libraryRoot && /(^|\/)library\.bib$/.test(c.base));
}

export type ConflictAction = "keepMine" | "keepTheirs" | "merge";

/** Apply one resolution. Returns null on success, else a message for the caller to show.
 *  Every path ends with the conflict copy deleted — see the header. */
export async function resolveConflict(
  root: string | null,
  c: SyncConflict,
  action: ConflictAction,
): Promise<string | null> {
  const fb = fileBridge();
  if (!fb?.remove) return "this build cannot delete files";
  if (c.libraryRoot) {
    // Reference library: locked, canonical-checked, and the copy is archived, not deleted.
    try {
      const { resolveLibraryConflict } = await import("../references/fluxlibBridge");
      const r = await resolveLibraryConflict(c.libraryRoot, c, action);
      if (action === "merge" && r.added.length) {
        pushToast("success", `Merged ${r.added.length} reference${r.added.length === 1 ? "" : "s"} from device ${c.device}`, {
          detail: `${r.alreadyPresent} already here. The copy is archived at ${r.archivedTo}.`,
        });
      }
      return null;
    } catch (e) {
      return String((e as Error)?.message ?? e);
    }
  }
  if (!root) return "no project is open";
  const copyAbs = joinPath(root, c.rel);
  const baseAbs = joinPath(root, c.base);
  try {
    if (action === "keepTheirs") {
      // Byte copy, not readText/writeText: a conflict can be any file in the project,
      // including binary plot assets and PDFs.
      const bytes = new Uint8Array(await fb.readFile(copyAbs));
      await fb.writeFile(baseAbs, bytes);
    } else if (action === "merge") {
      if (!isMergeableConflict(c.rel)) return "only append-only .ndjson ledgers and .bib libraries can be merged";
      const mine = c.baseExists ? await fb.readText(baseAbs) : "";
      const theirs = await fb.readText(copyAbs);
      // A project's references/library.bib is a materialized subset of FluxLib: union its
      // entries the same way (the planner dedupes by DOI / signature, keeps free citekeys).
      await fb.writeText(baseAbs, /\.bib$/i.test(c.base) ? planBibConflictMerge(mine, theirs).text : mergeNdjson(mine, theirs));
    }
    await fb.remove(copyAbs);
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** Resolve every conflict whose two sides are byte-identical — nothing was lost, so
 *  discarding the copy is the whole answer. Returns how many were cleared. */
export async function resolveIdentical(root: string | null): Promise<number> {
  let n = 0;
  for (const c of get(conflicts)) {
    if (!c.identical) continue;
    if ((await resolveConflict(root, c, "keepMine")) === null) n++;
  }
  if (n) await refreshConflicts(root);
  return n;
}

/** App start (no project yet): the reference library can have conflicted while Flux was
 *  closed, exactly like a project. Same scan, same banner. */
export async function conflictsOnStartup(): Promise<void> {
  return conflictsOnProjectOpen(null);
}

/** Wire a project open: scan now, and report anything found. */
export async function conflictsOnProjectOpen(root: string | null): Promise<void> {
  const found = await refreshConflicts(root);
  if (!found.length) return;
  const identical = found.filter((c) => c.identical).length;
  // "error" level, deliberately: this is sticky by default and reads as something to
  // act on, which is exactly the standing this needs (an "info" would be dismissed).
  pushToast("error", `${found.length} sync conflict${found.length === 1 ? "" : "s"} to resolve`, {
    ttl: 0,
    detail:
      identical === found.length
        ? "Both sides are identical — nothing was lost. Discarding the copies clears this."
        : found.some((c) => c.libraryRoot)
          ? "Two machines edited your reference library. Nothing was deleted; merging keeps both machines' entries. Until it is resolved, no new references can be added."
          : "Two machines edited the same file. Nothing was deleted; pick which side wins.",
    action: { label: "Resolve", run: () => conflictsOpen.set(true) },
  });
  conflictsOpen.set(true);
}
