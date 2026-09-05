// F1 file-watch live reload (renderer half). Subscribes to the Electron watcher's
// `fs:changed` events and non-destructively reloads the affected subsystem:
//   fig/ + plots/   → bump figRevision (figures/plots re-read live)
//   references/     → bump bibRevision (autocomplete + hover cards refresh)
//   manuscript/**   → signal the Paper editor to reload the doc IF it isn't dirty
//                     (PaperMode never clobbers unsaved work — see its handler)
//   slides/         → bump deckRevision (SlideMode reloads the deck if clean)  [W10]
//   fluxlib         → bump fluxLibRevision (Library/Reader/@-refs re-pull)      [W10]
//   plots/_dissections/ → bump dissectionsRevision (open Dissect viewer re-lists)
//
// The Electron main process already skips the app's own writes, so this only
// fires for genuine external (agent / analysis-script) edits.

import { writable } from "svelte/store";
import { bumpFigRevision, bumpBibRevision, bumpDeckRevision, bumpDissections } from "../../shell/scholar/revisions";
import { bumpFluxLib, bumpAssignInbox, bumpZoteroBib } from "../references/revision";
import { invalidateEnrichCache } from "../references/fluxlibBridge";
import { refreshConflicts } from "./conflicts";

export interface FsChange {
  subsystem: string;
  path: string;
}

/** External manuscript change → PaperMode reloads the doc if it is clean.
 *  Context/ doc changes ride the same signal (same handler, same protections). */
export const externalManuscriptChange = writable<(FsChange & { n: number }) | null>(null);
let mn = 0;
/** External .meta/feedback.ndjson change (agent resolve/send) → consumers re-read. */
export const feedbackRevision = writable(0);
let unsub: (() => void) | null = null;
let watchGeneration = 0;

interface WatchBridge {
  watchRoot?: (root: string | null) => Promise<boolean> | boolean;
  onFsChanged?: (cb: (info: FsChange) => void) => () => void;
  readText?: (p: string) => Promise<string>;
  exists?: (p: string) => Promise<boolean>;
}

export function startProjectWatch(root: string | null): void {
  stopProjectWatch();
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  if (!root || !fig?.watchRoot || !fig?.onFsChanged) return;
  void fig.watchRoot(root);
  const generation = watchGeneration;
  const refreshSources = () => {
    void import("./sourceBridge").then((m) => m.syncProjectSources(root, { isCurrent: () => generation === watchGeneration }))
      .catch((e) => console.warn("Figure source update failed; last saved assets are retained", e))
      // A Figure caption/journal conflict must not disable an independent
      // deck's sources. Keep Figure-first ordering for shared figure assets.
      .then(async () => { if (generation === watchGeneration) await (await import("./slideBridge")).refreshDeckSources(root); })
      .catch((e) => console.warn("Slide source update failed; last saved assets are retained", e));
  };
  // Project-level catch-up is independent of which mode opens first.
  refreshSources();
  unsub = fig.onFsChanged((info) => {
    if (info.subsystem === "plots") {
      refreshSources(); // service publishes only after durable commit
    } else if (info.subsystem === "dissections") bumpDissections(); // plots/_dissections/ — Dissect viewer re-lists
    else if (info.subsystem === "fig") { bumpFigRevision(); refreshSources(); }
    else if (info.subsystem === "references") bumpBibRevision();
    else if (info.subsystem === "manuscript" || info.subsystem === "context")
      externalManuscriptChange.set({ ...info, n: ++mn });
    else if (info.subsystem === "feedback") feedbackRevision.update((n) => n + 1);
    else if (info.subsystem === "slides") { bumpDeckRevision(); refreshSources(); } // W10 (SLD-1)
    else if (info.subsystem === "fluxlib") {
      // An external write to enrich.json (CLI hydrate, second window) must drop the
      // parse cache BEFORE consumers react to the revision bump (the mtime key would
      // catch it anyway — this makes the refresh immediate, not next-stat).
      if (info.path.endsWith("enrich.json")) invalidateEnrichCache();
      bumpFluxLib(); // W10 (LR-3): agent FluxLib edits
    } else if (info.subsystem === "conflict") {
      // A sync tool dropped a `.sync-conflict-*` copy into the project WHILE we are open.
      // It is deliberately NOT routed to the owning subsystem (main.cjs subsystemFor):
      // a conflict copy of main.qmd is not a manuscript edit, and letting it through put
      // it in the document list. Re-scan so the banner reflects reality.
      void refreshConflicts(root);
    } else if (info.subsystem === "assign-inbox") bumpAssignInbox(); // a PDF landed in the drop-inbox
    else if (info.subsystem === "capture") {
      // A capture landed in the download folder. Deliberately does NOT file it: intake is the
      // user's call (startup, or the Library's Assign button). All this does is refresh the
      // waiting count so that button offers the work — see captureIntake.svelte.ts.
      void import("../references/captureIntake.svelte").then((m) => m.refreshCaptureWaiting());
    }
    else if (info.subsystem === "zotero-bib") bumpZoteroBib(); // the BBT auto-export was rewritten
  });
}

export function stopProjectWatch(): void {
  watchGeneration++;
  if (unsub) {
    unsub();
    unsub = null;
  }
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  void fig?.watchRoot?.(null);
}
