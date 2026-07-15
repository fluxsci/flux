// The renderer-facing data shapes — mirrors the preload contract in
// electron/preload.cjs (§3.5 of the plan). Keep this surface tiny.

export type SetInfo = { id: string; name: string; count: number };

// One aligned cell: `file` is the basename in this set (null when the set is
// missing this item — the grid shows a placeholder so cell (r,c) is the same
// item in every set).
export type ItemCell = { key: string; present: boolean; file: string | null };

export type Manifest = {
  root: string;
  name: string;
  sets: SetInfo[];
  keys: string[]; // natural-sorted union of item keys (grid order)
  bySet: Record<string, ItemCell[]>; // per set, aligned to `keys`
};

export type Prefs = { columns: number; captions: boolean; recents: string[] };

export type RecentEntry = { path: string; name: string };

export interface LtApi {
  openDialog(): Promise<Manifest | null>;
  openPath(path: string): Promise<Manifest | null>;
  onOpen(cb: (m: Manifest) => void): void; // main-initiated opens (CLI/drag/2nd instance)
  recents(): Promise<RecentEntry[]>;
  thumbUrl(setId: string, key: string, px: number): Promise<string | null>;
  fullUrl(setId: string, key: string): Promise<string | null>;
  revealInFolder(setId: string, key: string): Promise<void>;
  pathForFile(f: File): string; // webUtils.getPathForFile — drag-to-open
  prefsGet(): Promise<Prefs>;
  prefsSet(p: Partial<Prefs>): Promise<void>;
}
