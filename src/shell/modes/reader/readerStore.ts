// The papers open in FluxReader. `readerTabs` is the tab strip: an ordered list of
// open citekeys plus the active one. It is module-global — it survives mode
// keep-alive eviction — and persists to localStorage so a restart restores the
// reading session (lazily: only the active tab loads bytes; per-paper page/zoom
// live separately under flux-reader-view:<citekey>).
//
// Multi-window A4.4 (2026-08-11): the persistence key is scoped PER PROJECT
// ROOT ("flux-reader-tabs:<root>"). localStorage is shared across windows while
// Svelte stores are not, so one global key meant window B's reading session
// silently overwrote window A's saved one — and a project's papers belong to
// the project anyway. Opening a project swaps in ITS saved session; the
// un-scoped legacy key remains both the first-run fallback (an existing global
// session is adopted by the next project opened) and the key for the
// no-project/web-fallback case, so the demo fixture behaves exactly as before.
import { writable, derived, get } from "svelte/store";
import { panes, focusedPaneId, setFocusedMode, splitWith } from "../../paneStore";
import { currentProject } from "../../shellStore";

export interface ReaderTab {
  key: string;
  openedAt: number;
}
export interface ReaderTabsState {
  tabs: ReaderTab[];
  active: string | null;
}

const TABS_LS = "flux-reader-tabs";
const tabsKey = (root: string | null) => (root ? `${TABS_LS}:${root}` : TABS_LS);
/** The project root whose session is currently live (and being persisted). */
let sessionRoot: string | null = get(currentProject)?.path ?? null;

function restoreTabs(root: string | null): ReaderTabsState {
  try {
    const stored = localStorage.getItem(tabsKey(root)) ?? (root ? localStorage.getItem(TABS_LS) : null);
    const raw = JSON.parse(stored ?? "null") as
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

export const readerTabs = writable<ReaderTabsState>(restoreTabs(sessionRoot));
readerTabs.subscribe((s) => {
  try {
    localStorage.setItem(tabsKey(sessionRoot), JSON.stringify({ v: 1, tabs: s.tabs.map((t) => t.key), active: s.active }));
  } catch {
    /* storage full/blocked — session restore is best-effort */
  }
});

// Project switch → swap in that project's saved reading session. sessionRoot
// flips BEFORE the set so the restore persists under the new key, not the old.
currentProject.subscribe((p) => {
  const root = p?.path ?? null;
  if (root === sessionRoot) return;
  sessionRoot = root;
  readerTabs.set(restoreTabs(root));
});

/** Citekey of the active paper (null = nothing open). Read-only compat view of readerTabs. */
export const readerKey = derived(readerTabs, (s) => s.active);

// --- split panes -------------------------------------------------------------------
// Per-pane view assignments (session-only — pane ids reset on every project open). A
// reader pane shows paneActiveTab[paneId] ?? readerTabs.active. Before anything
// re-targets the global active, every reader pane gets PINNED to what it currently
// shows (pinReaderPanes), so changing one pane's paper never silently changes the
// other's. `readerTabs.active` keeps meaning "the focused pane's paper" — the
// contract behind readerKey, __fluxReaderKey, and get_reading_context.
export const paneActiveTab = writable<Record<string, string>>({});

/** The pane whose ReaderMode currently hosts the shared terminal — one mount only
 * (terminalSession has a single detached host div; two mounts would steal it). */
export const readerTerminalPane = writable<string | null>(null);

// Drop assignments (and the terminal claim) for panes that no longer exist.
panes.subscribe((ps) => {
  const ids = new Set(ps.map((p) => p.id));
  paneActiveTab.update((m) => {
    const stale = Object.keys(m).filter((id) => !ids.has(id));
    if (!stale.length) return m;
    const next = { ...m };
    for (const id of stale) delete next[id];
    return next;
  });
  readerTerminalPane.update((id) => (id && !ids.has(id) ? null : id));
});

// readerKey follows pane focus: focusing a reader pane makes ITS paper the active one.
focusedPaneId.subscribe((fid) => {
  const p = get(panes).find((x) => x.id === fid);
  if (p?.mode !== "reader") return;
  const k = get(paneActiveTab)[fid];
  if (!k) return;
  readerTabs.update((s) => (s.active === k || !s.tabs.some((t) => t.key === k) ? s : { ...s, active: k }));
});

/** Pin every reader pane to its currently-displayed paper (no-op where already pinned). */
function pinReaderPanes(): void {
  const g = get(readerTabs).active;
  if (!g) return;
  const ids = get(panes)
    .filter((p) => p.mode === "reader")
    .map((p) => p.id);
  paneActiveTab.update((m) => {
    if (ids.every((id) => id in m)) return m;
    const next = { ...m };
    for (const id of ids) if (!(id in next)) next[id] = g;
    return next;
  });
}

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

/** Open a paper as a tab (or focus its existing tab); optionally jump to a find term.
 * The open lands in the FOCUSED pane (openInReader flips that pane to reader next). */
export function openReaderTab(citekey: string, opts?: { find?: string }): void {
  pinReaderPanes();
  readerTabs.update((s) => {
    const tabs = s.tabs.some((t) => t.key === citekey)
      ? s.tabs
      : [...s.tabs, { key: citekey, openedAt: Date.now() }];
    return { tabs, active: citekey };
  });
  // Overwrite the focused pane's assignment — a stale pin from an earlier reader
  // stint must not shadow this open when the pane flips back to reader.
  const fid = get(focusedPaneId);
  paneActiveTab.update((m) => (m[fid] === citekey ? m : { ...m, [fid]: citekey }));
  readerFind.set({ key: citekey, term: opts?.find?.trim() ?? "", nonce: ++findNonce });
}

/** Make an already-open tab the shown one in `paneId` (default: the focused pane). */
export function activateReaderTab(citekey: string, paneId?: string): void {
  if (!get(readerTabs).tabs.some((t) => t.key === citekey)) return;
  pinReaderPanes();
  const pid = paneId ?? get(focusedPaneId);
  paneActiveTab.update((m) => (m[pid] === citekey ? m : { ...m, [pid]: citekey }));
  if (pid === get(focusedPaneId))
    readerTabs.update((s) => (s.active === citekey ? s : { ...s, active: citekey }));
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
  // Panes that showed the closed paper fall back to the (already-advanced) global active.
  paneActiveTab.update((m) => {
    const stale = Object.keys(m).filter((id) => m[id] === citekey);
    if (!stale.length) return m;
    const next = { ...m };
    for (const id of stale) delete next[id];
    return next;
  });
}

/** Move a tab to another position in strip order (drag-reorder). Order is the only
 * thing that changes — the open set, the active tab, and every live document
 * instance are untouched (the strip and the doc slots key on citekey). */
export function moveReaderTab(citekey: string, toIndex: number): void {
  readerTabs.update((s) => {
    const from = s.tabs.findIndex((t) => t.key === citekey);
    if (from < 0) return s;
    const to = Math.max(0, Math.min(s.tabs.length - 1, toIndex));
    if (from === to) return s;
    const tabs = [...s.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { ...s, tabs };
  });
}

/** Cycle the shown tab of `paneId` (default: the focused pane) in strip order (wraps). */
export function cycleReaderTab(dir: 1 | -1, paneId?: string): void {
  const s = get(readerTabs);
  if (s.tabs.length < 2) return;
  const pid = paneId ?? get(focusedPaneId);
  const shown = get(paneActiveTab)[pid] ?? s.active;
  const i = Math.max(0, s.tabs.findIndex((t) => t.key === shown));
  const j = (i + dir + s.tabs.length) % s.tabs.length;
  activateReaderTab(s.tabs[j].key, pid);
}

/** Open a paper in the OTHER reader pane — Alt-click a tab. Splits when single-pane
 * (splitWith focuses the new pane); with two panes, the non-focused one converts to
 * reader (paneStore's existing split semantics) and keeps its own focus state. */
export function openReaderTabInSplit(citekey: string): void {
  pinReaderPanes();
  readerTabs.update((s) =>
    s.tabs.some((t) => t.key === citekey) ? s : { ...s, tabs: [...s.tabs, { key: citekey, openedAt: Date.now() }] },
  );
  const from = get(focusedPaneId);
  let target = get(panes).find((p) => p.mode === "reader" && p.id !== from);
  if (!target) {
    splitWith("reader");
    target = get(panes).find((p) => p.mode === "reader" && p.id !== from);
  }
  if (!target) return;
  const tid = target.id;
  paneActiveTab.update((m) => (m[tid] === citekey ? m : { ...m, [tid]: citekey }));
  if (get(focusedPaneId) === tid)
    readerTabs.update((s) => (s.active === citekey ? s : { ...s, active: citekey }));
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
    __fluxOpenReaderSplit?: (k: string) => void;
    __fluxReaderKey?: string | null;
    __fluxReaderFind?: ReaderFind;
    __fluxReaderTabs?: { tabs: string[]; active: string | null };
    __fluxPaneActiveTab?: Record<string, string>;
  };
  w.__fluxOpenReader = openInReader;
  w.__fluxOpenReaderSplit = openReaderTabInSplit;
  readerKey.subscribe((k) => (w.__fluxReaderKey = k));
  readerFind.subscribe((f) => (w.__fluxReaderFind = f));
  readerTabs.subscribe((s) => (w.__fluxReaderTabs = { tabs: s.tabs.map((t) => t.key), active: s.active }));
  paneActiveTab.subscribe((m) => (w.__fluxPaneActiveTab = m));
}
