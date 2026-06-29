// F1 file-watch live reload (renderer half). Subscribes to the Electron watcher's
// `fs:changed` events and non-destructively reloads the affected subsystem:
//   fig/ + plots/   → bump figRevision (figures/plots re-read live)
//   references/     → bump bibRevision (autocomplete + hover cards refresh)
//   manuscript/**   → signal the Paper editor to reload the doc IF it isn't dirty
//                     (PaperMode never clobbers unsaved work — see its handler)
//
// The Electron main process already skips the app's own writes, so this only
// fires for genuine external (agent / analysis-script) edits.

import { writable } from "svelte/store";
import { bumpFigRevision, bumpBibRevision } from "../../shell/scholar/revisions";

export interface FsChange {
  subsystem: string;
  path: string;
}

/** External manuscript change → PaperMode reloads the doc if it is clean. */
export const externalManuscriptChange = writable<(FsChange & { n: number }) | null>(null);
let mn = 0;
let unsub: (() => void) | null = null;

interface WatchBridge {
  watchRoot?: (root: string | null) => Promise<boolean> | boolean;
  onFsChanged?: (cb: (info: FsChange) => void) => () => void;
}

export function startProjectWatch(root: string | null): void {
  stopProjectWatch();
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  if (!root || !fig?.watchRoot || !fig?.onFsChanged) return;
  void fig.watchRoot(root);
  unsub = fig.onFsChanged((info) => {
    if (info.subsystem === "fig" || info.subsystem === "plots") bumpFigRevision();
    else if (info.subsystem === "references") bumpBibRevision();
    else if (info.subsystem === "manuscript") externalManuscriptChange.set({ ...info, n: ++mn });
  });
}

export function stopProjectWatch(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  void fig?.watchRoot?.(null);
}
