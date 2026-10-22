// The Plots rail's model of a plots tree (the project's plots/, the global library, or one
// reserved collection inside plots/). The walk runs in the thumbnail worker (plots:list); this
// keeps the result, fills placed sizes from header probes (visible tiles first), follows the
// watcher's per-path batches (fs:changedBatch: only the touched folders are re-listed) and the
// app's own writes (which the watcher deliberately skips — notifyPlotsWritten), and knows how
// many dissection files each plot has.

import { writable, get, type Readable } from "svelte/store";
import { fileBridge, type PlotIndexEntry } from "../project/types";

export type PlotScope = "project" | "global";

export interface PlotItem extends PlotIndexEntry {
  /** File name with extension. */
  name: string;
  /** Folder relative to the listed base ("" = its root). */
  dir: string;
  /** size:mtime — a regenerated plot is a new version (fresh thumbnail). */
  stamp: string;
  model3d: boolean;
}

export interface IndexState {
  items: PlotItem[];
  base: string;
  loading: boolean;
  loaded: boolean;
  truncated: boolean;
  error: string;
  /** Bumps whenever items or their sizes change. */
  version: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folder order then name order (numeric-aware: fig2 before fig10). */
export function compareItems(a: PlotItem, b: PlotItem): number {
  if (a.dir !== b.dir) {
    // Parent folders before their children, siblings alphabetically.
    const as = a.dir.split("/"), bs = b.dir.split("/");
    const n = Math.min(as.length, bs.length);
    for (let i = 0; i < n; i++) if (as[i] !== bs[i]) return a.dir === "" ? -1 : b.dir === "" ? 1 : collator.compare(as[i], bs[i]);
    return as.length - bs.length;
  }
  return collator.compare(a.name, b.name);
}

function toItem(e: PlotIndexEntry): PlotItem {
  const slash = e.rel.lastIndexOf("/");
  return {
    ...e,
    name: slash >= 0 ? e.rel.slice(slash + 1) : e.rel,
    dir: slash >= 0 ? e.rel.slice(0, slash) : "",
    stamp: `${e.size}:${e.mtimeMs}`,
    model3d: /\.glb$/i.test(e.rel),
  };
}

// FRESH marks (session-scoped): a file that appeared, or changed version, after the rail first
// listed its tree this session. The last listing of every base is remembered here — outside any
// one index — so a rail that was unmounted (Layers showing, another mode) still sees what changed
// meanwhile. Clicking, peeking or placing a plot clears its mark.
const lastSeen = new Map<string, Map<string, string>>(); // base → abs → stamp
const freshStore = writable<ReadonlySet<string>>(new Set());
/** The plots marked fresh (new or regenerated since the rail last listed them). */
export const freshPlots: Readable<ReadonlySet<string>> = { subscribe: freshStore.subscribe };
export function clearFresh(abs?: string): void {
  freshStore.update((s) => {
    if (abs === undefined) return s.size ? new Set() : s;
    if (!s.has(abs)) return s;
    const n = new Set(s); n.delete(abs); return n;
  });
}
/** Compare a (re)listing of `base` — the whole tree, or only `dirs` of it — with the last one. */
function noteListing(base: string, items: Iterable<PlotItem>, dirs: string[] | null): void {
  const prev = lastSeen.get(base);
  const next = new Map<string, string>();
  if (prev && dirs) {
    // A partial re-list: keep what lies outside the re-listed folders.
    for (const [abs, stamp] of prev) {
      const cut = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
      if (!dirs.includes(abs.slice(0, cut))) next.set(abs, stamp);
    }
  }
  const marked: string[] = [];
  for (const it of items) {
    next.set(it.abs, it.stamp);
    if (prev && prev.get(it.abs) !== it.stamp) marked.push(it.abs);
  }
  lastSeen.set(base, next);
  if (marked.length) freshStore.update((s) => { const n = new Set(s); for (const a of marked) n.add(a); return n; });
}

// The app's own writes under plots/ never reach the watcher (isSelfWrite) — writers announce them.
const writeListeners = new Set<(paths: string[]) => void>();
/** Announce files the app itself wrote under plots/ (pasted images, snips, dissection folders). */
export function notifyPlotsWritten(paths: string[]): void {
  for (const cb of writeListeners) cb(paths);
}

export interface PlotIndex extends Readable<IndexState> {
  load(): Promise<void>;
  /** Make sure these items have placed sizes (header probes), in this order. */
  ensureSizes(abs: string[]): Promise<void>;
  /** Dissection file counts per plot key (project scope). */
  counts: Readable<Map<string, number>>;
  ensureCounts(keys: string[]): void;
  /** Re-list (Refresh, or the global library regaining focus). */
  refresh(): Promise<void>;
  dispose(): void;
}

export function createPlotIndex(opts: { scope: PlotScope; collection?: string; accept: string; watch: boolean }): PlotIndex {
  const state = writable<IndexState>({ items: [], base: "", loading: false, loaded: false, truncated: false, error: "", version: 0 });
  const counts = writable<Map<string, number>>(new Map());
  const byAbs = new Map<string, PlotItem>();
  let generation = 0;
  let disposed = false;
  const probing = new Set<string>();
  // abs|stamp already probed without a size (a GLB, an unreadable header): never re-probed.
  const unsized = new Set<string>();
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  // Changes that arrived while the first walk ran (no base yet): one re-walk after it.
  let changedDuringLoad = false;
  let loadingNow = false;
  const countsAsked = new Set<string>();

  function publish(patch: Partial<IndexState> = {}) {
    const items = [...byAbs.values()].sort(compareItems);
    state.update((s) => ({ ...s, ...patch, items, version: s.version + 1 }));
  }

  async function load() {
    const fb = fileBridge();
    const mine = ++generation;
    if (!fb?.plotsList) { state.update((s) => ({ ...s, loading: false, loaded: true, error: "Plot browsing needs the desktop app" })); return; }
    state.update((s) => ({ ...s, loading: true, error: "" }));
    loadingNow = true; changedDuringLoad = false;
    let r;
    try { r = await fb.plotsList({ scope: opts.scope, accept: opts.accept, ...(opts.collection ? { collection: opts.collection } : {}) }); }
    catch (e) { if (mine === generation) state.update((s) => ({ ...s, loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) })); return; }
    loadingNow = false;
    if (mine !== generation || disposed || r.stale) return;
    byAbs.clear();
    for (const e of r.entries) byAbs.set(e.abs, toItem(e));
    if (r.base) noteListing(r.base, byAbs.values(), null);
    publish({ base: r.base, loading: false, loaded: true, truncated: r.truncated, error: r.error && !r.unavailable ? r.error : "" });
    if (changedDuringLoad) { changedDuringLoad = false; void load(); }
  }

  /** Re-list only these folders (a watcher batch / an app write named files in them). */
  async function refreshDirs(dirs: string[]) {
    const fb = fileBridge();
    const base = get(state).base;
    if (!fb?.plotsList || !base || !dirs.length) return;
    const mine = generation;
    let r;
    try { r = await fb.plotsList({ scope: opts.scope, accept: opts.accept, ...(opts.collection ? { collection: opts.collection } : {}), dirs }); }
    catch { return; }
    if (mine !== generation || disposed || r.stale) return;
    const listed = new Set(dirs.filter((d) => !(r.missing ?? []).includes(d)));
    // Replace each listed folder's own files; drop everything under a vanished folder.
    for (const [abs, it] of byAbs) {
      const parent = abs.slice(0, abs.length - it.name.length - 1);
      if (listed.has(parent)) byAbs.delete(abs);
      else for (const gone of r.missing ?? []) if (abs === gone || abs.startsWith(gone + "/") || abs.startsWith(gone + "\\")) { byAbs.delete(abs); break; }
    }
    for (const e of r.entries) {
      const prev = byAbs.get(e.abs);
      const it = toItem(e);
      // Keep a probed size across a re-list of the same version.
      if (prev && prev.stamp === it.stamp && prev.w && !it.w) { it.w = prev.w; it.h = prev.h; it.physMm = prev.physMm; }
      byAbs.set(e.abs, it);
    }
    const listedItems = [...byAbs.values()].filter((it) => listed.has(it.abs.slice(0, it.abs.length - it.name.length - 1)));
    noteListing(base, listedItems, [...listed]);
    publish();
  }

  async function ensureSizes(abs: string[]) {
    const fb = fileBridge();
    if (!fb?.plotsProbe) return;
    const want = abs.filter((a) => { const it = byAbs.get(a); return it && !it.w && !probing.has(a) && !unsized.has(`${a}|${it.stamp}`); });
    if (!want.length) return;
    for (const a of want) probing.add(a);
    const mine = generation;
    try {
      for (let i = 0; i < want.length; i += 400) {
        const chunk = want.slice(i, i + 400);
        const res = await fb.plotsProbe(chunk);
        if (mine !== generation || disposed) return;
        let changed = false;
        for (const p of res) {
          const it = byAbs.get(p.abs);
          // A NEW item object, never a mutation: views memoise on item identity.
          if (it && p.w && p.h) { byAbs.set(p.abs, { ...it, w: p.w, h: p.h, physMm: p.physMm ?? null }); changed = true; }
          else if (it) unsized.add(`${p.abs}|${it.stamp}`);
        }
        if (changed) state.update((s) => ({ ...s, items: s.items.map((i) => byAbs.get(i.abs) ?? i), version: s.version + 1 }));
      }
    } finally { for (const a of want) probing.delete(a); }
  }

  let countTimer: ReturnType<typeof setTimeout> | null = null;
  const countQueue = new Set<string>();
  function ensureCounts(keys: string[]) {
    if (opts.scope !== "project" || opts.collection) return;
    for (const k of keys) if (k && !countsAsked.has(k)) { countsAsked.add(k); countQueue.add(k); }
    if (!countQueue.size || countTimer) return;
    countTimer = setTimeout(async () => {
      countTimer = null;
      const fb = fileBridge();
      const ask = [...countQueue]; countQueue.clear();
      if (!fb?.dissectCounts || !ask.length) return;
      const mine = generation;
      // The bridge takes at most 5,000 keys a call (a Has-dissections filter asks for them all).
      for (let i = 0; i < ask.length; i += 2000) {
        const chunk = ask.slice(i, i + 2000);
        try {
          const got = await fb.dissectCounts(chunk);
          if (mine !== generation || disposed) return;
          counts.update((m) => { const next = new Map(m); for (const k of chunk) next.set(k, got[k] ?? 0); return next; });
        } catch { /* counts are decoration */ }
      }
    }, 0);
  }

  function refreshCounts() {
    const keys = [...countsAsked];
    countsAsked.clear();
    ensureCounts(keys);
  }

  const offs: (() => void)[] = [];
  if (opts.watch && opts.scope === "project") {
    const fb = fileBridge();
    let pendingDirs = new Set<string>();
    let rescan = false;
    const schedule = () => {
      if (batchTimer) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (disposed) return;
        if (rescan) { rescan = false; pendingDirs = new Set(); void load(); return; }
        const dirs = [...pendingDirs]; pendingDirs = new Set();
        void refreshDirs(dirs);
      }, 60);
    };
    const take = (paths: string[]) => {
      const base = get(state).base;
      if (!base) { if (loadingNow) changedDuringLoad = true; return; }
      for (const p of paths) {
        if (p !== base && !p.startsWith(base + "/") && !p.startsWith(base + "\\")) continue;
        const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        pendingDirs.add(p.slice(0, cut));
        // A path without an extension may be a folder that came or went.
        if (!/\.[^./\\]+$/.test(p)) pendingDirs.add(p);
      }
      schedule();
    };
    const off = fb?.onFsChangedBatch?.((info) => {
      if (disposed) return;
      if (info.subsystem === "dissections") {
        refreshCounts();
        if (opts.collection) { if (info.rescan) { rescan = true; schedule(); } else take(info.paths); }
        return;
      }
      if (info.subsystem !== "plots" || opts.collection) return;
      if (info.rescan) { rescan = true; schedule(); return; }
      take(info.paths);
    });
    if (off) offs.push(off);
    const onWrite = (paths: string[]) => { if (!disposed) { take(paths); refreshCounts(); } };
    writeListeners.add(onWrite);
    offs.push(() => writeListeners.delete(onWrite));
  }

  return {
    subscribe: state.subscribe,
    counts: { subscribe: counts.subscribe },
    load,
    ensureSizes,
    ensureCounts,
    refresh: async () => { countsAsked.clear(); counts.set(new Map()); await load(); },
    dispose() { disposed = true; generation++; for (const off of offs) off(); if (countTimer) clearTimeout(countTimer); if (batchTimer) clearTimeout(batchTimer); },
  };
}
