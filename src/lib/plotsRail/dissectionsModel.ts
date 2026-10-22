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
