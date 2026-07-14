// Dev-only inspection/automation handle (§1.4 / M17 of the Improvement Plan).
//
// Exposes the key stores + helpers on `window.__flux` so the headless Live Visual
// Verification harness (scripts/lib/driver.mjs) can deterministically set up state
// and assert against it — extending the existing `window.__fluxView` (one editor).
//
// Installed only from main.ts behind `import.meta.env.DEV`, via dynamic import, so
// it is never included in a production build.

import { get, type Readable } from "svelte/store";
import * as fig from "../store";
import { settings } from "../settings";
import * as panes from "../../shell/paneStore";
import * as shell from "../../shell/shellStore";
import * as caps from "../captions";
import * as bridge from "../project/figbridge";
import * as plot from "../plot/store";
import * as io from "../io";
import * as slide from "../slide/store";
import * as slideOps from "../slide/ops";
import * as slideBridge from "../project/slideBridge";
import * as deckProject from "../slide/deckProject";
import * as convert from "../project/convert";
import * as tenancy from "../tenancy";
import * as toast from "../toast";
import * as lifecycle from "../../shell/lifecycle";
import { perfCounters } from "./perfCounters";
import { paperPerf } from "../../shell/modes/paper/science/changeGate";
import * as presets from "../presets";

export interface FluxDevHandle {
  /** Snapshot any Svelte store: `__flux.get(__flux.fig.project)`. */
  get: <T>(s: Readable<T>) => T;
  /** The Figure-editor store module (project, viewport, selection, commit, …). */
  fig: typeof fig;
  /** Pane layout stores/actions. */
  panes: typeof panes;
  /** Shell navigation stores/actions (newProject, openProject, …). */
  shell: typeof shell;
  /** Caption helpers (composeCaption, panelLetters, captionBlocks). */
  caps: typeof caps;
  /** fig/ subsystem bridge (saveFigFrom, readFigSource, loadFigInto). */
  bridge: typeof bridge;
  /** Plot runtime stores (plotDom, plotManifests, plotRecipes, plotGen). */
  plot: typeof plot;
  /** Asset/plot I/O incl. reimportPlot (F2 hot-swap). */
  io: typeof io;
  /** Flux Slide overlay stores (deckOverlay, activeBeat, commitDeckLive,
   *  currentDeck, loadDeckModel — the static half lives in `fig`). */
  slide: typeof slide;
  /** Flux Slide pure ops core (addSlide, addBeat, setAnimation, …). */
  slideOps: typeof slideOps;
  /** Slide deck bridge (listProjectDecks, loadDeckInto, saveDeckFrom, …). */
  slideBridge: typeof slideBridge;
  /** The deck ⇄ figure-Project projection (deckToProject/projectIntoDeck). */
  deckProject: typeof deckProject;
  /** Send-to-deck / Send-to-canvas converters. */
  convert: typeof convert;
  /** Store tenancy (figure|slide) — the cross-write guard. */
  tenancy: typeof tenancy;
  /** App-wide toast store + pushToast/dismissToast (W1) — for headless asserts. */
  toast: typeof toast;
  /** Dirty registry + flushAll/anyDirty (W5) — for headless asserts. */
  lifecycle: typeof lifecycle;
  /** Convenience: the current figures array. */
  figures: () => unknown[];
  /** Editor settings store (rulers/grid/snap toggles, FluxFig Menu prefs). */
  settings: typeof settings;
  /** Live CodeMirror editor views (one per open Paper pane). */
  editors: unknown[];
  /** WS-1 recompute counters (Canvas culling/effState, Sidebar rows). */
  perf: typeof perfCounters;
  /** WS-2 block-field build() counters (embeds/tables/math). */
  paperPerf: typeof paperPerf;
  /** Design-preset library (presetPicker store, list/save/insert helpers). */
  presets: typeof presets;
}

export function installDevHandle(): void {
  const w = window as unknown as Record<string, any>;
  const existing = w.__flux ?? {};
  w.__flux = {
    get: <T>(s: Readable<T>) => get(s),
    fig,
    panes,
    shell,
    caps,
    bridge,
    plot,
    io,
    slide,
    slideOps,
    slideBridge,
    deckProject,
    convert,
    tenancy,
    toast,
    lifecycle,
    figures: () => get(fig.project).figures,
    settings,
    editors: existing.editors ?? [],
    perf: perfCounters,
    paperPerf,
    presets,
  } satisfies FluxDevHandle;
}
