// Library organization (3.3): per-paper tags, reading status, and collections. This is a
// derived-but-canonical sidecar (.fluxlib/organize.json) keyed by citekey — safe because a
// citekey is immutable (FluxLib never re-keys; it dedupes by DOI), so the join never breaks.
// This module is the PURE model + immutable mutation + query merge; the twin persistence
// layers (flux-core fs, renderer bridge) read/write it under the "library" lock.
import type { RefEntry } from "./types";

export type ReadingStatus = "unread" | "reading" | "read";
export const READING_STATUSES: ReadingStatus[] = ["unread", "reading", "read"];

export interface OrganizeEntry {
  tags: string[];
  status?: ReadingStatus;
  collections: string[];
}

export interface OrganizeData {
  version: 1;
  items: Record<string, OrganizeEntry>; // citekey → entry
}

export const emptyOrganize = (): OrganizeData => ({ version: 1, items: {} });
export const emptyEntry = (): OrganizeEntry => ({ tags: [], collections: [] });

/** A paper's organize entry (always defined; empty when unset). */
export function organizeOf(data: OrganizeData, key: string): OrganizeEntry {
  const e = data.items[key];
  return e ? { tags: e.tags ?? [], status: e.status, collections: e.collections ?? [] } : emptyEntry();
}

// Case-insensitive de-dupe that preserves the first-seen casing + order.
function normList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// Prune an entry that carries nothing, so organize.json stays sparse.
function pruned(data: OrganizeData, key: string, e: OrganizeEntry): OrganizeData {
  const items = { ...data.items };
  if (!e.tags.length && !e.collections.length && (!e.status || e.status === "unread")) delete items[key];
  else items[key] = e;
  return { version: 1, items };
}

export function setTags(data: OrganizeData, key: string, tags: string[]): OrganizeData {
  const e = { ...organizeOf(data, key), tags: normList(tags) };
  return pruned(data, key, e);
}
export function addTag(data: OrganizeData, key: string, tag: string): OrganizeData {
  const e = organizeOf(data, key);
  return setTags(data, key, [...e.tags, tag]);
}
export function removeTag(data: OrganizeData, key: string, tag: string): OrganizeData {
  const e = organizeOf(data, key);
  const t = tag.trim().toLowerCase();
  return setTags(data, key, e.tags.filter((x) => x.toLowerCase() !== t));
}
export function setStatus(data: OrganizeData, key: string, status: ReadingStatus | undefined): OrganizeData {
  const e = { ...organizeOf(data, key), status: status && status !== "unread" ? status : undefined };
  return pruned(data, key, e);
}
export function setCollections(data: OrganizeData, key: string, collections: string[]): OrganizeData {
  const e = { ...organizeOf(data, key), collections: normList(collections) };
  return pruned(data, key, e);
}
export function addToCollection(data: OrganizeData, key: string, collection: string): OrganizeData {
  const e = organizeOf(data, key);
  return setCollections(data, key, [...e.collections, collection]);
}
export function removeFromCollection(data: OrganizeData, key: string, collection: string): OrganizeData {
  const e = organizeOf(data, key);
  const c = collection.trim().toLowerCase();
  return setCollections(data, key, e.collections.filter((x) => x.toLowerCase() !== c));
}

/** Add one tag to many papers in a single pass (for bulk-tagging a multiselect). */
export function bulkAddTag(data: OrganizeData, keys: string[], tag: string): OrganizeData {
  let d = data;
  for (const k of keys) d = addTag(d, k, tag);
  return d;
}

/** All distinct tags across the library (sorted, case-insensitive). */
export function allTags(data: OrganizeData): string[] {
  return normList(Object.values(data.items).flatMap((e) => e.tags ?? [])).sort((a, b) => a.localeCompare(b));
}
export function allCollections(data: OrganizeData): string[] {
  return normList(Object.values(data.items).flatMap((e) => e.collections ?? [])).sort((a, b) => a.localeCompare(b));
}

/** Attach organize data to entries so the query grammar (tag:/status:/collection:) can match
 *  them — mirrors how enrich is merged. Returns a new array of shallow-extended entries. */
export type OrganizedEntry = RefEntry & { organize?: OrganizeEntry };
export function mergeOrganize<T extends RefEntry>(entries: T[], data: OrganizeData): (T & { organize?: OrganizeEntry })[] {
  return entries.map((e) => (data.items[e.key] ? { ...e, organize: organizeOf(data, e.key) } : e));
}

/** Parse/repair an on-disk organize.json into the canonical shape (defensive against hand-edits). */
export function normalizeOrganize(raw: unknown): OrganizeData {
  const out = emptyOrganize();
  const items = (raw as { items?: Record<string, unknown> })?.items;
  if (items && typeof items === "object") {
    for (const [key, v] of Object.entries(items)) {
      const val = v as Partial<OrganizeEntry>;
      const tags = normList(Array.isArray(val?.tags) ? val.tags.map(String) : []);
      const collections = normList(Array.isArray(val?.collections) ? val.collections.map(String) : []);
      const status = READING_STATUSES.includes(val?.status as ReadingStatus) ? (val?.status as ReadingStatus) : undefined;
      if (tags.length || collections.length || (status && status !== "unread")) {
        out.items[key] = { tags, collections, status: status && status !== "unread" ? status : undefined };
      }
    }
  }
  return out;
}
