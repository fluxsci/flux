// The renderer-facing data shapes — mirrors the preload contract in
// electron/preload.cjs (§3.5 of the plan). Keep this surface tiny.

export type SetInfo = { id: string; name: string; count: number };

// One aligned cell: `file` is the basename in this set (null when the set is
// missing this item — the grid shows a placeholder so cell (r,c) is the same
// item in every set).
export type ItemCell = { key: string; present: boolean; file: string | null };

// Annotations: a per-collection layer of marks/notes keyed by ITEM KEY (a
// mark belongs to the plot name across every set). One class = one JSON file
// in `<collection>/.lt-annotations/`.
export type AnnotMark = "valid" | "exclude";
export type AnnotItem = { mark?: AnnotMark; notes?: string };
export type AnnotData = { name: string; items: Record<string, AnnotItem> };
// `mark: null` clears the mark; blank notes clear the notes.
export type AnnotPatch = { mark?: AnnotMark | null; notes?: string };

export type Manifest = {
  root: string;
  name: string;
  sets: SetInfo[];
  keys: string[]; // natural-sorted union of item keys (grid order)
  bySet: Record<string, ItemCell[]>; // per set, aligned to `keys`
  annotations?: { classes: string[]; active: AnnotData | null };
};

export type Prefs = {
  columns: number;
  captions: boolean;
  hGap: number; // px between columns
  vGap: number; // px between rows
  recents: string[];
};

export type RecentEntry = { path: string; name: string };

export interface LtApi {
  openDialog(): Promise<Manifest | null>;
  openPath(path: string): Promise<Manifest | null>;
  onOpen(cb: (m: Manifest) => void): void; // main-initiated opens (CLI/drag/2nd instance)
  recents(): Promise<RecentEntry[]>;
  siblings(): Promise<RecentEntry[]>; // directories beside the open collection (sister folders)
  thumbUrl(setId: string, key: string, px: number): Promise<string | null>;
  fullUrl(setId: string, key: string): Promise<string | null>;
  revealInFolder(setId: string, key: string): Promise<void>;
  pathForFile(f: File): string; // webUtils.getPathForFile — drag-to-open
  prefsGet(): Promise<Prefs>;
  prefsSet(p: Partial<Prefs>): Promise<void>;
  annotList(): Promise<string[]>;
  annotCreate(name: string): Promise<AnnotData | null>;
  annotOpen(name: string): Promise<AnnotData | null>;
  annotClose(): Promise<void>;
  annotSet(key: string, patch: AnnotPatch): Promise<void>;
}
