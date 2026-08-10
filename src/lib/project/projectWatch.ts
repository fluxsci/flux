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

import { get, writable } from "svelte/store";
import { bumpFigRevision, bumpBibRevision, bumpDeckRevision, bumpDissections } from "../../shell/scholar/revisions";
import { bumpFluxLib, bumpAssignInbox, bumpZoteroBib } from "../references/revision";
import { invalidateEnrichCache } from "../references/fluxlibBridge";
import { project } from "../store";
import { assetData, dataUrlToBytes } from "../assets";
import { reimportPlot } from "../io";
import { plotSourceCandidates } from "../plot/source";
import type { FluxPlotManifest } from "../plot/types";

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

interface WatchBridge {
  watchRoot?: (root: string | null) => Promise<boolean> | boolean;
  onFsChanged?: (cb: (info: FsChange) => void) => () => void;
  readText?: (p: string) => Promise<string>;
  exists?: (p: string) => Promise<boolean>;
}

// A plots/ change → hot-swap every open plot asset whose SOURCE file's bytes
// now differ from the cached copy (reimportPlot: same F2 seam as Regenerate —
// id-keyed restyles survive, plotGen re-mounts the live DOM, autosave persists
// the fresh bytes into fig/assets). The watcher debounce collapses a bulk
// regeneration into ONE event carrying one path, so this sweeps ALL plot-backed
// assets instead of trusting info.path — that is exactly the case (36 plots
// re-themed at once) where the old bump-only handler left every fig/assets
// copy stale and the app silently kept rendering the old panels.
async function syncPlotsIntoFigures(root: string, fig: WatchBridge): Promise<number> {
  if (!fig.readText || !fig.exists) return 0;
  const p = get(project);
  // assetId → source paths to probe, best first. Candidates (not one path)
  // because a canvas can carry a foreign absolute path — imported on another
  // machine, or before the project folder moved — which resolves only once it
  // is re-anchored at THIS root (plot/source.ts).
  const srcOf = new Map<string, string[]>();
  for (const f of p.figures) {
    for (const el of f.elements) {
      if (el.type !== "plot") continue;
      const aid = (el as { assetId?: string }).assetId;
      const src = (el as { source?: { svgPath?: string } }).source?.svgPath;
      if (aid && src) srcOf.set(aid, plotSourceCandidates(root, src));
    }
  }
  const cached = get(assetData);
  let swapped = 0;
  for (const [aid, candidates] of srcOf) {
    try {
      let abs = "";
      for (const c of candidates) {
        if (await fig.exists(c)) {
          abs = c;
          break;
        }
      }
      if (!abs) continue;
      const fresh = await fig.readText(abs);
      const cur = cached[aid] ? new TextDecoder().decode(dataUrlToBytes(cached[aid])) : "";
      if (fresh === cur) continue;
      let manifest: FluxPlotManifest | undefined;
      let recipe: unknown;
      const base = abs.replace(/\.svg$/i, "");
      try {
        if (await fig.exists(`${base}.fluxplot.json`)) manifest = JSON.parse(await fig.readText(`${base}.fluxplot.json`));
        if (manifest && (await fig.exists(`${base}.recipe.json`))) recipe = JSON.parse(await fig.readText(`${base}.recipe.json`));
      } catch {
        manifest = undefined; // malformed sidecar → derived manifest, same as import
      }
      reimportPlot(aid, fresh, manifest, recipe);
      swapped++;
    } catch {
      /* per-asset failures never abort the sweep */
    }
  }
  return swapped;
}

export function startProjectWatch(root: string | null): void {
  stopProjectWatch();
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  if (!root || !fig?.watchRoot || !fig?.onFsChanged) return;
  void fig.watchRoot(root);
  unsub = fig.onFsChanged((info) => {
    if (info.subsystem === "plots") {
      // Swap first, then bump: the revision reload re-reads fig/assets, which
      // is only fresh AFTER reimportPlot marks the swapped bytes for save.
      void syncPlotsIntoFigures(root, fig).finally(() => bumpFigRevision());
    } else if (info.subsystem === "dissections") bumpDissections(); // plots/_dissections/ — Dissect viewer re-lists
    else if (info.subsystem === "fig") bumpFigRevision();
    else if (info.subsystem === "references") bumpBibRevision();
    else if (info.subsystem === "manuscript" || info.subsystem === "context")
      externalManuscriptChange.set({ ...info, n: ++mn });
    else if (info.subsystem === "feedback") feedbackRevision.update((n) => n + 1);
    else if (info.subsystem === "slides") bumpDeckRevision(); // W10 (SLD-1)
    else if (info.subsystem === "fluxlib") {
      // An external write to enrich.json (CLI hydrate, second window) must drop the
      // parse cache BEFORE consumers react to the revision bump (the mtime key would
      // catch it anyway — this makes the refresh immediate, not next-stat).
      if (info.path.endsWith("enrich.json")) invalidateEnrichCache();
      bumpFluxLib(); // W10 (LR-3): agent FluxLib edits
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
  if (unsub) {
    unsub();
    unsub = null;
  }
  const fig = (window as unknown as { fig?: WatchBridge }).fig;
  void fig?.watchRoot?.(null);
}
