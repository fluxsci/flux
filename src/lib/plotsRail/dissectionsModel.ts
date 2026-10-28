// The Dissections pane's model: the focus plot's companion material, arranged for a narrow,
// tall pane (gate: scripts/verify-plots-rail-focus.ts covers the arrangement).
//
//   Summary first — every table (groups named `_stats…` first): with 200 per-subject panels the
//   table that "is often all you need" must not sit below them. Then each image group as its own
//   section (the loose files first, as "·", the overlay's name for them). Then other files.
//
// Listing uses its own staleness (`ownEpoch`): another viewer clearing the shared byte cache
// must not abort the pane's listing. A new focus keeps the previous content on screen until the
// new listing arrives (the pane dims it meanwhile) — never a blank flash.

import { writable, get } from "svelte/store";
import { listDissections, type DissectListing, type DissectFile } from "../dissect/loader";
import { DISSECT_TABLE_RE } from "../dissect/rules";
import { fileBridge } from "../project/types";
import { tablePreview, type TablePreview } from "./tableCard";

export type DissectionSectionKind = "summary" | "images" | "other";
export interface DissectionSection {
  /** Stable id: kind + group. */
  id: string;
  kind: DissectionSectionKind;
  /** Header text. */
  title: string;
  /** The listing group the files come from ("" = loose files); summary/other span groups. */
  group: string;
  files: (DissectFile & { group: string })[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const statsFirst = (a: string, b: string) => {
  const sa = /^_?stats/i.test(a) ? 0 : 1, sb = /^_?stats/i.test(b) ? 0 : 1;
  return sa - sb || collator.compare(a, b);
};

/** Arrange a listing into the pane's sections (pure). */
export function arrangeDissections(listing: DissectListing | null): DissectionSection[] {
  const groups = listing?.groups ?? [];
  const tables: (DissectFile & { group: string })[] = [];
  const others: (DissectFile & { group: string })[] = [];
  const images: DissectionSection[] = [];
  const ordered = [...groups].sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : statsFirst(a.name, b.name)));
  for (const g of ordered) {
    const imgs: (DissectFile & { group: string })[] = [];
    for (const f of g.files) {
      const tagged = { ...f, group: g.name };
      if (f.kind === "table") tables.push(tagged);
      else if (f.kind === "image") imgs.push(tagged);
      else others.push(tagged);
    }
    // The loose files are the plot's overview (the expanded preview's name for them).
    if (imgs.length) images.push({ id: `images:${g.name}`, kind: "images", title: g.name || "Overview", group: g.name, files: imgs });
  }
  tables.sort((a, b) => statsFirst(a.group, b.group) || collator.compare(a.name, b.name));
  const out: DissectionSection[] = [];
  if (tables.length) out.push({ id: "summary", kind: "summary", title: "Summary", group: "", files: tables });
  out.push(...images);
  if (others.length) out.push({ id: "other", kind: "other", title: "Other files", group: "", files: others });
  return out;
}

export interface DissectionsState {
  /** The key whose content is shown. */
  key: string;
  listing: DissectListing | null;
  sections: DissectionSection[];
  /** The key being loaded (≠ key while switching: the old content stays, dimmed). */
  loadingKey: string;
  error: string;
  /** Bumps on every new listing (a live re-list included). */
  rev: number;
}

export function createDissectionsModel() {
  const state = writable<DissectionsState>({ key: "", listing: null, sections: [], loadingKey: "", error: "", rev: 0 });
  let generation = 0;
  let root = "";
  let wanted = "";

  async function load(r: string, key: string, force = false) {
    if (!force && r === root && key === wanted) return;
    root = r; wanted = key;
    const mine = ++generation;
    if (!key) { state.update((s) => ({ ...s, key: "", listing: null, sections: [], loadingKey: "", error: "", rev: s.rev + 1 })); return; }
    state.update((s) => ({ ...s, loadingKey: key, error: "" }));
    try {
      const listing = await listDissections(r, key, { ownEpoch: true });
      if (mine !== generation) return;
      state.update((s) => ({ key, listing, sections: arrangeDissections(listing), loadingKey: "", error: "", rev: s.rev + 1 }));
    } catch (e) {
      if (mine !== generation) return;
      state.update((s) => ({ ...s, key, listing: null, sections: [], loadingKey: "", error: e instanceof Error ? e.message : String(e), rev: s.rev + 1 }));
    }
  }

  return {
    subscribe: state.subscribe,
    /** Show `key` under project `root` (no-op if already shown). */
    show: (r: string, key: string) => load(r, key),
    /** Re-list the shown key (a watcher batch touched it, or Retry). */
    refresh: () => load(root, wanted, true),
    current: () => get(state),
  };
}

export interface DissectionImageSize { w: number; h: number; stamp: string; physMm: [number, number] | null; mtimeMs: number }
const UNREADABLE: TablePreview = { header: [], rows: [], rowCount: 0, complete: true, cols: 0, transposed: false, error: "Unreadable" };
/** What a grid needs before it lays out a listing: every image's header size + version stamp
 *  (one plotsProbe), and each table's bounded head as a card preview (plus a longer Peek look). */
export async function probeDissectionFiles(files: DissectFile[], peekRows = 0): Promise<{ sizes: Map<string, DissectionImageSize>; tables: Map<string, TablePreview>; peekTables: Map<string, TablePreview> }> {
  const fb = fileBridge();
  const sizes = new Map<string, DissectionImageSize>();
  const images = files.filter((f) => f.kind === "image").map((f) => f.abs);
  if (images.length && fb?.plotsProbe) {
    try {
      for (const p of await fb.plotsProbe(images)) sizes.set(p.abs, { w: p.w ?? 0, h: p.h ?? 0, stamp: `${p.size ?? 0}:${p.mtimeMs ?? 0}`, physMm: p.physMm ?? null, mtimeMs: p.mtimeMs ?? 0 });
    } catch { /* layout falls back to 4:3 */ }
  }
  const tables = new Map<string, TablePreview>(), peekTables = new Map<string, TablePreview>();
  await Promise.all(files.filter((f) => f.kind === "table" || DISSECT_TABLE_RE.test(f.name)).map(async (f) => {
    try {
      const r = await fb?.readTextBounded?.(f.abs, 64 * 1024);
      tables.set(f.abs, r ? tablePreview(r.text, f.name, r.truncated) : UNREADABLE);
      if (r && peekRows) peekTables.set(f.abs, tablePreview(r.text, f.name, r.truncated, peekRows));
    } catch { tables.set(f.abs, UNREADABLE); }
  }));
  return { sizes, tables, peekTables };
}
