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
import { pushToast } from "../toast";

/** Unresolved conflict copies in the open project. Empty is the normal state. */
export const conflicts = writable<SyncConflict[]>([]);
/** True while the resolver panel is open. */
export const conflictsOpen = writable(false);
/** Bumped whenever a scan lands, so views can react without diffing the list. */
export const conflictsScanned = writable(0);

let scanning = false;

/** Re-scan the open project. Safe to call often — overlapping calls collapse. */
export async function refreshConflicts(root: string | null): Promise<SyncConflict[]> {
  const fb = fileBridge();
  if (!root || !fb?.conflictsScan) {
    conflicts.set([]);
    return [];
  }
  if (scanning) return get(conflicts);
  scanning = true;
  try {
    const found = (await fb.conflictsScan(root)) ?? [];
    conflicts.set(found);
    conflictsScanned.update((n) => n + 1);
    return found;
  } catch {
    return get(conflicts); // a failed scan must never clear a standing warning
  } finally {
    scanning = false;
  }
}

export type ConflictAction = "keepMine" | "keepTheirs" | "merge";

/** Apply one resolution. Returns null on success, else a message for the caller to show.
 *  Every path ends with the conflict copy deleted — see the header. */
export async function resolveConflict(
  root: string,
  c: SyncConflict,
  action: ConflictAction,
): Promise<string | null> {
  const fb = fileBridge();
  if (!fb?.remove) return "this build cannot delete files";
  const copyAbs = joinPath(root, c.rel);
  const baseAbs = joinPath(root, c.base);
  try {
    if (action === "keepTheirs") {
      // Byte copy, not readText/writeText: a conflict can be any file in the project,
      // including binary plot assets and PDFs.
      const bytes = new Uint8Array(await fb.readFile(copyAbs));
      await fb.writeFile(baseAbs, bytes);
    } else if (action === "merge") {
      if (!isMergeableConflict(c.rel)) return "only append-only .ndjson ledgers can be merged";
      const mine = c.baseExists ? await fb.readText(baseAbs) : "";
      const theirs = await fb.readText(copyAbs);
      await fb.writeText(baseAbs, mergeNdjson(mine, theirs));
    }
    await fb.remove(copyAbs);
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** Resolve every conflict whose two sides are byte-identical — nothing was lost, so
 *  discarding the copy is the whole answer. Returns how many were cleared. */
export async function resolveIdentical(root: string): Promise<number> {
  let n = 0;
  for (const c of get(conflicts)) {
    if (!c.identical) continue;
    if ((await resolveConflict(root, c, "keepMine")) === null) n++;
  }
  if (n) await refreshConflicts(root);
  return n;
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
        : "Two machines edited the same file. Nothing was deleted; pick which side wins.",
    action: { label: "Resolve", run: () => conflictsOpen.set(true) },
  });
  conflictsOpen.set(true);
}
