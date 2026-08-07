// Listing + lazy content loading for the Dissect viewer. Listing is two levels of readdir
// (the plot's dissection root + its group subfolders); content rides the app-wide pattern —
// bytes over the fs IPC bridge, rendered as data URLs — with a byte-budgeted LRU so a big
// dissection can't pin hundreds of MB (Dissect folders are typically tens of files; the LRU
// is the guard, not the expectation). The cache clears on dissectionsRevision bumps (the
// watcher's dissections subsystem), so an external rewrite re-reads fresh bytes.

import { fileBridge, joinPath, basename } from "../project/types";
import { classifyDissectionFile, dissectionRootRelFor } from "./rules";
import type { DissectFileKind } from "../../../electron/dissectRules.js";

export interface DissectFile {
  name: string;
  abs: string;
  kind: DissectFileKind;
  /** Image with a .fluxplot.json sibling in the same folder (a true fluxplot). */
  semantic?: boolean;
}

export interface DissectGroup {
  /** "" = the default group (files sitting directly in the plot's dissection root). */
  name: string;
  files: DissectFile[];
}

export interface DissectListing {
  /** Absolute path of the plot's dissection root (plots/_dissections/<key>). */
  root: string;
  /** null = the root folder does not exist yet (offer to create it). */
  groups: DissectGroup[] | null;
  /** Viewable files across all groups (images + tables + others; sidecars excluded). */
  total: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Absolute dissection root for a plot key under a project root. */
export function dissectionRootAbs(projectRoot: string, key: string): string {
  return joinPath(joinPath(projectRoot, "plots"), dissectionRootRelFor(key));
}

function filesOf(entries: { name: string; dir: boolean }[], dir: string): DissectFile[] {
  const names = new Set(entries.filter((e) => !e.dir).map((e) => e.name));
  return entries
    .filter((e) => !e.dir)
    .map((e) => ({ name: e.name, kind: classifyDissectionFile(e.name) }))
    .filter((f) => f.kind !== "sidecar")
    .map((f) => ({
      ...f,
      abs: joinPath(dir, f.name),
      semantic: f.kind === "image" ? names.has(f.name.replace(/\.svg$/i, ".fluxplot.json")) : undefined,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** List a plot's dissections: loose files form the default group, one level of subfolders
 *  form named groups (deeper nesting is not walked — the convention is one level). */
export async function listDissections(projectRoot: string, key: string): Promise<DissectListing> {
  const fb = fileBridge();
  const root = dissectionRootAbs(projectRoot, key);
  if (!fb?.readdir || !projectRoot || !key || !(await fb.exists(root)))
    return { root, groups: null, total: 0 };
  const top = await fb.readdir(root);
  const groups: DissectGroup[] = [];
  const loose = filesOf(top, root);
  if (loose.length) groups.push({ name: "", files: loose });
  for (const d of top.filter((e) => e.dir).sort((a, b) => collator.compare(a.name, b.name))) {
    const sub = await fb.readdir(joinPath(root, d.name));
    groups.push({ name: d.name, files: filesOf(sub, joinPath(root, d.name)) });
  }
  return { root, groups, total: groups.reduce((n, g) => n + g.files.length, 0) };
}

/** Cheap count for the Inspector badge (memoized there by dissectionsRevision). */
export async function countDissections(projectRoot: string, key: string): Promise<number> {
  return (await listDissections(projectRoot, key)).total;
}

/** Create the (empty) dissection root — the overlay's empty-state affordance. */
export async function createDissectionRoot(projectRoot: string, key: string): Promise<string | null> {
  const fb = fileBridge();
  const root = dissectionRootAbs(projectRoot, key);
  try {
    await fb?.mkdir(root);
    return root;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content: data URLs (images) and text (tables), byte-budgeted LRU by abs path.
// ---------------------------------------------------------------------------
const CACHE_CAP_BYTES = 150 * 1024 * 1024;
const urlCache = new Map<string, { url: string; bytes: number }>(); // insertion order = LRU
let cacheBytes = 0;
const inflight = new Map<string, Promise<string | null>>();

export function clearDissectCache(): void {
  urlCache.clear();
  cacheBytes = 0;
}

function mimeForName(name: string): string {
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** An image file's data URL (LRU-cached). null on read failure — the cell shows its
 *  missing state; a broken image must never break the grid. */
export function imageUrl(abs: string): Promise<string | null> {
  const hit = urlCache.get(abs);
  if (hit) {
    urlCache.delete(abs); // refresh recency
    urlCache.set(abs, hit);
    return Promise.resolve(hit.url);
  }
  const started = inflight.get(abs);
  if (started) return started;
  const p = (async () => {
    try {
      const fb = fileBridge();
      if (!fb) return null;
      const buf = await fb.readFile(abs);
      const bytes = new Uint8Array(buf);
      const url = bytesToDataUrl(bytes, mimeForName(abs));
      urlCache.set(abs, { url, bytes: url.length });
      cacheBytes += url.length;
      for (const [k, v] of urlCache) {
        if (cacheBytes <= CACHE_CAP_BYTES) break;
        urlCache.delete(k);
        cacheBytes -= v.bytes;
      }
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(abs);
    }
  })();
  inflight.set(abs, p);
  return p;
}

/** A table file's text. null on read failure. */
export async function tableText(abs: string): Promise<string | null> {
  try {
    const fb = fileBridge();
    if (!fb) return null;
    return await fb.readText(abs);
  } catch {
    return null;
  }
}

export { basename };
