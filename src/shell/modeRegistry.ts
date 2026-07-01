// W15 (SHL-4): lazy mode loading. The five modes drag in CodeMirror (paper),
// pdf.js (reader), KaTeX (slide/reader) and xterm (paper terminal) — statically
// importing all of them put ~1.4MB of mode code in the entry chunk, so Home
// wasn't interactive until every mode had parsed. Each mode is now a dynamic
// import behind this registry: a loader map + a sync cache (so a warmed or
// already-visited mode renders with no async flash) + idle-time prefetch.

import type { Component } from "svelte";
import type { ModeId } from "./shellStore";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ModeComponent = Component<any>;
type Loader = () => Promise<{ default: ModeComponent }>;

const loaders: Record<ModeId, Loader> = {
  paper: () => import("./modes/paper/PaperMode.svelte"),
  figure: () => import("./modes/figure/FigureMode.svelte"),
  library: () => import("./modes/library/LibraryMode.svelte"),
  slide: () => import("./modes/slide/SlideMode.svelte"),
  reader: () => import("./modes/reader/ReaderMode.svelte"),
};

const cache = new Map<ModeId, ModeComponent>();
const inflight = new Map<ModeId, Promise<ModeComponent>>();

/** The mode component if it has already loaded, else undefined (→ render nothing
 *  / a skeleton for this frame). Synchronous, so warm modes never flash. */
export function cachedMode(mode: ModeId): ModeComponent | undefined {
  return cache.get(mode);
}

/** Load a mode's chunk (idempotent; concurrent calls share one import). */
export function loadMode(mode: ModeId): Promise<ModeComponent> {
  const hit = cache.get(mode);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(mode);
  if (!p) {
    p = loaders[mode]()
      .then((m) => {
        cache.set(mode, m.default);
        inflight.delete(mode);
        return m.default;
      })
      .catch((e) => {
        inflight.delete(mode); // let a later attempt retry
        throw e;
      });
    inflight.set(mode, p);
  }
  return p;
}

/** Prefetch modes during idle time so the first switch to them is instant.
 *  Best-effort: failures are swallowed (the real load will surface them). */
export function warmModes(modes: ModeId[]): void {
  const ric: (cb: () => void) => void =
    typeof (globalThis as any).requestIdleCallback === "function"
      ? (cb) => (globalThis as any).requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => setTimeout(cb, 200);
  for (const m of modes) {
    if (!cache.has(m) && !inflight.has(m)) ric(() => void loadMode(m).catch(() => {}));
  }
}

export const ALL_MODES: ModeId[] = ["paper", "figure", "library", "slide", "reader"];
