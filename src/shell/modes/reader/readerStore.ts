// The papers open in FluxReader. `readerTabs` is the tab strip: an ordered list of
// open citekeys plus the active one. It is module-global — it survives mode
// keep-alive eviction and project switches — and persists to localStorage so a
// restart restores the reading session (lazily: only the active tab loads bytes;
// per-paper page/zoom live separately under flux-reader-view:<citekey>).
import { writable, derived } from "svelte/store";
import { setFocusedMode } from "../../paneStore";

export interface ReaderTab {
  key: string;
  openedAt: number;
}
export interface ReaderTabsState {
  tabs: ReaderTab[];
  active: string | null;
}

const TABS_LS = "flux-reader-tabs";

function restoreTabs(): ReaderTabsState {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_LS) ?? "null") as
      | { v: number; tabs: unknown; active: unknown }
      | null;
    if (!raw || raw.v !== 1 || !Array.isArray(raw.tabs)) return { tabs: [], active: null };
    const keys = raw.tabs.filter((k): k is string => typeof k === "string" && !!k);
    // A stale citekey (paper removed from FluxLib since) degrades to the reader's
    // "No PDF on disk" state on activation — no validation pass at startup.
    const tabs = keys.map((key, i) => ({ key, openedAt: i }));
    const active =
      typeof raw.active === "string" && keys.includes(raw.active) ? raw.active : (tabs.at(-1)?.key ?? null);
    return { tabs, active };
  } catch {
    return { tabs: [], active: null };
  }
}

export const readerTabs = writable<ReaderTabsState>(restoreTabs());
readerTabs.subscribe((s) => {
  try {
    localStorage.setItem(TABS_LS, JSON.stringify({ v: 1, tabs: s.tabs.map((t) => t.key), active: s.active }));
  } catch {
    /* storage full/blocked — session restore is best-effort */
  }
});

/** Citekey of the active paper (null = nothing open). Read-only compat view of readerTabs. */
export const readerKey = derived(readerTabs, (s) => s.active);

// 2.3: a pending find-in-document intent carried alongside the open. Bumped on every
// openInReader so the ReaderDoc's effect always re-runs (even when re-opening the
// already-open paper to jump to a new full-text match). `term:""` means "no find —
// close any transient search bar". nonce disambiguates repeat opens with the same term.
// `key` addresses the intent to one paper: a freshly-mounted ReaderDoc must not adopt
// a stale find left over from an earlier open of a different paper.
export interface ReaderFind {
  key: string;
  term: string;
  nonce: number;
}
export const readerFind = writable<ReaderFind>({ key: "", term: "", nonce: 0 });
let findNonce = 0;

/** Open a paper as a tab (or focus its existing tab); optionally jump to a find term. */
export function openReaderTab(citekey: string, opts?: { find?: string }): void {
  readerTabs.update((s) => {
    const tabs = s.tabs.some((t) => t.key === citekey)
      ? s.tabs
      : [...s.tabs, { key: citekey, openedAt: Date.now() }];
    return { tabs, active: citekey };
  });
  readerFind.set({ key: citekey, term: opts?.find?.trim() ?? "", nonce: ++findNonce });
}

/** Make an already-open tab the active one (no-op for unknown keys). */
export function activateReaderTab(citekey: string): void {
  readerTabs.update((s) => (s.tabs.some((t) => t.key === citekey) ? { ...s, active: citekey } : s));
}

/** Close a tab. If it was active, its right neighbour takes over (else left, else none). */
export function closeReaderTab(citekey: string): void {
  readerTabs.update((s) => {
    const i = s.tabs.findIndex((t) => t.key === citekey);
    if (i < 0) return s;
    const tabs = s.tabs.filter((t) => t.key !== citekey);
    const active = s.active === citekey ? ((tabs[i] ?? tabs[i - 1])?.key ?? null) : s.active;
    return { tabs, active };
  });
}

/** Cycle the active tab in strip order (wraps). */
export function cycleReaderTab(dir: 1 | -1): void {
  readerTabs.update((s) => {
    if (s.tabs.length < 2) return s;
    const i = Math.max(0, s.tabs.findIndex((t) => t.key === s.active));
    const j = (i + dir + s.tabs.length) % s.tabs.length;
    return { ...s, active: s.tabs[j].key };
  });
}

/** Open a paper in FluxReader and focus the reader mode; optionally jump to a find term. */
export function openInReader(citekey: string, opts?: { find?: string }): void {
  openReaderTab(citekey, opts);
  setFocusedMode("reader");
}

// Dev-only: let the headless harness drive the reader (mirrors __fluxEmitCapture) and
// observe the live store values. A dynamic import of this module in a page.evaluate()
// yields a SECOND module instance in dev, so tests can't read the stores directly — we
// mirror them onto window from the app's own instance instead.
if (import.meta.env?.DEV && typeof window !== "undefined") {
  const w = window as unknown as {
    __fluxOpenReader?: (k: string, opts?: { find?: string }) => void;
    __fluxReaderKey?: string | null;
    __fluxReaderFind?: ReaderFind;
    __fluxReaderTabs?: { tabs: string[]; active: string | null };
  };
  w.__fluxOpenReader = openInReader;
  readerKey.subscribe((k) => (w.__fluxReaderKey = k));
  readerFind.subscribe((f) => (w.__fluxReaderFind = f));
  readerTabs.subscribe((s) => (w.__fluxReaderTabs = { tabs: s.tabs.map((t) => t.key), active: s.active }));
}
