// App state (Svelte 5 runes). One store, no state library — the app is small.
import type { ItemCell, LtApi, Manifest, RecentEntry, SetInfo } from "./types";

// Grid layout constants (shared with Grid.svelte and the verify gates).
export const GRID_PAD = 12;
export const GRID_GAP = 8;
export const CAPTION_H = 20;
export const OVERSCAN_ROWS = 2;

// Duplicated tiny constant from electron/lib/pure.cjs (no imports across the
// process line): bucket the requested thumb px so column drags don't spam
// regeneration — the URL only changes when the bucket does.
export const BUCKETS = [128, 192, 256, 384, 512, 768];
export function bucketFor(px: number): number {
  for (const b of BUCKETS) if (b >= px) return b;
  return BUCKETS[BUCKETS.length - 1];
}

export interface GridApi {
  ensureVisible(index: number): void;
  pageBy(dir: 1 | -1): void;
}
export interface DetailApi {
  toggleFit(): void;
  zoomBy(factor: number): void;
  resetZoom(): void;
}
export type GridDebug = { firstRow: number; lastRow: number; cellPx: number; rowH: number; dom: number };

class LtStore {
  manifest = $state<Manifest | null>(null);
  setIndex = $state(0);
  cols = $state(8);
  captions = $state(true);
  search = $state("");
  view = $state<"grid" | "detail">("grid");
  selectedKey = $state<string | null>(null);
  recents = $state<RecentEntry[]>([]);

  // Imperative hooks registered by components (non-reactive on purpose).
  gridApi: GridApi | null = null;
  detailApi: DetailApi | null = null;
  searchEl: HTMLInputElement | null = null;
  gridDebug: GridDebug | null = null;

  get api(): LtApi | null {
    return (window as unknown as { lt?: LtApi }).lt ?? null;
  }

  currentSet: SetInfo | null = $derived(this.manifest?.sets[this.setIndex] ?? null);

  keyIndex = $derived.by(() => {
    const m = new Map<string, number>();
    this.manifest?.keys.forEach((k, i) => m.set(k, i));
    return m;
  });

  // Search filters the aligned key list into the view list (substring on the
  // item key, case-insensitive). ≤100 ms trivially at thousands of keys.
  filteredKeys = $derived.by(() => {
    if (!this.manifest) return [] as string[];
    const q = this.search.trim().toLowerCase();
    if (!q) return this.manifest.keys;
    return this.manifest.keys.filter((k) => k.toLowerCase().includes(q));
  });

  selIdx = $derived(this.selectedKey ? this.filteredKeys.indexOf(this.selectedKey) : -1);

  cellFor(setId: string, key: string): ItemCell | null {
    const i = this.keyIndex.get(key);
    if (i === undefined) return null;
    return this.manifest?.bySet[setId]?.[i] ?? null;
  }

  setManifest(m: Manifest | null): void {
    if (!m) return;
    this.manifest = m;
    this.setIndex = 0;
    this.search = "";
    this.view = "grid";
    this.selectedKey = m.keys[0] ?? null;
    document.title = m.name ? `${m.name} — Lighttable` : "Lighttable";
  }

  switchSet(i: number): void {
    const n = this.manifest?.sets.length ?? 0;
    if (!n) return;
    this.setIndex = Math.min(n - 1, Math.max(0, i));
  }
  stepSet(d: number): void {
    const n = this.manifest?.sets.length ?? 0;
    if (!n) return;
    this.setIndex = (this.setIndex + d + n) % n;
  }

  moveSelection(d: number): void {
    const list = this.filteredKeys;
    if (!list.length) return;
    const i = this.selIdx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, this.selIdx + d));
    this.selectedKey = list[i];
    this.gridApi?.ensureVisible(i);
  }
  selectEdge(end: boolean): void {
    const list = this.filteredKeys;
    if (!list.length) return;
    const i = end ? list.length - 1 : 0;
    this.selectedKey = list[i];
    this.gridApi?.ensureVisible(i);
  }

  openDetail(key?: string): void {
    if (key) this.selectedKey = key;
    if (!this.selectedKey) return;
    this.view = "detail";
  }
  // Back to Grid: selection = the item being viewed; grid scroll is untouched
  // (Grid stays mounted under the overlay) and the cell is nudged into view
  // only if ←/→ in Detail moved it out of the window.
  closeDetail(): void {
    this.view = "grid";
    if (this.selIdx >= 0) this.gridApi?.ensureVisible(this.selIdx);
  }

  // Detail ←/→: previous/next item present in the CURRENT set (skip-missing),
  // through the filtered view list.
  detailStep(d: number): void {
    const setId = this.currentSet?.id;
    const list = this.filteredKeys;
    if (!setId || !list.length) return;
    let i = this.selIdx < 0 ? 0 : this.selIdx;
    for (;;) {
      i += d;
      if (i < 0 || i >= list.length) return;
      if (this.cellFor(setId, list[i])?.present) {
        this.selectedKey = list[i];
        return;
      }
    }
  }
  detailEdge(end: boolean): void {
    const setId = this.currentSet?.id;
    const list = this.filteredKeys;
    if (!setId || !list.length) return;
    const order = [...list.keys()];
    if (end) order.reverse();
    for (const i of order) {
      if (this.cellFor(setId, list[i])?.present) {
        this.selectedKey = list[i];
        return;
      }
    }
  }

  setCols(n: number): void {
    this.cols = Math.min(24, Math.max(1, Math.round(n)));
    void this.api?.prefsSet({ columns: this.cols });
  }
  toggleCaptions(): void {
    this.captions = !this.captions;
    void this.api?.prefsSet({ captions: this.captions });
  }
  clearSearch(): void {
    this.search = "";
  }

  async openViaDialog(): Promise<void> {
    const m = await this.api?.openDialog();
    if (m) this.setManifest(m);
  }
  async openPath(p: string): Promise<boolean> {
    const m = await this.api?.openPath(p);
    if (m) this.setManifest(m);
    return m != null;
  }
  async refreshRecents(): Promise<void> {
    this.recents = (await this.api?.recents()) ?? [];
  }
  revealSelected(): void {
    const setId = this.currentSet?.id;
    if (setId && this.selectedKey) void this.api?.revealInFolder(setId, this.selectedKey);
  }
}

export const store = new LtStore();

// Dev-only introspection handle for the verify gates (mirrors Flux's
// __fluxView pattern). Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ltState = {
    get view() {
      return store.view;
    },
    get setId() {
      return store.currentSet?.id ?? null;
    },
    get setName() {
      return store.currentSet?.name ?? null;
    },
    get setIndex() {
      return store.setIndex;
    },
    get cols() {
      return store.cols;
    },
    get captions() {
      return store.captions;
    },
    get search() {
      return store.search;
    },
    get selectedKey() {
      return store.selectedKey;
    },
    get filteredCount() {
      return store.filteredKeys.length;
    },
    get keyCount() {
      return store.manifest?.keys.length ?? 0;
    },
    get grid() {
      return store.gridDebug;
    },
  };
}
